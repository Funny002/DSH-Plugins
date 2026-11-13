/**
 * Offline checks for the Node supervisor: warm-server reuse, one-shot fallback,
 * payload cleanup, timeouts, cancellation, and the "server mode cannot start"
 * fallback path. Uses only read-only desktop actions (`info`); it never sends
 * mouse or keyboard input.
 *
 *   node test/runner-check.mjs
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopRunner } from '../lib/runner.js'

const scriptPath = fileURLToPath(new URL('../lib/computer.ps1', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'dsh-computer-control-runner-'))
const failures = []
const check = (label, condition, detail = '') => {
  if (!condition) failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`)
}
const payloads = () => new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-computer-control-') && name.endsWith('.json')))

let runner
try {
  // Warm server reuse.
  runner = new DesktopRunner({ scriptPath, timeoutMs: 60000, idleTimeoutMs: 0 })
  await runner.run('info', {})
  await runner.run('windows', {})
  check('two calls reuse one warm server', runner.stats.serverStarts === 1 && runner.stats.oneShotRuns === 0, JSON.stringify(runner.stats))
  check('the warm server is running', runner.stats.serverRunning === true, JSON.stringify(runner.stats))
  await runner.dispose()
  check('dispose stops the warm server', runner.stats.serverRunning === false, JSON.stringify(runner.stats))

  // One-shot path and payload cleanup.
  const before = payloads()
  const oneShot = new DesktopRunner({ scriptPath, timeoutMs: 60000, persistent: false })
  const info = await oneShot.run('info', {})
  check('the one-shot path returns a result', info.virtualScreen.width > 0)
  check('the one-shot path counts its run', oneShot.stats.oneShotRuns === 1, JSON.stringify(oneShot.stats))
  await oneShot.dispose()
  const leaked = [...payloads()].filter((name) => !before.has(name))
  check('the one-shot payload file is removed', leaked.length === 0, leaked.join(', '))

  // A server that cannot start falls back to one-shot for read-only actions.
  const wrapper = join(work, 'no-server.ps1')
  writeFileSync(
    wrapper,
    `#requires -Version 5.1\nparam([string]$Action, [string]$PayloadPath, [switch]$Server)\n` +
      `if ($Server) { [Console]::Error.WriteLine('COMPUTER_CONTROL_ERROR: server mode disabled for test'); exit 1 }\n` +
      `& '${scriptPath}' -Action $Action -PayloadPath $PayloadPath\n` +
      `exit $LASTEXITCODE\n`,
    'utf8',
  )
  const fallback = new DesktopRunner({ scriptPath: wrapper, timeoutMs: 60000, idleTimeoutMs: 0 })
  const fallbackInfo = await fallback.run('info', {})
  check('a failed server falls back to one-shot', fallbackInfo.virtualScreen.width > 0 && fallback.stats.fallbacks === 1, JSON.stringify(fallback.stats))
  check('a failed server is disabled for later calls', fallback.stats.serverDisabled === true, JSON.stringify(fallback.stats))
  await fallback.dispose()

  // Timeout kills the one-shot process and removes its payload.
  const beforeTimeout = payloads()
  const timed = new DesktopRunner({ scriptPath, timeoutMs: 1, persistent: false })
  let timeoutMessage = ''
  try {
    await timed.run('screenshot', { path: join(work, 'timeout.png'), all: true })
  } catch (error) {
    timeoutMessage = error instanceof Error ? error.message : String(error)
  }
  check('a timeout rejects the call', /did not finish within 1 ms/.test(timeoutMessage), timeoutMessage)
  check('a timeout is counted', timed.stats.timeouts === 1, JSON.stringify(timed.stats))
  await timed.dispose()
  const timeoutLeaks = [...payloads()].filter((name) => !beforeTimeout.has(name))
  check('a timed-out payload file is removed', timeoutLeaks.length === 0, timeoutLeaks.join(', '))
  if (existsSync(join(work, 'timeout.png'))) rmSync(join(work, 'timeout.png'), { force: true })

  // Cancellation of an in-flight server action kills that server; the next call restarts it.
  const cancel = new DesktopRunner({ scriptPath, timeoutMs: 60000, idleTimeoutMs: 0 })
  await cancel.run('info', {})
  const controller = new AbortController()
  const pending = cancel.run('screenshot', { path: join(work, 'cancel.png'), all: true }, controller.signal)
  setTimeout(() => controller.abort(), 2)
  let cancelMessage = ''
  try {
    await pending
  } catch (error) {
    cancelMessage = error instanceof Error ? error.message : String(error)
  }
  check('cancellation rejects the call', /cancelled/.test(cancelMessage), cancelMessage)
  check('cancellation stops the server process', cancel.stats.serverRunning === false, JSON.stringify(cancel.stats))
  const restarted = await cancel.run('info', {})
  check('the next call restarts the server', restarted.virtualScreen.width > 0 && cancel.stats.serverStarts >= 2, JSON.stringify(cancel.stats))
  await cancel.dispose()
  if (existsSync(join(work, 'cancel.png'))) rmSync(join(work, 'cancel.png'), { force: true })
} catch (error) {
  failures.push(`unexpected: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  if (runner !== undefined) {
    try {
      await runner.dispose()
    } catch {
      // Best effort.
    }
  }
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`FAIL runner-check (${failures.length})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('PASS runner-check: warm server, one-shot, fallback, timeout, cancellation')
}
