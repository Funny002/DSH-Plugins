/**
 * Live verification against a running host: create, read, invoke, rename, copy,
 * and delete skills through the plugin's own RPC channel, then confirm the files
 * on disk with the same parser the host used. Everything happens in the single
 * managed root (`<DSH_HOME>/skills`).
 *
 *   node test/verify-live.mjs http://127.0.0.1:3099 <token-from-launch-line>
 *
 * The token is the one on the `dsh web: …?token=…` line printed at startup; a
 * fresh host prints it once, and this script exchanges it for the browser
 * session cookie.
 *
 * Every temporary skill is removed again, including on failure.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const scanner = await import(new URL('../lib/scanner.js', import.meta.url).href)

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  console.error('usage: node test/verify-live.mjs <baseUrl> <token>')
  process.exit(2)
}

const jar = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
const cookie = (jar.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]).join('; ')
if (cookie === '') {
  console.error('verify-live: the token exchange did not set a session cookie')
  process.exit(1)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One RPC call, retried while a hot swap has the channel unregistered. */
async function rpc(method, payload = {}) {
  let lastError
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${base}/skill-manager/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: 'verify-live', method, payload }),
      })
      const text = await response.text()
      if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status} ${text}`)
      const envelope = JSON.parse(text)
      if (envelope.result.ok !== true) throw new Error(`${method}: ${envelope.result.error.message}`)
      return envelope.result.value
    } catch (error) {
      lastError = error
      await sleep(400)
    }
  }
  throw lastError
}

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`ok   ${label}`)
    return
  }
  failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`)
  console.error(`FAIL ${label}${detail === '' ? '' : `: ${detail}`}`)
}

const stamp = Date.now().toString(36)
const name = `verify-live-${stamp}`
const renamed = `${name}-renamed`
const flatCopy = `verify-copy-${stamp}`
const importedName = `verify-import-${stamp}`
const brokenName = `verify-broken-${stamp}`
const created = []
let root = ''
try {
  const initial = await rpc('state')
  root = initial.skillRoot
  console.log(`workspace: ${initial.workspace.cwd}`)
  console.log(`skill root: ${root}`)
  console.log(`skills: ${initial.totals.skills}, roots: ${initial.roots.map((entry) => entry.id).join(', ')}`)
  check('the channel is registered', initial.channel.state === 'registered', initial.channel.state)
  check('exactly one root is managed', initial.roots.length === 1 && initial.roots[0].id === 'user-dsh')
  check('the root is the harness skills directory', root.endsWith(join('.dsh', 'skills')) || root.endsWith(join('dsh', 'skills')), root)
  check('the root exists or can be created', typeof initial.roots[0].exists === 'boolean')

  // 1. create
  const receipt = await rpc('create', {
    definition: {
      layout: 'bundle',
      name,
      description: 'Live verification skill created by verify-live.mjs.',
      whenToUse: 'Only while the skill manager is being verified.',
      modelInvocable: true,
      userInvocable: true,
      body: '# Live verification\n\n1. Create.\n2. Read.\n3. Rename.\n4. Delete.',
    },
  })
  created.push(receipt.path)
  check('create wrote the bundle file', existsSync(receipt.path), receipt.path)
  check('create wrote into the managed root', receipt.path.startsWith(root), receipt.path)
  const parsed = scanner.readSkillFile(receipt.path)
  check('the file parses as a skill', parsed.name === name && parsed.invocation.modelInvocable === true)
  check('the snapshot lists the new skill', receipt.snapshot.skills.some((row) => row.path === receipt.path && row.status === 'active'))

  // 2. read
  const detail = await rpc('get', { path: receipt.path })
  check('get returns the body', detail.body === '# Live verification\n\n1. Create.\n2. Read.\n3. Rename.\n4. Delete.')
  check('get returns the frontmatter', detail.frontmatter.name === name)

  // 3. disable the model surface only
  const toggled = await rpc('setInvocation', { path: receipt.path, modelInvocable: false })
  check('setInvocation reports the new policy', toggled.invocation.modelInvocable === false && toggled.invocation.userInvocable === true)
  check('setInvocation rewrote the frontmatter', scanner.readSkillFile(receipt.path).invocation.modelInvocable === false)

  // 4. rename (and re-enable in the same update)
  const updated = await rpc('update', {
    path: receipt.path,
    definition: {
      name: renamed,
      description: 'Live verification skill after a rename.',
      whenToUse: '',
      modelInvocable: true,
      userInvocable: true,
      body: '# Live verification\n\nRenamed in place.',
    },
  })
  created.push(updated.path)
  check('rename moved the bundle', updated.path !== receipt.path && existsSync(updated.path), updated.path)
  check('rename removed the old bundle', !existsSync(receipt.path), receipt.path)
  const renamedSkill = scanner.readSkillFile(updated.path)
  check('rename rewrote the name', renamedSkill.name === renamed)
  check('rename re-enabled the model surface', renamedSkill.invocation.modelInvocable === true)
  check('rename replaced the body', renamedSkill.body === '# Live verification\n\nRenamed in place.')

  // 5. copy as a flat file in the same root
  const copied = await rpc('copy', { path: updated.path, definition: { name: flatCopy, layout: 'file' } })
  created.push(copied.path)
  check('copy wrote a flat file into the managed root', copied.path === join(root, `${flatCopy}.md`), copied.path)
  check('copy kept the body', readFileSync(copied.path, 'utf8').includes('Renamed in place.'))
  check('copy is listed with the flat layout', copied.snapshot.skills.some((row) => row.path === copied.path && row.layout === 'file'))

  // 6. delete the copy and the original
  const removedCopy = await rpc('remove', { path: copied.path })
  check('remove deleted the copy', removedCopy.removed === true && !existsSync(copied.path))
  const removed = await rpc('remove', { path: updated.path })
  check('remove deleted the bundle directory', removed.removed === true && !existsSync(updated.path))
  check('the snapshot no longer lists either skill', !removed.snapshot.skills.some((row) => row.name === renamed || row.name === flatCopy))

  // 7. import a pasted SKILL.md
  const pasted = [
    '---',
    `name: ${importedName}`,
    'description: Imported by verify-live.mjs.',
    'license: MIT',
    '---',
    '',
    '## Imported body',
    '',
    'Keep this line exactly.',
    '',
  ].join('\n')
  const imported = await rpc('import', { text: pasted })
  created.push(imported.path)
  check('import wrote the pasted skill', existsSync(imported.path) && imported.path === join(root, importedName, 'SKILL.md'), imported.path)
  check('import kept the pasted text byte for byte', readFileSync(imported.path, 'utf8') === pasted)
  const importedDetail = await rpc('get', { path: imported.path })
  check('import preserved unknown frontmatter keys', importedDetail.frontmatter.license === 'MIT')
  check('import kept the body', importedDetail.body.includes('Keep this line exactly.'))
  await rpc('remove', { path: imported.path })

  // 8. an unreadable entry can be discarded from the issues panel
  const brokenDirectory = join(root, brokenName)
  mkdirSync(brokenDirectory, { recursive: true })
  writeFileSync(join(brokenDirectory, 'SKILL.md'), '# no frontmatter\n', 'utf8')
  const brokenState = await rpc('state')
  const brokenIssue = brokenState.issues.find((issue) => issue.path === join(brokenDirectory, 'SKILL.md'))
  check('a malformed file is reported as an issue', brokenIssue !== undefined)
  const discarded = await rpc('discard', { path: brokenIssue.path })
  check('discard removed the unreadable bundle', discarded.removed === true && !existsSync(brokenDirectory))

  // 9. the root is clean again
  const finalState = await rpc('state')
  check('the final state has no verification skill', !finalState.skills.some((row) => row.name.startsWith('verify-')))
  check('the final state has no verification issue', !finalState.issues.some((issue) => issue.path.includes(brokenName)))
  check('the final state still has exactly one root', finalState.roots.length === 1)
  check('refresh answers with a snapshot', Array.isArray((await rpc('refresh', {})).skills))
} catch (error) {
  failures.push(String((error && error.message) || error))
} finally {
  for (const path of created) {
    try {
      await rpc('discard', { path })
    } catch {
      /* best effort cleanup */
    }
    try {
      await rpc('remove', { path })
    } catch {
      /* best effort cleanup */
    }
  }
  rmSync(join(root, brokenName), { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`live verification FAILED (${failures.length})`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log('live verification OK')
