/**
 * Persistent supervisor for the bundled PowerShell desktop runner.
 *
 * A cold `powershell.exe` start costs 0.5-1.2 s per desktop action, which is
 * most of a click's latency. This module keeps one `computer.ps1 -Server`
 * process warm, speaks JSON Lines with it, serializes calls so two tools never
 * interleave desktop input, restarts it after a crash, and falls back to a
 * one-shot process when server mode cannot start or dies before answering a
 * read-only action.
 *
 * Input actions are never retried after a transport failure: the action may
 * already have reached the desktop, and repeating a click or keystroke is worse
 * than reporting the failure. Read-only actions (`info`, `windows`,
 * `foreground`, `screenshot`, and `ui list`) may be retried once through the
 * one-shot path.
 *
 * @module dsh-computer-control/runner
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Shown when the platform cannot run the bundled runner. */
export const UNSUPPORTED =
  'computer control requires Windows: the bundled action runner drives user32.dll through Windows PowerShell'
/** Default wall-clock bound for one desktop action. */
export const DEFAULT_TIMEOUT_MS = 120_000
/** How long the first server response may take; the helper DLL may compile. */
const STARTUP_TIMEOUT_MS = 30_000
/** How long an idle server stays alive before it is shut down. */
const IDLE_TIMEOUT_MS = 180_000
/** Restart budget after a server that was previously healthy crashes. */
const MAX_RESTARTS = 3
/** Keep the newest diagnostics from the child's stderr. */
const DIAGNOSTIC_LIMIT = 64 * 1024
/** Actions that may be replayed safely after a transport failure. */
const RETRY_SAFE_ACTIONS = new Set(['info', 'windows', 'foreground', 'screenshot'])

/** Cache of the resolved Windows PowerShell executable. */
let powershellPath

/**
 * Locate Windows PowerShell 5.1, which ships System.Drawing and
 * System.Windows.Forms (needed for capture and UIA); `pwsh` 7 does not.
 * @returns executable path or command name.
 */
export function resolvePowerShell() {
  if (powershellPath !== undefined) return powershellPath
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  powershellPath = existsSync(candidate) ? candidate : 'pwsh'
  return powershellPath
}

/**
 * Reduce a PowerShell or runner error stream to the first useful line.
 * @param stderr - captured stderr.
 * @returns one diagnostic line.
 */
export function firstDiagnostic(stderr) {
  const text = typeof stderr === 'string' ? stderr : ''
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  for (const line of lines) {
    if (line.startsWith('COMPUTER_CONTROL_ERROR:')) {
      const detail = line.slice('COMPUTER_CONTROL_ERROR:'.length).trim()
      if (detail !== '') return detail
    }
  }
  for (const line of lines) {
    if (/^(At line|At char|At |\+ |CategoryInfo|FullyQualifiedErrorId|Exception calling|<!--)/.test(line)) continue
    return line
  }
  return lines[0] ?? 'the desktop action failed'
}

/** A clean error returned by the runner, as opposed to a transport failure. */
class DesktopActionError extends Error {
  /** @param message - runner-provided message. */
  constructor(message) {
    super(message)
    this.name = 'DesktopActionError'
    this.desktopActionError = true
  }
}

/** A caller-cancelled call; never replayed through the fallback path. */
class CancelledError extends Error {
  /** @param message - cancellation detail. */
  constructor(message) {
    super(message)
    this.name = 'CancelledError'
    this.noRetry = true
  }
}

/** Write a one-shot payload, sweeping abandoned files once per process. */
let swept = false
function sweepStalePayloads() {
  if (swept) return
  swept = true
  const cutoff = Date.now() - 60 * 60 * 1000
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith('dsh-computer-control-') || !name.endsWith('.json')) continue
      const path = join(tmpdir(), name)
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
      } catch {
        // A file another process just removed is not a problem.
      }
    }
  } catch {
    // The temporary directory is not always listable; the payload still works.
  }
}

/**
 * Serialized supervisor for one warm action runner plus its one-shot fallback.
 */
export class DesktopRunner {
  /** @type {string} */
  #scriptPath
  /** @type {number} */
  #timeoutMs
  /** @type {number} */
  #startupTimeoutMs
  /** @type {number} */
  #idleTimeoutMs
  /** @type {boolean} */
  #persistent
  /** @type {NodeJS.ProcessEnv} */
  #env
  /** @type {import('node:child_process').ChildProcess | null} */
  #child = null
  /** @type {number} */
  #generation = 0
  /** @type {Promise<import('node:child_process').ChildProcess> | null} */
  #readyPromise = null
  /** @type {{ generation: number, resolve: Function, reject: Function, timer: NodeJS.Timeout } | null} */
  #startWaiter = null
  /** @type {{ id: number, finish: Function } | null} */
  #pending = null
  /** @type {Promise<unknown>} */
  #chain = Promise.resolve()
  /** @type {NodeJS.Timeout | null} */
  #idleTimer = null
  /** @type {NodeJS.Timeout | null} */
  #exitTimer = null
  /** @type {string} */
  #stdoutBuffer = ''
  /** @type {string} */
  #stderr = ''
  /** @type {number} */
  #nextId = 0
  /** @type {boolean} */
  #everReady = false
  /** @type {number} */
  #restartFailures = 0
  /** @type {boolean} */
  #serverDisabled = false
  /** @type {boolean} */
  #disposed = false
  /** @type {object} */
  #stats = {
    serverStarts: 0,
    oneShotRuns: 0,
    requests: 0,
    crashes: 0,
    timeouts: 0,
    kills: 0,
    fallbacks: 0,
  }

  /** @type {() => void} */
  #exitHook = () => {
    const child = this.#child
    this.#child = null
    this.#generation++
    if (child !== null) {
      try {
        child.kill()
      } catch {
        // The process is already gone.
      }
    }
  }

  /**
   * @param options - runner configuration.
   * @param options.scriptPath - absolute path of `computer.ps1`.
   * @param options.timeoutMs - per-action timeout.
   * @param options.startupTimeoutMs - first server response timeout.
   * @param options.idleTimeoutMs - idle shutdown delay; 0 disables it.
   * @param options.persistent - false forces the one-shot path.
   * @param options.env - process environment for children.
   */
  constructor(options) {
    if (options === null || typeof options !== 'object' || typeof options.scriptPath !== 'string') {
      throw new Error('DesktopRunner requires an absolute scriptPath')
    }
    this.#scriptPath = options.scriptPath
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    this.#startupTimeoutMs = positive(options.startupTimeoutMs, STARTUP_TIMEOUT_MS)
    this.#idleTimeoutMs = options.idleTimeoutMs === undefined ? IDLE_TIMEOUT_MS : Math.max(0, Number(options.idleTimeoutMs))
    this.#persistent = options.persistent !== false
    this.#env = options.env ?? process.env
    if (process.platform === 'win32') process.once('exit', this.#exitHook)
  }

  /** Snapshot of runner counters and transport state. */
  get stats() {
    return {
      ...this.#stats,
      serverRunning: this.#child !== null,
      serverDisabled: this.#serverDisabled,
      pending: this.#pending !== null,
    }
  }

  /**
   * Run one desktop action, serialized with every other call on this runner.
   * @param action - runner action name.
   * @param payload - action arguments.
   * @param signal - caller cancellation.
   * @returns the parsed JSON result.
   */
  run(action, payload, signal) {
    if (process.platform !== 'win32') return Promise.reject(new Error(UNSUPPORTED))
    if (this.#disposed) return Promise.reject(new Error('the desktop runner has been disposed'))
    if (typeof action !== 'string' || action === '') {
      return Promise.reject(new Error('the desktop action name is missing'))
    }
    if (signal !== undefined && signal.aborted) {
      return Promise.reject(new CancelledError(`the desktop action "${action}" was cancelled before it started`))
    }
    const task = this.#chain.then(() => this.#execute(action, payload, signal))
    this.#chain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  /**
   * Stop the warm process (if any) and reject outstanding work.
   * @returns completion after the process is gone or the grace period expires.
   */
  dispose() {
    if (this.#disposed) return Promise.resolve()
    this.#disposed = true
    this.#clearIdle()
    process.removeListener('exit', this.#exitHook)

    const waiter = this.#startWaiter
    this.#startWaiter = null
    if (waiter !== null) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('the desktop runner was disposed'))
    }
    this.#completePending(new Error('the desktop runner was disposed'))

    const child = this.#child
    this.#child = null
    this.#generation++
    this.#readyPromise = null
    if (child === null) return Promise.resolve()

    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        if (this.#exitTimer !== null) {
          clearTimeout(this.#exitTimer)
          this.#exitTimer = null
        }
        resolve()
      }
      child.once('exit', finish)
      this.#exitTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        finish()
      }, 1500)
      this.#exitTimer.unref?.()
      try {
        child.stdin.write(JSON.stringify({ id: 0, action: 'shutdown' }) + '\n')
        child.stdin.end()
      } catch {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      }
    })
  }

  /**
   * Run one action through the warm server, or fall back when a read-only action
   * cannot reach it.
   * @param action - runner action.
   * @param payload - action arguments.
   * @param signal - cancellation.
   * @returns the result.
   */
  async #execute(action, payload, signal) {
    if (this.#disposed) throw new Error('the desktop runner has been disposed')
    if (signal !== undefined && signal.aborted) {
      throw new CancelledError(`the desktop action "${action}" was cancelled before it started`)
    }
    this.#stats.requests++
    if (this.#persistent && !this.#serverDisabled) {
      try {
        return await this.#callServer(action, payload, signal)
      } catch (error) {
        if (error !== null && typeof error === 'object' && (error.desktopActionError === true || error.noRetry === true)) {
          throw error
        }
        this.#stats.fallbacks++
        if (!RETRY_SAFE_ACTIONS.has(action)) {
          throw new Error(`${errorMessage(error)} (not retried: "${action}" may already have reached the desktop)`)
        }
      }
    }
    return this.#oneShot(action, payload, signal)
  }

  /**
   * Send one request and wait for its response.
   * @param action - runner action.
   * @param payload - action arguments.
   * @param signal - cancellation.
   * @returns the result.
   */
  async #callServer(action, payload, signal) {
    if (this.#pending !== null) throw new Error('the desktop runner already has an action in flight')
    const child = await this.#ensureServer()
    if (child !== this.#child) throw new Error('the desktop runner restarted before the action started')
    if (signal !== undefined && signal.aborted) {
      this.#killServer('cancelled before dispatch')
      throw new CancelledError(`the desktop action "${action}" was cancelled before it started`)
    }

    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        this.#killServer('timeout')
        finish(new CancelledError(`the desktop action "${action}" did not finish within ${this.#timeoutMs} ms`))
      }, this.#timeoutMs)
      const onAbort = () => {
        this.#killServer('cancelled')
        finish(new CancelledError(`the desktop action "${action}" was cancelled`))
      }
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        if (this.#pending !== null && this.#pending.id === id) this.#pending = null
        this.#armIdle()
        if (error !== undefined) reject(error)
        else resolve(value)
      }
      this.#pending = { id, finish }
      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
      if (signal !== undefined && signal.aborted) {
        onAbort()
        return
      }
      try {
        child.stdin.write(JSON.stringify({ id, action, payload: payload ?? {} }) + '\n', 'utf8')
      } catch (error) {
        this.#killServer('write failed')
        finish(new Error(`cannot send the desktop action to the persistent runner: ${errorMessage(error)}`))
      }
    })
  }

  /**
   * Start the server on demand and cache the ready promise.
   * @returns the ready child.
   */
  #ensureServer() {
    if (this.#readyPromise !== null) return this.#readyPromise
    const attempt = this.#startServer()
    this.#readyPromise = attempt
    attempt.catch(() => {
      if (this.#readyPromise === attempt) this.#readyPromise = null
    })
    return attempt
  }

  /**
   * Spawn one server process and wait for its ready line.
   * @returns the ready child.
   */
  #startServer() {
    if (this.#disposed) return Promise.reject(new Error('the desktop runner has been disposed'))
    const generation = ++this.#generation
    this.#stdoutBuffer = ''
    this.#stderr = ''
    let child
    try {
      child = spawn(
        resolvePowerShell(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.#scriptPath, '-Server'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: this.#env },
      )
    } catch (error) {
      this.#serverDisabled = true
      return Promise.reject(new Error(`cannot start the persistent desktop runner: ${errorMessage(error)}`))
    }
    this.#child = child
    this.#stats.serverStarts++

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(generation, chunk))
    child.stderr.on('data', (chunk) => {
      if (generation !== this.#generation) return
      this.#stderr = (this.#stderr + chunk).slice(-DIAGNOSTIC_LIMIT)
    })
    child.on('error', (error) => {
      if (generation !== this.#generation) return
      this.#failTransport(generation, new Error(`cannot run the persistent desktop runner: ${error.message}`))
    })
    child.on('close', (code) => {
      if (generation !== this.#generation) return
      const diagnostic = firstDiagnostic(this.#stderr)
      const suffix = this.#stderr.trim() === '' ? '' : `: ${diagnostic}`
      this.#failTransport(generation, new Error(`the persistent desktop runner exited (code ${code})${suffix}`))
    })

    let readyResolve
    let readyReject
    const readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    const rejectReady = (error) => {
      const waiter = this.#startWaiter
      this.#startWaiter = null
      if (waiter !== null) clearTimeout(waiter.timer)
      readyReject(error)
    }
    const timer = setTimeout(() => {
      if (this.#startWaiter === null || this.#startWaiter.generation !== generation) return
      this.#killServer('startup timeout', generation)
      this.#serverDisabled = true
      rejectReady(new Error(`the persistent desktop runner did not start within ${this.#startupTimeoutMs} ms`))
    }, this.#startupTimeoutMs)
    timer.unref?.()
    this.#startWaiter = {
      generation,
      resolve: readyResolve,
      reject: rejectReady,
      timer,
    }
    return readyPromise
  }

  /**
   * Handle one stdout line from a server generation.
   * @param generation - child generation.
   * @param chunk - decoded stdout.
   */
  #onStdout(generation, chunk) {
    if (generation !== this.#generation) return
    this.#stdoutBuffer += chunk
    let index = this.#stdoutBuffer.indexOf('\n')
    while (index >= 0) {
      const line = this.#stdoutBuffer.slice(0, index).replace(/\r$/, '')
      this.#stdoutBuffer = this.#stdoutBuffer.slice(index + 1)
      if (line.trim() !== '') this.#onLine(generation, line)
      index = this.#stdoutBuffer.indexOf('\n')
    }
    if (this.#stdoutBuffer.length > 1_000_000) this.#stdoutBuffer = ''
  }

  /**
   * Dispatch one ready line or one action response.
   * @param generation - child generation.
   * @param line - one JSON line.
   */
  #onLine(generation, line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return

    if (message.ready === true) {
      const waiter = this.#startWaiter
      if (waiter === null || waiter.generation !== generation) return
      this.#startWaiter = null
      clearTimeout(waiter.timer)
      this.#everReady = true
      this.#restartFailures = 0
      this.#armIdle()
      waiter.resolve(this.#child)
      return
    }

    if (!Number.isInteger(message.id)) return
    const pending = this.#pending
    if (pending === null || pending.id !== message.id) return
    this.#pending = null
    if (message.ok === true) {
      this.#restartFailures = 0
      pending.finish(undefined, message.result)
    } else {
      const detail = typeof message.error === 'string' && message.error !== ''
        ? message.error
        : 'the desktop action failed without a message'
      pending.finish(new DesktopActionError(detail))
    }
    this.#armIdle()
  }

  /**
   * Fail the current generation after a crash or spawn error.
   * @param generation - child generation.
   * @param error - transport error.
   */
  #failTransport(generation, error) {
    if (generation !== this.#generation) return
    this.#child = null
    this.#readyPromise = null
    this.#generation++
    this.#clearIdle()
    this.#stats.crashes++

    const waiter = this.#startWaiter
    if (waiter !== null && waiter.generation === generation) {
      this.#startWaiter = null
      clearTimeout(waiter.timer)
      waiter.reject(error)
      // A server that never became ready is a startup failure, not a crash loop.
      this.#serverDisabled = true
      return
    }
    if (this.#everReady) {
      this.#restartFailures++
      if (this.#restartFailures > MAX_RESTARTS) this.#serverDisabled = true
    }
    this.#completePending(
      new Error(`${error.message}${this.#everReady ? '' : ' (server mode disabled; using one-shot runs)'}`),
    )
  }

  /**
   * Settle the in-flight request, if any.
   * @param error - rejection reason.
   */
  #completePending(error) {
    const pending = this.#pending
    if (pending === null) return
    this.#pending = null
    pending.finish(error)
  }

  /**
   * Stop the current server generation.
   * @param reason - recorded reason.
   * @param generation - only act on this generation.
   */
  #killServer(reason, generation) {
    if (generation !== undefined && generation !== this.#generation) return
    const child = this.#child
    if (child === null) return
    this.#child = null
    this.#readyPromise = null
    this.#generation++
    this.#clearIdle()
    this.#stats.kills++
    void reason
    try {
      child.kill()
    } catch {
      // Already gone.
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }, 1500)
    timer.unref?.()
  }

  /** Arm the idle shutdown timer. */
  #armIdle() {
    this.#clearIdle()
    if (!this.#persistent || this.#idleTimeoutMs <= 0 || this.#child === null) return
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null
      if (this.#pending !== null) return
      const child = this.#child
      if (child === null) return
      this.#child = null
      this.#readyPromise = null
      this.#generation++
      try {
        child.stdin.write(JSON.stringify({ id: 0, action: 'shutdown' }) + '\n')
        child.stdin.end()
      } catch {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      }, 1000)
      timer.unref?.()
    }, this.#idleTimeoutMs)
    this.#idleTimer.unref?.()
  }

  /** Cancel the idle shutdown timer. */
  #clearIdle() {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = null
    }
  }

  /**
   * Run one action in a fresh process.
   * @param action - runner action.
   * @param payload - action arguments.
   * @param signal - cancellation.
   * @returns the result.
   */
  #oneShot(action, payload, signal) {
    if (process.platform !== 'win32') return Promise.reject(new Error(UNSUPPORTED))
    sweepStalePayloads()
    this.#stats.oneShotRuns++
    const payloadPath = join(tmpdir(), `dsh-computer-control-${randomBytes(8).toString('hex')}.json`)
    try {
      writeFileSync(payloadPath, JSON.stringify(payload ?? {}), 'utf8')
    } catch (error) {
      return Promise.reject(new Error(`cannot write the desktop action payload: ${errorMessage(error)}`))
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        try {
          unlinkSync(payloadPath)
        } catch {
          // Best effort: a leftover payload file carries no secrets.
        }
      }
      let child
      try {
        child = spawn(
          resolvePowerShell(),
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            this.#scriptPath,
            '-Action',
            action,
            '-PayloadPath',
            payloadPath,
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: this.#env },
        )
      } catch (error) {
        cleanup()
        reject(new Error(`cannot start the desktop action runner: ${errorMessage(error)}`))
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false
      let killTimer = null
      let deferred = null
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killTimer !== null) clearTimeout(killTimer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        cleanup()
        if (error !== undefined) reject(error)
        else resolve(value)
      }
      const stop = (error) => {
        if (settled) return
        deferred = error
        try {
          child.kill()
        } catch {
          // Already gone.
        }
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // Already gone.
          }
          finish(error)
        }, 2000)
        killTimer.unref?.()
      }
      const onAbort = () => {
        stop(new Error(`the desktop action "${action}" was cancelled`))
      }
      const timer = setTimeout(() => {
        this.#stats.timeouts++
        stop(new Error(`the desktop action "${action}" did not finish within ${this.#timeoutMs} ms`))
      }, this.#timeoutMs)

      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-DIAGNOSTIC_LIMIT)
      })
      child.on('error', (error) => {
        finish(new Error(`cannot start the desktop action runner: ${error.message}`))
      })
      child.on('close', (code) => {
        if (deferred !== null) {
          finish(deferred)
          return
        }
        if (code !== 0) {
          const detail = stderr.trim() === '' ? `exit code ${code}` : firstDiagnostic(stderr)
          finish(new Error(detail))
          return
        }
        const text = stdout.trim()
        if (text === '') {
          finish(new Error('the desktop action returned no result'))
          return
        }
        try {
          finish(undefined, JSON.parse(text))
        } catch {
          finish(new Error(`the desktop action returned unreadable output: ${text.slice(0, 400)}`))
        }
      })
    })
  }
}

/**
 * Coerce a positive finite number with a fallback.
 * @param value - candidate.
 * @param fallback - default.
 * @returns a usable integer.
 */
function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

/**
 * Read a message off an unknown thrown value.
 * @param error - thrown value.
 * @returns a diagnostic string.
 */
function errorMessage(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
