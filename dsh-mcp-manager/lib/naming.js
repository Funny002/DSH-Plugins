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
 * Content projection mirrors the shipped bridge as well: text stays text, an
 * image block either becomes a durable image attachment (when the active model
 * route declares image input and the attachment store admits it) or an explicit
 * diagnostic, and every other MCP block becomes a bounded placeholder instead of
 * an unbounded dump.
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
/** Media types the durable attachment store admits. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
/** Canonical RFC 4648 base64: no whitespace, no URL-safe aliases. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

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
 * Whether a declared MIME string is one the attachment store persists.
 * @param value - candidate media type.
 * @returns true for PNG, JPEG, WebP, or GIF.
 */
function isImageMediaType(value) {
  return IMAGE_MEDIA_TYPES.includes(value)
}

/**
 * Decode one untrusted MCP image block.
 *
 * The network is a trust boundary, so both the declared media type and the
 * payload are re-validated here: only canonical base64 survives, and the round
 * trip must reproduce the exact input text.
 * @param block - one MCP content block claiming `type: 'image'`.
 * @returns the decoded bytes and their media type.
 * @throws when the media type or the payload is not admissible.
 */
export function decodeImageBlock(block) {
  if (typeof block.mimeType !== 'string' || !isImageMediaType(block.mimeType)) {
    throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF')
  }
  if (typeof block.data !== 'string' || !CANONICAL_BASE64.test(block.data)) {
    throw new Error('the image data is not canonical base64')
  }
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) throw new Error('the image data is not canonical base64')
  return { data, mediaType: block.mimeType }
}

/**
 * Stable diagnostic text for an image block that was not admitted.
 * @param block - the refused image block.
 * @param reason - why it was not admitted.
 * @returns the model-visible placeholder.
 */
export function imageDiagnostic(block, reason) {
  const mediaType = typeof block.mimeType === 'string' ? block.mimeType : 'unknown media type'
  return `[image unavailable: ${mediaType}; ${reason}; raw image data remains available to programmatic callers]`
}

/**
 * Project a whole MCP content array into harness content blocks.
 *
 * Text-like runs are newline-coalesced and split at each image position, so an
 * admitted image keeps its place in the ordered result.
 * @param content - the MCP result's content array (untrusted).
 * @param toolName - raw MCP tool name, used for the empty-result placeholder.
 * @param image - projection for one image block; defaults to a diagnostic.
 * @returns the projected content blocks, never empty.
 */
export function projectContent(content, toolName, image = (block) => ({
  type: 'text',
  text: imageDiagnostic(block, 'this result was not admitted to durable model context'),
})) {
  const projected = []
  const text = []
  const flushText = () => {
    if (text.length === 0) return
    projected.push({ type: 'text', text: text.splice(0).join('\n') })
  }
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: `(${toolName} returned no model-visible content)` }]
  }
  for (const [index, value] of content.entries()) {
    if (!isRecord(value)) {
      text.push('[unsupported MCP content block: expected an object]')
      continue
    }
    switch (value.type) {
      case 'text':
        if (typeof value.text === 'string') text.push(value.text)
        break
      case 'image':
        flushText()
        projected.push(image(value, index))
        break
      case 'resource_link':
        if (typeof value.name !== 'string' || typeof value.uri !== 'string') {
          text.push('[resource link unavailable: the MCP block is missing its name or URI]')
        } else {
          text.push(`Resource link: ${value.name} (${value.uri})`)
        }
        break
      case 'audio':
        text.push(
          `[audio result unsupported: ${typeof value.mimeType === 'string' ? value.mimeType : 'unknown media type'}; raw audio data remains available to programmatic callers]`,
        )
        break
      case 'resource':
        text.push('[embedded resource unsupported; raw resource data remains available to programmatic callers]')
        break
      default:
        text.push(`[unsupported MCP content type: ${String(value.type)}]`)
    }
  }
  flushText()
  return projected.length > 0 ? projected : [{ type: 'text', text: `(${toolName} returned no model-visible content)` }]
}

/**
 * Project a whole MCP content array to model-visible text.
 * @param content - the MCP result's content array, when it is an array.
 * @param rawName - raw MCP tool name, used for the empty-result placeholder.
 * @returns the joined text projection.
 */
export function contentToText(content, rawName) {
  return projectContent(content, rawName)
    .map((block) => (block.type === 'text' ? block.text : imageDiagnostic(block, 'this result was not admitted to durable model context')))
    .join('\n')
}

/**
 * Render one thrown value as text, without following its `cause` chain.
 * @param error - rejected value.
 * @returns the message text.
 */
function ownMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Render a thrown value as one diagnostic line, keeping the cause.
 *
 * `fetch failed` is the canonical case: the useful part (`ECONNREFUSED`, a TLS
 * code, a proxy failure) lives on `error.cause`, so dropping it leaves the
 * settings page with an error nobody can act on. Node's fetch and the MCP SDK
 * both use `cause`, hence the one-level unwind below.
 *
 * @param error - rejected value.
 * @returns the message text, with at most one cause level appended.
 */
export function errorMessage(error) {
  const message = ownMessage(error)
  const cause = error instanceof Error ? error.cause : undefined
  if (cause === undefined || cause === null || cause === error) return message
  const causeText = ownMessage(cause)
  if (causeText === '' || causeText === message || message.includes(causeText)) return message
  return `${message}: ${causeText}`
}
