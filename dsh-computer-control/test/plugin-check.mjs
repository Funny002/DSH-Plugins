/**
 * Registration and degradation checks for the Node half: tool catalog, raw JSON
 * Schema parameters, read-only mode, screenshot directory failures, and an
 * attachment-store refusal degrading to the text block.
 *
 *   node test/plugin-check.mjs
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-computer-control-plugin-'))
process.env.DSH_HOME = home
const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

const failures = []
const check = (label, condition, detail = '') => {
  if (!condition) failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`)
}

function createContext(attachments) {
  const registered = new Map()
  const disposers = []
  const ctx = {
    get(name) {
      return name === 'attachments' ? attachments : undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject(_names, callback) {
      callback({
        effect(fn) {
          const dispose = fn()
          if (typeof dispose === 'function') disposers.push(dispose)
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
  return { ctx, registered, disposers }
}

async function disposeAll(disposers) {
  for (const dispose of [...disposers].reverse()) {
    try {
      await dispose()
    } catch {
      // Best effort.
    }
  }
}

const exec = { signal: new AbortController().signal }

/**
 * Collect JSON-Schema defects that a strict model API rejects: a boolean
 * `required` (the tool-registration DSL style) instead of an array, a required
 * name missing from `properties`, or a `type` array the APIs do not accept.
 * @param node - schema node to inspect.
 * @param path - diagnostic path.
 * @returns human-readable problems, empty when the node is valid.
 */
function schemaProblems(node, path) {
  const problems = []
  if (node === null || typeof node !== 'object') return problems
  if (Array.isArray(node)) {
    node.forEach((item, index) => problems.push(...schemaProblems(item, `${path}[${index}]`)))
    return problems
  }
  if (Array.isArray(node.type)) problems.push(`${path}.type must be one string, not an array`)
  if ('required' in node) {
    if (!Array.isArray(node.required)) {
      problems.push(`${path}.required must be an array of property names`)
    } else if (node.properties !== undefined) {
      for (const name of node.required) {
        if (!(name in node.properties)) problems.push(`${path}.required names missing property "${name}"`)
      }
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required') continue
    problems.push(...schemaProblems(value, `${path}.${key}`))
  }
  return problems
}

// Full tool catalog and schema shape.
{
  const { ctx, registered, disposers } = createContext(undefined)
  plugin.apply(ctx, {})
  const names = [...registered.keys()]
  check(
    'the catalog has all six tools',
    names.length === 6 && ['computer_screenshot', 'computer_screen_info', 'computer_window', 'computer_mouse', 'computer_keyboard', 'computer_ui'].every((name) => registered.has(name)),
    names.join(', '),
  )
  for (const definition of registered.values()) {
    check(`${definition.name} declares a raw object schema`, definition.parameters?.type === 'object')
    check(`${definition.name} declares an output schema`, definition.output?.schema?.type === 'object')
    check(`${definition.name} has a concise description`, definition.description.length <= 500, String(definition.description.length))
    check(`${definition.name} renders content`, Array.isArray(definition.output.render({}, { ok: true })))
  }
  check('keyboard exposes the expect guard', registered.get('computer_keyboard').parameters.properties.expect !== undefined)
  check('mouse exposes the expect guard', registered.get('computer_mouse').parameters.properties.expect !== undefined)
  check('window exposes move/minimize/close', ['move', 'minimize', 'maximize', 'restore', 'close'].every((action) => registered.get('computer_window').parameters.properties.action.enum.includes(action)))
  for (const definition of registered.values()) {
    check(
      `${definition.name} parameters are strict-API JSON Schema`,
      schemaProblems(definition.parameters, definition.name).length === 0,
      schemaProblems(definition.parameters, definition.name).join('; '),
    )
    check(
      `${definition.name} output schema is strict-API JSON Schema`,
      schemaProblems(definition.output.schema, `${definition.name}.output`).length === 0,
      schemaProblems(definition.output.schema, `${definition.name}.output`).join('; '),
    )
  }
  check('ui exposes the UIA actions', ['list', 'invoke', 'setValue', 'select', 'click', 'focus'].every((action) => registered.get('computer_ui').parameters.properties.action.enum.includes(action)))
  await disposeAll(disposers)
  check('disposal unregisters the tools', registered.size === 0)
}

// A refused attachment degrades to text, with the path still present.
{
  const attachment = {
    async saveImages() {
      throw new Error('attachment store refused the image')
    },
  }
  const { ctx, registered, disposers } = createContext(attachment)
  plugin.apply(ctx, {})
  const value = await registered.get('computer_screenshot').execute({ region: { x: 0, y: 0, width: 320, height: 200 }, maxWidth: 320 }, exec)
  check('the capture still succeeds without an attachment', existsSync(value.path) && value.bytes > 0)
  check('the attachment refusal is reported', value.attachmentError === 'attachment store refused the image', String(value.attachmentError))
  const blocks = registered.get('computer_screenshot').output.render({}, value)
  check('a refused attachment renders only text', blocks.length === 1 && blocks[0].type === 'text')
  check('the text names the attachment failure', blocks[0].text.includes('image attachment unavailable'), blocks[0].text)
  check('the text still names the capture path', blocks[0].text.includes(value.path))
  await disposeAll(disposers)
}

// An accepted attachment adds an image block.
{
  const attachment = {
    async saveImages(inputs) {
      return [{
        attachmentId: 'att-test',
        mediaType: 'image/png',
        bytes: inputs[0].data.length,
        width: 320,
        height: 200,
      }]
    },
  }
  const { ctx, registered, disposers } = createContext(attachment)
  plugin.apply(ctx, {})
  const value = await registered.get('computer_screenshot').execute({ region: { x: 0, y: 0, width: 320, height: 200 }, maxWidth: 320 }, exec)
  const blocks = registered.get('computer_screenshot').output.render({}, value)
  check('an accepted attachment renders an image block', blocks.length === 2 && blocks[1].type === 'image' && blocks[1].attachment.attachmentId === 'att-test', JSON.stringify(blocks))
  await disposeAll(disposers)
}

// An unusable screenshot directory fails with a clear message.
{
  const blocker = join(home, 'blocker')
  writeFileSync(blocker, 'file', 'utf8')
  const { ctx, registered, disposers } = createContext(undefined)
  plugin.apply(ctx, { screenshotDir: join(blocker, 'shots') })
  let message = ''
  try {
    await registered.get('computer_screenshot').execute({}, exec)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('an unusable screenshot directory is explained', message.includes('cannot create the screenshot directory'), message)
  await disposeAll(disposers)
}

// Read-only mode removes input tools and restricts the mutating action enums.
{
  const { ctx, registered, disposers } = createContext(undefined)
  plugin.apply(ctx, { inputEnabled: false })
  check('read-only mode omits mouse and keyboard', !registered.has('computer_mouse') && !registered.has('computer_keyboard'))
  check('read-only window allows only list', registered.get('computer_window').parameters.properties.action.enum.join(',') === 'list')
  check('read-only ui allows only list', registered.get('computer_ui').parameters.properties.action.enum.join(',') === 'list')
  await disposeAll(disposers)
}

rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`FAIL plugin-check (${failures.length})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('PASS plugin-check: catalog, schemas, attachment degradation, directory failure, read-only mode')
}
