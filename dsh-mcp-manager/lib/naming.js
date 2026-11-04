/**
 * Model-facing naming and content projection for the MCP manager.
 *
 * The public tool name is a pure function of `(serverName, rawName)` and follows
 * the same pinned contract `@deepseek-ai/dsh-mcp-client` uses, so a server moved
 * between the two bridges keeps identical model-facing tool names:
 *
 *   `mcp__<serverName>__<rawName>` verbatim when it already satisfies the
 *   DeepSeek function-name limits (64 chars, `[A-Za-z0-9_-]`); otherwise the
 *   invalid characters become `_` and a 12-hex-char SHA-256 identity hash is
 *   appended so two distinct MCP identities can never collapse into one name.
 *
 * The raw MCP name is the only name ever sent on the wire.
 *
 * @module dsh-mcp-manager/naming
 */
import { createHash } from 'node:crypto'

/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
/** Hex characters of the identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/**
 * Derive the model-facing public name for one MCP tool.
 * @param serverName - stable local namespace from the managed server definition.
 * @param rawName - the MCP server's own tool name.
 * @returns the registry-qualified public tool name.
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/**
 * Whether a value is a JSON object (not null, not an array).
 * @param value - candidate value.
 * @returns true for a plain record-shaped value.
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Project one MCP content block to model-visible text.
 *
 * Text passes through, images become a bounded placeholder (this bridge does not
 * persist attachments), resource links keep their name and URI as text, and every
 * other block is rendered as compact JSON so nothing is silently dropped.
 * @param block - one untrusted MCP content block.
 * @returns the text projection of that block.
 */
export function blockToText(block) {
  if (!isRecord(block)) return typeof block === 'string' ? block : JSON.stringify(block)
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : ''
    case 'image':
      return `[image ${typeof block.mimeType === 'string' ? block.mimeType : 'unknown type'}]`
    case 'audio':
      return `[audio ${typeof block.mimeType === 'string' ? block.mimeType : 'unknown type'}]`
    case 'resource': {
      const resource = isRecord(block.resource) ? block.resource : {}
      const uri = typeof resource.uri === 'string' ? resource.uri : '(no uri)'
      const name = typeof resource.name === 'string' ? resource.name : ''
      if (typeof resource.text === 'string') return `${name === '' ? '' : `${name} `}${uri}\n${resource.text}`
      return `[resource ${name === '' ? '' : `${name} `}${uri}]`
    }
    case 'resource_link': {
      const name = typeof block.name === 'string' ? block.name : ''
      const uri = typeof block.uri === 'string' ? block.uri : '(no uri)'
      return `[resource_link ${name === '' ? '' : `${name} `}${uri}]`
    }
    default:
      try {
        return JSON.stringify(block)
      } catch {
        return '[unrenderable content block]'
      }
  }
}

/**
 * Project a whole MCP content array to model-visible text.
 * @param content - the MCP result's content array, when it is an array.
 * @param rawName - raw MCP tool name, used for the empty-result placeholder.
 * @returns the joined text projection.
 */
export function contentToText(content, rawName) {
  if (!Array.isArray(content)) return `(${rawName} returned no content)`
  const parts = content.map(blockToText).filter((part) => part !== '')
  return parts.length === 0 ? `(${rawName} returned no content)` : parts.join('\n\n')
}

/**
 * Render a thrown value as one diagnostic line.
 * @param error - rejected value.
 * @returns the message text.
 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
