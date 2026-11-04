/**
 * One MCP server connection per managed definition.
 *
 * A supervisor owns the MCP SDK client, its transport, and the exact set of
 * `ctx.tools` registrations that came from that server. It is deliberately
 * independent of Cordis HMR: the manager row hot-swaps as a whole when the patch
 * file changes, so each generation builds fresh supervisors and disposal is the
 * only teardown path.
 *
 * Model-facing tool names are `mcp__<serverName>__<rawName>` (see `./naming.js`),
 * the same contract `@deepseek-ai/dsh-mcp-client` pins, so moving a server
 * between the two bridges never renames a tool in session history.
 *
 * @module dsh-mcp-manager/supervisor
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { contentToText, errorMessage, isRecord, publicToolName } from './naming.js'

/** Default per-call timeout, matching the shipped MCP bridge. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000
/** Ambient names the stdio bridge refuses to forward: explicit config must supply them. */
const SECRET_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
/** A `tools/call` result the bridge validates itself, without pre-validating an advertised output schema. */
const RawCallToolResultSchema = z.record(z.string(), z.unknown())

/**
 * Resolve one configured environment value.
 *
 * A literal is used as-is. `env.NAME` or `${NAME}` reads the harness process
 * environment at connect time, which is how a server definition stays in the
 * patch file while its credential comes from the launching environment or from
 * `$DSH_HOME/.env`.
 *
 * @param value - configured value text.
 * @returns the resolved value text.
 */
export function resolveEnvValue(value) {
  const match = /^(?:env\.|\$\{)([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value.trim())
  if (match === null) return value
  return process.env[match[1]] ?? ''
}

/**
 * Build the child environment for a stdio server.
 *
 * The harness process environment is forwarded minus names that look like
 * credentials and minus every `DSH_*` name (the same scrub the shipped bridge
 * applies), then the configured values are merged on top so an explicit
 * override always wins.
 *
 * @param configured - resolved `env` map from the server definition.
 * @returns the child environment.
 */
export function buildChildEnv(configured) {
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    if (name.startsWith('DSH_') || SECRET_ENV_PATTERN.test(name)) continue
    env[name] = value
  }
  for (const [name, value] of Object.entries(configured ?? {})) env[name] = resolveEnvValue(String(value))
  return env
}

/**
 * Create the MCP transport selected by a server definition.
 * @param definition - normalized server definition.
 * @returns a not-yet-connected MCP transport.
 */
function createTransport(definition) {
  if (definition.transport === 'streamable-http') {
    return new StreamableHTTPClientTransport(new URL(definition.url), {
      requestInit: { headers: definition.headers ?? {} },
    })
  }
  return new StdioClientTransport({
    command: definition.command,
    args: definition.args ?? [],
    env: buildChildEnv(definition.env),
    cwd: definition.cwd === '' ? undefined : definition.cwd,
  })
}

/**
 * One managed MCP server: connection, tool generation, and status.
 */
export class McpServerSupervisor {
  /** @type {import('@deepseek-ai/cordis').Context} */
  #ctx
  /** @type {object} */
  #definition
  /** @type {'idle'|'connecting'|'connected'|'error'} */
  #state = 'idle'
  /** @type {string} */
  #error = ''
  /** @type {import('@modelcontextprotocol/sdk/client/index.js').Client|null} */
  #client = null
  #connecting = null
  /** @type {Map<string, () => void>} */
  #disposers = new Map()
  /** @type {Array<{rawName: string, publicName: string, description: string}>} */
  #tools = []
  #startedAt = 0
  #lastSyncAt = 0

  /**
   * @param ctx - host plugin context carrying the tool registry.
   * @param definition - normalized server definition.
   */
  constructor(ctx, definition) {
    this.#ctx = ctx
    this.#definition = definition
  }

  /** @returns the stable server name (the registry namespace). */
  get name() {
    return this.#definition.name
  }

  /** @returns the normalized definition this supervisor was built from. */
  get definition() {
    return this.#definition
  }

  /** @returns a human-readable connection target. */
  get target() {
    return this.#definition.transport === 'streamable-http'
      ? this.#definition.url
      : [this.#definition.command, ...(this.#definition.args ?? [])].join(' ')
  }

  /**
   * Snapshot this server's runtime state for the status API and the settings page.
   * @returns a plain JSON-safe status object.
   */
  status() {
    return {
      name: this.name,
      transport: this.#definition.transport,
      enabled: this.#definition.enabled !== false,
      target: this.target,
      definition: { ...this.#definition },
      state: this.#state,
      error: this.#error,
      toolCount: this.#tools.length,
      tools: this.#tools.map((tool) => ({ ...tool })),
      startedAt: this.#startedAt,
      lastSyncAt: this.#lastSyncAt,
      timeoutMs: this.#definition.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    }
  }

  /**
   * Connect and publish the server's initial tool generation.
   *
   * Activation never blocks on a server: the manager kicks this off in the
   * background and the settings page reports the outcome, so one unreachable
   * server cannot stall the whole profile.
   * @returns when the attempt settled (connected or failed).
   */
  async start() {
    if (this.#state === 'connected' || this.#state === 'connecting') return
    if (this.#connecting !== null) return this.#connecting
    this.#state = 'connecting'
    this.#error = ''
    this.#connecting = this.#connect()
    try {
      await this.#connecting
    } finally {
      this.#connecting = null
    }
  }

  /** Perform one connection + initial tool synchronization. */
  async #connect() {
    const client = new Client({ name: 'dsh-mcp-manager', version: '0.1.0' }, { capabilities: {} })
    try {
      await client.connect(createTransport(this.#definition))
      this.#client = client
      await this.#syncTools()
      this.#state = 'connected'
      this.#startedAt = Date.now()
      this.#ctx.logger.info(
        'mcp-manager(%s): connected via %s, %d tool(s) registered',
        this.name,
        this.#definition.transport,
        this.#tools.length,
      )
    } catch (error) {
      this.#error = errorMessage(error)
      this.#state = 'error'
      this.#client = null
      this.#ctx.logger.error('mcp-manager(%s): connection failed: %s', this.name, this.#error)
      try {
        await client.close()
      } catch {
        /* a transport that never connected owns nothing to close */
      }
    }
  }

  /**
   * Fetch the server's tool list and swap it into `ctx.tools`.
   *
   * Fetch fully before touching the registry, then dispose the previous
   * generation and register the next one: a failure in the fetch phase leaves
   * the previous generation registered, and a registration conflict rolls the
   * attempted generation back so a server never contributes a partial tool set.
   * @returns the number of registered tools.
   */
  async #syncTools() {
    const client = this.#client
    if (client === null) throw new Error('尚未连接')
    const listed = []
    const seenCursors = new Set()
    let cursor
    do {
      const response = await client.request(
        { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
        ListToolsResultSchema,
      )
      for (const tool of response.tools) listed.push(tool)
      cursor = response.nextCursor
      if (cursor !== undefined && cursor !== null && cursor !== '') {
        if (seenCursors.has(cursor)) throw new Error(`服务器重复返回了 tools/list 的续页游标`)
        seenCursors.add(cursor)
      } else {
        cursor = undefined
      }
    } while (cursor !== undefined)

    const definitions = new Map()
    const tools = []
    for (const tool of listed) {
      const publicName = publicToolName(this.name, tool.name)
      if (definitions.has(publicName)) throw new Error(`服务器重复列出了工具 "${tool.name}"：工具列表无效`)
      const description = typeof tool.description === 'string' ? tool.description : ''
      definitions.set(publicName, this.#toolDefinition(tool, publicName, description))
      tools.push({ rawName: tool.name, publicName, description })
    }

    for (const dispose of this.#disposers.values()) dispose()
    this.#disposers = new Map()
    const registered = new Map()
    try {
      for (const [publicName, definition] of definitions) {
        registered.set(publicName, this.#ctx.tools.register(definition))
      }
    } catch (error) {
      for (const dispose of registered.values()) dispose()
      throw new Error(`工具注册失败，未注册任何工具：${errorMessage(error)}`)
    }
    this.#disposers = registered
    this.#tools = tools
    this.#lastSyncAt = Date.now()
    return tools.length
  }

  /**
   * Build one ToolDefinition for an MCP tool.
   * @param tool - the MCP tool descriptor from `tools/list`.
   * @param publicName - model-facing registry name.
   * @param description - model-facing description.
   * @returns a ToolRuntime definition.
   */
  #toolDefinition(tool, publicName, description) {
    const rawName = tool.name
    const timeoutMs = this.#definition.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
    const parameters = isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} }
    return {
      name: publicName,
      description: description === '' ? `MCP tool "${rawName}" from server "${this.name}"` : description,
      parameters,
      output: {
        schema: {
          type: 'object',
          properties: { content: { type: 'array', items: {} } },
          required: ['content'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: contentToText(isRecord(value) ? value.content : [], rawName) }]
        },
      },
      execute: async (args, exec) => {
        const client = this.#client
        if (client === null) throw new Error(`mcp-manager(${this.name})：服务器未连接`)
        const result = await client.request(
          { method: 'tools/call', params: { name: rawName, arguments: isRecord(args) ? args : {} } },
          RawCallToolResultSchema,
          { signal: exec?.signal, timeout: timeoutMs },
        )
        const content = Array.isArray(result.content) ? result.content : []
        if (result.isError === true) throw new Error(contentToText(content, rawName))
        return { content }
      },
    }
  }

  /** Re-fetch this server's tool list while it stays connected. */
  async refreshTools() {
    if (this.#client === null) {
      await this.start()
      return this.#tools.length
    }
    return this.#syncTools()
  }

  /**
   * Disconnect, unregister this server's tools, and return to `idle`.
   * @returns when teardown settled.
   */
  async stop() {
    const client = this.#client
    this.#client = null
    for (const dispose of this.#disposers.values()) dispose()
    this.#disposers = new Map()
    this.#tools = []
    this.#state = 'idle'
    this.#error = ''
    this.#startedAt = 0
    if (client !== null) {
      try {
        await client.close()
      } catch (error) {
        this.#ctx.logger.warn('mcp-manager(%s): close failed: %s', this.name, errorMessage(error))
      }
    }
  }

  /** Stop and release everything this supervisor owns. */
  async dispose() {
    if (this.#connecting !== null) {
      try {
        await this.#connecting
      } catch {
        /* the connect attempt already recorded its own failure */
      }
    }
    await this.stop()
  }
}

/**
 * Connect to one candidate definition, list its tools, and disconnect.
 *
 * The settings page uses this as a "test connection" action: nothing is
 * persisted and nothing is registered on `ctx.tools`, so an experiment cannot
 * pollute the model's tool catalog.
 *
 * @param definition - normalized server definition.
 * @returns the tool rows the server advertises.
 */
export async function probeServer(definition) {
  const client = new Client({ name: 'dsh-mcp-manager-probe', version: '0.1.0' }, { capabilities: {} })
  await client.connect(createTransport(definition))
  try {
    const listed = []
    const seenCursors = new Set()
    let cursor
    do {
      const response = await client.request(
        { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
        ListToolsResultSchema,
      )
      for (const tool of response.tools) listed.push(tool)
      const next = response.nextCursor
      if (next === undefined || next === null || next === '') {
        cursor = undefined
      } else {
        if (seenCursors.has(next)) throw new Error('服务器重复返回了 tools/list 的续页游标')
        seenCursors.add(next)
        cursor = next
      }
    } while (cursor !== undefined)
    return listed.map((tool) => ({
      rawName: tool.name,
      publicName: publicToolName(definition.name, tool.name),
      description: typeof tool.description === 'string' ? tool.description : '',
    }))
  } finally {
    try {
      await client.close()
    } catch {
      /* probe teardown is best-effort */
    }
  }
}
