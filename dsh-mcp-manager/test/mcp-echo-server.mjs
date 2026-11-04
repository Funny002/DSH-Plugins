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
 */
import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

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

/** Build one server instance (an MCP Protocol binds one instance to one transport). */
function buildServer() {
  const server = new Server(
    { name: 'dsh-mcp-manager-fixture', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const input = args ?? {}
    if (name === 'echo') return { content: [{ type: 'text', text: `echo: ${String(input.text ?? '')}` }] }
    if (name === 'add') return { content: [{ type: 'text', text: String(Number(input.a ?? 0) + Number(input.b ?? 0)) }] }
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  })
  return server
}

const httpFlag = process.argv.indexOf('--http')
if (httpFlag === -1) {
  await buildServer().connect(new StdioServerTransport())
} else {
  const port = Number(process.argv[httpFlag + 1] ?? 8931)
  const http = createServer((request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end('not found')
      return
    }
    void (async () => {
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
