/**
 * The browser-facing RPC channel for the skill manager.
 *
 * Connection owns the shared `/api` channel and can host one interceptor there,
 * which the Typert gateway already claims. A feature that needs its own
 * authenticated endpoint therefore registers a prefix route on the web server —
 * exactly what the gateway itself does for its Remote-stream upgrade route —
 * and applies Connection's trust fence before doing any work.
 *
 * The wire format is Connection's own unary envelope, unchanged, so the browser
 * half can keep using `ctx.connection.rpc.call('/skill-manager', …)`:
 *
 *   request   { type: 'client-request',  rpcId, method, payload }
 *   response  { type: 'server-response', rpcId, result: { ok: true, value }
 *                                                     | { ok: false, error } }
 *
 * A business failure is a `200` carrying `ok: false` (the client folds it into
 * its error branch); only transport-level problems use a non-200 status.
 *
 * @module dsh-skill-manager/channel
 */
import { errorMessage, isRecord } from './scanner.js'

/**
 * Largest accepted request body. A skill body is the biggest value the settings
 * page sends, and instruction files stay far below this in practice; the cap
 * exists so one broken request cannot make the host buffer without bound.
 */
export const MAX_BODY_BYTES = 1048576
/** Correlation id used when the request envelope is too broken to carry one. */
const INVALID_RPC_ID = 'invalid-request'
/** Endpoint segments accepted by Connection's own channels. */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
/** Failure code for a body over {@link MAX_BODY_BYTES}. */
const BODY_TOO_LARGE = 'BODY_TOO_LARGE'
/** Failure code for a body that is not JSON. */
const BODY_NOT_JSON = 'BODY_NOT_JSON'

/**
 * Build one tagged body-read failure, so the caller matches on the cause rather
 * than on an English message.
 * @param code - machine-readable failure code.
 * @param message - transport-level explanation.
 * @returns the error to reject with.
 */
function bodyError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Extract the channel-relative endpoint from a request path.
 * @param channel - absolute channel prefix, e.g. `/skill-manager`.
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
 * @returns whether the response was written.
 */
function sendResult(res, rpcId, result) {
  // A disconnected browser must not turn into an unhandled stream error.
  if (res.writableEnded || res.destroyed) return false
  const body = JSON.stringify({ type: 'server-response', rpcId, result })
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
  return true
}

/**
 * Send one failure branch.
 * @param res - node:http response.
 * @param rpcId - correlation id.
 * @param code - machine-readable failure code.
 * @param message - human-readable failure message.
 * @param details - structured failure details (always an object).
 * @returns whether the response was written.
 */
function sendFailure(res, rpcId, code, message, details = {}) {
  return sendResult(res, rpcId, { ok: false, error: { code, message, details } })
}

/**
 * Read a bounded JSON body from a node:http request.
 *
 * The promise settles exactly once. An oversized body is not read to the end —
 * the stream is paused and the caller answers `413` — and a browser that hangs
 * up before finishing settles the read instead of leaving the handler waiting on
 * a request that will never end.
 * @param req - node:http request.
 * @returns the parsed JSON value.
 * @throws a {@link bodyError} when the body exceeds the cap, is not JSON, or the
 * stream aborts.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      callback(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settle(reject, bodyError(BODY_TOO_LARGE, 'request body is too large'))
        // Stop buffering but keep the socket writable so the 413 can be sent.
        req.pause()
        return
      }
      chunks.push(chunk)
    })
    req.on('aborted', () => settle(reject, bodyError(BODY_NOT_JSON, 'request aborted before the body ended')))
    req.on('error', (error) => settle(reject, error))
    req.on('end', () => {
      try {
        settle(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        settle(reject, bodyError(BODY_NOT_JSON, 'body is not JSON'))
      }
    })
  })
}

/**
 * Serve one request on the manager channel.
 * @param options - `channel`, `connection` (for the trust fence), and `dispatch`.
 * @param req - node:http request.
 * @param res - node:http response.
 * @returns when the response has been written.
 */
export async function serveChannelRequest(options, req, res) {
  const { channel, connection, dispatch } = options
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection, { 'content-type': 'text/plain' })
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  let pathname
  try {
    pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
  } catch {
    pathname = ''
  }
  const endpoint = endpointFromPath(channel, pathname)
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
    const code = error && typeof error === 'object' ? error.code : undefined
    if (code === BODY_TOO_LARGE) {
      /*
       * The body is still arriving, so the socket is destroyed only after the
       * response is flushed; destroying it first turns the 413 into a reset the
       * page can only report as a transport failure.
       */
      res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' })
      res.end(message, () => req.destroy())
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
    sendFailure(res, rpcId, `skill-manager/${endpoint === '' ? 'unknown' : endpoint}`, errorMessage(error))
  }
}
