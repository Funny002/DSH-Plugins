/**
 * End-to-end checks through the real plugin registration and the persistent
 * runner. Starts the disposable WinForms window, drives it with the model-facing
 * tools (window list/focus, UIA list/setValue/invoke/select/click, mouse,
 * keyboard with the `expect` guard, screenshot), and proves the result by
 * reading the files the window wrote.
 *
 *   node test/tools-check.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testWindow = fileURLToPath(new URL('./test-window.ps1', import.meta.url))
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) return
  failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForContent(path, expected, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        last = readFileSync(path, 'utf8').trim()
        if (last === expected) return last
      } catch {
        // The window may still be writing.
      }
    }
    await sleep(120)
  }
  return last
}

async function waitForWindow(tools, title, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const listing = await tools.get('computer_window').execute({ action: 'list' }, { signal: undefined })
    const match = listing.detail.windows.find((window) => window.title === title)
    if (match !== undefined) return match
    await sleep(150)
  }
  return undefined
}

const home = mkdtempSync(join(tmpdir(), 'dsh-computer-control-tools-'))
process.env.DSH_HOME = home
const plugin = await import(new URL('../lib/index.js', import.meta.url).href)
const registered = new Map()
const disposers = []
const ctx = {
  get() {
    return undefined
  },
  effect(fn) {
    disposers.push(fn())
  },
  inject(_names, callback) {
    callback({
      effect(fn) {
        disposers.push(fn())
      },
      tools: {
        register(definition) {
          registered.set(definition.name, definition)
          return () => registered.delete(definition.name)
        },
      },
    })
  },
}
plugin.apply(ctx, {})

const exec = { signal: new AbortController().signal }
const work = join(home, 'test-window')
const resultPath = join(work, 'result.txt')
const selectionPath = `${resultPath}.selection`
const unicode = `tool ${String.fromCharCode(0x4e2d, 0x6587)} ${String.fromCodePoint(0x1f600)}`
let windowProcess

try {
  mkdirSync(work, { recursive: true })
  windowProcess = spawn(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', testWindow, '-ResultPath', resultPath],
    { stdio: 'ignore' },
  )

  const window = await waitForWindow(registered, 'DSH Computer Control Test')
  check('test window is listed', window !== undefined, String(window?.hwnd))
  if (window === undefined) throw new Error('the test window never appeared')

  const focus = await registered.get('computer_window').execute({ action: 'focus', hwnd: window.hwnd }, exec)
  check('focus verifies the foreground window', focus.detail.foreground === true, JSON.stringify(focus.detail))

  const listed = await registered.get('computer_ui').execute({ action: 'list', hwnd: window.hwnd, maxDepth: 6 }, exec)
  const controls = listed.controls
  const edit = controls.find((control) => control.name === 'testBox')
  const button = controls.find((control) => control.name === 'OK')
  const list = controls.find((control) => control.name === 'choiceList')
  const label = controls.find((control) => control.name === 'statusLabel')
  check('UIA lists the text box', edit !== undefined && edit.type === 'Edit', JSON.stringify(edit))
  check('UIA lists the OK button', button !== undefined && button.type === 'Button', JSON.stringify(button))
  check('UIA lists the list box with items', list !== undefined && Array.isArray(list.items) && list.items.length === 3, JSON.stringify(list))
  check('the text box supports Value', edit?.patterns?.includes('Value') === true, JSON.stringify(edit?.patterns))
  check('the button supports Invoke', button?.patterns?.includes('Invoke') === true, JSON.stringify(button?.patterns))

  const set = await registered.get('computer_ui').execute({ action: 'setValue', hwnd: window.hwnd, name: 'testBox', value: unicode }, exec)
  check('setValue reports the written text', set.matched === true && set.value === unicode, JSON.stringify(set))

  const invoked = await registered.get('computer_ui').execute({ action: 'invoke', hwnd: window.hwnd, name: 'OK' }, exec)
  check('invoke reaches the OK button', invoked.ok === true && invoked.control.name === 'OK', JSON.stringify(invoked))
  const saved = await waitForContent(resultPath, unicode)
  check('the OK button wrote the Unicode text', saved === unicode, `saved=[${String(saved)}]`)

  const selected = await registered.get('computer_ui').execute({ action: 'select', hwnd: window.hwnd, name: 'choiceList', item: 'Beta' }, exec)
  check('select chooses the list item', selected.selected === true && selected.item === 'Beta', JSON.stringify(selected))
  const selection = await waitForContent(selectionPath, 'Beta')
  check('the list selection reached the window', selection === 'Beta', `selection=[${String(selection)}]`)

  const listAgain = await registered.get('computer_ui').execute({ action: 'list', hwnd: window.hwnd, name: 'choiceList', maxDepth: 4 }, exec)
  const beta = listAgain.controls[0]?.items?.find((item) => item.name === 'Beta')
  check('the list reflects the new selection', beta?.selected === true, JSON.stringify(beta))

  const screenshot = await registered.get('computer_screenshot').execute(
    {
      region: { x: window.x, y: window.y, width: Math.max(1, window.width), height: Math.max(1, window.height) },
      maxWidth: 800,
    },
    exec,
  )
  check('screenshot writes a PNG', existsSync(screenshot.path) && screenshot.bytes > 0, screenshot.path)
  check('screenshot reports the physical region', screenshot.originalWidth === window.width || screenshot.clamped === true, `${screenshot.originalWidth}/${window.width}`)
  check('screenshot includes the cursor', Number.isInteger(screenshot.cursorX) && Number.isInteger(screenshot.cursorY))

  const clickX = edit.x + Math.floor(edit.width / 2)
  const clickY = edit.y + Math.floor(edit.height / 2)
  await registered.get('computer_window').execute({ action: 'focus', hwnd: window.hwnd }, exec)
  const clicked = await registered.get('computer_mouse').execute(
    { action: 'click', x: clickX, y: clickY, expect: 'DSH Computer Control Test' },
    exec,
  )
  check('coordinate click targets the text box', clicked.detail.x === clickX && clicked.detail.y === clickY, JSON.stringify(clicked.detail))
  const focused = await registered.get('computer_ui').execute({ action: 'focus', hwnd: window.hwnd, name: 'testBox' }, exec)
  check('UIA focus lands on the text box', focused.focused === true, JSON.stringify(focused))
  await registered.get('computer_window').execute({ action: 'focus', hwnd: window.hwnd }, exec)
  const end = await registered.get('computer_keyboard').execute(
    { action: 'key', keys: 'end', expect: 'Computer Control Test' },
    exec,
  )
  check('the end chord is accepted', end.detail.pressed === 1, JSON.stringify(end.detail))

  const typed = await registered.get('computer_keyboard').execute(
    { action: 'type', text: ' typed', expect: 'Computer Control Test' },
    exec,
  )
  check('guarded typing reports the character count', typed.detail.typed === ' typed'.length, JSON.stringify(typed.detail))
  const afterType = await registered.get('computer_ui').execute({ action: 'list', hwnd: window.hwnd, name: 'testBox' }, exec)
  check(
    'typed text is visible in the control',
    afterType.controls[0]?.value === `${unicode} typed`,
    `value=[${String(afterType.controls[0]?.value)}]`,
  )

  let guardMessage = ''
  try {
    await registered.get('computer_keyboard').execute(
      { action: 'type', text: 'SHOULD-NOT-APPEAR', expect: 'a window that does not exist' },
      exec,
    )
  } catch (error) {
    guardMessage = error instanceof Error ? error.message : String(error)
  }
  check('a mismatched expect aborts typing', guardMessage.includes('refusing to send input'), guardMessage)

  const okCenter = { x: button.x + Math.floor(button.width / 2), y: button.y + Math.floor(button.height / 2) }
  await registered.get('computer_window').execute({ action: 'focus', hwnd: window.hwnd }, exec)
  const okClick = await registered.get('computer_mouse').execute(
    { action: 'click', x: okCenter.x, y: okCenter.y, expect: String(window.hwnd) },
    exec,
  )
  check('clicking OK accepts a handle guard', okClick.detail.hwnd === window.hwnd, JSON.stringify(okClick.detail))
  const finalText = await waitForContent(resultPath, `${unicode} typed`)
  check('typed text plus Unicode reaches the file', finalText === `${unicode} typed`, `saved=[${String(finalText)}]`)
  check('the guard-blocked text never reached the file', !String(finalText).includes('SHOULD-NOT-APPEAR'), String(finalText))

  const fallback = await registered.get('computer_ui').execute({ action: 'click', hwnd: window.hwnd, name: 'statusLabel' }, exec)
  check('a patternless control falls back to a coordinate click', fallback.method === 'coordinate', JSON.stringify(fallback))

  await registered.get('computer_window').execute({ action: 'focus', hwnd: window.hwnd }, exec)
  const chords = await registered.get('computer_keyboard').execute(
    { action: 'key', keys: 'ctrl++', expect: 'DSH Computer Control Test' },
    exec,
  )
  check('ctrl++ resolves to Ctrl+Shift+Plus', chords.detail.pressed >= 2, JSON.stringify(chords.detail))

  const closed = await registered.get('computer_window').execute({ action: 'close', hwnd: window.hwnd }, exec)
  check('window close reports the window gone', closed.detail.closed === true, JSON.stringify(closed.detail))
} catch (error) {
  failures.push(`unexpected: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  if (windowProcess !== undefined) {
    windowProcess.kill()
    await sleep(200)
    windowProcess.kill('SIGKILL')
  }
  for (const dispose of disposers.reverse()) {
    try {
      await dispose()
    } catch {
      // Best effort.
    }
  }
  rmSync(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`FAIL tools-check (${failures.length})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('PASS tools-check: window, UIA, mouse, keyboard, screenshot')
}
