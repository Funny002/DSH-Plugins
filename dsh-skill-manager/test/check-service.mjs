/**
 * Integration checks for the host service against a real temporary harness home:
 * create, rename, edit, invoke, copy, delete, dispatch, and duplicate handling in
 * the single managed root. A real Cordis context is used so the service's own
 * registration path is exercised.
 *
 *   node test/check-service.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

const scanner = await import(new URL('../lib/scanner.js', import.meta.url).href)
const { SkillManager } = await import(new URL('../lib/index.js', import.meta.url).href)

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) return
  failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`)
}
const throws = (label, run, needle = '') => {
  try {
    run()
  } catch (error) {
    const message = String(error.message)
    check(label, needle === '' || message.includes(needle), message)
    return message
  }
  check(label, false, 'did not throw')
  return ''
}

const temporary = mkdtempSync(join(tmpdir(), 'dsh-skill-manager-service-'))
const dshHome = join(temporary, 'dsh')
const root = join(dshHome, 'skills')
mkdirSync(root, { recursive: true })

const ctx = new Context()
let manager
try {
  manager = new SkillManager(ctx, { dshHome })

  const initial = manager.list()
  check('the manager reports its workspace', typeof initial.workspace.cwd === 'string' && initial.workspace.cwd !== '')
  check('the manager reports the harness home', initial.workspace.dshHome === dshHome)
  check('exactly one root is managed', initial.roots.length === 1 && initial.roots[0].id === 'user-dsh')
  check('the root is <dshHome>/skills', initial.roots[0].path === root)
  check('the snapshot exposes the root path', initial.skillRoot === root)
  check('an empty root has no skills', initial.skills.length === 0)
  check('the root exists', initial.roots[0].exists === true)

  // ── create ────────────────────────────────────────────────────────────────
  const created = manager.create({
    layout: 'bundle',
    name: 'created-skill',
    description: 'A skill created by the test.',
    whenToUse: 'When testing creation.',
    modelInvocable: false,
    userInvocable: true,
    body: '# Created\n\n1. First step.\n2. Second step.',
  })
  check('create reports the bundle path', created.path === join(root, 'created-skill', 'SKILL.md'))
  check('create writes the file', existsSync(created.path))
  const parsed = scanner.readSkillFile(created.path)
  check('the file has the requested invocation', parsed.invocation.modelInvocable === false && parsed.invocation.userInvocable === true)
  check('the file has the requested body', parsed.body.startsWith('# Created'))
  check('the file has the requested whenToUse', parsed.whenToUse === 'When testing creation.')
  check('the receipt carries the new snapshot', created.snapshot.skills.length === 1 && created.snapshot.generation > 0)
  check('the snapshot marks the skill active', created.snapshot.skills[0].status === 'active')

  throws('a duplicate active name is refused', () => manager.create({ name: 'created-skill', description: 'x' }), '已被')

  // ── preserve unknown frontmatter keys through an update ───────────────────
  const current = readFileSync(created.path, 'utf8')
  writeFileSync(created.path, current.replace('\n---\n', '\nlicense: MIT\n---\n'), 'utf8')
  check('the hand-written frontmatter key is in place', readFileSync(created.path, 'utf8').includes('license: MIT'))
  const updated = manager.update(created.path, {
    name: 'renamed-skill',
    description: 'A renamed skill.',
    whenToUse: '',
    modelInvocable: true,
    userInvocable: false,
    body: '# Renamed\n\nNew body.',
  })
  const renamedPath = join(root, 'renamed-skill', 'SKILL.md')
  check('rename moves the directory', updated.path === renamedPath && existsSync(renamedPath))
  check('rename removes the old directory', !existsSync(join(root, 'created-skill')))
  const renamed = scanner.readSkillFile(renamedPath)
  check('rename rewrites the frontmatter name', renamed.name === 'renamed-skill')
  check('rename keeps unknown frontmatter keys', renamed.data.license === 'MIT')
  check('rename rewrites the invocation', renamed.invocation.modelInvocable === true && renamed.invocation.userInvocable === false)
  check('rename replaces the body', renamed.body === '# Renamed\n\nNew body.')

  // ── read back for the editor ──────────────────────────────────────────────
  const detail = manager.get(renamedPath)
  check('get returns the body', detail.body === '# Renamed\n\nNew body.')
  check('get returns the raw text', detail.raw.startsWith('---\n'))
  check('get returns the frontmatter object', detail.frontmatter.name === 'renamed-skill')
  check('get carries the invocation policy', detail.skill.invocation.userInvocable === false)

  // ── invocation toggles ────────────────────────────────────────────────────
  const toggled = manager.setInvocation(renamedPath, { userInvocable: true })
  check('setInvocation flips only the named surface', toggled.invocation.userInvocable === true && toggled.invocation.modelInvocable === true)
  check('setInvocation preserves the body', scanner.readSkillFile(renamedPath).body.includes('New body.'))
  const disabled = manager.setEnabled(renamedPath, false)
  check('setEnabled disables both surfaces', disabled.invocation.modelInvocable === false && disabled.invocation.userInvocable === false)
  manager.setEnabled(renamedPath, true)

  // ── copy ──────────────────────────────────────────────────────────────────
  const copied = manager.copy(renamedPath, { name: 'copied-skill', layout: 'file' })
  check('copy writes a flat file into the same root', copied.path === join(root, 'copied-skill.md'))
  check('copy keeps the body', readFileSync(copied.path, 'utf8').includes('New body.'))
  check('copy keeps unknown frontmatter keys', readFileSync(copied.path, 'utf8').includes('license: MIT'))
  const copiedRow = copied.snapshot.skills.find((row) => row.name === 'copied-skill')
  check('the copy is listed with the flat layout', copiedRow.layout === 'file')
  throws('copy refuses a name already in use', () => manager.copy(renamedPath, { name: 'copied-skill' }), '已被')

  // ── create with the flat layout ───────────────────────────────────────────
  const flat = manager.create({ layout: 'file', name: 'flat-skill', description: 'A flat skill.', body: 'Body.' })
  check('a flat skill is written as <name>.md', flat.path === join(root, 'flat-skill.md') && existsSync(flat.path))

  // ── validate ──────────────────────────────────────────────────────────────
  const good = manager.validate({ name: 'validate-me', description: 'Valid.', body: 'Body.' })
  check('validate accepts a valid definition', good.valid === true && good.target === join(root, 'validate-me', 'SKILL.md'))
  const bad = manager.validate({ name: 'Bad Name', description: 'x' })
  check('validate reports an invalid definition', bad.valid === false && bad.issues.length === 1)

  // ── delete ────────────────────────────────────────────────────────────────
  const removedBundle = manager.remove(renamedPath)
  check('remove deletes the bundle directory', removedBundle.removed === true && !existsSync(join(root, 'renamed-skill')))
  check('remove deletes a flat file', manager.remove(flat.path).removed === true && !existsSync(flat.path))
  check('the snapshot no longer lists a removed skill', !manager.list().skills.some((row) => row.name === 'renamed-skill'))
  throws('removing an unknown path is refused', () => manager.remove(join(root, 'nope.md')), '没有找到')

  // ── dispatch ──────────────────────────────────────────────────────────────
  const state = manager.dispatch('state', {})
  check('dispatch answers state', Array.isArray(state.skills) && state.roots.length === 1)
  check('dispatch answers get', manager.dispatch('get', { path: copied.path }).skill.name === 'copied-skill')
  check('dispatch answers validate', manager.dispatch('validate', { definition: { name: 'd', description: 'x' } }).valid === true)
  const stopped = manager.dispatch('stop', { path: copied.path })
  check('dispatch answers stop', stopped.invocation.modelInvocable === false)
  throws('dispatch rejects an unknown endpoint', () => manager.dispatch('nope', {}), '未知的接口')
  manager.remove(copied.path)

  // ── duplicate names inside one root ───────────────────────────────────────
  mkdirSync(join(root, 'shadow-one'), { recursive: true })
  mkdirSync(join(root, 'shadow-two'), { recursive: true })
  writeFileSync(join(root, 'shadow-one', 'SKILL.md'), '---\nname: shadow-test\ndescription: First shadow.\n---\n\nA.\n', 'utf8')
  writeFileSync(join(root, 'shadow-two', 'SKILL.md'), '---\nname: shadow-test\ndescription: Second shadow.\n---\n\nB.\n', 'utf8')
  const shadowed = manager.list()
  const rows = shadowed.skills.filter((row) => row.name === 'shadow-test')
  check('a duplicate inside one root is kept as a shadowed row', rows.length === 2 && rows.filter((row) => row.status === 'shadowed').length === 1)
  check('the shadowed row names the winner', rows.find((row) => row.status === 'shadowed').shadowedBy === rows.find((row) => row.status === 'active').path)
  const loser = rows.find((row) => row.status === 'shadowed')
  const editedLoser = manager.update(loser.path, { description: 'Edited while shadowed.' })
  check('a shadowed row stays editable under its own name', editedLoser.updated === true)
  check('the shadowed edit landed on disk', scanner.readSkillFile(loser.path).description === 'Edited while shadowed.')
  manager.remove(rows.find((row) => row.status === 'active').path)
  check('removing the winner promotes the shadowed row', manager.list().skills.find((row) => row.name === 'shadow-test')?.status === 'active')
  manager.remove(loser.path)
  check('the root is empty again', manager.list().skills.length === 0)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`service check FAILED (${failures.length})`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log('service check OK')
