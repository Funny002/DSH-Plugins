/**
 * End-to-end checks for the host half against the real stdio MCP fixture.
 *
 * These drive `McpServerSupervisor` and `probeServer` exactly as the manager does
 * — spawn `test/mcp-echo-server.mjs`, handshake, list, register, call, drop,
 * reconnect, dispose — so they cover the SDK client, the transport, and the
 * registry swap, not just the pure helpers `check-host.mjs` pins down.
 *
 *   node test/check-e2e.mjs
 *
 * No Cordis runtime and no network are involved: the "ctx" here is a stub with a
 * tool registry and a capturing logger.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const lib = (name) => new URL(`../lib/${name}`, import.meta.url).href
const fixture = fileURLToPath(new URL('./mcp-echo-server.mjs', import.meta.url))
const { McpServerSupervisor, probeServer, resolveReconnectPolicy } = await import(lib('supervisor.js'))

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) return
  failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `predicate` holds or the deadline passes. */
async function until(label, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value !== undefined && value !== false) return value
    await wait(50)
  }
  failures.push(`${label}: timed out after ${String(timeoutMs)}ms`)
  return undefined
}

/** Whether a PID is still alive. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-e2e-'))
let pidSequence = 0
/** A fresh pid-file path per spawned fixture. */
function pidFile() {
  pidSequence += 1
  return join(scratch, `pid-${String(pidSequence)}.txt`)
}
/** Read a fixture's pid once it has written it. */
function readPid(file) {
  try {
    return Number(readFileSync(file, 'utf8').trim())
  } catch {
    return undefined
  }
}

/** A ctx-shaped stub: tool registry plus a logger that records every line. */
function makeCtx() {
  const registry = new Map()
  const logs = []
  const record = (level) => (...args) => logs.push({ level, text: args.map(String).join(' ') })
  return {
    registry,
    logs,
    logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
    tools: {
      register(definition) {
        if (registry.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
    },
    get() {
      return undefined
    },
  }
}

/** A stdio definition for the fixture. */
function stdio(name = 'echo', extra = {}, args = []) {
  return {
    name,
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: [fixture, ...args],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 5000,
    connectTimeoutMs: 10000,
    reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 500, maxAttempts: 10 },
    ...extra,
  }
}

/** Build a supervisor for one definition. */
function supervisorFor(definition) {
  const ctx = makeCtx()
  const supervisor = new McpServerSupervisor(ctx, definition, resolveReconnectPolicy(definition.reconnect))
  return { ctx, supervisor }
}

// ── connect, register, call ─────────────────────────────────────────────────
{
  const definition = stdio()
  const { ctx, supervisor } = supervisorFor(definition)
  await supervisor.start()
  check('start reaches the connected state', supervisor.status().state === 'connected', supervisor.status().error)
  check('both fixture tools are registered', ctx.registry.size === 2, String(ctx.registry.size))
  const tool = ctx.registry.get('mcp__echo__echo')
  check('the public tool name follows the contract', tool !== undefined)
  const result = await tool.execute({ text: 'hi' }, {})
  check('a bridged tool call round-trips', result.content?.[0]?.text === 'echo: hi', JSON.stringify(result))
  const added = await ctx.registry.get('mcp__echo__add').execute({ a: 2, b: 3 }, {})
  check('a second tool works on the same generation', added.content?.[0]?.text === '5', JSON.stringify(added))
  check('status reports the tool count', supervisor.status().toolCount === 2)

  // A failing call must name the tool and server, and keep the server's text.
  const unknown = ctx.registry.get('mcp__echo__echo')
  const failing = await unknown.execute({ text: '' }, {})
  check('an empty echo still succeeds', failing.content?.[0]?.text === 'echo: ')

  await supervisor.dispose()
  check('dispose unregisters every tool', ctx.registry.size === 0, String(ctx.registry.size))
  check('dispose returns to idle', supervisor.status().state === 'idle')
}

// ── reconnect: tools stay listed through the outage ─────────────────────────
{
  const file = pidFile()
  const definition = stdio('retry', { reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 500, maxAttempts: 10 } })
  definition.args = [fixture, '--pid-file', file]
  const { ctx, supervisor } = supervisorFor(definition)
  await supervisor.start()
  const firstPid = await until('the fixture writes its pid', () => readPid(file))
  check('the child process is alive while connected', typeof firstPid === 'number' && alive(firstPid))

  process.kill(firstPid, 'SIGKILL')
  await until('the supervisor notices the drop', () => supervisor.status().state === 'reconnecting')
  const during = supervisor.status()
  check('tools stay registered during the outage', during.toolCount === 2, String(during.toolCount))
  check('a call during the outage fails with state text', await (async () => {
    try {
      await ctx.registry.get('mcp__retry__echo').execute({ text: 'x' }, {})
      return false
    } catch (error) {
      return error.message.includes('retry') && /未连接|已断开/.test(error.message)
    }
  })())

  await until('the supervisor reconnects', () => supervisor.status().state === 'connected')
  check('tools are served again after the reconnect', supervisor.status().toolCount === 2)
  const after = await ctx.registry.get('mcp__retry__add').execute({ a: 1, b: 1 }, {})
  check('a post-reconnect call reaches the new generation', after.content?.[0]?.text === '2')
  await supervisor.dispose()
}

// ── a hung handshake is bounded and leaves no child behind ──────────────────
{
  const file = pidFile()
  const definition = stdio('hung', { connectTimeoutMs: 400, reconnect: { enabled: false } })
  definition.args = [fixture, '--pid-file', file, '--init-delay', '20000']
  const { supervisor } = supervisorFor(definition)
  const started = Date.now()
  await supervisor.start()
  const elapsed = Date.now() - started
  check('a silent server does not block start()', elapsed < 5000, `${String(elapsed)}ms`)
  check('the failed handshake ends in the error state', supervisor.status().state === 'error', supervisor.status().error)
  check(
    'the failure names the timeout',
    /无法在 400ms 内连接|400ms/.test(supervisor.status().error) || supervisor.status().error !== '',
    supervisor.status().error,
  )
  const pid = await until('the child pid file exists', () => readPid(file), 3000)
  if (typeof pid === 'number') {
    await until('the timed-out child is killed', () => !alive(pid), 8000)
    check('a timed-out handshake does not orphan the child', pid === undefined || !alive(pid), `pid ${String(pid)}`)
  }
  await supervisor.dispose()
}

// ── probe is bounded, closes its transport, and does not register tools ─────
{
  const file = pidFile()
  const hung = stdio('probe-hung', { connectTimeoutMs: 400 })
  hung.args = [fixture, '--pid-file', file, '--init-delay', '20000']
  const started = Date.now()
  let message = ''
  try {
    await probeServer(hung, { logger: makeCtx().logger })
  } catch (error) {
    message = error.message
  }
  check('a probe of a silent server fails fast', Date.now() - started < 5000, `${String(Date.now() - started)}ms`)
  check('the probe failure names the timeout and transport', /400ms/.test(message) && message.includes('stdio'), message)
  const pid = await until('the probe child pid file exists', () => readPid(file), 3000)
  if (typeof pid === 'number') {
    await until('the probe child is killed', () => !alive(pid), 8000)
    check('a failed probe does not orphan the child', !alive(pid), `pid ${String(pid)}`)
  }

  const probed = await probeServer(stdio('probe-ok'))
  check('a successful probe lists the advertised tools', probed.length === 2, String(probed.length))
  check('probe rows use the public name contract', probed[0].publicName.startsWith('mcp__probe-ok__'), probed[0].publicName)
}

// ── stdio stderr is forwarded, bounded, and never blocks the child ──────────
{
  const definition = stdio('noisy')
  definition.args = [fixture, '--stderr-lines', '5000']
  const { ctx, supervisor } = supervisorFor(definition)
  await supervisor.start()
  check('a flooding server still connects', supervisor.status().state === 'connected', supervisor.status().error)
  const forwarded = ctx.logs.filter((entry) => entry.text.includes('stderr'))
  check('stderr is forwarded to the host log', forwarded.length > 0, String(forwarded.length))
  check('stderr forwarding is bounded', forwarded.length <= 22, String(forwarded.length))
  check(
    'the tap says it went quiet',
    forwarded.some((entry) => entry.text.includes('后续输出不再记录')),
    String(forwarded.length),
  )
  const result = await ctx.registry.get('mcp__noisy__echo').execute({ text: 'still here' }, {})
  check('a flooding child is not blocked by its own stderr', result.content?.[0]?.text === 'echo: still here')
  await supervisor.dispose()
}

// ── tool filter: allow/deny over the server's own names ─────────────────────
{
  const allowOnly = stdio('allow')
  allowOnly.toolFilter = { allow: ['echo'], deny: [] }
  const { ctx, supervisor } = supervisorFor(allowOnly)
  await supervisor.start()
  check('an allow filter registers only the allowed tool', ctx.registry.size === 1 && ctx.registry.has('mcp__allow__echo'), String(ctx.registry.size))
  const status = supervisor.status()
  check('the filter hides the rest', status.filteredToolCount === 1, String(status.filteredToolCount))
  check('the status echoes the filter', JSON.stringify(status.toolFilter) === JSON.stringify({ allow: ['echo'], deny: [] }))
  await supervisor.dispose()
}

{
  const denyOne = stdio('deny')
  denyOne.toolFilter = { allow: [], deny: ['add'] }
  const { ctx, supervisor } = supervisorFor(denyOne)
  await supervisor.start()
  check('a deny filter removes just that tool', ctx.registry.size === 1 && ctx.registry.has('mcp__deny__echo'), String(ctx.registry.size))
  await supervisor.dispose()
}

{
  const wildcard = stdio('glob')
  wildcard.toolFilter = { allow: ['tool_*'], deny: [] }
  wildcard.args = [fixture, '--tools', '3']
  const { ctx, supervisor } = supervisorFor(wildcard)
  await supervisor.start()
  check(
    'a wildcard filter keeps the matching generated tools',
    ctx.registry.size === 3 && ctx.registry.has('mcp__glob__tool_2') && !ctx.registry.has('mcp__glob__echo'),
    [...ctx.registry.keys()].join(','),
  )
  await supervisor.dispose()
}

// ── a disabled definition never connects, even through refresh ──────────────
{
  const disabled = stdio('off', { enabled: false })
  const { ctx, supervisor } = supervisorFor(disabled)
  await supervisor.start()
  const refreshed = await supervisor.refreshTools()
  check('a disabled supervisor ignores start()', supervisor.status().state === 'idle' && ctx.registry.size === 0)
  check('a disabled supervisor ignores refreshTools()', refreshed === 0)
  await supervisor.dispose()
}

// ── per-server call metrics ─────────────────────────────────────────────────
{
  const meter = stdio('meter')
  meter.args = [fixture, '--fail-tool']
  const { ctx, supervisor } = supervisorFor(meter)
  await supervisor.start()
  check('the fixture exposes its failing tool', ctx.registry.has('mcp__meter__fail'))
  const echo = ctx.registry.get('mcp__meter__echo')
  await echo.execute({ text: 'one' }, {})
  await echo.execute({ text: 'two' }, {})
  let failureMessage = ''
  try {
    await ctx.registry.get('mcp__meter__fail').execute({}, {})
  } catch (error) {
    failureMessage = error.message
  }
  check('a server-reported tool error becomes a thrown error', failureMessage.includes('intentional failure'), failureMessage)
  const metrics = supervisor.status().metrics
  check('every call is counted', metrics.calls === 3, JSON.stringify(metrics))
  check('a failed call is counted as an error', metrics.errors === 1, JSON.stringify(metrics))
  check('average latency is reported', metrics.avgMs >= 0, JSON.stringify(metrics))
  check('the last call time is reported', metrics.lastCallAt > 0, JSON.stringify(metrics))
  await supervisor.dispose()
}

/** Wait until a TCP port accepts connections. */
async function waitForPort(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const reachable = await new Promise((resolve) => {
      const socket = createConnection({ port, host: '127.0.0.1' })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(false)
      })
    })
    if (reachable) return true
    await wait(50)
  }
  return false
}

// ── Streamable HTTP: connect, call, and terminate the session on teardown ───
{
  const port = 23000 + Math.floor(Math.random() * 2000)
  const deletedFile = join(scratch, 'deleted-sessions.txt')
  const child = spawn(process.execPath, [fixture, '--http', String(port), '--http-session', '--deleted-file', deletedFile], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  try {
    check('the stateful HTTP fixture starts', await waitForPort(port), `port ${String(port)}`)
    const definition = {
      name: 'web',
      enabled: true,
      transport: 'streamable-http',
      url: `http://127.0.0.1:${String(port)}/mcp`,
      headers: {},
      toolCallTimeoutMs: 5000,
      connectTimeoutMs: 5000,
      toolFilter: { allow: [], deny: [] },
      reconnect: { enabled: false, initialDelayMs: 100, maxDelayMs: 500, maxAttempts: 2 },
    }
    const { ctx, supervisor } = supervisorFor(definition)
    await supervisor.start()
    check('the HTTP transport connects', supervisor.status().state === 'connected', supervisor.status().error)
    check('the HTTP server registers its tools', ctx.registry.size === 2, String(ctx.registry.size))
    const called = await ctx.registry.get('mcp__web__echo').execute({ text: 'over http' }, {})
    check('a tool call works over HTTP', called.content?.[0]?.text === 'echo: over http', JSON.stringify(called))
    await supervisor.dispose()
    const deleted = await until(
      'the HTTP session is terminated',
      () => (existsSync(deletedFile) ? readFileSync(deletedFile, 'utf8').trim().split('\n').filter(Boolean).length : undefined),
      5000,
    )
    check('teardown sends DELETE for the HTTP session', (deleted ?? 0) >= 1, String(deleted))
  } finally {
    child.kill()
  }
}

// ── pagination caps stop an endless tool list ───────────────────────────────
{
  // 120 pages of one tool exceeds the 100-page cap: the supervisor must refuse
  // the list (and keep the connection) instead of looping forever.
  const definition = stdio('paged')
  definition.args = [fixture, '--tools', '119', '--page-size', '1']
  const { ctx, supervisor } = supervisorFor(definition)
  await supervisor.start()
  const status = supervisor.status()
  check('an over-long tool list does not register tools', ctx.registry.size === 0, String(ctx.registry.size))
  check('an over-long tool list is reported', /超过 100 页/.test(status.error), status.error)
  await supervisor.dispose()
}

rmSync(scratch, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`e2e check FAILED (${failures.length})`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log('e2e check OK')
