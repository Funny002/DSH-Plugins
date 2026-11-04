/**
 * Offline checks for the host half: config validation, reconnect policy, tool
 * naming and content projection, and the patch-layer managed block in both of
 * its modes. No Cordis runtime needed.
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

const { Config, VERSION, normalizeReconnect, normalizeServer, inject, name: pluginName } = await import(lib('index.js'))
const naming = await import(lib('naming.js'))
const patchFile = await import(lib('patch-file.js'))
const supervisor = await import(lib('supervisor.js'))

// ── plugin identity ──────────────────────────────────────────────────────────
check('plugin name', pluginName === 'mcp-manager')
check('static inject is tools only', JSON.stringify(inject) === '["tools"]')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
check('version comes from the package manifest', VERSION === manifest.version, `${VERSION} vs ${manifest.version}`)
check('version is a semver triple', /^\d+\.\d+\.\d+/.test(VERSION), VERSION)

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
check(
  'reconnect defaults are resolved by the schema',
  resolved.servers[0].reconnect.enabled === true &&
    resolved.servers[0].reconnect.maxAttempts === 10 &&
    resolved.servers[0].reconnect.initialDelayMs === 500,
)

// ── definition normalization ─────────────────────────────────────────────────
const stdio = normalizeServer({ name: 'echo', transport: 'stdio', command: ' node ', args: 'a\nb\n', env: { A: 'env.HOME' }, extra: 'dropped' })
check('normalizes command', stdio.command === 'node')
check('args from text', JSON.stringify(stdio.args) === '["a","b"]')
check('drops unknown fields', !('extra' in stdio))
check('reconnect is normalized into the definition', stdio.reconnect.enabled === true && stdio.reconnect.maxAttempts === 10)
check(
  'unknown reconnect keys are dropped on write',
  JSON.stringify(Object.keys(normalizeReconnect({ enabled: false, bogus: 1 })).sort()) ===
    JSON.stringify(['enabled', 'initialDelayMs', 'maxAttempts', 'maxDelayMs']),
)
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

// ── reconnect policy ────────────────────────────────────────────────────────
const defaults = supervisor.resolveReconnectPolicy(undefined)
check(
  'reconnect defaults',
  defaults.enabled === true && defaults.initialDelayMs === 500 && defaults.maxDelayMs === 30000 && defaults.maxAttempts === 10,
)
check('reconnect policy is frozen', Object.isFrozen(defaults))
for (const [label, input] of [
  ['unknown option', { retries: 3 }],
  ['zero delay', { initialDelayMs: 0 }],
  ['inverted delays', { initialDelayMs: 900, maxDelayMs: 500 }],
  ['fractional attempts', { maxAttempts: 1.5 }],
  ['zero attempts', { maxAttempts: 0 }],
]) {
  let threw = false
  try {
    supervisor.resolveReconnectPolicy(input)
  } catch {
    threw = true
  }
  check(`refuses reconnect ${label}`, threw)
}

// ── output schema support ───────────────────────────────────────────────────
check('no outputSchema stays absent', supervisor.supportedOutputSchema(undefined) === undefined)
check(
  'plain object outputSchema is kept',
  JSON.stringify(supervisor.supportedOutputSchema({ type: 'object', properties: { total: { type: 'number' } }, required: ['total'] })) ===
    '{"type":"object","properties":{"total":{"type":"number"}},"required":["total"]}',
)
check('non-object outputSchema is dropped', supervisor.supportedOutputSchema({ type: 'string' }) === undefined)
check('$ref outputSchema is dropped', supervisor.supportedOutputSchema({ type: 'object', properties: { a: { $ref: '#/x' } } }) === undefined)
check('openapi keyword is dropped', supervisor.supportedOutputSchema({ type: 'object', additionalProperties: true, nullable: true }) === undefined)

// ── naming contract ──────────────────────────────────────────────────────────
check('clean public name', naming.publicToolName('echo', 'echo') === 'mcp__echo__echo')
check('lossy public name is hashed', naming.publicToolName('my server', 'a tool/with spaces').startsWith('mcp__my_server__a_tool_with_spaces_'))
check('lossy public name is stable', naming.publicToolName('my server', 'a tool') === naming.publicToolName('my server', 'a tool'))
check(
  'public names stay inside the 64-char contract',
  naming.publicToolName('namespace', 'x'.repeat(200)).length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(naming.publicToolName('namespace', 'x'.repeat(200))),
)

// ── content projection ──────────────────────────────────────────────────────
check('text projection', naming.contentToText([{ type: 'text', text: 'hi' }], 'echo') === 'hi')
const imageText = naming.contentToText([{ type: 'image', mimeType: 'image/png', data: 'AAAA' }], 'shot')
check('an unadmitted image explains itself', imageText.includes('image unavailable') && imageText.includes('image/png'), imageText)
check('empty result is explained', naming.contentToText([], 'echo').includes('no model-visible content'))
check(
  'text runs are coalesced around an image',
  JSON.stringify(naming.projectContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'echo')) ===
    JSON.stringify([{ type: 'text', text: 'a\nb' }]),
)
check(
  'a resource link keeps its name and URI',
  naming.contentToText([{ type: 'resource_link', name: 'doc', uri: 'file:///x' }], 'echo').includes('doc (file:///x)'),
)
check(
  'audio and embedded resources become bounded placeholders',
  naming.contentToText([{ type: 'audio', mimeType: 'audio/wav' }, { type: 'resource', resource: { uri: 'x' } }], 'echo').includes(
    'audio result unsupported',
  ),
)
check(
  'a canonical image decodes',
  naming.decodeImageBlock({ type: 'image', mimeType: 'image/png', data: 'AAAA' }).mediaType === 'image/png',
)
for (const [label, block] of [
  ['non-image media type', { type: 'image', mimeType: 'image/tiff', data: 'AAAA' }],
  ['non-canonical base64', { type: 'image', mimeType: 'image/png', data: 'AAA' }],
]) {
  let threw = false
  try {
    naming.decodeImageBlock(block)
  } catch {
    threw = true
  }
  check(`refuses ${label}`, threw)
}

// ── environment handling ────────────────────────────────────────────────────
const env = supervisor.buildChildEnv({ TOKEN: 'explicit' })
check('secret-looking ambient names are dropped', !('DSH_HOME' in env))
check('configured values win', env.TOKEN === 'explicit')
check('literal env value', supervisor.resolveEnvValue('literal') === 'literal')
check('env.NAME indirection', supervisor.resolveEnvValue('env.PATH') === process.env.PATH)
check('${NAME} indirection', supervisor.resolveEnvValue('${PATH}') === process.env.PATH)
check('an unset name resolves empty', supervisor.resolveEnvValue('env.DSH_MCP_MANAGER_NOT_SET') === '')

// ── managed patch block: insert mode (loose copy) ───────────────────────────
const template = '# Your patch layer\n# a top-level YAML array of loader patch entries\n[]\n'
const servers = [
  {
    name: 'echo',
    enabled: true,
    transport: 'stdio',
    command: 'node',
    args: ['x.mjs'],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60000,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
  },
  {
    name: 'web',
    enabled: false,
    transport: 'streamable-http',
    url: 'http://127.0.0.1:8931/mcp',
    headers: {},
    toolCallTimeoutMs: 60000,
    reconnect: { enabled: false, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 3 },
  },
]
const block = patchFile.renderManagedBlock(servers, {})
const composed = patchFile.upsertManagedBlock(template, block)
check('empty flow list is replaced, not appended to', composed.includes('[]') === false)
check('comments are preserved', composed.includes('# Your patch layer'))
check('block is an insert list', composed.includes('- insert:') && composed.includes(`- id: ${patchFile.ROW_ID}`))
check('insert mode round trips', patchFile.readManagedBlock(composed).mode === 'insert')
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

// ── managed patch block: override mode (row supplied by the bundle layer) ───
const override = patchFile.upsertManagedBlock(template, patchFile.renderManagedBlock(servers, { mode: 'override' }))
check('override mode is not an insert', override.includes('- insert:') === false && override.includes(`- id: ${patchFile.ROW_ID}`))
check('override mode round trips', patchFile.readManagedBlock(override).mode === 'override')
check('override mode keeps every server', JSON.stringify(patchFile.readManagedBlock(override).servers) === JSON.stringify(servers))
check('override mode does not repeat the row name', override.includes('name:') === false)
check(
  'override mode appends after existing entries',
  patchFile
    .upsertManagedBlock('- id: other\n  config:\n    x: 1\n', patchFile.renderManagedBlock([], { mode: 'override' }))
    .includes('- id: other'),
)
check(
  'a pin is written under config in both modes',
  patchFile.renderManagedBlock([], { mode: 'override', patchFile: 'C:\\x\\cordis.patch.yml' }).includes("patchFile: 'C:/x/cordis.patch.yml'") &&
    patchFile.renderManagedBlock([], { patchFile: 'C:\\x\\cordis.patch.yml' }).includes("patchFile: 'C:/x/cordis.patch.yml'"),
)

// ── file write path ─────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-'))
const target = join(dir, 'cordis.patch.yml')
writeFileSync(target, template, 'utf8')
patchFile.writeManagedServers(target, servers, { mode: 'insert', rowName: patchFile.DEFAULT_ROW_NAME })
check('writeManagedServers persists', JSON.stringify(patchFile.readManagedBlock(readFileSync(target, 'utf8')).servers) === JSON.stringify(servers))
check('row name is preserved on rewrite', patchFile.readManagedRowName(target) === patchFile.DEFAULT_ROW_NAME)
patchFile.writeManagedServers(target, [servers[0]], { mode: 'insert', rowName: './custom/path.js' })
check('explicit row name is written', readFileSync(target, 'utf8').includes("name: './custom/path.js'"))
patchFile.writeManagedServers(target, servers, { mode: 'override' })
const persisted = patchFile.readManagedBlock(readFileSync(target, 'utf8'))
check('the write path can switch modes in place', persisted.mode === 'override' && persisted.servers.length === 2)
check('a switched block drops the stale row name', readFileSync(target, 'utf8').includes('name:') === false)

if (failures.length > 0) {
  console.error(`host check FAILED (${failures.length})`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log('host check OK')
