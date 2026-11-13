/**
 * Offline benchmark for catalog discovery: how long a scan of N synthetic skills
 * takes, cold and warm, and what one externally edited file costs.
 *
 *   node test/bench-scan.mjs                        # this checkout's scanner
 *   node test/bench-scan.mjs --skills 800 --scans 20
 *   node test/bench-scan.mjs --scanner <path/to/scanner.js>
 *
 * Every RPC request scans the root and the settings page polls every eight
 * seconds, so this number is the plugin's steady-state cost. The synthetic root
 * is a temporary directory and is removed afterwards; nothing in the real skill
 * root is touched.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const options = { skills: 400, scans: 20, scanner: join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'scanner.js') }
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index]
  const value = argv[index + 1]
  if (flag === '--skills') options.skills = Number(value)
  else if (flag === '--scans') options.scans = Number(value)
  else if (flag === '--scanner') options.scanner = resolve(value)
  else if (flag === '--help' || flag === '-h') {
    console.log('usage: node test/bench-scan.mjs [--skills N] [--scans N] [--scanner PATH]')
    process.exit(0)
  } else {
    console.error(`unknown argument: ${flag}`)
    process.exit(2)
  }
  index += 1
}
if (!Number.isInteger(options.skills) || options.skills < 1) throw new Error('--skills must be a positive integer')
if (!Number.isInteger(options.scans) || options.scans < 1) throw new Error('--scans must be a positive integer')

const scanner = await import(pathToFileURL(options.scanner).href)
console.log(`scanner: ${options.scanner}`)

const base = mkdtempSync(join(tmpdir(), 'dsh-skill-manager-bench-'))
const root = join(base, 'skills')
const body = `# Instructions\n\n${'Do the thing carefully, then report what changed.\n'.repeat(20)}`

for (let index = 0; index < options.skills; index += 1) {
  const name = `skill-${String(index).padStart(4, '0')}`
  if (index % 2 === 0) {
    mkdirSync(join(root, name, 'references'), { recursive: true })
    writeFileSync(join(root, name, 'references', 'notes.md'), '# resource\n')
    writeFileSync(
      join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Synthetic ${name} for the scan benchmark.\nwhenToUse: When benchmarking.\nmetadata:\n  owner: bench\n---\n\n${body}`,
    )
  } else {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, `${name}.md`), `---\nname: ${name}\ndescription: Synthetic ${name} for the scan benchmark.\n---\n\n${body}`)
  }
}

/** One full discovery pass: the work every `state` request performs. */
const scan = () => {
  const discovered = scanner.scanRoot({ path: root, skipSystem: true })
  return scanner.resolveCatalog(discovered.skills)
}

const time = (runs) => {
  const started = process.hrtime.bigint()
  for (let index = 0; index < runs; index += 1) scan()
  return Number(process.hrtime.bigint() - started) / 1e6
}

try {
  const cold = time(1)
  const rows = scan()
  const warm = time(options.scans)
  // One externally edited file: the next scan should re-read only that file.
  writeFileSync(join(root, 'skill-0000', 'SKILL.md'), `---\nname: skill-0000\ndescription: Edited.\n---\n\n${body}`, 'utf8')
  const edited = time(1)
  // A rewritten file whose bytes and mtime are identical must not be re-parsed
  // by a header cache, but a genuinely changed one must be.
  const unchanged = time(1)
  const row = scan().find((candidate) => candidate.name === 'skill-0000')
  const perFile = cold / options.skills
  console.log(`skills: ${options.skills}`)
  console.log(`cold scan:            ${cold.toFixed(1)} ms (${perFile.toFixed(3)} ms/file)`)
  console.log(`warm scan (${String(options.scans).padStart(2)} runs): ${warm.toFixed(1)} ms (${(warm / options.scans).toFixed(2)} ms/scan)`)
  console.log(`after editing 1 file: ${edited.toFixed(1)} ms`)
  console.log(`stable rescan:        ${unchanged.toFixed(1)} ms`)
  console.log(`rows: ${rows.length}, edited description: ${JSON.stringify(row?.description)}`)
  if (rows.length !== options.skills) throw new Error(`expected ${options.skills} rows, got ${rows.length}`)
  if (row?.description !== 'Edited.') throw new Error('the edit was not picked up by the next scan')
} finally {
  rmSync(base, { recursive: true, force: true })
}
