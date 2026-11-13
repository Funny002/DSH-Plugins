/**
 * Local MCP server fixture for verifying `dsh-mcp-manager`.
 *
 * It serves two tools over both supported transports, so the manager's stdio and
 * Streamable-HTTP paths can be exercised without any network dependency:
 *
 *   node test/mcp-echo-server.mjs              # stdio (spawned by the manager)
 *   node test/mcp-echo-server.mjs --http 8931  # Streamable HTTP on :8931/mcp
 *
 * Tools: `echo` (text in, text out) and `add` (two numbers).
 *
 * Test-only flags, all optional and inert by default:
 *
 *   --tools <n>       advertise `n` extra tools named `tool_<i>`
 *   --page-size <n>   paginate `tools/list` with `n` tools per page
 *   --init-delay <ms> stay silent for that long before serving (a hung connect)
 *   --pid-file <path> write this process's PID on startup (orphan detection)
 *   --stderr-lines <n> write `n` noise lines to stderr on startup
 *   --list-changed <n> send `n` `tools/list_changed` notifications once (stdio only)
 *   --fail-tool        also advertise `fail`, a tool that always returns isError
 *   --http-session     serve stateful Streamable-HTTP sessions (honours DELETE)
 *   --deleted-file <p> append one line per terminated HTTP session
 *
 * `echo` still answers, and `stats` (when added by `--tools`) reports the
 * server's own request counters, so a test can assert protocol traffic.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/** Read one numeric CLI flag, or the fallback when it is absent/invalid. */
function numberFlag(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
}

const extraTools = numberFlag('--tools', 0)
const pageSize = numberFlag('--page-size', 0)
const initDelayMs = numberFlag('--init-delay', 0)
const stderrLines = numberFlag('--stderr-lines', 0)
const listChangedCount = numberFlag('--list-changed', 0)
const pidFileFlag = process.argv.indexOf('--pid-file')
if (pidFileFlag !== -1 && typeof process.argv[pidFileFlag + 1] === 'string') {
  writeFileSync(process.argv[pidFileFlag + 1], String(process.pid), 'utf8')
}
const httpSessionMode = process.argv.includes('--http-session')
const deletedFileFlag = process.argv.indexOf('--deleted-file')
const deletedFile = deletedFileFlag === -1 ? undefined : process.argv[deletedFileFlag + 1]
for (let index = 0; index < stderrLines; index += 1) {
  process.stderr.write(`fixture stderr line ${String(index)}\n`)
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the provided text back.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'add',
    description: 'Add two numbers and return the sum.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
]
for (let index = 0; index < extraTools; index += 1) {
  TOOLS.push({
    name: `tool_${String(index)}`,
    description: `Generated fixture tool ${String(index)}.`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  })
}
if (process.argv.includes('--fail-tool')) {
  TOOLS.push({
    name: 'fail',
    description: 'Always report a tool error.',
    inputSchema: { type: 'object', properties: {} },
  })
}

/** Per-server protocol counters, exposed through the `stats` tool. */
const counters = { list: 0, call: 0 }

/** Build one server instance (an MCP Protocol binds one instance to one transport). */
function buildServer() {
  const server = new Server(
    { name: 'dsh-mcp-manager-fixture', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    counters.list += 1
    const offset = request.params?.cursor === undefined ? 0 : Number(request.params.cursor)
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0
    if (pageSize <= 0) return { tools: TOOLS }
    const end = start + pageSize
    return {
      tools: TOOLS.slice(start, end),
      ...(end < TOOLS.length ? { nextCursor: String(end) } : {}),
    }
  })
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    counters.call += 1
    const { name, arguments: args } = request.params
    const input = args ?? {}
    if (name === 'echo') return { content: [{ type: 'text', text: `echo: ${String(input.text ?? '')}` }] }
    if (name === 'add') return { content: [{ type: 'text', text: String(Number(input.a ?? 0) + Number(input.b ?? 0)) }] }
    if (name === 'fail') return { content: [{ type: 'text', text: 'intentional failure' }], isError: true }
    if (name === 'stats') return { content: [{ type: 'text', text: JSON.stringify(counters) }] }
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  })
  return server
}

/** Start serving once the optional artificial initialize delay elapses. */
async function serve(connect) {
  if (initDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, initDelayMs))
  const server = await connect()
  if (listChangedCount > 0) {
    // A notification storm must be observed after the client registered its
    // handler, hence the small delay rather than an immediate burst.
    setTimeout(() => {
      for (let index = 0; index < listChangedCount; index += 1) {
        void server.notification({ method: 'notifications/tools/list_changed' }).catch(() => {})
      }
    }, 150)
  }
  return server
}

const httpFlag = process.argv.indexOf('--http')
if (httpFlag === -1) {
  await serve(async () => {
    const server = buildServer()
    await server.connect(new StdioServerTransport())
    return server
  })
} else {
  const port = Number(process.argv[httpFlag + 1] ?? 8931)
  /** Stateful sessions, keyed by the id the transport handed out. */
  const sessions = new Map()
  const http = createServer((request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end('not found')
      return
    }
    void (async () => {
      if (httpSessionMode) {
        const sessionId = request.headers['mcp-session-id']
        if (request.method === 'DELETE') {
          const entry = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
          if (entry === undefined) {
            response.writeHead(404).end('unknown session')
            return
          }
          sessions.delete(sessionId)
          await entry.transport.close().catch(() => {})
          await entry.server.close().catch(() => {})
          if (deletedFile !== undefined) appendFileSync(deletedFile, `${sessionId}\n`, 'utf8')
          response.writeHead(200).end()
          return
        }
        if (typeof sessionId === 'string') {
          const entry = sessions.get(sessionId)
          if (entry === undefined) {
            response.writeHead(404).end('unknown session')
            return
          }
          await entry.transport.handleRequest(request, response)
          return
        }
        const server = buildServer()
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => sessions.set(id, { transport, server }),
        })
        await server.connect(transport)
        await transport.handleRequest(request, response)
        return
      }
      // A hung server must not answer the initialize request at all; delaying the
      // transport attachment achieves exactly that.
      if (initDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, initDelayMs))
      const server = buildServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      response.on('close', () => {
        void transport.close().catch(() => {})
        void server.close().catch(() => {})
      })
      await server.connect(transport)
      await transport.handleRequest(request, response)
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(String(error))
    })
  })
  http.listen(port, '127.0.0.1', () => {
    process.stderr.write(`fixture listening on http://127.0.0.1:${String(port)}/mcp\n`)
  })
}
