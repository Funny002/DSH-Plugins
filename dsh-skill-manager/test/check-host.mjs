/**
 * Offline checks for the host half: frontmatter parsing, the invocation grammar,
 * scanning the single managed root, duplicate resolution, definition validation,
 * path containment, and the root descriptor.
 *
 *   node test/check-host.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scanner = await import(new URL('../lib/scanner.js', import.meta.url).href)
const index = await import(new URL('../lib/index.js', import.meta.url).href)

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) return
  failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`)
}

const temporary = mkdtempSync(join(tmpdir(), 'dsh-skill-manager-check-'))
const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

const SKILL = (frontmatter, body = '# Instructions\n\nDo the thing.\n') => `---\n${frontmatter}\n---\n\n${body}`

// ── frontmatter parsing and the invocation grammar ─────────────────────────
{
  const parsed = scanner.parseFrontmatter(SKILL('name: demo\ndescription: A demo skill.'))
  check('frontmatter parses data', parsed?.data?.name === 'demo')
  check('frontmatter keeps the body', parsed?.body?.includes('Do the thing.') === true)
  check('missing frontmatter is undefined', scanner.parseFrontmatter('# no frontmatter') === undefined)
  check('unclosed frontmatter is undefined', scanner.parseFrontmatter('---\nname: x\n') === undefined)
  check('array frontmatter is rejected', scanner.parseFrontmatter('---\n- a\n---\n') === undefined)
}
{
  const policy = scanner.parseInvocation({ 'disable-model-invocation': 'yes', 'user-invocable': 'off' })
  check('yes/off invocation', policy.modelInvocable === false && policy.userInvocable === false)
  const numeric = scanner.parseInvocation({ 'disable-model-invocation': 0, 'user-invocable': 1 })
  check('numeric invocation', numeric.modelInvocable === true && numeric.userInvocable === true)
  let threw = false
  try {
    scanner.parseInvocation({ 'user-invocable': 'maybe' })
  } catch {
    threw = true
  }
  check('invalid invocation boolean throws', threw)
  threw = false
  try {
    scanner.parseInvocation({ disableModelInvocation: true })
  } catch (error) {
    threw = String(error.message).includes('disable-model-invocation')
  }
  check('legacy invocation key is explained', threw)
}

// ── rendering, round-trip, and preserved keys ──────────────────────────────
{
  const definition = scanner.normalizeDefinition({
    name: 'render-demo',
    description: 'Renders: a skill with a colon, a "quote", and 中文。',
    whenToUse: 'When the renderer is under test',
    modelInvocable: false,
    userInvocable: true,
    body: '  # Title\n\nBody line.\n\n',
  })
  const text = scanner.renderSkillFile(definition, { license: 'MIT', 'allowed-tools': ['read'], metadata: { owner: 'qa' } })
  const parsed = scanner.parseFrontmatter(text)
  check('rendered frontmatter parses', parsed !== undefined)
  check('rendered description round-trips', parsed?.data?.description === definition.description)
  check('rendered name round-trips', parsed?.data?.name === 'render-demo')
  check('rendered whenToUse round-trips', parsed?.data?.whenToUse === definition.whenToUse)
  check('rendered invocation flags', parsed?.data?.['disable-model-invocation'] === true && parsed?.data?.['user-invocable'] === true)
  check('unknown keys are preserved', parsed?.data?.license === 'MIT' && Array.isArray(parsed?.data?.['allowed-tools']))
  check('metadata is preserved', parsed?.data?.metadata?.owner === 'qa')
  check('body is trimmed and kept', parsed?.body?.trim() === '# Title\n\nBody line.')
  check('file starts with the frontmatter fence', text.startsWith('---\n'))
  check('file ends with a newline', text.endsWith('\n'))
}
{
  const text = scanner.renderSkillFile(
    { name: 'empty-body', description: 'No body.', whenToUse: '', modelInvocable: true, userInvocable: true, body: '', layout: 'bundle' },
    {},
  )
  const parsed = scanner.parseFrontmatter(text)
  check('empty body still renders valid frontmatter', parsed?.data?.name === 'empty-body' && parsed?.body?.trim() === '')
  check('default invocation is written explicitly', parsed?.data?.['disable-model-invocation'] === false && parsed?.data?.['user-invocable'] === true)
}

// ── readSkillFile validation ───────────────────────────────────────────────
{
  const directory = join(temporary, 'files')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  writeFileSync(path, '# no frontmatter\n', 'utf8')
  let message = ''
  try {
    scanner.readSkillFile(path)
  } catch (error) {
    message = String(error.message)
  }
  check('missing frontmatter is a readable error', message.includes('frontmatter'), message)
}
{
  const path = join(temporary, 'files', 'bad-name.md')
  writeFileSync(path, SKILL('name: Not_Kebab\ndescription: x'), 'utf8')
  let message = ''
  try {
    scanner.readSkillFile(path)
  } catch (error) {
    message = String(error.message)
  }
  check('invalid skill name is explained', message.includes('kebab-case'), message)
}
{
  const path = join(temporary, 'files', 'metadata.md')
  writeFileSync(path, SKILL('name: meta-demo\ndescription: x\nmetadata: just-a-string'), 'utf8')
  const parsed = scanner.readSkillFile(path)
  check('non-object metadata warns instead of failing', parsed.warnings.some((warning) => warning.includes('metadata')))
}

// ── definition normalization and validation ────────────────────────────────
{
  const cases = [
    ['missing name', { description: 'x' }],
    ['invalid name', { name: 'Bad Name', description: 'x' }],
    ['missing description', { name: 'ok-name' }],
    ['non-object metadata', { name: 'ok-name', description: 'x', metadata: 'nope' }],
  ]
  for (const [label, input] of cases) {
    let threw = false
    try {
      scanner.normalizeDefinition(input)
    } catch {
      threw = true
    }
    check(`normalize rejects ${label}`, threw)
  }
  const normalized = scanner.normalizeDefinition({ name: 'a', description: ' b ', whenToUse: ' c ', body: 'x\r\ny', modelInvocable: undefined })
  check('normalize trims fields', normalized.name === 'a' && normalized.description === 'b' && normalized.whenToUse === 'c')
  check('normalize normalizes CRLF', normalized.body === 'x\ny')
  check('normalize defaults to the bundle layout', normalized.layout === 'bundle')
  const pinned = scanner.normalizeDefinition({ name: 'a', description: 'b', layout: 'file' }, { layout: 'bundle' })
  check('options.layout pins the layout', pinned.layout === 'bundle')
}
{
  const result = scanner.validateDefinition({ name: 'valid-skill', description: 'x'.repeat(2000), body: '' })
  check('validation accepts a valid definition', result.valid === true)
  check('validation warns about the empty body', result.warnings.some((warning) => warning.includes('正文')))
  check('validation warns about a long description', result.warnings.some((warning) => warning.includes('1024')))
  check('validation renders a preview', result.preview.startsWith('---\n'))
  const invalid = scanner.validateDefinition({ name: 'Bad Name', description: 'x' })
  check('validation reports issues', invalid.valid === false && invalid.issues.length === 1)
}

// ── path containment and the root descriptor ───────────────────────────────
{
  const root = join(temporary, 'contain')
  check('a path is inside itself', scanner.isInside(root, root) === true)
  check('a descendant is inside', scanner.isInside(root, join(root, 'a', 'SKILL.md')) === true)
  check('a sibling prefix is not inside', scanner.isInside(root, `${root}-old`) === false)
  check('a parent is not inside', scanner.isInside(join(root, 'a'), root) === false)
  check('skill path for a bundle', scanner.skillPathFor(root, 'demo', 'bundle') === join(root, 'demo', 'SKILL.md'))
  check('skill path for a flat file', scanner.skillPathFor(root, 'demo', 'file') === join(root, 'demo.md'))
  const userRoot = scanner.userSkillRoot(join(temporary, 'home'))
  check('the managed root is <home>/skills', userRoot.path === join(temporary, 'home', 'skills'))
  check('the managed root skips .system', userRoot.skipSystem === true)
  check('home resolution prefers the explicit value', scanner.resolveDshHome(join(temporary, 'home'), { DSH_HOME: 'ignored' }) === join(temporary, 'home'))
  check('home resolution falls back to the environment', scanner.resolveDshHome('', { DSH_HOME: join(temporary, 'env-home') }) === join(temporary, 'env-home'))
  check('home resolution falls back to ~/.dsh', scanner.resolveDshHome('', {}).endsWith('.dsh'))
}

// ── scanning the single root and duplicate resolution ──────────────────────
const root = join(temporary, 'home', 'skills')
write(join(root, 'alpha', 'SKILL.md'), SKILL('name: alpha\ndescription: Bundle alpha.'))
write(join(root, 'alpha', 'references', 'notes.md'), '# resource\n')
write(join(root, 'dup', 'SKILL.md'), SKILL('name: alpha\ndescription: Duplicate alpha in the same root.'))
write(join(root, 'my-skill.md'), SKILL('name: my-skill\ndescription: Flat file skill.'))
write(join(root, 'mixed', 'SKILL.md'), SKILL('name: other-name\ndescription: Directory name differs.'))
write(join(root, 'broken', 'SKILL.md'), '# no frontmatter\n')
write(join(root, 'bad-bool', 'SKILL.md'), SKILL('name: bad-bool\ndescription: x\nuser-invocable: maybe'))
write(join(root, 'resources', 'notes.md'), '# not a skill\n')
write(join(root, 'notes.txt'), 'ignored\n')
write(join(root, '.system', 'hidden', 'SKILL.md'), SKILL('name: hidden\ndescription: hidden.'))

const scan = scanner.scanRoot({ path: root, skipSystem: true })
check('bundle, flat, and duplicate entries are found', scan.skills.length === 4, String(scan.skills.length))
check('the root exists', scan.exists === true)
check('a directory without SKILL.md is not a skill', scan.skills.every((skill) => skill.name !== 'resources'))
check('non-markdown files are ignored', scan.skills.every((skill) => skill.name !== 'notes'))
check('the user root skips .system', scan.skills.every((skill) => skill.name !== 'hidden'))
check('unparseable files are reported', scan.issues.length === 2, String(scan.issues.length))
check('issues name the file', scan.issues.every((issue) => typeof issue.path === 'string' && issue.path !== ''))
check('a directory-name mismatch warns', scan.skills.find((skill) => skill.name === 'other-name').warnings.some((warning) => warning.includes('mixed')))
check('bundle resources are not scanned as skills', scan.skills.every((skill) => !skill.path.endsWith('notes.md')))
check('rows do not carry the whole body', scan.skills.every((skill) => !Object.hasOwn(skill, 'body')))

const rows = scanner.resolveCatalog(scan.skills)
const alphaRows = rows.filter((row) => row.name === 'alpha')
check('all alpha entries are kept', alphaRows.length === 2, String(alphaRows.length))
check('the first scanned entry wins alpha', alphaRows.filter((row) => row.status === 'active').length === 1 && alphaRows.find((row) => row.status === 'active').path.endsWith(join('alpha', 'SKILL.md')))
check('the loser explains the winner', alphaRows.find((row) => row.status === 'shadowed').shadowedBy.endsWith(join('alpha', 'SKILL.md')))
check('the flat file is active', rows.find((row) => row.name === 'my-skill').status === 'active')
check('rows are sorted by name', rows.map((row) => row.name).join(',') === [...rows.map((row) => row.name)].sort((a, b) => a.localeCompare(b)).join(','))
check('the flat layout is recorded', rows.find((row) => row.name === 'my-skill').layout === 'file')
check('the body byte count is recorded', rows.find((row) => row.name === 'my-skill').bodyBytes > 0)
check('findRow locates a row by path', scanner.findRow(rows, rows.find((row) => row.name === 'my-skill').path).name === 'my-skill')
let findThrew = false
try {
  scanner.findRow(rows, join(temporary, 'nope.md'))
} catch {
  findThrew = true
}
check('findRow rejects an unknown path', findThrew)

// A missing root is valid empty state, not an error.
{
  const missing = scanner.scanRoot({ path: join(temporary, 'absent'), skipSystem: true })
  check('a missing root is empty', missing.exists === false && missing.skills.length === 0 && missing.issues.length === 0)
}

// ── config normalization ───────────────────────────────────────────────────
{
  const config = index.Config({ dshHome: 'C:/custom-home' })
  check('config keeps the dshHome override', config.dshHome === 'C:/custom-home')
  const empty = index.Config({})
  check('config defaults dshHome to empty', empty.dshHome === '')
}

// ── wrap up ────────────────────────────────────────────────────────────────
rmSync(temporary, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`host check FAILED (${failures.length})`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log('host check OK')
