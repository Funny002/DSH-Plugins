/**
 * The browser-facing RPC channel for the MCP manager.
 *
 * Connection owns the shared `/api` channel and can host one interceptor there,
 * which the Typert gateway already claims. A feature that needs its own
 * authenticated endpoint therefore registers a prefix route on the web server —
 * exactly what the gateway itself does for its Remote-stream upgrade route —
 * and applies Connection's trust fence before doing any work.
 *
 * The wire format is Connection's own unary envelope, unchanged, so the browser
 * half can keep using `ctx.connection.rpc.call('/mcp-manager', …)`:
 *
 *   request   { type: 'client-request',  rpcId, method, payload }
 *   response  { type: 'server-response', rpcId, result: { ok: true, value }
 *                                                     | { ok: false, error } }
 *
 * A business failure is a `200` carrying `ok: false` (the client folds it into
 * its error branch); only transport-level problems use a non-200 status.
 *
 * @module dsh-mcp-manager/channel
 */
import { errorMessage, isRecord } from './naming.js'

/** Largest accepted request body; the settings page only ever sends a server definition. */
const MAX_BODY_BYTES = 262144
/** Correlation id used when the request envelope is too broken to carry one. */
const INVALID_RPC_ID = 'invalid-request'
/** Endpoint segments accepted by Connection's own channels. */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Extract the channel-relative endpoint from a request path.
 * @param channel - absolute channel prefix, e.g. `/mcp-manager`.
 * @param pathname - request pathname.
 * @returns the endpoint, or `undefined` when the path does not address the channel.
 */
export function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) return undefined
  return endpoint
}

/**
 * Send one `server-response` envelope.
 * @param res - node:http response.
 * @param rpcId - correlation id from the request.
 * @param result - success or failure branch.
 */
function sendResult(res, rpcId, result) {
  const body = JSON.stringify({ type: 'server-response', rpcId, result })
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * Send one failure branch.
 * @param res - node:http response.
 * @param rpcId - correlation id.
 * @param code - machine-readable failure code.
 * @param message - human-readable failure message.
 * @param details - structured failure details (always an object).
 */
function sendFailure(res, rpcId, code, message, details = {}) {
  sendResult(res, rpcId, { ok: false, error: { code, message, details } })
}

/**
 * Read a bounded JSON body from a node:http request.
 * @param req - node:http request.
 * @returns the parsed JSON value.
 * @throws when the body exceeds the cap, is not JSON, or the stream fails.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    // A client that disconnects mid-upload emits `aborted` instead of `end` on
    // some Node versions; without this the promise would never settle and the
    // handler would keep its buffers alive.
    req.on('aborted', () => fail(new Error('request aborted')))
    req.on('error', fail)
    req.on('end', () => {
      if (settled) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        fail(new Error('body is not JSON'))
      }
    })
  })
}

/**
 * Serve one request on the manager channel.
 *
 * A transport-level throw (a broken socket, a `requestRejection` that itself
 * throws) must still produce a response: an unhandled rejection here would be a
 * process-level warning and the browser would wait for a reply that never comes.
 *
 * @param options - `channel`, `connection` (for the trust fence), and `dispatch`.
 * @param req - node:http request.
 * @param res - node:http response.
 * @returns when the response has been written.
 */
export async function serveChannelRequest(options, req, res) {
  try {
    await handleChannelRequest(options, req, res)
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('internal error')
      return
    }
    if (!res.writableEnded) res.end()
  }
}

/**
 * The actual request pipeline behind {@link serveChannelRequest}.
 * @param options - `channel`, `connection`, and `dispatch`.
 * @param req - node:http request.
 * @param res - node:http response.
 * @returns when the response has been written.
 */
async function handleChannelRequest(options, req, res) {
  const { channel, connection, dispatch } = options
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection, { 'content-type': 'text/plain' })
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  const endpoint = endpointFromPath(channel, new URL(req.url ?? '/', 'http://dsh.invalid').pathname)
  if (req.method !== 'POST' || endpoint === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    res.writeHead(415, { 'content-type': 'text/plain' })
    res.end('content type must be application/json')
    return
  }
  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    const message = errorMessage(error)
    if (message === 'request body is too large') {
      res.writeHead(413, { 'content-type': 'text/plain' })
      res.end(message)
      return
    }
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end(message)
    return
  }
  const rpcId = isRecord(body) && typeof body.rpcId === 'string' && body.rpcId !== '' ? body.rpcId : INVALID_RPC_ID
  if (!isRecord(body) || body.type !== 'client-request' || typeof body.method !== 'string' || rpcId === INVALID_RPC_ID) {
    sendFailure(res, rpcId, 'gateway/bad-request', 'invalid client-request message', { issues: [] })
    return
  }
  if (body.method !== endpoint) {
    sendFailure(res, rpcId, 'gateway/bad-request', `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`, { issues: [] })
    return
  }
  try {
    sendResult(res, rpcId, { ok: true, value: await dispatch(endpoint, body.payload) })
  } catch (error) {
    sendFailure(res, rpcId, `mcp-manager/${endpoint === '' ? 'unknown' : endpoint}`, errorMessage(error))
  }
}
