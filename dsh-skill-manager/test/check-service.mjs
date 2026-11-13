/**
 * Integration checks for the host service against a real temporary harness home:
 * create, rename, edit, invoke, copy, delete, dispatch, and duplicate handling in
 * the single managed root. A real Cordis context is used so the service's own
 * registration path is exercised.
 *
 *   node test/check-service.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
/** The names of the direct entries of one directory, for debris checks. */
const scanDirectoryNames = (directory) => readdirSync(directory)

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
  const importedByDispatch = manager.dispatch('import', { text: '---\nname: dispatch-import\ndescription: Via dispatch.\n---\n\nBody.\n' })
  check('dispatch answers import', importedByDispatch.imported === true && importedByDispatch.name === 'dispatch-import')
  manager.dispatch('remove', { path: importedByDispatch.path })
  check('dispatch answers remove for the imported skill', manager.list().skills.every((row) => row.name !== 'dispatch-import'))
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

  // ── import a pasted SKILL.md ──────────────────────────────────────────────
  {
    const text = '---\nname: imported-skill\ndescription: Pasted from somewhere.\nlicense: MIT\n---\n\n## Steps\n\n1. Keep this text exactly.\n'
    const imported = manager.importSkill({ text })
    check('import writes the bundle at the frontmatter name', imported.path === join(root, 'imported-skill', 'SKILL.md') && existsSync(imported.path))
    check('import keeps the pasted text byte for byte', readFileSync(imported.path, 'utf8') === text)
    check('import preserves unknown frontmatter keys', scanner.readSkillFile(imported.path).data.license === 'MIT')
    check('import reports the final name', imported.name === 'imported-skill')
    check('import lists the new skill as active', imported.snapshot.skills.some((row) => row.name === 'imported-skill' && row.status === 'active'))
    const renamedImport = manager.importSkill({ text, name: 'renamed-import', layout: 'file' })
    check('import honours a new name and layout', renamedImport.path === join(root, 'renamed-import.md'))
    check('import rewrites the frontmatter name when renamed', scanner.readSkillFile(renamedImport.path).name === 'renamed-import')
    throws('import refuses a name already in use', () => manager.importSkill({ text }), '已被')
    throws('import refuses an empty paste', () => manager.importSkill({ text: '   ' }), '导入内容为空')
    throws('import refuses text that is not a skill', () => manager.importSkill({ text: '# just a body\n' }), 'frontmatter')
    throws('import refuses a pasted file over an existing path', () => manager.importSkill({ text: text.replace('imported-skill', 'renamed-import') }), '已被')
    manager.remove(imported.path)
    manager.remove(renamedImport.path)
  }

  // ── discard an unreadable entry from the issues list ──────────────────────
  {
    mkdirSync(join(root, 'broken-skill'), { recursive: true })
    writeFileSync(join(root, 'broken-skill', 'SKILL.md'), '# no frontmatter here\n', 'utf8')
    const issues = manager.list().issues
    const brokenIssue = issues.find((issue) => issue.path === join(root, 'broken-skill', 'SKILL.md'))
    check('an unreadable file is reported as an issue', brokenIssue !== undefined)
    const discarded = manager.discard(brokenIssue.path)
    check('discard removes the bundle directory', !existsSync(join(root, 'broken-skill')))
    check('discard reports the path it removed', discarded.path === brokenIssue.path)
    check('the issue list is empty afterwards', manager.list().issues.length === 0)
    throws('discard refuses a path that is not an issue', () => manager.discard(join(root, 'nope.md')), '没有找到')
    throws('discard refuses the skill root itself', () => manager.discard(root), '没有找到')
    const valid = manager.create({ name: 'still-valid', description: 'x', body: 'y' })
    throws('discard refuses a valid skill', () => manager.discard(valid.path), '没有找到')
    manager.remove(valid.path)
    // A flat file that cannot be parsed goes on its own, without a directory.
    writeFileSync(join(root, 'flat-broken.md'), 'name: no-frontmatter\n', 'utf8')
    const flatIssue = manager.list().issues.find((issue) => issue.path === join(root, 'flat-broken.md'))
    check('a flat unreadable file is reported', flatIssue !== undefined)
    manager.discard(flatIssue.path)
    check('discard removes only the flat file', !existsSync(join(root, 'flat-broken.md')) && existsSync(root))
  }

  // ── a create never clobbers a file the page did not make ──────────────────
  writeFileSync(join(root, 'taken.md'), 'hand-written, not a skill yet\n', 'utf8')
  throws('a create over an existing file is refused', () => manager.create({ layout: 'file', name: 'taken', description: 'x' }), '目标文件已存在')
  check('the existing file survived', readFileSync(join(root, 'taken.md'), 'utf8').startsWith('hand-written'))
  check('the refused create left no temporary file', scanDirectoryNames(root).every((name) => !name.includes('.tmp')), scanDirectoryNames(root).join(','))
  rmSync(join(root, 'taken.md'), { force: true })

  // ── a rename never lands on an occupied directory ─────────────────────────
  const mover = manager.create({ name: 'mover-skill', description: 'Moved later.', body: 'Body.' })
  // A directory without SKILL.md is not a skill, so the name is free while the
  // path is taken: exactly the case a pre-check on the name alone would miss.
  mkdirSync(join(root, 'reserved-dir'), { recursive: true })
  writeFileSync(join(root, 'reserved-dir', 'notes.md'), 'not an instruction file\n', 'utf8')
  throws(
    'a rename onto an occupied directory is refused',
    () => manager.update(mover.path, { name: 'reserved-dir', description: 'Moved later.' }),
    '目标目录已存在',
  )
  check('the refused rename left the original in place', existsSync(mover.path))
  manager.remove(mover.path)
  rmSync(join(root, 'reserved-dir'), { recursive: true, force: true })

  // ── deleting a linked bundle removes the link, never the target ───────────
  {
    const outside = join(temporary, 'outside-bundle')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: linked-bundle\ndescription: Lives outside the root.\n---\n\nBody.\n', 'utf8')
    writeFileSync(join(outside, 'keep.txt'), 'must survive\n', 'utf8')
    let linked = true
    try {
      symlinkSync(outside, join(root, 'linked-bundle'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      linked = false
    }
    if (linked) {
      const linkedRow = manager.list().skills.find((row) => row.name === 'linked-bundle')
      check('a linked bundle is listed once', manager.list().skills.filter((row) => row.name === 'linked-bundle').length === 1)
      manager.remove(linkedRow.path)
      check('removing a linked bundle keeps its target directory', existsSync(join(outside, 'keep.txt')))
      check('removing a linked bundle removes the link', !existsSync(join(root, 'linked-bundle')))
    } else {
      console.log('note: links are unavailable here, skipped the linked-bundle removal check')
    }
  }
  check('the managed root is empty again', manager.list().skills.length === 0)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`service check FAILED (${failures.length})`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log('service check OK')
