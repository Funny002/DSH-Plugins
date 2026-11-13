/**
 * `dsh-computer-control` 鈥?host half.
 *
 * A small, explicit desktop capability for Windows: look at the screen,
 * move/click/scroll/drag the pointer, type text or key chords into the focused
 * window, list or control top-level windows, and drive a window's UI Automation
 * controls. The tools are registered on `ctx.tools`, so every Agent in this
 * profile sees them until the row is disabled.
 *
 * All desktop work happens in `lib/computer.ps1`, which drives `user32.dll`
 * (and UI Automation with a Microsoft Active Accessibility fallback) through a
 * cached, compiled helper assembly. `lib/runner.js` keeps one server-mode
 * PowerShell process warm, serializes calls, restarts it after a crash, and
 * falls back to a one-shot process when server mode cannot start. The Node half
 * owns the model-facing schemas, argument rules, the screenshot directory, and
 * the projection of captures into durable image attachments.
 *
 * Screenshots are written to `<DSH_HOME>/computer-control/screenshots`
 * (overridable through the row config) and additionally attached to the session
 * as an image block when the attachment service accepts them, so the model can
 * see what it is about to click instead of re-reading a file path. A refused
 * attachment degrades to the text block with the path.
 *
 * @module dsh-computer-control
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { DesktopRunner } from './runner.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'computer-control'
/** This plugin contributes tools, so the registry must be mounted first. */
export const inject = ['tools']
/** Absolute path of the bundled action runner. */
const SCRIPT_PATH = fileURLToPath(new URL('./computer.ps1', import.meta.url))
/** Hard wall-clock bound for one desktop action. */
const ACTION_TIMEOUT_MS = 120_000
/** Model-facing default; keeps one capture around 1k-2k tokens of image input. */
const DEFAULT_MAX_IMAGE_WIDTH = 1600

/** Row config: where captures go, how wide they are, and whether input is allowed. */
export const Config = z.object({
  screenshotDir: z
    .string()
    .default('')
    .description('Directory for screenshot files. Empty uses <DSH_HOME>/computer-control/screenshots.'),
  maxImageWidth: z
    .number()
    .min(320)
    .max(4096)
    .default(DEFAULT_MAX_IMAGE_WIDTH)
    .description('Default downscale cap for screenshots, in pixels. A call may lower but not raise it.'),
  inputEnabled: z
    .boolean()
    .default(true)
    .description(
      'Enable pointer, keyboard, UI-action, and window-control tools. When false the plugin is read-only: screenshot, screen info, window listing, and UI control listing.',
    ),
  persistentRunner: z
    .boolean()
    .default(true)
    .description('Keep one warm PowerShell runner for fast actions. Disable to force a one-shot process per call.'),
})

/**
 * Resolve the row config into the values the tools use.
 * @param config - resolved row config.
 * @returns normalized settings.
 */
function resolveSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const dir = typeof source.screenshotDir === 'string' ? source.screenshotDir.trim() : ''
  const width = Number.isFinite(source.maxImageWidth) ? Math.trunc(source.maxImageWidth) : DEFAULT_MAX_IMAGE_WIDTH
  return {
    screenshotDir: dir === '' ? join(dshHome(), 'computer-control', 'screenshots') : dir,
    maxImageWidth: Math.min(4096, Math.max(320, width)),
    inputEnabled: source.inputEnabled !== false,
    persistentRunner: source.persistentRunner !== false,
  }
}

/** @returns the harness home directory used for this profile's files. */
function dshHome() {
  const home = process.env.DSH_HOME
  return home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
}

/**
 * Save one PNG into the durable attachment store when that service is mounted.
 * A refusal is not fatal: the call still returns the capture path.
 * @param ctx - plugin context.
 * @param filePath - capture path.
 * @returns the attachment reference, or an error message.
 */
async function saveCapture(ctx, filePath) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined || attachments === null) return { ref: undefined, error: undefined }
  try {
    const data = readFileSync(filePath)
    const [ref] = await attachments.saveImages([
      { data, mediaType: 'image/png', name: filePath.slice(filePath.lastIndexOf('\\') + 1) },
    ])
    return { ref, error: undefined }
  } catch (error) {
    return { ref: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Shared output schema for tools that report one desktop action. */
const ACTION_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    detail: {},
  },
}

/** Image-bearing capture value. */
const SCREENSHOT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'width', 'height', 'bytes'],
  properties: {
    path: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    originalWidth: { type: 'integer' },
    originalHeight: { type: 'integer' },
    bytes: { type: 'integer' },
    left: { type: 'integer' },
    top: { type: 'integer' },
    clamped: { type: 'boolean' },
    cursorX: { type: 'integer' },
    cursorY: { type: 'integer' },
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    attachmentError: { type: 'string' },
  },
}

/** UI Automation result for one listing or control action. */
const UI_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'ok'],
  properties: {
    action: { type: 'string' },
    op: { type: 'string' },
    ok: { type: 'boolean' },
    window: { type: 'object', additionalProperties: true, properties: {} },
    count: { type: 'integer' },
    truncated: { type: 'boolean' },
    controls: { type: 'array', items: {} },
    control: { type: 'object', additionalProperties: true, properties: {} },
    method: { type: 'string' },
    value: { type: 'string' },
    matched: { type: 'boolean' },
    selected: { type: 'boolean' },
    focused: { type: 'boolean' },
    item: { type: 'string' },
    childId: { type: 'integer' },
  },
}

/**
 * Build the model-facing text for one capture.
 * @param value - capture value.
 * @returns concise description; the bitmap rides the adjacent image block.
 */
function screenshotText(value) {
  const scale = value.width !== value.originalWidth || value.height !== value.originalHeight
    ? ` (scaled from ${value.originalWidth}x${value.originalHeight}; multiply coordinates by ${(value.originalWidth / value.width).toFixed(2)} to locate features on screen)`
    : ''
  const origin = value.left !== undefined ? ` at ${value.left},${value.top}` : ''
  const clamp = value.clamped === true ? '; clamped to the virtual desktop' : ''
  const cursor = value.cursorX !== undefined ? `; cursor at ${value.cursorX},${value.cursorY}` : ''
  const attachment = value.attachmentError === undefined
    ? ''
    : `\n<attachment-status>image attachment unavailable: ${value.attachmentError}</attachment-status>`
  return `<screenshot>${value.width}x${value.height} px${scale}${origin}${clamp}${cursor}</screenshot>
<path>${value.path}</path>${attachment}`
}

/**
 * Build the content blocks for one capture.
 * @param value - capture value.
 * @returns the text block and, when available, the image block.
 */
function screenshotContent(value) {
  const blocks = [{ type: 'text', text: screenshotText(value) }]
  if (value.attachmentId !== undefined) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: value.attachmentId,
        mediaType: value.mediaType ?? 'image/png',
        bytes: value.bytes,
        width: value.width,
        height: value.height,
      },
    })
  }
  return blocks
}

/**
 * Convert a UI Automation window/control result into a model-facing text block.
 * @param value - canonical result.
 * @returns one text block.
 */
function uiContent(value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * Plugin entry: resolve settings, install the desktop runner, then register the
 * desktop tools while the tool registry lives.
 * @param ctx - host plugin context.
 * @param config - resolved row config.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const runner = new DesktopRunner({
    scriptPath: SCRIPT_PATH,
    timeoutMs: ACTION_TIMEOUT_MS,
    persistent: settings.persistentRunner,
  })
  const definitions = []

  // The supervisor owns one warm PowerShell process; stop it with the row.
  ctx.effect(
    () => () => runner.dispose(),
    'computer-control: desktop runner',
  )

  definitions.push({
    name: 'computer_screenshot',
    description:
      'Capture this computer\'s screen and return the image. Use it before acting and afterwards to confirm the result. Returned coordinates are physical desktop pixels; the text states the multiplier when the image was downscaled.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        screen: {
          type: 'integer',
          minimum: 1,
          description: '1-based display index from computer_screen_info. Defaults to the primary display.',
        },
        all: {
          type: 'boolean',
          description: 'Capture the whole virtual desktop across every display instead of one display.',
        },
        region: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y', 'width', 'height'],
          description: 'Capture only this rectangle of the physical desktop; it is clamped to the virtual desktop.',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer', minimum: 1 },
            height: { type: 'integer', minimum: 1 },
          },
        },
        maxWidth: {
          type: 'integer',
          minimum: 320,
          maximum: 4096,
          description: `Downscale the capture to at most this width. Defaults to ${settings.maxImageWidth}; larger values are ignored.`,
        },
      },
    },
    output: {
      schema: SCREENSHOT_VALUE_SCHEMA,
      render: (_args, value) => screenshotContent(value),
    },
    timeoutMs: ACTION_TIMEOUT_MS,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const dir = settings.screenshotDir
      try {
        mkdirSync(dir, { recursive: true })
      } catch (error) {
        throw new Error(`cannot create the screenshot directory "${dir}": ${error instanceof Error ? error.message : String(error)}`)
      }
      const filePath = join(dir, `screen-${timestamp()}-${process.pid}-${++captureCounter}.png`)
      const maxWidth = Number.isFinite(input.maxWidth)
        ? Math.min(settings.maxImageWidth, Math.max(320, Math.trunc(input.maxWidth)))
        : settings.maxImageWidth
      const payload = {
        path: filePath,
        maxWidth,
        ...(input.screen === undefined ? {} : { screen: input.screen }),
        ...(input.all === true ? { all: true } : {}),
        ...(input.region === undefined ? {} : { region: input.region }),
      }
      const captured = await runner.run('screenshot', payload, exec?.signal)
      const saved = await saveCapture(ctx, filePath)
      return {
        path: filePath,
        width: captured.width,
        height: captured.height,
        originalWidth: captured.originalWidth,
        originalHeight: captured.originalHeight,
        bytes: captured.bytes,
        clamped: captured.clamped === true,
        ...(captured.left === undefined ? {} : { left: captured.left }),
        ...(captured.top === undefined ? {} : { top: captured.top }),
        ...(captured.cursorX === undefined ? {} : { cursorX: captured.cursorX, cursorY: captured.cursorY }),
        ...(saved.ref === undefined
          ? {}
          : { attachmentId: saved.ref.attachmentId, mediaType: saved.ref.mediaType }),
        ...(saved.error === undefined ? {} : { attachmentError: saved.error }),
      }
    },
  })

  definitions.push({
    name: 'computer_screen_info',
    description:
      'Report displays, virtual-desktop bounds, DPI awareness, current cursor position, and the foreground window handle. Cheaper than a screenshot when only coordinates or sizes are needed.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['virtualScreen', 'screens'],
        properties: {
          virtualScreen: {
            type: 'object',
            additionalProperties: false,
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
          },
          screens: { type: 'array', items: {} },
          cursor: { type: 'object', additionalProperties: true, properties: {} },
          foreground: { type: 'integer' },
          dpiAwareness: { type: 'string' },
          os: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: ACTION_TIMEOUT_MS,
    async execute(_args, exec) {
      const info = await runner.run('info', {}, exec?.signal)
      return {
        virtualScreen: info.virtualScreen,
        screens: info.screens,
        ...(info.cursor === undefined ? {} : { cursor: info.cursor }),
        ...(info.foreground === undefined ? {} : { foreground: info.foreground }),
        ...(info.dpiAwareness === undefined ? {} : { dpiAwareness: info.dpiAwareness }),
        ...(info.os === undefined ? {} : { os: info.os }),
      }
    },
  })

  const windowActions = settings.inputEnabled
    ? ['list', 'focus', 'move', 'minimize', 'maximize', 'restore', 'close']
    : ['list']
  definitions.push({
    name: 'computer_window',
    description:
      'Inspect or control top-level windows. `list` returns handle, pid, process, bounds, title, and minimized state. `focus` brings a window forward and verifies it; `move`, `minimize`, `maximize`, `restore`, and `close` act on a window chosen by hwnd, pid, or title. `close` refuses an ambiguous selector.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: windowActions, description: 'Operation to run.' },
        hwnd: { type: 'integer', description: 'Exact window handle from the list.' },
        pid: { type: 'integer', description: 'Process id that owns the window; hosted Windows Store windows are matched too.' },
        title: { type: 'string', description: 'Window title: exact match first, then a case-insensitive substring match.' },
        x: { type: 'integer', description: 'New left edge for move, in physical pixels. Defaults to the current position.' },
        y: { type: 'integer', description: 'New top edge for move, in physical pixels. Defaults to the current position.' },
        width: { type: 'integer', minimum: 1, description: 'New width for move. Defaults to the current width.' },
        height: { type: 'integer', minimum: 1, description: 'New height for move. Defaults to the current height.' },
      },
    },
    output: {
      schema: ACTION_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.detail ?? value) }],
    },
    timeoutMs: ACTION_TIMEOUT_MS,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = input.action
      if (!windowActions.includes(action)) {
        throw new Error(`window action "${String(action)}" is not enabled`)
      }
      if (action === 'move') {
        if (input.x === undefined || input.y === undefined) throw new Error('move requires both x and y')
        if (input.width !== undefined && !(input.width >= 1)) throw new Error('move width must be at least 1')
        if (input.height !== undefined && !(input.height >= 1)) throw new Error('move height must be at least 1')
      }
      if (action !== 'list' && input.hwnd === undefined && input.pid === undefined && input.title === undefined) {
        throw new Error(`${action} requires hwnd, pid, or title`)
      }
      const actions = {
        list: 'windows',
        focus: 'focus',
        move: 'window-move',
        minimize: 'window-minimize',
        maximize: 'window-maximize',
        restore: 'window-restore',
        close: 'window-close',
      }
      const payload = {}
      for (const key of ['hwnd', 'pid', 'title', 'x', 'y', 'width', 'height']) {
        if (input[key] !== undefined) payload[key] = input[key]
      }
      const result = await runner.run(actions[action], payload, exec?.signal)
      return { ok: true, detail: result }
    },
    isConcurrencySafe: () => false,
  })

  if (settings.inputEnabled) {
    definitions.push({
      name: 'computer_mouse',
      description:
        'Move, click, scroll, or drag the real mouse pointer. Coordinates are physical screen pixels; capture a screenshot or call computer_screen_info first to learn them. Input goes to the live desktop immediately. Pass expect to abort when the foreground window does not match.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['move', 'click', 'scroll', 'drag'],
            description: 'Pointer operation to run.',
          },
          x: { type: 'integer', description: 'Target x. Required for move; defaults to the current cursor position for click and scroll.' },
          y: { type: 'integer', description: 'Target y. Required for move; defaults to the current cursor position for click and scroll.' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for click and drag. Defaults to left.' },
          count: { type: 'integer', minimum: 1, maximum: 3, description: 'Click count: 1 single, 2 double. Defaults to 1.' },
          amount: { type: 'integer', description: 'Scroll wheel notches. Positive scrolls up or right. Defaults to 3.' },
          horizontal: { type: 'boolean', description: 'Scroll sideways instead of vertically.' },
          fromX: { type: 'integer', description: 'Drag start x.' },
          fromY: { type: 'integer', description: 'Drag start y.' },
          toX: { type: 'integer', description: 'Drag end x.' },
          toY: { type: 'integer', description: 'Drag end y.' },
          durationMs: { type: 'integer', minimum: 50, maximum: 10000, description: 'Drag duration in milliseconds. Defaults to 400.' },
          expect: {
            type: 'string',
            description: 'Foreground check before input: a window handle, "hwnd:...", "pid:...", or a title substring. A mismatch aborts the call.',
          },
        },
      },
      output: {
        schema: ACTION_VALUE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.detail ?? value) }],
      },
      timeoutMs: ACTION_TIMEOUT_MS,
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        const action = input.action
        if (!['move', 'click', 'scroll', 'drag'].includes(action)) {
          throw new Error(`unknown mouse action "${String(action)}"`)
        }
        if (action === 'move' && (input.x === undefined || input.y === undefined)) {
          throw new Error('move requires both x and y')
        }
        if (action === 'drag') {
          for (const key of ['fromX', 'fromY', 'toX', 'toY']) {
            if (input[key] === undefined) throw new Error(`drag requires ${key}`)
          }
        }
        const payload = {}
        for (const key of ['action', 'x', 'y', 'button', 'count', 'amount', 'horizontal', 'fromX', 'fromY', 'toX', 'toY', 'durationMs', 'expect']) {
          if (input[key] !== undefined) payload[key] = input[key]
        }
        delete payload.action
        const result = await runner.run(action, payload, exec?.signal)
        return { ok: true, detail: result }
      },
      isConcurrencySafe: () => false,
    })

    definitions.push({
      name: 'computer_keyboard',
      description:
        'Type text or press a key chord in the window that currently has focus. Text is sent as Unicode, so non-Latin input and emoji work; newlines become Enter. Focus the target with computer_window first, and pass expect so a mismatched front window aborts instead of receiving the keystrokes.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['type', 'key'], description: 'Type a string, or press a key chord.' },
          text: { type: 'string', description: 'Text to type when action is type.' },
          keys: {
            type: 'string',
            description: 'Chord when action is key, for example "ctrl+shift+s", "ctrl++", "enter", "alt+f4", "f13", "win".',
          },
          expect: {
            type: 'string',
            description: 'Foreground check: a window handle, "hwnd:...", "pid:...", or a title substring. A mismatch aborts before any input.',
          },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
          repeat: { type: 'integer', minimum: 1, maximum: 20, description: 'Repeat the chord this many times. Defaults to 1.' },
        },
      },
      output: {
        schema: ACTION_VALUE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.detail ?? value) }],
      },
      timeoutMs: ACTION_TIMEOUT_MS,
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        if (input.action === 'type') {
          if (typeof input.text !== 'string') throw new Error('type requires a text string')
          const result = await runner.run(
            'type',
            {
              text: input.text,
              submit: input.submit === true,
              ...(input.expect === undefined ? {} : { expect: input.expect }),
            },
            exec?.signal,
          )
          return { ok: true, detail: result }
        }
        if (input.action === 'key') {
          if (typeof input.keys !== 'string' || input.keys.trim() === '') throw new Error('key requires a keys chord')
          const result = await runner.run(
            'key',
            {
              keys: input.keys,
              ...(input.expect === undefined ? {} : { expect: input.expect }),
              ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
            },
            exec?.signal,
          )
          return { ok: true, detail: result }
        }
        throw new Error(`unknown keyboard action "${String(input.action)}"`)
      },
      isConcurrencySafe: () => false,
    })
  }

  const uiActions = settings.inputEnabled
    ? ['list', 'invoke', 'setValue', 'select', 'click', 'focus']
    : ['list']
  definitions.push({
    name: 'computer_ui',
    description:
      'Read and drive a window through UI Automation, which is more reliable than pixel coordinates. `list` returns control type, name, automation id, bounds, supported patterns, and list items. `invoke` presses a button, `setValue` writes a text field, `select` chooses a list item, `click` invokes/selects/toggles or clicks the control center, and `focus` moves keyboard focus.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: uiActions, description: 'UI Automation operation.' },
        hwnd: { type: 'integer', description: 'Target window handle. Prefer this over title for accuracy.' },
        pid: { type: 'integer', description: 'Target window process id (Windows Store host processes are matched).' },
        title: { type: 'string', description: 'Target window title: exact first, then case-insensitive substring.' },
        name: { type: 'string', description: 'Control name; exact match preferred, then substring. For select, the list control name when item is set.' },
        automationId: { type: 'string', description: 'Control automation id, exact preferred then substring.' },
        controlType: { type: 'string', description: 'Control type filter, for example Button, Edit, ListItem.' },
        index: { type: 'integer', minimum: 0, description: 'Zero-based index into the filtered control list. Use after list.' },
        item: { type: 'string', description: 'List item name for select. If the parent list is not named, the first matching item is used.' },
        value: { type: 'string', description: 'Text to write for setValue.' },
        expect: {
          type: 'string',
          description: 'Foreground guard used by the coordinate-click fallback: a handle or title substring.',
        },
        maxDepth: { type: 'integer', minimum: 1, maximum: 20, description: 'List depth limit. Defaults to 8.' },
        maxItems: { type: 'integer', minimum: 1, maximum: 2000, description: 'List control cap. Defaults to 250.' },
      },
    },
    output: {
      schema: UI_VALUE_SCHEMA,
      render: (_args, value) => uiContent(value),
    },
    timeoutMs: ACTION_TIMEOUT_MS,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = input.action
      if (!uiActions.includes(action)) throw new Error(`ui action "${String(action)}" is not enabled`)
      if (action !== 'list' && input.hwnd === undefined && input.pid === undefined && input.title === undefined) {
        throw new Error(`${action} requires hwnd, pid, or title`)
      }
      if (action === 'setValue' && typeof input.value !== 'string') {
        throw new Error('setValue requires a value string')
      }
      if (action === 'select' && (typeof input.item !== 'string' || input.item.trim() === '')) {
        throw new Error('select requires an item name')
      }
      if (!['list', 'select'].includes(action)
        && input.name === undefined && input.automationId === undefined && input.index === undefined) {
        throw new Error(`${action} requires name, automationId, or index`)
      }
      const payload = { op: action }
      for (const key of ['hwnd', 'pid', 'title', 'name', 'automationId', 'controlType', 'index', 'item', 'value', 'expect', 'maxDepth', 'maxItems']) {
        if (input[key] !== undefined) payload[key] = input[key]
      }
      const result = await runner.run('ui', payload, exec?.signal)
      return { ...result, action, ok: result.ok !== false }
    },
    isConcurrencySafe: () => false,
  })

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(
      () => {
        const disposers = []
        for (const definition of definitions) {
          disposers.push(toolsCtx.tools.register(definition))
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // Disposal is best effort; the fiber is going away regardless.
            }
          }
        }
      },
      'computer-control: desktop tools',
    )
  })
}

/** Monotonic suffix so two captures in the same millisecond cannot collide. */
let captureCounter = 0

/**
 * Build a filename-safe timestamp with millisecond resolution.
 * @returns `YYYYMMDD-HHMMSS-mmm`.
 */
function timestamp() {
  const now = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`
}
