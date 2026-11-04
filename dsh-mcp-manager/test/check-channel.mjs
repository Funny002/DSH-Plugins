/**
 * Offline checks for the browser-facing RPC channel: envelope handling, the
 * request-body limits, and every failure branch, driven through fake node:http
 * request/response objects.
 *
 *   node test/check-channel.mjs
 */
import { EventEmitter } from 'node:events'

const { serveChannelRequest, endpointFromPath } = await import(new URL('../lib/channel.js', import.meta.url).href)

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) return
  failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`)
}

/** Minimal node:http request stand-in. */
function makeRequest({ method = 'POST', url = '/mcp-manager/state', headers = { 'content-type': 'application/json' }, body = '' } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.headers = headers
  request.destroy = () => {}
  setImmediate(() => {
    if (body !== '') request.emit('data', Buffer.from(body, 'utf8'))
    request.emit('end')
  })
  return request
}

/** Minimal node:http response stand-in capturing status and body. */
function makeResponse() {
  const response = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      response.status = status
      response.headers = headers ?? {}
      return response
    },
    end(body) {
      response.body = body ?? ''
    },
  }
  return response
}

const connection = { requestRejection: () => undefined }
const dispatch = async (endpoint, payload) => {
  if (endpoint === 'boom') throw new Error('dispatch exploded')
  return { endpoint, payload }
}
const envelope = (rpcId, method, payload = {}) => JSON.stringify({ type: 'client-request', rpcId, method, payload })

// ── path parsing ────────────────────────────────────────────────────────────
check('endpoint extraction', endpointFromPath('/mcp-manager', '/mcp-manager/state') === 'state')
check('nested endpoint extraction', endpointFromPath('/mcp-manager', '/mcp-manager/servers/list') === 'servers/list')
check('foreign path is ignored', endpointFromPath('/mcp-manager', '/mcp-manager') === undefined)
check('traversal is ignored', endpointFromPath('/mcp-manager', '/mcp-manager/../secret') === undefined)

// ── trust fence ─────────────────────────────────────────────────────────────
{
  const response = makeResponse()
  await serveChannelRequest({ channel: '/mcp-manager', connection: { requestRejection: () => 401 }, dispatch }, makeRequest(), response)
  check('unauthenticated request is 401', response.status === 401 && response.body === 'unauthorized')
}

// ── transport-level branches ────────────────────────────────────────────────
for (const [label, options, status] of [
  ['GET is 404', { method: 'GET' }, 404],
  ['wrong content type is 415', { headers: { 'content-type': 'text/plain' } }, 415],
  ['malformed JSON is 400', { body: '{not json' }, 400],
]) {
  const response = makeResponse()
  await serveChannelRequest({ channel: '/mcp-manager', connection, dispatch }, makeRequest(options), response)
  check(label, response.status === status, `got ${String(response.status)}`)
}

// ── envelope branches ───────────────────────────────────────────────────────
{
  const response = makeResponse()
  await serveChannelRequest({ channel: '/mcp-manager', connection, dispatch }, makeRequest({ body: JSON.stringify({ method: 'state' }) }), response)
  const parsed = JSON.parse(response.body)
  check('invalid envelope is a 200 failure', response.status === 200 && parsed.result.ok === false)
  check('invalid envelope code', parsed.result.error.code === 'gateway/bad-request')
  check('invalid envelope echoes a correlation id', typeof parsed.rpcId === 'string')
}
{
  const response = makeResponse()
  await serveChannelRequest({ channel: '/mcp-manager', connection, dispatch }, makeRequest({ body: envelope('r1', 'other') }), response)
  const parsed = JSON.parse(response.body)
  check('method mismatch is refused', parsed.result.ok === false && parsed.result.error.message.includes('does not match endpoint'))
}
{
  const oversized = JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'state', payload: { pad: 'x'.repeat(300000) } })
  const response = makeResponse()
  await serveChannelRequest({ channel: '/mcp-manager', connection, dispatch }, makeRequest({ body: oversized }), response)
  check('oversized body is 413', response.status === 413, `got ${String(response.status)}`)
}

// ── success and dispatch failure ────────────────────────────────────────────
{
  const response = makeResponse()
  await serveChannelRequest({ channel: '/mcp-manager', connection, dispatch }, makeRequest({ body: envelope('r3', 'state', { a: 1 }) }), response)
  const parsed = JSON.parse(response.body)
  check('success envelope', response.status === 200 && parsed.type === 'server-response' && parsed.rpcId === 'r3' && parsed.result.ok === true)
  check('payload is forwarded', parsed.result.value.endpoint === 'state' && parsed.result.value.payload.a === 1)
}
{
  const response = makeResponse()
  await serveChannelRequest({ channel: '/mcp-manager', connection, dispatch }, makeRequest({ url: '/mcp-manager/boom', body: envelope('r4', 'boom') }), response)
  const parsed = JSON.parse(response.body)
  check('dispatch failure is a 200 failure branch', response.status === 200 && parsed.result.ok === false)
  check('dispatch failure names the endpoint', parsed.result.error.code === 'mcp-manager/boom' && parsed.result.error.message === 'dispatch exploded')
  check('dispatch failure details are an object', typeof parsed.result.error.details === 'object')
}

if (failures.length > 0) {
  console.error(`channel check FAILED (${failures.length})`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log('channel check OK')
