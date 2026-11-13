/**
 * Latency check: starts the disposable test window (topmost, so every move lands
 * on our own window), then times 20 `move` actions through a cold one-shot
 * process and 20 through the warm server. The pointer is restored afterwards.
 *
 *   node test/perf.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { DesktopRunner } from '../lib/runner.js'

const scriptPath = fileURLToPath(new URL('../lib/computer.ps1', import.meta.url))
const testWindow = fileURLToPath(new URL('./test-window.ps1', import.meta.url))
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const work = mkdtempSync(join(tmpdir(), 'dsh-computer-control-perf-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const total = samples.reduce((sum, value) => sum + value, 0)
  return {
    count: samples.length,
    totalMs: Math.round(total),
    avgMs: Number((total / samples.length).toFixed(2)),
    minMs: Number(sorted[0].toFixed(2)),
    p50Ms: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
  }
}

async function waitForWindow(runner) {
  for (let i = 0; i < 60; i++) {
    await sleep(200)
    const listing = await runner.run('windows', {})
    const match = listing.windows.find((window) => window.title === 'DSH Computer Control Test')
    if (match !== undefined) return match
  }
  return undefined
}

const windowProcess = spawn(
  powershell,
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', testWindow, '-ResultPath', join(work, 'result.txt'), '-TopMost'],
  { stdio: 'ignore' },
)
let setup
let oneShot
let server
const originalCursor = { x: 0, y: 0 }
try {
  setup = new DesktopRunner({ scriptPath, timeoutMs: 60000, idleTimeoutMs: 0 })
  const window = await waitForWindow(setup)
  if (window === undefined) throw new Error('the test window never appeared')
  await setup.run('focus', { hwnd: window.hwnd })
  const info = await setup.run('info', {})
  originalCursor.x = info.cursor.x
  originalCursor.y = info.cursor.y

  const points = []
  for (let i = 0; i < 20; i++) {
    points.push({
      x: window.x + 80 + (i % 10) * 30,
      y: window.y + 260 + (i % 3) * 40,
    })
  }

  // One-shot baseline, including one warm-up call so helper compilation is not
  // charged to the first measured action.
  oneShot = new DesktopRunner({ scriptPath, timeoutMs: 60000, persistent: false })
  const coldStart = performance.now()
  await oneShot.run('info', {})
  const coldStartMs = performance.now() - coldStart
  const oneShotSamples = []
  for (const point of points) {
    const started = performance.now()
    await oneShot.run('move', point)
    oneShotSamples.push(performance.now() - started)
  }
  await oneShot.dispose()

  // Warm server.
  server = new DesktopRunner({ scriptPath, timeoutMs: 60000, idleTimeoutMs: 0 })
  const serverStart = performance.now()
  await server.run('info', {})
  const serverStartMs = performance.now() - serverStart
  await server.run('focus', { hwnd: window.hwnd })
  const serverSamples = []
  for (const point of points) {
    const started = performance.now()
    await server.run('move', point)
    serverSamples.push(performance.now() - started)
  }

  // Restore the pointer through the warm server, then report.
  await server.run('move', originalCursor)
  const oneShotSummary = summarize(oneShotSamples)
  const serverSummary = summarize(serverSamples)
  console.log(JSON.stringify({
    target: '20 × move, sequential, same test window',
    coldStartMs: Math.round(coldStartMs),
    serverStartMs: Math.round(serverStartMs),
    oneShot: oneShotSummary,
    server: serverSummary,
    speedup: Number((oneShotSummary.avgMs / serverSummary.avgMs).toFixed(1)),
  }, null, 2))
} catch (error) {
  console.error(`FAIL perf: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  try {
    if (server !== undefined) await server.dispose()
  } catch {
    // Best effort.
  }
  try {
    if (oneShot !== undefined) await oneShot.dispose()
  } catch {
    // Best effort.
  }
  try {
    if (setup !== undefined) {
      await setup.run('move', originalCursor)
      await setup.dispose()
    }
  } catch {
    // Best effort.
  }
  windowProcess.kill()
  await sleep(200)
  windowProcess.kill('SIGKILL')
  rmSync(work, { recursive: true, force: true })
}
