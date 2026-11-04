/**
 * Live verification against an isolated dsh host: reconnect state, budget
 * exhaustion, and override-mode persistence through the plugin's own RPC.
 *
 *   node verify-live.mjs <baseUrl> <token>
 */
const [base, token] = process.argv.slice(2)
const jar = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
const cookie = (jar.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]).join('; ')

async function rpc(method, payload = {}) {
  const response = await fetch(`${base}/mcp-manager/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload }),
  })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status} ${text}`)
  const envelope = JSON.parse(text)
  if (envelope.result.ok !== true) throw new Error(`${method}: ${envelope.result.error.message}`)
  return envelope.result.value
}

function server(name) {
  return rpc('state').then((snapshot) => snapshot.servers.find((entry) => entry.name === name))
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('initial:', JSON.stringify(await server('echo').then((s) => ({ state: s.state, tools: s.toolCount }))))

// 1. Kill the MCP child from the outside; the supervisor must notice the drop,
//    keep the tools listed, and reconnect under the configured budget.
const { execSync } = await import('node:child_process')
const pid = execSync(
  `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -like '*mcp-echo-server*' -and $_.CommandLine -notlike '*CimInstance*' } | Select-Object -First 1).ProcessId"`,
).toString().trim()
console.log('killing mcp child', pid)
execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force"`)

let observedReconnecting = null
for (let attempt = 0; attempt < 40; attempt += 1) {
  await wait(150)
  const entry = await server('echo')
  if (entry.state === 'reconnecting' && observedReconnecting === null) {
    observedReconnecting = entry
    console.log(
      'during outage:',
      JSON.stringify({ state: entry.state, attempts: entry.reconnect.attempts, toolsStillListed: entry.toolCount }),
    )
  }
  if (entry.state === 'connected' && observedReconnecting !== null) {
    console.log('recovered:', JSON.stringify({ state: entry.state, attempts: entry.reconnect.attempts, tools: entry.toolCount }))
    break
  }
}
if (observedReconnecting === null) console.log('NOTE: reconnect state was never sampled (retry was faster than the poll)')

// 2. Add a server that cannot connect. Its bounded budget must end in `error`
//    without disturbing the healthy server, and the write must land as an
//    id-targeted override.
const receipt = await rpc('add', {
  definition: {
    name: 'dead',
    enabled: true,
    transport: 'streamable-http',
    url: 'http://127.0.0.1:1/mcp',
    toolCallTimeoutMs: 2000,
    reconnect: { enabled: true, initialDelayMs: 200, maxDelayMs: 400, maxAttempts: 2 },
  },
})
console.log('add receipt:', JSON.stringify({ mode: receipt.mode, persisted: receipt.persisted }))

let dead
for (let attempt = 0; attempt < 60; attempt += 1) {
  await wait(250)
  dead = await server('dead')
  if (dead !== undefined && (dead.state === 'error' || dead.state === 'connected')) break
}
console.log('dead server settled:', JSON.stringify({ state: dead?.state, attempts: dead?.reconnect?.attempts, error: dead?.error }))
const healthy = await server('echo')
console.log('healthy neighbour unaffected:', JSON.stringify({ state: healthy.state, tools: healthy.toolCount }))

// 3. Remove it again; the block must round-trip back to one server.
const removed = await rpc('remove', { name: 'dead' })
console.log('remove receipt:', JSON.stringify({ servers: removed.snapshot.servers.map((entry) => entry.name), mode: removed.mode }))
