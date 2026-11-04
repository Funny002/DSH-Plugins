/**
 * One supervised MCP server connection per managed definition.
 *
 * A supervisor owns the MCP SDK client, its transport, and the exact set of
 * `ctx.tools` registrations that came from that server. It is deliberately
 * independent of Cordis HMR: the manager row hot-swaps as a whole when the patch
 * file changes, so each generation builds fresh supervisors and disposal is the
 * only teardown path.
 *
 * The supervision model follows `@deepseek-ai/dsh-mcp-client`: one *generation*
 * is one `Client` bound to one transport for life. When a generation drops
 * (`onclose`, or a failed connect) the server is restarted with bounded
 * exponential backoff under one shared attempt budget, and the tool
 * registrations stay listed while it is down — a call during an outage fails
 * with the connection error instead of the model losing the tool. Exhausting the
 * budget unregisters the tools and stops; only disposal (a config change, an HMR
 * reload, or a Host restart) brings the server back, which is why the settings
 * page reports the state and offers "刷新".
 *
 * Model-facing tool names are `mcp__<serverName>__<rawName>` (see `./naming.js`),
 * the same contract `@deepseek-ai/dsh-mcp-client` pins, so moving a server
 * between the two bridges never renames a tool in session history.
 *
 * Tool results keep the shipped bridge's fidelity: an advertised `outputSchema`
 * is honoured as `structuredContent`, an image block becomes a durable
 * attachment when the active model route declares image input, and every other
 * block projects to bounded text.
 *
 * @module dsh-mcp-manager/supervisor
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  contentToText,
  decodeImageBlock,
  errorMessage,
  imageDiagnostic,
  isRecord,
  projectContent,
  publicToolName,
} from './naming.js'

/** Default per-call timeout, matching the shipped MCP bridge. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000
/** Ambient names the stdio bridge refuses to forward: explicit config must supply them. */
const SECRET_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
/** Largest delay `setTimeout` accepts without overflowing. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1
/** How long teardown waits for a generation's transport to confirm closure. */
const GENERATION_CLOSE_TIMEOUT_MS = 5000
/** A `tools/call` result the bridge validates itself, without pre-validating an advertised output schema. */
const RawCallToolResultSchema = z.record(z.string(), z.unknown())
/** JSON Schema keywords this bridge can pass to the harness unchanged. */
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  'type',
  'description',
  'title',
  'default',
  'enum',
  'const',
  'properties',
  'required',
  'items',
  'additionalProperties',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'anyOf',
  'oneOf',
  'allOf',
])

/** Reconnect defaults shared by the config schema and {@link resolveReconnectPolicy}. */
export const RECONNECT_DEFAULTS = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30000,
  maxAttempts: 10,
})

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
 * Resolve the reconnect policy for one server.
 *
 * Every default and bound is re-judged here rather than trusted from the config
 * schema, because programmatic construction and hand-written patch entries may
 * both bypass normalization; a misconfigured policy fails the row loudly instead
 * of producing a silent reconnect storm.
 *
 * @param config - raw `reconnect` config; omission uses the defaults.
 * @param path - diagnostic prefix naming the config location.
 * @returns the frozen resolved policy.
 */
export function resolveReconnectPolicy(config, path = 'mcp-manager: reconnect') {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`${path}.${key} 不是可识别的重连选项`)
    }
  }
  const enabled = config?.enabled ?? RECONNECT_DEFAULTS.enabled
  const initialDelayMs = config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs
  const maxDelayMs = config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
  const maxAttempts = config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs 必须是 1 到 ${MAX_TIMER_DELAY_MS} 之间的数字`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs 必须是 1 到 ${MAX_TIMER_DELAY_MS} 之间的数字`)
  }
  if (initialDelayMs > maxDelayMs) throw new Error(`${path}.initialDelayMs 不能大于 maxDelayMs`)
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error(`${path}.maxAttempts 必须是正整数`)
  return Object.freeze({ enabled, initialDelayMs, maxDelayMs, maxAttempts })
}

/**
 * Whether every node of a candidate JSON Schema uses only supported keywords.
 * @param node - candidate schema node.
 * @returns true when the node can be forwarded unchanged.
 */
function isSupportedSchemaNode(node) {
  if (!isRecord(node)) return false
  for (const [key, value] of Object.entries(node)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) return false
    if (key === 'properties') {
      if (!isRecord(value)) return false
      for (const child of Object.values(value)) if (!isSupportedSchemaNode(child)) return false
    } else if (key === 'items' || key === 'additionalProperties') {
      if (typeof value === 'boolean') continue
      if (!isSupportedSchemaNode(value)) return false
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      if (!Array.isArray(value)) return false
      for (const child of value) if (!isSupportedSchemaNode(child)) return false
    }
  }
  return true
}

/**
 * Keep a supported advertised output schema; unsupported MCP vocabulary falls
 * back to the permissive default, exactly as the shipped bridge does.
 * @param candidate - the MCP tool's declared `outputSchema`.
 * @returns the schema to declare, or `undefined` to omit it.
 */
export function supportedOutputSchema(candidate) {
  if (candidate === undefined) return undefined
  if (!isRecord(candidate) || candidate.type !== 'object') return undefined
  return isSupportedSchemaNode(candidate) ? candidate : undefined
}

/**
 * Connect to a server and drain its paginated tool list.
 * @param client - connected MCP client.
 * @returns every advertised tool descriptor.
 */
async function listServerTools(client) {
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
  return listed
}

/**
 * Resolve the attachment store and prove the active model route accepts images.
 * @param ctx - plugin context carrying optional services.
 * @param exec - the exact tool execution supplying the active route and signal.
 * @returns the attachment store.
 * @throws when no store exists or the route does not declare image input.
 */
async function resolveImageAdmission(ctx, exec) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('没有挂载附件存储')
  const routed = exec?.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec?.agent?.options?.provider
  const model = routed?.model ?? exec?.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) throw new Error('无法解析当前模型路由')
  let info
  try {
    info = await llm.resolveModelInfo(provider, model, exec?.signal)
  } catch {
    throw new Error('无法校验当前模型路由')
  }
  if (info?.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`模型 "${model}" 未声明图片输入能力`)
  }
  if (exec?.signal?.aborted === true) throw new Error('工具调用在图片落盘前被取消')
  return attachments
}

/**
 * Decode, admit, and durably save one result's ordered image batch.
 *
 * Any refusal degrades every image in the batch to text while the canonical raw
 * value stays available to programmatic callers.
 * @param ctx - plugin context.
 * @param exec - the tool execution owning the result.
 * @param content - the MCP content array.
 * @param toolName - raw MCP tool name.
 * @returns the projected content blocks.
 */
async function prepareImageProjection(ctx, exec, content, toolName) {
  const decoded = []
  const validationErrors = new Map()
  const imageIndexes = []
  for (const [index, value] of content.entries()) {
    if (!isRecord(value) || value.type !== 'image') continue
    imageIndexes.push(index)
    try {
      decoded.push(decodeImageBlock(value))
    } catch (error) {
      validationErrors.set(index, errorMessage(error))
    }
  }
  if (validationErrors.size > 0) {
    return projectContent(content, toolName, (block, index) => ({
      type: 'text',
      text: imageDiagnostic(block, validationErrors.get(index) ?? '同一结果中的另一张图片无效'),
    }))
  }
  let attachments
  try {
    attachments = await resolveImageAdmission(ctx, exec)
  } catch (error) {
    const reason = errorMessage(error)
    return projectContent(content, toolName, (block) => ({ type: 'text', text: imageDiagnostic(block, reason) }))
  }
  try {
    const refs = await attachments.saveImages(decoded)
    const byIndex = new Map(imageIndexes.map((index, offset) => [index, refs[offset]]))
    return projectContent(content, toolName, (_block, index) => ({ type: 'image', attachment: byIndex.get(index) }))
  } catch {
    return projectContent(content, toolName, (block) => ({
      type: 'text',
      text: imageDiagnostic(block, '持久化图片存储拒绝了该结果'),
    }))
  }
}

/**
 * One managed MCP server: supervised connection, tool generation, and status.
 */
export class McpServerSupervisor {
  /** @type {import('@deepseek-ai/cordis').Context} */
  #ctx
  /** @type {object} */
  #definition
  /** @type {ReturnType<typeof resolveReconnectPolicy>} */
  #policy
  /** @type {'idle'|'connecting'|'connected'|'reconnecting'|'error'} */
  #state = 'idle'
  /** @type {string} */
  #error = ''
  /** @type {import('@modelcontextprotocol/sdk/client/index.js').Client|undefined} */
  #client
  #clientClosed
  /** @type {Map<string, () => void>} */
  #disposers = new Map()
  /** @type {Array<{rawName: string, publicName: string, description: string}>} */
  #tools = []
  #startedAt = 0
  #lastSyncAt = 0
  #connectedAt = 0
  /** Consecutive failed connection attempts within the current outage. */
  #failedAttempts = 0
  /** When the next scheduled retry fires, or 0 while none is scheduled. */
  #nextRetryAt = 0
  #reconnectTimer
  #disposed = false
  #settling
  /** Serializes every tool sync so two swaps can never interleave. */
  #syncChain = Promise.resolve()

  /**
   * @param ctx - host plugin context carrying the tool registry.
   * @param definition - normalized server definition.
   * @param policy - resolved reconnect policy; omitted uses the defaults.
   */
  constructor(ctx, definition, policy = resolveReconnectPolicy(undefined)) {
    this.#ctx = ctx
    this.#definition = definition
    this.#policy = policy
  }

  /** @returns the stable server name (the registry namespace). */
  get name() {
    return this.#definition.name
  }

  /** @returns the normalized definition this supervisor was built from. */
  get definition() {
    return this.#definition
  }

  /** @returns whether the definition is enabled. */
  get enabled() {
    return this.#definition.enabled !== false
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
      enabled: this.enabled,
      target: this.target,
      definition: { ...this.#definition },
      state: this.#state,
      error: this.#error,
      toolCount: this.#tools.length,
      tools: this.#tools.map((tool) => ({ ...tool })),
      startedAt: this.#startedAt,
      lastSyncAt: this.#lastSyncAt,
      timeoutMs: this.#definition.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
      reconnect: {
        ...this.#policy,
        attempts: this.#failedAttempts,
        nextRetryAt: this.#nextRetryAt,
      },
    }
  }

  /**
   * Whether a generation may still act on behalf of this supervisor.
   * @param generation - the client under test.
   * @returns true while that client is the current generation.
   */
  #isCurrent(generation) {
    return !this.#disposed && this.#client === generation
  }

  /**
   * Queue one tool synchronization.
   *
   * Initial syncs, notification re-syncs, and manual refreshes all share this
   * chain: two interleaved dispose-previous/register-next swaps would double
   * dispose one generation and leak another.
   * @param generation - the client whose tool list is read.
   * @returns when this sync settled.
   */
  #enqueueSync(generation) {
    const run = this.#syncChain.then(async () => {
      if (!this.#isCurrent(generation)) return
      await this.#syncTools(generation)
    })
    this.#syncChain = run.catch(() => {})
    return run
  }

  /**
   * Read the server's tool list and swap it into `ctx.tools`.
   *
   * Fetch fully before touching the registry, then dispose the previous
   * generation and register the next one: a fetch failure leaves the previous
   * generation registered, and a registration conflict rolls the attempted
   * generation back so a server never contributes a partial tool set.
   * @param generation - the connected client to read from.
   * @returns the number of registered tools.
   */
  async #syncTools(generation) {
    const listed = await listServerTools(generation)
    const definitions = new Map()
    const tools = []
    for (const tool of listed) {
      const publicName = publicToolName(this.name, tool.name)
      if (definitions.has(publicName)) throw new Error(`服务器重复列出了工具 "${tool.name}"：工具列表无效`)
      const description = typeof tool.description === 'string' ? tool.description : ''
      definitions.set(publicName, this.#toolDefinition(generation, tool, publicName, description))
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
      // A registry conflict can only mean a foreign registration squats on this
      // server's `mcp__<serverName>__` namespace. Contain it: this server
      // contributes nothing, the connection stays up, and the row keeps serving
      // its other servers. Retrying would not change the outcome.
      this.#tools = []
      this.#ctx.logger.error(
        'mcp-manager(%s): 工具注册失败，本服务器未注册任何工具: %s',
        this.name,
        errorMessage(error),
      )
      return 0
    }
    this.#disposers = registered
    this.#tools = tools
    this.#lastSyncAt = Date.now()
    return tools.length
  }

  /**
   * Build one ToolDefinition for an MCP tool.
   * @param generation - the client this definition calls through.
   * @param tool - the MCP tool descriptor from `tools/list`.
   * @param publicName - model-facing registry name.
   * @param description - model-facing description.
   * @returns a complete harness ToolDefinition.
   */
  #toolDefinition(generation, tool, publicName, description) {
    const rawName = tool.name
    const timeoutMs = this.#definition.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
    const parameters = isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} }
    const structuredSchema = supportedOutputSchema(tool.outputSchema)
    const taskRequired = tool.execution?.taskSupport === 'required'
    /** Per-execution rich projections, consulted once by `finalizeContent`. */
    const projections = new WeakMap()
    return {
      name: publicName,
      description: description === '' ? `MCP tool "${rawName}" from server "${this.name}"` : description,
      parameters,
      output: {
        schema: {
          type: 'object',
          properties: {
            content: { type: 'array', items: {} },
            ...(structuredSchema === undefined ? {} : { structuredContent: structuredSchema }),
          },
          required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: contentToText(isRecord(value) ? value.content : [], rawName) }]
        },
      },
      finalizeContent(exec, result) {
        const projection = projections.get(exec)
        if (projection === undefined) return undefined
        projections.delete(exec)
        if (result.isError) return undefined
        if (!isDeepStrictEqual(result.content, projection.fallback)) return undefined
        if (!isDeepStrictEqual(result.value, projection.value)) return undefined
        return projection.content
      },
      execute: async (args, exec) => {
        if (taskRequired) throw new Error(`工具 "${rawName}" 需要 MCP task 执行模式，本桥接不支持`)
        if (!this.#isCurrent(generation)) {
          throw new Error(`mcp-manager(${this.name})：服务器未连接（${this.#stateLabel()}）`)
        }
        const result = await generation.request(
          { method: 'tools/call', params: { name: rawName, arguments: isRecord(args) ? args : {} } },
          RawCallToolResultSchema,
          { signal: exec?.signal, timeout: timeoutMs },
        )
        if (!Array.isArray(result.content)) {
          const rendered = 'toolResult' in result ? JSON.stringify(result.toolResult) : '(no output)'
          const text = typeof rendered === 'string' ? rendered : '(no output)'
          if (result.isError === true) throw new Error(text)
          return {
            content: [{ type: 'text', text }],
            ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
          }
        }
        const content = result.content
        const text = contentToText(content, rawName)
        if (result.isError === true) throw new Error(text)
        const value = {
          content,
          ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        }
        if (content.some((block) => isRecord(block) && block.type === 'image')) {
          const fallback = [{ type: 'text', text }]
          const projected = await prepareImageProjection(this.#ctx, exec, content, rawName)
          projections.set(exec, { value, fallback, content: projected })
        }
        return value
      },
    }
  }

  /** @returns a short human-readable state label for error text. */
  #stateLabel() {
    switch (this.#state) {
      case 'reconnecting':
        return `第 ${this.#failedAttempts}/${this.#policy.maxAttempts} 次重连`
      case 'connecting':
        return '正在连接'
      case 'error':
        return '连接失败'
      case 'idle':
        return '未启动'
      default:
        return '已断开'
    }
  }

  /**
   * Start the supervised connection. Activation never blocks on a server: the
   * manager kicks this off in the background and the settings page reports the
   * outcome, so one unreachable server cannot stall the whole profile.
   * @returns when the first attempt settled (connected, failed, or retrying).
   */
  async start() {
    if (this.#disposed) return
    // A manual start supersedes a scheduled retry. Leaving both alive would open
    // a second generation and orphan the first transport (and its child process).
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = undefined
      this.#nextRetryAt = 0
    }
    if (this.#settling !== undefined) return this.#settling
    if (this.#client !== undefined || this.#state === 'connected') return
    this.#state = this.#failedAttempts === 0 ? 'connecting' : 'reconnecting'
    this.#error = ''
    this.#settling = this.#connectGeneration()
    try {
      await this.#settling
    } finally {
      this.#settling = undefined
    }
  }

  /**
   * One connection attempt: a fresh transport + client (the SDK binds a protocol
   * to one transport for life), connect, then queue the initial tool sync. Every
   * failure funnels through {@link #generationDown}. Never rejects.
   */
  async #connectGeneration() {
    // Disposal and an already-live generation both mean "nothing to do here";
    // this is the last guard before a new transport is created.
    if (this.#disposed || this.#client !== undefined) return
    const generation = new Client({ name: 'dsh-mcp-manager', version: '0.1.0' }, { capabilities: {} })
    const closed = Promise.withResolvers()
    let attemptSettled = false
    let closeObserved = false
    this.#client = generation
    this.#clientClosed = closed.promise
    generation.onclose = () => {
      closeObserved = true
      closed.resolve()
      if (attemptSettled) this.#generationDown(generation)
    }
    generation.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (!this.#isCurrent(generation)) return
      this.#ctx.logger.info('mcp-manager(%s): 工具列表变化，正在重新同步', this.name)
      try {
        await this.#enqueueSync(generation)
      } catch (error) {
        if (!this.#disposed) this.#ctx.logger.error('mcp-manager(%s): 工具重新同步失败: %s', this.name, errorMessage(error))
      }
    })
    try {
      await generation.connect(createTransport(this.#definition))
      if (closeObserved) {
        attemptSettled = true
        this.#generationDown(generation)
        return
      }
      await this.#enqueueSync(generation)
    } catch (error) {
      if (this.#isCurrent(generation)) {
        this.#error = errorMessage(error)
        this.#ctx.logger.warn('mcp-manager(%s): 连接尝试失败: %s', this.name, this.#error)
      }
      try {
        await generation.close()
      } catch {
        /* a transport that never connected owns nothing to close */
      }
      const quiesced = closeObserved || (await this.#waitForClose(closed.promise))
      attemptSettled = true
      if (!this.#isCurrent(generation)) return
      if (!quiesced) {
        this.#client = undefined
        this.#clientClosed = undefined
        this.#state = 'error'
        this.#error = `失败的连接未在 ${GENERATION_CLOSE_TIMEOUT_MS}ms 内关闭，已停止重连以避免叠加服务器进程`
        this.#ctx.logger.error('mcp-manager(%s): %s', this.name, this.#error)
        return
      }
      this.#generationDown(generation)
      return
    }
    attemptSettled = true
    if (closeObserved) {
      this.#generationDown(generation)
      return
    }
    if (!this.#isCurrent(generation)) return
    this.#connectedAt = Date.now()
    this.#startedAt = this.#connectedAt
    this.#state = 'connected'
    this.#error = ''
    this.#nextRetryAt = 0
    const wasReconnecting = this.#failedAttempts > 0
    if (wasReconnecting) {
      this.#ctx.logger.info('mcp-manager(%s): 已重连并重新同步工具（第 %d 次尝试）', this.name, this.#failedAttempts)
      this.#failedAttempts = 0
    }
    this.#ctx.logger.info(
      'mcp-manager(%s): 已通过 %s 连接，注册 %d 个工具',
      this.name,
      this.#definition.transport,
      this.#tools.length,
    )
  }

  /**
   * Wait for a transport-owned close signal without letting a broken transport
   * wedge teardown forever.
   * @param closed - the generation's close promise.
   * @returns whether the generation confirmed closure in time.
   */
  async #waitForClose(closed) {
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), GENERATION_CLOSE_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
    })
    try {
      return await Promise.race([closed.then(() => true), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Handle one dropped generation: forget it and schedule the next attempt.
   * @param generation - the generation that disconnected.
   */
  #generationDown(generation) {
    if (!this.#isCurrent(generation)) return
    this.#client = undefined
    this.#clientClosed = undefined
    this.#scheduleReconnect()
  }

  /** Schedule the next connection attempt under the shared attempt budget. */
  #scheduleReconnect() {
    if (this.#disposed) return
    const lostEstablishedConnection = this.#connectedAt !== 0
    if (!this.#policy.enabled) {
      this.#state = 'error'
      this.#error = lostEstablishedConnection
        ? '连接已断开，且未启用自动重连：工具会持续失败，直到重载插件或重启 Host'
        : '连接失败，且未启用自动重连：未注册任何工具，重载插件或重启 Host 后可重连'
      this.#ctx.logger.error('mcp-manager(%s): %s', this.name, this.#error)
      return
    }
    // A connection that stayed up past the stability window closes the outage,
    // so a crash-looping server still exhausts the budget instead of retrying forever.
    if (lostEstablishedConnection && Date.now() - this.#connectedAt >= this.#policy.maxDelayMs) this.#failedAttempts = 0
    this.#connectedAt = 0
    this.#failedAttempts += 1
    if (this.#failedAttempts > this.#policy.maxAttempts) {
      this.#syncChain = this.#syncChain.then(() => {
        for (const dispose of this.#disposers.values()) dispose()
        this.#disposers = new Map()
        this.#tools = []
      })
      this.#state = 'error'
      this.#nextRetryAt = 0
      // Report the budget, not the arithmetic: the attempt that broke the budget
      // is the failure being reported, so the status reads "10/10", not "11/10".
      this.#failedAttempts = this.#policy.maxAttempts
      this.#error = `连续 ${this.#policy.maxAttempts} 次重连失败，已注销工具并停止重连：重载插件或重启 Host 后可重连`
      this.#ctx.logger.error('mcp-manager(%s): %s', this.name, this.#error)
      return
    }
    const delayMs = Math.min(this.#policy.maxDelayMs, this.#policy.initialDelayMs * 2 ** (this.#failedAttempts - 1))
    this.#state = 'reconnecting'
    this.#nextRetryAt = Date.now() + delayMs
    this.#ctx.logger.warn(
      'mcp-manager(%s): %s，将在 %dms 后重试（第 %d/%d 次）',
      this.name,
      lostEstablishedConnection ? '连接丢失' : '连接失败',
      delayMs,
      this.#failedAttempts,
      this.#policy.maxAttempts,
    )
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      this.#nextRetryAt = 0
      this.#settling = this.#connectGeneration()
      this.#settling.finally(() => {
        this.#settling = undefined
      })
    }, delayMs)
    if (typeof this.#reconnectTimer.unref === 'function') this.#reconnectTimer.unref()
  }

  /**
   * Re-fetch this server's tool list without touching its connection.
   * @returns the number of registered tools.
   */
  async refreshTools() {
    if (this.#client === undefined) {
      await this.start()
      return this.#tools.length
    }
    return this.#enqueueSync(this.#client)
  }

  /**
   * Disconnect, unregister this server's tools, and return to `idle`.
   *
   * The supervisor may be started again afterwards; only {@link dispose} is
   * terminal. A manager-level stop is a graceful pause, not a tombstone.
   * @returns when teardown settled.
   */
  async stop() {
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = undefined
    }
    const current = this.#client
    const currentClosed = this.#clientClosed
    this.#client = undefined
    this.#clientClosed = undefined
    if (current !== undefined) {
      try {
        await current.close()
      } catch (error) {
        this.#ctx.logger.warn('mcp-manager(%s): 关闭失败: %s', this.name, errorMessage(error))
      }
      if (currentClosed !== undefined && !(await this.#waitForClose(currentClosed))) {
        this.#ctx.logger.error(
          'mcp-manager(%s): 连接未在 %dms 内关闭，服务器进程可能残留',
          this.name,
          GENERATION_CLOSE_TIMEOUT_MS,
        )
      }
    }
    if (this.#settling !== undefined) {
      try {
        await this.#settling
      } catch {
        /* the attempt already recorded its own failure */
      }
    }
    await this.#syncChain
    for (const dispose of this.#disposers.values()) dispose()
    this.#disposers = new Map()
    this.#tools = []
    this.#state = 'idle'
    this.#error = ''
    this.#startedAt = 0
    this.#connectedAt = 0
    this.#nextRetryAt = 0
    this.#failedAttempts = 0
  }

  /** Stop and release everything this supervisor owns. Terminal. */
  async dispose() {
    this.#disposed = true
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
    return (await listServerTools(client)).map((tool) => ({
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
