/**
 * Offline checks for the browser-facing RPC channel: envelope handling, the
 * request-body limit, and every failure branch, driven through fake node:http
 * request/response objects.
 *
 *   node test/check-channel.mjs
 */
import { EventEmitter } from 'node:events'

const { serveChannelRequest, endpointFromPath, MAX_BODY_BYTES } = await import(new URL('../lib/channel.js', import.meta.url).href)

const CHANNEL = '/skill-manager'
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) return
  failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`)
}

/** Minimal node:http request stand-in. */
function makeRequest({ method = 'POST', url = `${CHANNEL}/state`, headers = { 'content-type': 'application/json' }, body = '' } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.headers = headers
  request.destroyed = false
  request.paused = false
  request.destroy = () => {
    request.destroyed = true
  }
  request.pause = () => {
    request.paused = true
  }
  request.resume = () => {
    request.paused = false
  }
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
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      response.status = status
      response.headers = headers ?? {}
      return response
    },
    end(body, callback) {
      response.body = body ?? ''
      response.writableEnded = true
      if (typeof callback === 'function') setImmediate(callback)
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
check('endpoint extraction', endpointFromPath(CHANNEL, '/skill-manager/state') === 'state')
check('nested endpoint extraction', endpointFromPath(CHANNEL, '/skill-manager/roots/list') === 'roots/list')
check('foreign path is ignored', endpointFromPath(CHANNEL, '/skill-manager') === undefined)
check('traversal is ignored', endpointFromPath(CHANNEL, '/skill-manager/../secret') === undefined)

// ── trust fence ─────────────────────────────────────────────────────────────
{
  const response = makeResponse()
  await serveChannelRequest({ channel: CHANNEL, connection: { requestRejection: () => 401 }, dispatch }, makeRequest(), response)
  check('unauthenticated request is 401', response.status === 401 && response.body === 'unauthorized')
  const forbidden = makeResponse()
  await serveChannelRequest({ channel: CHANNEL, connection: { requestRejection: () => 403 }, dispatch }, makeRequest(), forbidden)
  check('a forbidden origin is 403', forbidden.status === 403 && forbidden.body === 'forbidden')
}

// ── transport-level branches ────────────────────────────────────────────────
for (const [label, options, status] of [
  ['GET is 404', { method: 'GET' }, 404],
  ['a foreign path is 404', { url: '/elsewhere/state' }, 404],
  ['wrong content type is 415', { headers: { 'content-type': 'text/plain' } }, 415],
  ['malformed JSON is 400', { body: '{not json' }, 400],
]) {
  const response = makeResponse()
  await serveChannelRequest({ channel: CHANNEL, connection, dispatch }, makeRequest(options), response)
  check(label, response.status === status, `got ${String(response.status)}`)
}

// ── envelope branches ───────────────────────────────────────────────────────
{
  const response = makeResponse()
  await serveChannelRequest({ channel: CHANNEL, connection, dispatch }, makeRequest({ body: JSON.stringify({ method: 'state' }) }), response)
  const parsed = JSON.parse(response.body)
  check('invalid envelope is a 200 failure', response.status === 200 && parsed.result.ok === false)
  check('invalid envelope code', parsed.result.error.code === 'gateway/bad-request')
  check('invalid envelope echoes a correlation id', typeof parsed.rpcId === 'string')
}
{
  const response = makeResponse()
  await serveChannelRequest({ channel: CHANNEL, connection, dispatch }, makeRequest({ body: envelope('r1', 'other') }), response)
  const parsed = JSON.parse(response.body)
  check('method mismatch is refused', parsed.result.ok === false && parsed.result.error.message.includes('does not match endpoint'))
}
{
  const oversized = JSON.stringify({
    type: 'client-request',
    rpcId: 'r2',
    method: 'state',
    payload: { pad: 'x'.repeat(MAX_BODY_BYTES + 1024) },
  })
  const response = makeResponse()
  await serveChannelRequest({ channel: CHANNEL, connection, dispatch }, makeRequest({ body: oversized }), response)
  check('oversized body is 413', response.status === 413, `got ${String(response.status)}`)
}

// ── success and dispatch failure ────────────────────────────────────────────
{
  const response = makeResponse()
  await serveChannelRequest({ channel: CHANNEL, connection, dispatch }, makeRequest({ body: envelope('r3', 'state', { a: 1 }) }), response)
  const parsed = JSON.parse(response.body)
  check('success envelope', response.status === 200 && parsed.type === 'server-response' && parsed.rpcId === 'r3' && parsed.result.ok === true)
  check('payload is forwarded', parsed.result.value.endpoint === 'state' && parsed.result.value.payload.a === 1)
}
{
  const response = makeResponse()
  await serveChannelRequest({ channel: CHANNEL, connection, dispatch }, makeRequest({ url: `${CHANNEL}/boom`, body: envelope('r4', 'boom') }), response)
  const parsed = JSON.parse(response.body)
  check('dispatch failure is a 200 failure branch', response.status === 200 && parsed.result.ok === false)
  check('dispatch failure names the endpoint', parsed.result.error.code === 'skill-manager/boom' && parsed.result.error.message === 'dispatch exploded')
  check('dispatch failure details are an object', typeof parsed.result.error.details === 'object')
}
{
  const response = makeResponse()
  await serveChannelRequest({ channel: CHANNEL, connection, dispatch }, makeRequest({ body: envelope('r5', 'state', { text: '中文字符' }) }), response)
  check('the response declares its byte length', Number(response.headers['content-length']) === Buffer.byteLength(response.body))
}
{
  const response = makeResponse()
  const tooLarge = 'x'.repeat(MAX_BODY_BYTES + 2048)
  const body = JSON.stringify({ type: 'client-request', rpcId: 'r6', method: 'state', payload: { text: tooLarge } })
  const request = makeRequest({ body })
  await serveChannelRequest({ channel: CHANNEL, connection, dispatch }, request, response)
  check('a body over the cap is refused before parsing', response.status === 413)
  check('an oversized request is paused rather than buffered', request.paused === true)
  check('an oversized request keeps the socket long enough to answer', request.destroyed === false)
  await new Promise((resolve) => setTimeout(resolve, 5))
  check('the socket is closed once the 413 has been flushed', request.destroyed === true)
}

// ── robustness: disconnected and aborted requests ───────────────────────────
{
  // The browser navigated away while the host was still answering: writing to a
  // finished response must not throw and must not reject the handler.
  const response = makeResponse()
  response.writableEnded = true
  await serveChannelRequest({ channel: CHANNEL, connection, dispatch }, makeRequest({ body: envelope('r7', 'state') }), response)
  check('an already finished response is left alone', response.status === 0, String(response.status))
}
{
  // The client hung up mid-body: the read must settle instead of leaving the
  // route handler awaiting a request that will never end.
  const request = new EventEmitter()
  request.method = 'POST'
  request.url = `${CHANNEL}/state`
  request.headers = { 'content-type': 'application/json' }
  request.destroy = () => {}
  request.pause = () => {}
  const response = makeResponse()
  setImmediate(() => {
    request.emit('data', Buffer.from('{"type":"client-request",', 'utf8'))
    request.emit('aborted')
  })
  const settled = await Promise.race([
    serveChannelRequest({ channel: CHANNEL, connection, dispatch }, request, response).then(() => 'served'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 250)),
  ])
  check('an aborted request settles', settled === 'served', settled)
  check('an aborted request is a 400', response.status === 400, String(response.status))
}
{
  // A rejected trust fence or a broken URL must stay a status code, never a throw.
  const response = makeResponse()
  await serveChannelRequest({ channel: CHANNEL, connection, dispatch }, makeRequest({ url: 'http://[bad' }), response)
  check('an unparseable URL is 404', response.status === 404, String(response.status))
}

if (failures.length > 0) {
  console.error(`channel check FAILED (${failures.length})`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log('channel check OK')
