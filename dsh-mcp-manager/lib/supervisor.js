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
import { VERSION } from './version.js'

/** Default per-call timeout, matching the shipped MCP bridge. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000
/**
 * Default bound on one connection attempt (transport start + `initialize`).
 *
 * Without it a server that accepts the process/HTTP connection but never answers
 * `initialize` keeps `connect()` pending forever, which in turn keeps the
 * supervisor's settling promise, its sync chain, and therefore `stop()` and
 * disposal pending forever — a hung server would block profile teardown.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30000
/** Bound on one `tools/list` page; the SDK default (60s) is longer than a list should ever take. */
const LIST_TOOLS_TIMEOUT_MS = 30000
/** Pages of `tools/list` accepted from one server before the list is called invalid. */
const MAX_TOOL_PAGES = 100
/** Tool descriptors accepted from one server before the list is called invalid. */
const MAX_LISTED_TOOLS = 5000
/** Bound on the best-effort HTTP session termination during teardown. */
const HTTP_SESSION_TERMINATE_TIMEOUT_MS = 2000
/** stderr lines forwarded per generation before the tap goes quiet (the pipe keeps draining). */
const STDERR_MAX_LINES = 20
/** stderr bytes forwarded per generation before the tap goes quiet. */
const STDERR_MAX_BYTES = 16 * 1024
/** Longest single forwarded stderr line. */
const STDERR_LINE_MAX_CHARS = 500
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

/** No tool is filtered out. */
export const DEFAULT_TOOL_FILTER = Object.freeze({ allow: Object.freeze([]), deny: Object.freeze([]) })
/** Longest accepted tool-filter pattern. */
const TOOL_FILTER_MAX_PATTERN_LENGTH = 200
/** Most patterns accepted in one tool-filter list. */
const TOOL_FILTER_MAX_ENTRIES = 200

/**
 * Compile one tool-filter pattern into a regular expression.
 *
 * `*` matches any run of characters and `?` exactly one; everything else is
 * literal, so a tool named `a.b` cannot be matched accidentally by a regex dot.
 * @param pattern - the configured pattern.
 * @returns the anchored matcher.
 */
function compileToolPattern(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

/**
 * Validate and freeze one server's tool filter.
 *
 * `allow` empty means "every tool"; a pattern in `deny` always wins. Patterns
 * match the raw MCP tool name (the name the server publishes), not the
 * `mcp__<server>__` public name, because the filter describes the server's own
 * catalogue.
 *
 * @param input - untrusted `toolFilter` value, or `undefined`.
 * @param path - diagnostic prefix naming the config location.
 * @returns the frozen filter.
 * @throws when a list, an entry, or a pattern is unusable.
 */
export function resolveToolFilter(input, path = 'mcp-manager: toolFilter') {
  if (input === undefined || input === null) return DEFAULT_TOOL_FILTER
  if (!isRecord(input)) throw new Error(`${path} 必须是对象`)
  for (const key of Object.keys(input)) {
    if (key !== 'allow' && key !== 'deny') throw new Error(`${path}.${key} 不是可识别的工具过滤选项`)
  }
  const readList = (key) => {
    const value = input[key]
    if (value === undefined || value === null) return Object.freeze([])
    if (!Array.isArray(value)) throw new Error(`${path}.${key} 必须是字符串数组`)
    if (value.length > TOOL_FILTER_MAX_ENTRIES) {
      throw new Error(`${path}.${key} 最多 ${TOOL_FILTER_MAX_ENTRIES} 条`)
    }
    const entries = []
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim() === '') throw new Error(`${path}.${key} 不允许空条目`)
      const pattern = entry.trim()
      if (pattern.length > TOOL_FILTER_MAX_PATTERN_LENGTH) {
        throw new Error(`${path}.${key} 的条目 ${JSON.stringify(pattern.slice(0, 20))}… 超过 ${TOOL_FILTER_MAX_PATTERN_LENGTH} 个字符`)
      }
      entries.push(pattern)
    }
    return Object.freeze(entries)
  }
  return Object.freeze({ allow: readList('allow'), deny: readList('deny') })
}

/**
 * Build the predicate for one resolved tool filter.
 * @param filter - resolved filter.
 * @returns a function deciding whether a raw tool name is exposed.
 */
function compileToolFilter(filter) {
  const allow = filter.allow.map(compileToolPattern)
  const deny = filter.deny.map(compileToolPattern)
  return (rawName) => {
    if (deny.some((pattern) => pattern.test(rawName))) return false
    return allow.length === 0 || allow.some((pattern) => pattern.test(rawName))
  }
}

/**
 * Whether one raw tool name passes a tool filter.
 * @param filter - resolved filter (or `undefined` for "no filter").
 * @param rawName - the server's own tool name.
 * @returns true when the tool is exposed to the model.
 */
export function matchesToolFilter(filter, rawName) {
  return compileToolFilter(filter ?? DEFAULT_TOOL_FILTER)(rawName)
}

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
 *
 * stdio children get `stderr: 'pipe'`: with the SDK default (`inherit`) a chatty
 * server writes straight into the host's stderr forever, and with an
 * unconsumed pipe it would block on its own stderr once the pipe buffer fills.
 * The generation attaches a bounded consumer to {@link StdioClientTransport.stderr}
 * right after this call (see {@link forwardStderr}).
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
    stderr: 'pipe',
  })
}

/**
 * Validate one connection-timeout value.
 *
 * Judged here as well as in the config schema because programmatic construction
 * and hand-written patch entries both bypass normalization; a bad bound fails the
 * row loudly instead of silently becoming an unbounded connect.
 * @param value - raw `connectTimeoutMs`, or `undefined` for the default.
 * @param path - diagnostic prefix naming the config location.
 * @returns the timeout in milliseconds.
 */
export function resolveConnectTimeout(value, path = 'mcp-manager: connectTimeoutMs') {
  if (value === undefined || value === null) return DEFAULT_CONNECT_TIMEOUT_MS
  if (!Number.isFinite(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path} 必须是 1 到 ${MAX_TIMER_DELAY_MS} 之间的数字`)
  }
  return value
}

/**
 * Forward a bounded slice of a stdio child's stderr into the host log.
 *
 * Two failure modes are avoided at once: an inherited stderr floods the host's
 * own output without limit, and a piped-but-unread stderr eventually blocks the
 * child when the pipe buffer fills. The tap therefore always drains the stream,
 * but only emits the first {@link STDERR_MAX_LINES} lines (bounded by
 * {@link STDERR_MAX_BYTES}) and then says once that it went quiet.
 *
 * @param transport - the stdio transport that owns the child process.
 * @param logger - host logger.
 * @param serverName - server name used in the log prefix.
 * @returns a detach function that removes this generation's listeners.
 */
function forwardStderr(transport, logger, serverName) {
  const stream = transport.stderr
  if (stream === null || stream === undefined || typeof stream.on !== 'function') return () => {}
  let bytes = 0
  let lines = 0
  let pending = ''
  let muted = false
  const emit = (line) => {
    if (line === '') return
    logger.warn(
      'mcp-manager(%s): stderr: %s',
      serverName,
      line.length > STDERR_LINE_MAX_CHARS ? `${line.slice(0, STDERR_LINE_MAX_CHARS)}…` : line,
    )
  }
  const onData = (chunk) => {
    if (muted) return
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    bytes += text.length
    pending += text
    let index = pending.indexOf('\n')
    while (index !== -1) {
      const line = pending.slice(0, index).replace(/\r$/, '')
      pending = pending.slice(index + 1)
      if (line.trim() !== '') {
        lines += 1
        if (lines > STDERR_MAX_LINES || bytes > STDERR_MAX_BYTES) {
          muted = true
          pending = ''
          logger.warn(
            'mcp-manager(%s): stderr 已超过 %d 行 / %d KiB，后续输出不再记录（子进程仍在被读取，不会阻塞）',
            serverName,
            STDERR_MAX_LINES,
            STDERR_MAX_BYTES / 1024,
          )
          return
        }
        emit(line)
      }
      index = pending.indexOf('\n')
    }
    // A server that never emits a newline must not grow this buffer forever.
    if (pending.length > 4096) {
      emit(pending)
      pending = ''
    }
  }
  const onError = () => {
    muted = true
  }
  stream.on('data', onData)
  stream.on('error', onError)
  return () => {
    stream.off('data', onData)
    stream.off('error', onError)
    // Keep draining after teardown: the child may still flush stderr while it is
    // being killed, and an unread pipe would block it until the SIGKILL.
    if (typeof stream.resume === 'function') stream.resume()
  }
}

/**
 * Settle a best-effort promise with a deadline, ignoring its outcome.
 * @param promise - the operation to bound.
 * @param timeoutMs - how long to wait.
 * @returns when the operation settled or the deadline passed.
 */
async function settleWithin(promise, timeoutMs) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    await Promise.race([promise.then(() => true, () => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
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
 *
 * Both bounds matter on a hostile or broken server: a page that never answers
 * would otherwise pin the supervisor's sync chain (and its disposal) on the SDK
 * default timeout, and a server that streams endless distinct pages would grow
 * the tool list without limit.
 *
 * @param client - connected MCP client.
 * @returns every advertised tool descriptor.
 * @throws when the list exceeds the page/tool caps.
 */
async function listServerTools(client) {
  const listed = []
  const seenCursors = new Set()
  let cursor
  let pages = 0
  do {
    pages += 1
    if (pages > MAX_TOOL_PAGES) throw new Error(`tools/list 返回了超过 ${MAX_TOOL_PAGES} 页，已停止读取`)
    const response = await client.request(
      { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
      ListToolsResultSchema,
      { timeout: LIST_TOOLS_TIMEOUT_MS },
    )
    for (const tool of response.tools) listed.push(tool)
    if (listed.length > MAX_LISTED_TOOLS) {
      throw new Error(`服务器公布了超过 ${MAX_LISTED_TOOLS} 个工具，已停止读取（工具列表无效）`)
    }
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
 * Structural fingerprint of a `tools/list` result.
 *
 * Two syncs of the same generation that produce the same fingerprint would
 * register byte-identical tool definitions, so the sync can skip the registry
 * swap entirely. Only fields the bridge projects are included: a server that
 * changes nothing observable should not churn `ctx.tools`.
 * @param listed - tool descriptors from `tools/list`.
 * @returns a stable string key.
 */
function listFingerprint(listed) {
  let text = ''
  for (const tool of listed) {
    text += `${tool.name}\u0000${typeof tool.description === 'string' ? tool.description : ''}\u0000${JSON.stringify(tool.inputSchema ?? null)}\u0000${JSON.stringify(tool.outputSchema ?? null)}\u0000${JSON.stringify(tool.annotations ?? null)}\u0000${tool.execution?.taskSupport ?? ''}\n`
  }
  return text
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
  } catch (error) {
    throw new Error(`无法校验当前模型路由：${errorMessage(error)}`)
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
    // The store must hand back exactly one durable reference per image: a short
    // array would otherwise project an `image` block with no attachment, which
    // the host cannot render and the model cannot see.
    if (!Array.isArray(refs) || refs.length !== decoded.length || refs.some((ref) => ref === undefined || ref === null)) {
      throw new Error(`附件存储返回了 ${Array.isArray(refs) ? refs.length : 0} 个引用，与图片数量 ${decoded.length} 不一致`)
    }
    const byIndex = new Map(imageIndexes.map((index, offset) => [index, refs[offset]]))
    return projectContent(content, toolName, (_block, index) => ({ type: 'image', attachment: byIndex.get(index) }))
  } catch (error) {
    const reason = `持久化图片存储拒绝了该结果：${errorMessage(error)}`
    return projectContent(content, toolName, (block) => ({ type: 'text', text: imageDiagnostic(block, reason) }))
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
  /** @type {number} bound on one connection attempt. */
  #connectTimeoutMs
  /** @type {ReturnType<typeof resolveToolFilter>} */
  #toolFilter
  /** How many advertised tools the filter hides. */
  #filteredCount = 0
  /** Per-server call counters, reported by {@link status}. */
  #metrics = { calls: 0, errors: 0, totalMs: 0, lastCallAt: 0, lastCallMs: 0, reconnects: 0 }
  /** @type {'idle'|'connecting'|'connected'|'reconnecting'|'error'} */
  #state = 'idle'
  /** @type {string} */
  #error = ''
  /** @type {import('@modelcontextprotocol/sdk/client/index.js').Client|undefined} */
  #client
  #clientClosed
  /**
   * Per-generation transport resources, keyed by the client that owns them.
   *
   * A `WeakMap` rather than a single field keeps teardown of a stale generation
   * from clobbering the live one: concurrent connect/close paths can otherwise
   * clear each other's transport and leak an HTTP session or a child process.
   * @type {WeakMap<object, {transport: object, detachStderr: () => void}>}
   */
  #resources = new WeakMap()
  /** @type {Map<string, () => void>} */
  #disposers = new Map()
  /** @type {Array<{rawName: string, publicName: string, description: string}>} */
  #tools = []
  /** The generation the current registrations call through; `undefined` means "not registered". */
  #toolsGeneration
  /** Structural fingerprint of the current registrations, for the no-op fast path. */
  #toolsFingerprint = ''
  /** The one notification-driven sync that consecutive notifications may share. */
  #coalescedSync
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
    this.#connectTimeoutMs = resolveConnectTimeout(
      definition.connectTimeoutMs,
      `mcp-manager(${definition.name}): connectTimeoutMs`,
    )
    this.#toolFilter = resolveToolFilter(definition.toolFilter, `mcp-manager(${definition.name}): toolFilter`)
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
   *
   * Tool rows are the bulk of a snapshot (a description per tool), and the
   * settings page only needs them for the one card the user expanded. Callers
   * that poll for state can therefore ask for the cheap shape and keep their
   * previously fetched rows; `toolCount` is always present.
   *
   * @param options - `includeTools: false` omits the `tools` array.
   * @returns a plain JSON-safe status object.
   */
  status(options = {}) {
    const includeTools = options.includeTools !== false
    return {
      name: this.name,
      transport: this.#definition.transport,
      enabled: this.enabled,
      target: this.target,
      definition: { ...this.#definition },
      state: this.#state,
      error: this.#error,
      toolCount: this.#tools.length,
      ...(includeTools ? { tools: this.#tools.map((tool) => ({ ...tool })) } : {}),
      startedAt: this.#startedAt,
      lastSyncAt: this.#lastSyncAt,
      timeoutMs: this.#definition.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
      connectTimeoutMs: this.#connectTimeoutMs,
      toolFilter: { allow: [...this.#toolFilter.allow], deny: [...this.#toolFilter.deny] },
      filteredToolCount: this.#filteredCount,
      metrics: {
        calls: this.#metrics.calls,
        errors: this.#metrics.errors,
        avgMs: this.#metrics.calls === 0 ? 0 : Math.round((this.#metrics.totalMs / this.#metrics.calls) * 10) / 10,
        lastCallMs: this.#metrics.lastCallMs,
        lastCallAt: this.#metrics.lastCallAt,
        reconnects: this.#metrics.reconnects,
      },
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
   *
   * A notification storm (one `tools/list_changed` per tool) must not become one
   * full `tools/list` round trip and registry swap per notification, so
   * notification-driven syncs may share the next queued refresh. The share ends
   * the moment that refresh starts fetching: anything that changes afterwards is a
   * new change and deserves its own pass. Manual refreshes never share.
   *
   * @param generation - the client whose tool list is read.
   * @param options - `coalesce: true` for notification-driven syncs.
   * @returns when this sync settled.
   */
  #enqueueSync(generation, options = {}) {
    const coalesce = options.coalesce === true
    if (coalesce && this.#coalescedSync !== undefined && this.#coalescedSync.generation === generation) {
      return this.#coalescedSync.run
    }
    const entry = { generation, run: undefined }
    const run = this.#syncChain.then(async () => {
      // This refresh is committed to reading the server now; later notifications
      // must not be folded into it.
      if (this.#coalescedSync === entry) this.#coalescedSync = undefined
      if (!this.#isCurrent(generation)) return
      await this.#syncTools(generation)
    })
    this.#syncChain = run.catch(() => {})
    entry.run = run
    if (coalesce) {
      this.#coalescedSync = entry
      const clear = () => {
        if (this.#coalescedSync === entry) this.#coalescedSync = undefined
      }
      run.then(clear, clear)
    }
    return run
  }

  /**
   * Read the server's tool list and swap it into `ctx.tools`.
   *
   * Fetch fully before touching the registry, then dispose the previous
   * generation and register the next one: a fetch failure leaves the previous
   * generation registered, and a registration conflict rolls the attempted
   * generation back so a server never contributes a partial tool set.
   *
   * When the same generation re-reads an unchanged list, nothing is swapped at
   * all: re-registering identical tools invalidates every tool view the host
   * derived from them for no behavioural gain, and is the common case behind a
   * `tools/list_changed` storm.
   *
   * @param generation - the connected client to read from.
   * @returns the number of registered tools.
   */
  async #syncTools(generation) {
    const listed = await listServerTools(generation)
    // The fetch is asynchronous: a generation swap, a stop, or disposal may have
    // landed while it was in flight. Registering then would publish tools bound
    // to a dead client and, after a stop, leave them behind the cleared disposers.
    if (!this.#isCurrent(generation)) return 0
    const fingerprint = listFingerprint(listed)
    if (this.#toolsGeneration === generation && fingerprint === this.#toolsFingerprint) {
      this.#lastSyncAt = Date.now()
      return this.#tools.length
    }
    const exposed = compileToolFilter(this.#toolFilter)
    const visible = listed.filter((tool) => exposed(tool.name))
    const definitions = new Map()
    const tools = []
    for (const tool of visible) {
      const publicName = publicToolName(this.name, tool.name)
      if (definitions.has(publicName)) throw new Error(`服务器重复列出了工具 "${tool.name}"：工具列表无效`)
      const description = typeof tool.description === 'string' ? tool.description : ''
      definitions.set(publicName, this.#toolDefinition(generation, tool, publicName, description))
      tools.push({ rawName: tool.name, publicName, description })
    }
    for (const dispose of this.#disposers.values()) dispose()
    this.#disposers = new Map()
    this.#toolsGeneration = undefined
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
    this.#filteredCount = listed.length - visible.length
    this.#toolsGeneration = generation
    this.#toolsFingerprint = fingerprint
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
        let result
        const startedAt = Date.now()
        /** Record one finished call, whether it failed on the wire or in the tool. */
        const record = (failed) => {
          const durationMs = Date.now() - startedAt
          this.#metrics.calls += 1
          if (failed) this.#metrics.errors += 1
          this.#metrics.lastCallAt = startedAt
          this.#metrics.lastCallMs = durationMs
          this.#metrics.totalMs += durationMs
        }
        try {
          result = await generation.request(
            { method: 'tools/call', params: { name: rawName, arguments: isRecord(args) ? args : {} } },
            RawCallToolResultSchema,
            { signal: exec?.signal, timeout: timeoutMs },
          )
        } catch (error) {
          record(true)
          throw this.#callFailure(generation, rawName, error, timeoutMs)
        }
        // A server-reported `isError` escapes as a thrown error below, so it is a
        // failed call for the server's health counters as well.
        record(result.isError === true)
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
   * Turn one failed `tools/call` into an error the model can act on.
   *
   * The SDK's own text ("Request timed out", "This operation was aborted",
   * `McpError` codes) does not say which tool, which server, or which state the
   * failure belongs to, and a bare abort drops the caller's cancellation reason.
   * The original text is always kept at the end so nothing is lost.
   *
   * @param generation - the generation the call ran on.
   * @param rawName - raw MCP tool name.
   * @param error - rejected value from the protocol request.
   * @param timeoutMs - the per-call timeout that was applied.
   * @returns the error to throw.
   */
  #callFailure(generation, rawName, error, timeoutMs) {
    const detail = errorMessage(error)
    const code = isRecord(error) ? error.code : undefined
    const timedOut = code === -32001 || /timed?\s?out|timeout/i.test(detail)
    if (timedOut) {
      return new Error(`mcp-manager(${this.name})：工具 "${rawName}" 在 ${timeoutMs}ms 内没有返回结果（${detail}）`)
    }
    const cancelled = (isRecord(error) && error.name === 'AbortError') || /abort/i.test(detail)
    if (cancelled) {
      const reason = errorMessage((isRecord(error) && error.cause) || '调用被取消')
      return new Error(`mcp-manager(${this.name})：工具 "${rawName}" 已被取消：${reason}`)
    }
    if (!this.#isCurrent(generation)) {
      return new Error(
        `mcp-manager(${this.name})：工具 "${rawName}" 未完成，服务器连接已断开（${this.#stateLabel()}）：${detail}`,
      )
    }
    return new Error(`mcp-manager(${this.name})：工具 "${rawName}" 调用失败：${detail}`)
  }

  /**
   * Start the supervised connection. Activation never blocks on a server: the
   * manager kicks this off in the background and the settings page reports the
   * outcome, so one unreachable server cannot stall the whole profile.
   * @returns when the first attempt settled (connected, failed, or retrying).
   */
  async start() {
    // A disabled definition must never connect: "刷新" on a disabled card would
    // otherwise spawn its process and register its tools while the settings page
    // keeps reporting "已禁用" (and the manager only starts enabled supervisors).
    if (this.#disposed || !this.enabled) return
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
    const generation = new Client({ name: 'dsh-mcp-manager', version: VERSION }, { capabilities: {} })
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
        await this.#enqueueSync(generation, { coalesce: true })
      } catch (error) {
        if (!this.#disposed) this.#ctx.logger.error('mcp-manager(%s): 工具重新同步失败: %s', this.name, errorMessage(error))
      }
    })
    let transport
    try {
      transport = createTransport(this.#definition)
      this.#resources.set(generation, {
        transport,
        detachStderr: this.#definition.transport === 'stdio' ? forwardStderr(transport, this.#ctx.logger, this.name) : () => {},
      })
      // The initialize handshake is the one request a silent server can hold
      // forever; the SDK forwards this option to it and closes the transport it
      // built itself when the request fails.
      await generation.connect(transport, { timeout: this.#connectTimeoutMs })
      if (closeObserved) {
        attemptSettled = true
        this.#generationDown(generation)
        return
      }
      await this.#enqueueSync(generation)
    } catch (error) {
      if (this.#isCurrent(generation)) {
        const detail = errorMessage(error)
        // A bounded handshake must say which bound it hit; "Request timed out"
        // alone cannot be told apart from a tool-call timeout.
        this.#error = /timed?\s?out|timeout/i.test(detail)
          ? `连接在 ${this.#connectTimeoutMs}ms 内没有完成（${detail}）`
          : detail
        this.#ctx.logger.warn('mcp-manager(%s): 连接尝试失败: %s', this.name, this.#error)
      }
      // Terminates an HTTP session (if one was created) before the abort signal
      // the SDK's close() raises would make that request impossible.
      const hadTransport = this.#resources.has(generation)
      await this.#closeGeneration(generation)
      // A failure before a transport existed (for example a definition that
      // cannot even build one) owns no close signal, so it must not wait for one.
      const quiesced = !hadTransport || closeObserved || (await this.#waitForClose(closed.promise))
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
      this.#metrics.reconnects += 1
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
   * Release one generation's transport-owned resources.
   *
   * Detaches the stderr tap first so a dying child's last words do not land in
   * the host log after the status already reported the outage.
   * @param generation - the generation being torn down.
   * @returns its transport, when one was recorded.
   */
  #releaseResources(generation) {
    const resources = this.#resources.get(generation)
    if (resources === undefined) return undefined
    this.#resources.delete(generation)
    try {
      resources.detachStderr()
    } catch {
      /* the stream is already gone */
    }
    return resources.transport
  }

  /**
   * Close one generation, terminating a Streamable-HTTP session first.
   *
   * The SDK's HTTP transport abort is local: `close()` never sends the `DELETE`
   * that ends the server-side session, so a reconnecting supervisor would leave
   * one server session behind per generation. The termination is best-effort and
   * bounded — a server that ignores `DELETE` must not delay teardown.
   * @param generation - the generation to close.
   * @returns when the transport was asked to close.
   */
  async #closeGeneration(generation) {
    const transport = this.#releaseResources(generation)
    if (transport !== undefined && typeof transport.terminateSession === 'function' && transport.sessionId !== undefined) {
      await settleWithin(
        transport.terminateSession().catch((error) => {
          this.#ctx.logger.warn('mcp-manager(%s): 终止 HTTP 会话失败: %s', this.name, errorMessage(error))
        }),
        HTTP_SESSION_TERMINATE_TIMEOUT_MS,
      )
    }
    try {
      await generation.close()
    } catch (error) {
      /* a transport that never connected owns nothing to close */
      this.#ctx.logger.debug('mcp-manager(%s): 关闭连接时出错: %s', this.name, errorMessage(error))
    }
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
    // The transport is already dead, so a `DELETE` is pointless here; only the
    // stderr tap is detached so the next generation starts with a clean listener.
    this.#releaseResources(generation)
    this.#scheduleReconnect()
  }

  /** Schedule the next connection attempt under the shared attempt budget. */
  #scheduleReconnect() {
    if (this.#disposed) return
    const lostEstablishedConnection = this.#connectedAt !== 0
    // The generic state text is what the settings page shows, so the cause that
    // produced it (spawn ENOENT, ECONNREFUSED, a handshake timeout) is kept in it
    // instead of being overwritten by "auto-reconnect is off".
    const detail = this.#error === '' ? '' : `（最近错误：${this.#error}）`
    if (!this.#policy.enabled) {
      this.#state = 'error'
      this.#error = lostEstablishedConnection
        ? `连接已断开，且未启用自动重连：工具会持续失败，直到重载插件或重启 Host${detail}`
        : `连接失败，且未启用自动重连：未注册任何工具，重载插件或重启 Host 后可重连${detail}`
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
      this.#error = `连续 ${this.#policy.maxAttempts} 次重连失败，已注销工具并停止重连：重载插件或重启 Host 后可重连${detail}`
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
    if (!this.enabled) return 0
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
      await this.#closeGeneration(current)
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
    this.#toolsGeneration = undefined
    this.#toolsFingerprint = ''
    this.#coalescedSync = undefined
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
 * Every step is bounded: the handshake by `connectTimeoutMs` (a server that never
 * answers must not hold the RPC — and the form's "连接中…" state — forever), the
 * tool list by the same request timeout the runtime bridge uses. The transport is
 * closed on every path, including a failed handshake, so a probe never leaves a
 * child process or an HTTP session behind.
 *
 * @param definition - normalized server definition.
 * @param options - optional `logger` for a stdio child's stderr tap.
 * @returns the tool rows the server advertises.
 * @throws when the connection or the tool listing fails.
 */
export async function probeServer(definition, options = {}) {
  const timeoutMs = resolveConnectTimeout(definition.connectTimeoutMs, `mcp-manager(${definition.name}): connectTimeoutMs`)
  const logger = options.logger ?? { debug() {}, info() {}, warn() {}, error() {} }
  const client = new Client({ name: 'dsh-mcp-manager-probe', version: VERSION }, { capabilities: {} })
  const transport = createTransport(definition)
  const detachStderr = definition.transport === 'stdio' ? forwardStderr(transport, logger, definition.name) : () => {}
  try {
    try {
      await client.connect(transport, { timeout: timeoutMs })
    } catch (error) {
      throw new Error(`无法在 ${timeoutMs}ms 内连接到 ${definition.transport} 服务器：${errorMessage(error)}`)
    }
    let listed
    try {
      listed = await listServerTools(client)
    } catch (error) {
      throw new Error(`已连接，但读取工具列表失败：${errorMessage(error)}`)
    }
    return listed.map((tool) => ({
      rawName: tool.name,
      publicName: publicToolName(definition.name, tool.name),
      description: typeof tool.description === 'string' ? tool.description : '',
    }))
  } finally {
    detachStderr()
    if (typeof transport.terminateSession === 'function' && transport.sessionId !== undefined) {
      await settleWithin(transport.terminateSession().catch(() => {}), HTTP_SESSION_TERMINATE_TIMEOUT_MS)
    }
    try {
      await client.close()
    } catch {
      /* probe teardown is best-effort */
    }
  }
}
