/**
 * Bridge benchmark for `dsh-mcp-manager` (report only; not a pass/fail check).
 *
 * It drives the real `McpServerSupervisor` against `test/mcp-echo-server.mjs`
 * over stdio, so the numbers cover the actual SDK client, transport, registry
 * swap, and status projection — not a synthetic mock:
 *
 *   node test/bench-bridge.mjs
 *   MCP_BENCH_LIB=../lib-before node --expose-gc test/bench-bridge.mjs
 *
 * Reported measurements:
 *   connectMs          median `start()` wall time (spawn + initialize + tools/list + register)
 *   listSyncMs         median full `refreshTools()` wall time with 200 advertised tools
 *   callP50Ms          median single `tools/call` round trip through the bridged tool
 *   refreshChurn       `tools/list` requests caused by 10 concurrent manual refresh calls
 *   notificationChurn  `tools/list` requests caused by 10 `tools/list_changed` notifications
 *   registerChurn      `ctx.tools.register()` calls caused by 5 unchanged refreshes
 *   statusBytes        JSON size of one `status()` snapshot with 200 tools
 *   pollBytes          JSON size of the same snapshot without its tool rows
 *   handleDelta        change in active handles/timers after 10 connect/dispose cycles
 *   heapGrowthMb       heap growth over those cycles (noisy; needs --expose-gc)
 */
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

const libBase = process.env.MCP_BENCH_LIB ?? '../lib'
const { McpServerSupervisor, resolveReconnectPolicy } = await import(
  new URL(`${libBase}/supervisor.js`, import.meta.url).href
)
const fixture = fileURLToPath(new URL('./mcp-echo-server.mjs', import.meta.url))
const TOOL_COUNT = 200

/** A ctx-shaped stub: only the tool registry and logger are used by the supervisor. */
function makeCtx() {
  const registry = new Map()
  const noop = () => {}
  const ctx = {
    registry,
    registerCount: 0,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    tools: {
      register(definition) {
        if (registry.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
        registry.set(definition.name, definition)
        ctx.registerCount += 1
        return () => registry.delete(definition.name)
      },
    },
    get() {
      return undefined
    },
  }
  return ctx
}

const definition = (extraTools = TOOL_COUNT, extraArgs = []) => ({
  name: 'bench',
  enabled: true,
  transport: 'stdio',
  command: process.execPath,
  args: [fixture, '--tools', String(extraTools), ...extraArgs],
  env: {},
  cwd: '',
  toolCallTimeoutMs: 60000,
  connectTimeoutMs: 30000,
  reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 1000, maxAttempts: 5 },
})

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Count `tools/list` requests at the protocol layer. */
const originalRequest = Client.prototype.request
let listRequests = 0
Client.prototype.request = function countedRequest(request, schema, options) {
  if (request?.method === 'tools/list') listRequests += 1
  return originalRequest.call(this, request, schema, options)
}

async function withSupervisor(config, run) {
  const ctx = makeCtx()
  const supervisor = new McpServerSupervisor(ctx, config, resolveReconnectPolicy(config.reconnect))
  try {
    return await run(supervisor, ctx)
  } finally {
    await supervisor.dispose()
  }
}

const report = { lib: libBase }

// ── connect + register ──────────────────────────────────────────────────────
const connectSamples = []
await withSupervisor(definition(), async (supervisor, ctx) => {
  for (let index = 0; index < 3; index += 1) {
    const started = performance.now()
    await supervisor.start()
    connectSamples.push(performance.now() - started)
    if (ctx.registry.size !== TOOL_COUNT + 2) throw new Error(`registry has ${String(ctx.registry.size)} tools`)
    await supervisor.stop()
  }
})
report.connectMs = Number(median(connectSamples).toFixed(1))
report.toolsRegistered = TOOL_COUNT + 2

// ── refresh churn + full sync latency ───────────────────────────────────────
await withSupervisor(definition(), async (supervisor, ctx) => {
  listRequests = 0
  const syncSamples = []
  for (let index = 0; index < 3; index += 1) {
    const started = performance.now()
    await supervisor.refreshTools()
    syncSamples.push(performance.now() - started)
  }
  report.listSyncMs = Number(median(syncSamples).toFixed(1))

  listRequests = 0
  await Promise.all(Array.from({ length: 10 }, () => supervisor.refreshTools()))
  report.refreshChurn = listRequests

  // Unchanged re-syncs: the tool definitions are byte-identical, so the registry
  // should not be touched at all.
  const before = ctx.registerCount
  for (let index = 0; index < 5; index += 1) await supervisor.refreshTools()
  report.registerChurn = ctx.registerCount - before
})

// ── notification storm ──────────────────────────────────────────────────────
await withSupervisor(definition(TOOL_COUNT, ['--list-changed', '10']), async (supervisor) => {
  listRequests = 0
  await supervisor.start()
  await new Promise((resolve) => setTimeout(resolve, 1500))
  report.notificationChurn = listRequests
})

// ── per-call overhead ───────────────────────────────────────────────────────
await withSupervisor(definition(), async (supervisor, ctx) => {
  await supervisor.start()
  const tool = ctx.registry.get('mcp__bench__echo')
  if (tool === undefined) throw new Error('the bridged echo tool is missing')
  const samples = []
  for (let index = 0; index < 30; index += 1) {
    const started = performance.now()
    const result = await tool.execute({ text: 'hi' }, {})
    samples.push(performance.now() - started)
    if (result.content[0].text !== 'echo: hi') throw new Error('unexpected tool result')
  }
  report.callP50Ms = Number(median(samples).toFixed(2))
  report.callTotalMs = Number(samples.reduce((total, value) => total + value, 0).toFixed(1))
})

// ── status payload sizes ────────────────────────────────────────────────────
await withSupervisor(definition(), async (supervisor) => {
  await supervisor.start()
  const status = supervisor.status()
  const compact = supervisor.status({ includeTools: false })
  report.statusBytes = Buffer.byteLength(JSON.stringify(status))
  report.pollBytes = Buffer.byteLength(JSON.stringify(compact))
})

// ── handle and heap growth across generations ───────────────────────────────
const handlesBefore = process.getActiveResourcesInfo().length
const heapBefore = process.memoryUsage().heapUsed
for (let index = 0; index < 10; index += 1) {
  const ctx = makeCtx()
  const supervisor = new McpServerSupervisor(ctx, definition(), resolveReconnectPolicy(definition().reconnect))
  await supervisor.start()
  await supervisor.dispose()
  if (ctx.registry.size !== 0) throw new Error('dispose left tools registered')
}
await new Promise((resolve) => setTimeout(resolve, 100))
report.handleDelta = process.getActiveResourcesInfo().length - handlesBefore
if (typeof global.gc === 'function') global.gc()
report.heapGrowthMb = Number(((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024).toFixed(2))
report.gcAvailable = typeof global.gc === 'function'

console.log(JSON.stringify(report, null, 2))
