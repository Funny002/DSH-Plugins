/**
 * `dsh-mcp-manager` — host half.
 *
 * A profile-plane row with three jobs:
 *
 * 1. **Connect.** It owns one `McpServerSupervisor` per configured server
 *    (stdio or Streamable HTTP) and publishes each server's tools on
 *    `ctx.tools` under the pinned `mcp__<serverName>__<rawName>` contract.
 * 2. **Persist.** Every settings-page change is written into this row's own
 *    config inside the profile's `cordis.patch.yml`, so the definition set is
 *    restored on the next launch and the running tree hot-swaps the row
 *    (the `web` profile runs with `patchReload: live`) as soon as the file
 *    lands.
 * 3. **Answer.** It provides the `mcpManager` service and an authenticated
 *    `/mcp-manager` RPC channel on `ctx.connection`, which is how the browser
 *    settings page reads status and mutates the server set.
 *
 * The class is registered as a Cordis `Service`, so HMR disposal and
 * re-registration are automatic: a hot swap disposes the old instance —
 * closing every MCP connection and unregistering every bridged tool — and the
 * replacement reconnects from the freshly patched config.
 *
 * The managed block adapts to how the row was mounted: when this plugin's own
 * `dsh.bundle` layer put the row in the tree (the `dsh plugin add` install), the
 * block only retargets the existing row by id; when the row exists because the
 * block itself inserted it (a loose copy under the profile), the block keeps
 * creating it. See `./patch-file.js`.
 *
 * @module dsh-mcp-manager
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
import { serveChannelRequest } from './channel.js'
import { errorMessage, isRecord } from './naming.js'
import {
  DEFAULT_ROW_NAME,
  ROW_ID,
  discoverPatchFile,
  readManagedRowName,
  writeManagedServers,
} from './patch-file.js'
import {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  McpServerSupervisor,
  RECONNECT_DEFAULTS,
  probeServer,
  resolveReconnectPolicy,
} from './supervisor.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-manager'
/** Services required before this plugin activates. */
export const inject = ['tools']
/** Absolute RPC channel the browser settings page calls. */
export const CHANNEL = '/mcp-manager'
/** Valid server namespace, kept inside the public tool-name budget. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
/** Shortest usable numeric config value. */
const MIN_TIMEOUT_MS = 1
/** This module's own path, used to tell "our block inserted the row" from "a bundle did". */
const SELF_MODULE_PATH = fileURLToPath(import.meta.url)

/**
 * Reconnect policy for one server. Every bound is re-validated by
 * {@link resolveReconnectPolicy} so a hand-written patch entry cannot smuggle in
 * a zero-delay retry storm.
 */
const ReconnectSchema = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().default(RECONNECT_DEFAULTS.maxAttempts),
})

const StdioServerSchema = z.object({
  name: z.string().required().pattern(SERVER_NAME_PATTERN),
  enabled: z.boolean().default(true),
  transport: z.const('stdio'),
  command: z.string().required(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  cwd: z.string().default(''),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  reconnect: ReconnectSchema,
})

const StreamableHttpServerSchema = z.object({
  name: z.string().required().pattern(SERVER_NAME_PATTERN),
  enabled: z.boolean().default(true),
  transport: z.const('streamable-http'),
  url: z.string().required(),
  headers: z.dict(String).default({}),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  reconnect: ReconnectSchema,
})

/** One managed MCP server, discriminated on `transport`. */
export const ServerSchema = z.union([StdioServerSchema, StreamableHttpServerSchema])

/** Row configuration: the server list this row owns plus an optional path pin. */
export const Config = z.object({
  servers: z.array(ServerSchema).default([]),
  /**
   * Absolute path of the profile patch file to write. Empty means "discover it
   * from the Loader's root include", which is correct for every profile.
   */
  patchFile: z.string().default(''),
})

/**
 * Coerce one untrusted value into a string list.
 * @param value - candidate array (or a newline-separated string).
 * @returns the string list.
 */
function toStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string' && value.trim() !== '') return value.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return []
}

/**
 * Coerce one untrusted value into a string map.
 * @param value - candidate object of scalar values.
 * @returns a fresh string map.
 */
function toStringMap(value) {
  if (!isRecord(value)) return {}
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue
    result[String(key)] = String(item)
  }
  return result
}

/**
 * Normalize one reconnect policy from untrusted input.
 *
 * Unknown keys are dropped here (the write path must produce exactly what the
 * schema accepts), while out-of-range values are kept and rejected by
 * {@link resolveReconnectPolicy} when the supervisor is built — so a bad policy
 * fails loudly instead of being silently corrected.
 * @param input - untrusted `reconnect` value.
 * @returns the normalized policy object.
 */
export function normalizeReconnect(input) {
  const source = isRecord(input) ? input : {}
  const number = (key) => {
    const raw = source[key]
    if (raw === undefined || raw === null) return RECONNECT_DEFAULTS[key]
    const value = Number(raw)
    return Number.isFinite(value) ? value : RECONNECT_DEFAULTS[key]
  }
  return {
    enabled: source.enabled === undefined ? RECONNECT_DEFAULTS.enabled : source.enabled !== false,
    initialDelayMs: number('initialDelayMs'),
    maxDelayMs: number('maxDelayMs'),
    maxAttempts: number('maxAttempts'),
  }
}

/**
 * Validate and normalize one server definition.
 *
 * Unknown fields are dropped, so what the settings page writes back is exactly
 * what the row schema accepts on the next launch.
 * @param input - untrusted definition from config or RPC payload.
 * @returns the normalized definition.
 * @throws when a required field is missing or malformed.
 */
export function normalizeServer(input) {
  if (!isRecord(input)) throw new Error('服务器定义必须是一个对象')
  const serverName = String(input.name ?? '').trim()
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`服务器名称 ${JSON.stringify(serverName)} 无效：只能使用 1-32 个字母、数字、下划线或连字符`)
  }
  const timeout = Number.isFinite(Number(input.toolCallTimeoutMs))
    ? Math.max(MIN_TIMEOUT_MS, Math.trunc(Number(input.toolCallTimeoutMs)))
    : DEFAULT_TOOL_CALL_TIMEOUT_MS
  const enabled = input.enabled !== false
  const reconnect = normalizeReconnect(input.reconnect)
  if (input.transport === 'streamable-http') {
    let url = String(input.url ?? '').trim()
    if (url === '') throw new Error(`服务器 "${serverName}"：streamable-http 必须填写地址（url）`)
    // `localhost:3000/mcp` and `127.0.0.1:8931/mcp` are what people type; only a
    // missing scheme is filled in, and the normalized value is what gets stored.
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) url = `http://${url}`
    try {
      void new URL(url)
    } catch {
      throw new Error(`服务器 "${serverName}"：${JSON.stringify(url)} 不是合法的 URL`)
    }
    return {
      name: serverName,
      enabled,
      transport: 'streamable-http',
      url,
      headers: toStringMap(input.headers),
      toolCallTimeoutMs: timeout,
      reconnect,
    }
  }
  if (input.transport !== 'stdio') {
    throw new Error(`服务器 "${serverName}"：传输方式必须是 "stdio" 或 "streamable-http"`)
  }
  const command = String(input.command ?? '').trim()
  if (command === '') throw new Error(`服务器 "${serverName}"：stdio 必须填写命令（command）`)
  return {
    name: serverName,
    enabled,
    transport: 'stdio',
    command,
    args: toStringArray(input.args),
    env: toStringMap(input.env),
    cwd: String(input.cwd ?? ''),
    toolCallTimeoutMs: timeout,
    reconnect,
  }
}

/**
 * Duplicate-name check with a message the settings page can show verbatim.
 * @param servers - normalized definitions.
 */
function assertUniqueNames(servers) {
  const seen = new Set()
  for (const server of servers) {
    if (seen.has(server.name)) throw new Error(`服务器 "${server.name}" 已存在：名称必须唯一`)
    seen.add(server.name)
  }
}

/**
 * Decide how the managed block must address this row.
 *
 * `insert` means the block is what mounts the row (a loose copy under the
 * profile). `override` means some other layer already mounts it — in practice
 * this plugin's own `dsh.bundle` patch, installed with `dsh plugin add` — so
 * repeating the row would mount it twice and the block may only retarget it.
 *
 * The test is the composed loader entry's own specifier: when it resolves to
 * *this* module, the row came from the block; anything else (a bare package
 * specifier, another path) came from a different layer.
 *
 * @param ctx - host plugin context carrying the Loader service.
 * @returns the mode the next write must use.
 */
export function resolveManagedMode(ctx) {
  const loader = ctx.get('loader')
  if (loader === undefined || typeof loader.entries !== 'function') return 'insert'
  for (const entry of loader.entries()) {
    const options = entry.options ?? {}
    if (options.id !== ROW_ID) continue
    const specifier = options.name
    if (typeof specifier !== 'string') continue
    if (!specifier.startsWith('file:')) return 'override'
    let path
    try {
      path = fileURLToPath(specifier)
    } catch {
      continue
    }
    return path.toLowerCase() === SELF_MODULE_PATH.toLowerCase() ? 'insert' : 'override'
  }
  return 'insert'
}

/**
 * The `mcpManager` service: live supervisors plus the persisted definition set.
 */
export class McpManager extends Service {
  /*
   * State lives in ordinary fields, not `#private` ones: Cordis hands a service
   * to other fibers through a tracked proxy, and an ECMAScript private field
   * rejects a receiver that is not the exact instance — so `ctx.mcpManager`
   * would read fine but calling any method on it would throw. Shipped services
   * (for example Connection's own) follow the same convention.
   */
  /** @type {object[]} normalized server definitions currently persisted. */
  definitions
  /** @type {Map<string, McpServerSupervisor>} live supervisors, keyed by server name. */
  supervisors = new Map()
  /** @type {number} changes on every persisted mutation; the settings page polls it across a hot swap. */
  generation
  /** @type {string} absolute path of the profile patch file, or `''` when it could not be resolved. */
  patchFile
  /** @type {string} explicit `patchFile` from the row config, kept when writing the block back. */
  patchFilePinned
  /** @type {'insert'|'override'} how the managed block addresses this row. */
  managedMode
  /**
   * Registration state of the browser RPC channel. It is reported in every
   * snapshot so the settings page (and a host-side probe) can tell "the plugin
   * is mounted but its channel is not" apart from "the profile has no browser
   * transport at all".
   * @type {{path: string, state: 'pending'|'registered'|'failed'|'unavailable', error: string}}
   */
  channel = { path: CHANNEL, state: 'pending', error: '' }

  /**
   * @param ctx - host plugin context carrying `tools` and (usually) `connection`.
   * @param config - resolved row config.
   */
  constructor(ctx, config) {
    super(ctx, 'mcpManager')
    this.definitions = (config.servers ?? []).map((server) => normalizeServer(server))
    assertUniqueNames(this.definitions)
    // Fail the row here rather than starting a server with a broken policy.
    for (const definition of this.definitions) {
      resolveReconnectPolicy(definition.reconnect, `mcp-manager(${definition.name}): reconnect`)
    }
    this.patchFilePinned = config.patchFile === undefined ? '' : String(config.patchFile)
    this.patchFile = this.patchFilePinned === '' ? discoverPatchFile(ctx) : this.patchFilePinned
    this.managedMode = resolveManagedMode(ctx)
    this.generation = Date.now()
    for (const definition of this.definitions) this.adoptServer(definition)
    this.ctx.logger.info(
      'mcp-manager: %d server(s) configured, %d enabled, patch layer %s (%s mode)',
      this.definitions.length,
      this.definitions.filter((server) => server.enabled !== false).length,
      this.patchFile === '' ? '(not found — persistence disabled)' : this.patchFile,
      this.managedMode,
    )
  }

  /** Create a supervisor for one definition and start it unless disabled. */
  adoptServer(definition) {
    const policy = resolveReconnectPolicy(definition.reconnect, `mcp-manager(${definition.name}): reconnect`)
    const supervisor = new McpServerSupervisor(this.ctx, definition, policy)
    this.supervisors.set(definition.name, supervisor)
    if (definition.enabled !== false) void supervisor.start()
  }

  /**
   * Live runtime state for every configured server.
   * @returns a plain JSON-safe snapshot (the RPC `state` payload).
   */
  list() {
    const servers = [...this.supervisors.values()].map((supervisor) => {
      const status = supervisor.status()
      if (status.enabled) return status
      return {
        ...status,
        state: 'disabled',
        error: '',
        toolCount: 0,
        tools: [],
        startedAt: 0,
        lastSyncAt: 0,
        reconnect: { ...status.reconnect, attempts: 0, nextRetryAt: 0 },
      }
    })
    servers.sort((left, right) => left.name.localeCompare(right.name))
    return {
      generation: this.generation,
      rowId: ROW_ID,
      patchMode: this.managedMode,
      channel: { ...this.channel },
      patchFile: this.patchFile,
      persistence: { writable: this.patchFile !== '', patchFile: this.patchFile, mode: this.managedMode },
      servers,
      totals: {
        servers: servers.length,
        enabled: this.definitions.filter((definition) => definition.enabled !== false).length,
        connected: servers.filter((server) => server.state === 'connected').length,
        reconnecting: servers.filter((server) => server.state === 'reconnecting').length,
        tools: servers.reduce((total, server) => total + server.toolCount, 0),
      },
    }
  }

  /**
   * Tool inventory of one server, or of every server when no name is given.
   * @param serverName - optional server namespace.
   * @returns tool rows with their model-facing names.
   */
  tools(serverName) {
    const rows = []
    for (const supervisor of this.supervisors.values()) {
      if (serverName !== undefined && serverName !== '' && supervisor.name !== serverName) continue
      for (const tool of supervisor.status().tools) rows.push({ server: supervisor.name, ...tool })
    }
    return { tools: rows }
  }

  /**
   * Persist a new definition set and apply it to the running generation.
   *
   * The file write is the durable half: `cordis.patch.yml` is watched by the
   * profile launcher, so the row hot-swaps and every server reconnects from the
   * patched config. Applying the same change to the live supervisors keeps the
   * current generation truthful even on a surface without live patch reload.
   * @param next - the complete next definition list.
   * @returns the write receipt plus the refreshed snapshot.
   */
  async commit(next) {
    assertUniqueNames(next)
    if (this.patchFile === '') {
      throw new Error(
        '无法持久化：没有找到 profile 的 patch 文件。请在 mcp-manager 行的 config 里显式设置 patchFile，或在 profile 目录中运行本插件。',
      )
    }
    // Re-read how the row is mounted rather than trusting the value cached at
    // activation: writing `insert` for a row a bundle already provides would
    // mount it twice on the next launch.
    this.managedMode = resolveManagedMode(this.ctx)
    writeManagedServers(this.patchFile, next, {
      mode: this.managedMode,
      rowName: this.managedMode === 'insert' ? readManagedRowName(this.patchFile) : DEFAULT_ROW_NAME,
      patchFile: this.patchFilePinned,
    })
    this.definitions = next
    this.generation = Date.now()
    await this.applyRuntime(next)
    return {
      persisted: true,
      patchFile: this.patchFile,
      mode: this.managedMode,
      generation: this.generation,
      reloading: true,
      snapshot: this.list(),
    }
  }

  /**
   * Bring live supervisors in line with a just-persisted definition set.
   *
   * A supervisor's identity is its exact definition: any change — including a
   * plain enable/disable toggle — retires the old supervisor (closing its
   * connection and unregistering its tools) and adopts a fresh one, so the
   * status page can never report a stale definition.
   */
  async applyRuntime(next) {
    const wanted = new Map(next.map((definition) => [definition.name, definition]))
    for (const [serverName, supervisor] of [...this.supervisors]) {
      const definition = wanted.get(serverName)
      if (definition !== undefined && JSON.stringify(supervisor.definition) === JSON.stringify(definition)) continue
      this.supervisors.delete(serverName)
      await supervisor.dispose()
    }
    for (const definition of next) {
      if (this.supervisors.has(definition.name)) continue
      this.adoptServer(definition)
    }
  }

  /**
   * Add one server definition.
   * @param input - untrusted definition.
   * @returns the write receipt.
   */
  async add(input) {
    const definition = normalizeServer(input)
    if (this.definitions.some((server) => server.name === definition.name)) {
      throw new Error(`服务器 "${definition.name}" 已存在：请换一个名称，或直接编辑该服务器`)
    }
    return this.commit([...this.definitions, definition])
  }

  /**
   * Replace one server definition, supporting rename.
   * @param serverName - current server name.
   * @param input - the complete next definition.
   * @returns the write receipt.
   */
  async update(serverName, input) {
    const current = this.definitions.find((server) => server.name === serverName)
    if (current === undefined) throw new Error(`没有名为 "${serverName}" 的服务器`)
    const definition = normalizeServer(isRecord(input) && input.name === undefined ? { ...input, name: serverName } : input)
    const next = this.definitions.map((server) => (server.name === serverName ? definition : server))
    return this.commit(next)
  }

  /**
   * Remove one server definition.
   * @param serverName - server name.
   * @returns the write receipt.
   */
  async remove(serverName) {
    if (!this.definitions.some((server) => server.name === serverName)) throw new Error(`没有名为 "${serverName}" 的服务器`)
    return this.commit(this.definitions.filter((server) => server.name !== serverName))
  }

  /**
   * Enable or disable one server, keeping its definition.
   * @param serverName - server name.
   * @param enabled - next enablement.
   * @returns the write receipt.
   */
  async setEnabled(serverName, enabled) {
    if (!this.definitions.some((server) => server.name === serverName)) throw new Error(`没有名为 "${serverName}" 的服务器`)
    const next = this.definitions.map((server) => (server.name === serverName ? { ...server, enabled: enabled !== false } : server))
    return this.commit(next)
  }

  /**
   * Re-fetch tool lists without touching the definition set.
   *
   * On a server that is down this also revives it: the supervisor starts a
   * fresh connection, which is how the settings page pulls a server out of
   * "gave up reconnecting" without a config change.
   * @param serverName - optional single server.
   * @returns the refreshed snapshot.
   */
  async refresh(serverName) {
    for (const supervisor of this.supervisors.values()) {
      if (serverName !== undefined && serverName !== '' && supervisor.name !== serverName) continue
      try {
        await supervisor.refreshTools()
      } catch (error) {
        this.ctx.logger.warn('mcp-manager(%s): tool refresh failed: %s', supervisor.name, errorMessage(error))
      }
    }
    return this.list()
  }

  /**
   * Connect to a candidate definition without persisting or registering tools.
   * @param input - untrusted definition.
   * @returns the tool list the server advertises.
   */
  async probe(input) {
    const definition = normalizeServer(input)
    const tools = await probeServer(definition)
    return { name: definition.name, toolCount: tools.length, tools }
  }

  /** Dispose every supervisor and close every MCP connection. */
  async dispose() {
    const supervisors = [...this.supervisors.values()]
    this.supervisors.clear()
    await Promise.all(supervisors.map((supervisor) => supervisor.dispose()))
  }

  /**
   * Dispatch one RPC endpoint.
   * @param endpoint - channel-relative endpoint name.
   * @param payload - decoded JSON payload.
   * @returns the endpoint result envelope's value.
   */
  async dispatch(endpoint, payload) {
    const args = isRecord(payload) ? payload : {}
    switch (endpoint) {
      case 'state':
        return this.list()
      case 'add':
        return this.add(args.definition ?? args)
      case 'update':
        return this.update(String(args.name ?? ''), args.definition ?? args)
      case 'remove':
        return this.remove(String(args.name ?? ''))
      case 'setEnabled':
        return this.setEnabled(String(args.name ?? ''), args.enabled !== false)
      case 'start':
        return this.setEnabled(String(args.name ?? ''), true)
      case 'stop':
        return this.setEnabled(String(args.name ?? ''), false)
      case 'refresh':
        return this.refresh(typeof args.name === 'string' ? args.name : undefined)
      case 'tools':
        return this.tools(typeof args.name === 'string' ? args.name : undefined)
      case 'probe':
        return this.probe(args.definition ?? args)
      default:
        throw new Error(`未知的接口 ${JSON.stringify(endpoint)}`)
    }
  }
}

/**
 * Plugin entry: build the manager (which connects immediately), answer the
 * browser channel, and release every connection with the fiber.
 * @param ctx - host plugin context.
 * @param config - resolved row config.
 */
export function apply(ctx, config) {
  const manager = new McpManager(ctx, config)
  ctx.effect(
    () => () => manager.dispose(),
    'mcp-manager: MCP connections and bridged tools',
  )
  /*
   * The channel route is registered directly on the web server rather than
   * through `ctx.connection.rpc.handle`: Connection hosts one interceptor on the
   * shared `/api` channel and the Typert gateway already owns it, and its
   * per-channel route registration resolves `webServer` through the service's own
   * bound context. A prefix route plus `connection.requestRejection` is the same
   * shape the gateway uses for its Remote-stream upgrade route, and the envelope
   * it speaks is Connection's, so the browser half still calls
   * `ctx.connection.rpc.call(CHANNEL, …)`.
   */
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    try {
      const connection = webCtx.connection
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: 'prefix',
            path: CHANNEL,
            handler: (req, res) => {
              void serveChannelRequest(
                {
                  channel: CHANNEL,
                  connection,
                  dispatch: (endpoint, payload) => manager.dispatch(endpoint, payload),
                },
                req,
                res,
              )
            },
          }),
        `dsh-mcp-manager: ${CHANNEL} RPC route`,
      )
      manager.channel.state = 'registered'
      manager.channel.error = ''
      webCtx.logger.info('mcp-manager: browser channel %s is live', CHANNEL)
    } catch (error) {
      manager.channel.state = 'failed'
      manager.channel.error = errorMessage(error)
      ctx.logger.error('mcp-manager: browser channel %s could not be registered: %s', CHANNEL, manager.channel.error)
    }
  })
}
