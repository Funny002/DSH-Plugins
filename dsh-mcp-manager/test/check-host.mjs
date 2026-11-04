/**
 * Offline checks for the host half: config validation, tool naming, content
 * projection, and the patch-layer managed block. No Cordis runtime needed.
 *
 *   node test/check-host.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const lib = (name) => new URL(`../lib/${name}`, import.meta.url).href
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) return
  failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`)
}

const { Config, normalizeServer, inject, name: pluginName } = await import(lib('index.js'))
const naming = await import(lib('naming.js'))
const patchFile = await import(lib('patch-file.js'))
const supervisor = await import(lib('supervisor.js'))

// ── plugin identity ──────────────────────────────────────────────────────────
check('plugin name', pluginName === 'mcp-manager')
check('static inject is tools only', JSON.stringify(inject) === '["tools"]')

// ── config schema ────────────────────────────────────────────────────────────
const resolved = Config({
  servers: [
    { name: 'echo', transport: 'stdio', command: 'node' },
    { name: 'web', transport: 'streamable-http', url: 'http://127.0.0.1:8931/mcp' },
  ],
})
check('stdio defaults', resolved.servers[0].enabled === true && resolved.servers[0].args.length === 0 && resolved.servers[0].toolCallTimeoutMs === 60000)
check('http defaults', resolved.servers[1].headers !== undefined && resolved.servers[1].enabled === true)
check('empty default', JSON.stringify(Config({}).servers) === '[]')

// ── definition normalization ─────────────────────────────────────────────────
const stdio = normalizeServer({ name: 'echo', transport: 'stdio', command: ' node ', args: 'a\nb\n', env: { A: 'env.HOME' }, extra: 'dropped' })
check('normalizes command', stdio.command === 'node')
check('args from text', JSON.stringify(stdio.args) === '["a","b"]')
check('drops unknown fields', !('extra' in stdio))
for (const [label, input] of [
  ['bad name', { name: 'bad name!', transport: 'stdio', command: 'node' }],
  ['missing command', { name: 'x', transport: 'stdio' }],
  ['missing url', { name: 'x', transport: 'streamable-http' }],
  ['bad url', { name: 'x', transport: 'streamable-http', url: 'not a url' }],
  ['bad transport', { name: 'x', transport: 'sse', command: 'node' }],
]) {
  let threw = false
  try {
    normalizeServer(input)
  } catch {
    threw = true
  }
  check(`refuses ${label}`, threw)
}
// A missing scheme is what people actually type; it is filled in, not refused.
check(
  'scheme-less url gains http://',
  normalizeServer({ name: 'web', transport: 'streamable-http', url: 'localhost:3000/mcp' }).url === 'http://localhost:3000/mcp',
)
check(
  'explicit https is kept',
  normalizeServer({ name: 'web', transport: 'streamable-http', url: 'https://example.test/mcp' }).url === 'https://example.test/mcp',
)

// ── naming contract ──────────────────────────────────────────────────────────
check('clean public name', naming.publicToolName('echo', 'echo') === 'mcp__echo__echo')
check('lossy public name is hashed', naming.publicToolName('my server', 'a tool/with spaces').startsWith('mcp__my_server__a_tool_with_spaces_'))
check('lossy public name is stable', naming.publicToolName('my server', 'a tool') === naming.publicToolName('my server', 'a tool'))
check(
  'public names stay inside the 64-char contract',
  naming.publicToolName('namespace', 'x'.repeat(200)).length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(naming.publicToolName('namespace', 'x'.repeat(200))),
)
check('text projection', naming.contentToText([{ type: 'text', text: 'hi' }], 'echo') === 'hi')
check(
  'image projection is bounded',
  naming.contentToText([{ type: 'image', mimeType: 'image/png', data: 'AAAA' }], 'shot') === '[image image/png]',
)
check('empty result is explained', naming.contentToText([], 'echo').includes('no content'))

// ── environment handling ────────────────────────────────────────────────────
const env = supervisor.buildChildEnv({ TOKEN: 'explicit' })
check('secret-looking ambient names are dropped', !('DSH_HOME' in env))
check('configured values win', env.TOKEN === 'explicit')
check('literal env value', supervisor.resolveEnvValue('literal') === 'literal')
check('env.NAME indirection', supervisor.resolveEnvValue('env.PATH') === process.env.PATH)
check('${NAME} indirection', supervisor.resolveEnvValue('${PATH}') === process.env.PATH)
check('an unset name resolves empty', supervisor.resolveEnvValue('env.DSH_MCP_MANAGER_NOT_SET') === '')

// ── managed patch block ─────────────────────────────────────────────────────
const template = '# Your patch layer\n# a top-level YAML array of loader patch entries\n[]\n'
const servers = [
  { name: 'echo', enabled: true, transport: 'stdio', command: 'node', args: ['x.mjs'], env: {}, cwd: '', toolCallTimeoutMs: 60000 },
  { name: 'web', enabled: false, transport: 'streamable-http', url: 'http://127.0.0.1:8931/mcp', headers: {}, toolCallTimeoutMs: 60000 },
]
const block = patchFile.renderManagedBlock(servers, {})
const composed = patchFile.upsertManagedBlock(template, block)
check('empty flow list is replaced, not appended to', composed.includes('[]') === false)
check('comments are preserved', composed.includes('# Your patch layer'))
check('block is an insert list', composed.includes('- insert:') && composed.includes(`- id: ${patchFile.ROW_ID}`))
check('round trip', JSON.stringify(patchFile.readManagedBlock(composed).servers) === JSON.stringify(servers))
const rewritten = patchFile.upsertManagedBlock(composed, patchFile.renderManagedBlock([], {}))
check('replacement drops the old entries', JSON.stringify(patchFile.readManagedBlock(rewritten).servers) === '[]')
check('replacement keeps one block', rewritten.split(patchFile.BLOCK_START).length === 2)
let refused = false
try {
  patchFile.upsertManagedBlock('[{ "id": "x" }]\n', block)
} catch {
  refused = true
}
check('non-empty flow list is refused', refused)

// ── file write path ─────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-'))
const target = join(dir, 'cordis.patch.yml')
writeFileSync(target, template, 'utf8')
patchFile.writeManagedServers(target, servers, { rowName: patchFile.DEFAULT_ROW_NAME })
check('writeManagedServers persists', JSON.stringify(patchFile.readManagedBlock(readFileSync(target, 'utf8')).servers) === JSON.stringify(servers))
check('row name is preserved on rewrite', patchFile.readManagedRowName(target) === patchFile.DEFAULT_ROW_NAME)
patchFile.writeManagedServers(target, [servers[0]], { rowName: './custom/path.js' })
check('explicit row name is written', readFileSync(target, 'utf8').includes("name: './custom/path.js'"))

if (failures.length > 0) {
  console.error(`host check FAILED (${failures.length})`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log('host check OK')
