/**
 * Offline checks for the browser bundle: it must register itself through the
 * shell's module-loader facade, export the plugin surface, carry every literal
 * translation key in both dictionaries, and render each component without a
 * browser (a React-shaped shim walks the element tree).
 *
 *   node test/check-client.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) return
  failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`)
}

// ── a React-shaped shim, enough to walk function components ─────────────────
let hooks = []
let cursor = 0
function withHooks(run) {
  const outerHooks = hooks
  const outerCursor = cursor
  hooks = []
  cursor = 0
  try {
    return run()
  } finally {
    hooks = outerHooks
    cursor = outerCursor
  }
}
const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState(initial) {
    const slot = cursor++
    if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial
    return [hooks[slot], (next) => { hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next }]
  },
  useRef(initial) {
    const slot = cursor++
    if (!(slot in hooks)) hooks[slot] = { current: initial }
    return hooks[slot]
  },
  useCallback(fn) {
    cursor += 1
    return fn
  },
  useEffect() {
    cursor += 1
  },
}
const requireShim = (id) => {
  if (id === 'react') return React
  throw new Error(`bundle required an unexpected module: ${id}`)
}

// ── load the bundle the way the shell does ──────────────────────────────────
let registered = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      if (typeof entry.id !== 'string' || typeof entry.factory !== 'function') throw new Error('bad load() call')
      registered = { id: entry.id, exports: entry.factory(requireShim) }
    },
  },
}
await import(new URL('../lib/client.js', import.meta.url).href)
check('bundle registers itself', registered !== null)
if (registered === null) {
  console.error('client check FAILED: the bundle never called window.__ModuleLoader__.load')
  process.exit(1)
}
const plugin = registered.exports
check('bundle id equals the package name', registered.id === 'dsh-mcp-manager', registered.id)
check('exports apply', typeof plugin.apply === 'function')
check('exports inject', Array.isArray(plugin.inject))
check('inject lists slots and connection', plugin.inject.includes('slots') && plugin.inject.includes('connection'))

// ── dictionary coverage for every literal t("…") key ───────────────────────
const source = readFileSync(bundlePath, 'utf8')
const usedKeys = new Set([...source.matchAll(/\bt\("([^"]+)"\)/g)].map((match) => match[1]))
for (const key of usedKeys) {
  for (const [dictionaryName, dictionary] of Object.entries(plugin.__dictionaries)) {
    let value = dictionary
    for (const part of key.split('.')) value = value === undefined ? undefined : value[part]
    check(`dictionary ${dictionaryName} has ${key}`, typeof value === 'string')
  }
}
for (const status of ['connected', 'connecting', 'error', 'idle', 'disabled']) {
  for (const [dictionaryName, dictionary] of Object.entries(plugin.__dictionaries)) {
    check(`dictionary ${dictionaryName}.status has ${status}`, typeof dictionary.status?.[status] === 'string')
  }
}

// ── walk every component ───────────────────────────────────────────────────
function walk(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') return
  if (typeof node.type === 'function') {
    let rendered
    try {
      rendered = withHooks(() => node.type(node.props))
    } catch (error) {
      failures.push(`render failed in ${node.type.name || 'anonymous'}: ${error.message}`)
      return
    }
    walk(rendered)
    return
  }
  if (typeof node.type === 'string') {
    walk(node.props?.children)
    return
  }
  failures.push(`element with unusable type: ${String(node.type)}`)
}

const strictT = (key) => {
  let value = plugin.__dictionaries.zh
  for (const part of String(key).split('.')) value = value === undefined ? undefined : value[part]
  if (typeof value !== 'string') throw new Error(`missing translation for ${key}`)
  return value
}

const snapshot = {
  generation: 1,
  rowId: 'mcp-manager',
  channel: { path: '/mcp-manager', state: 'registered', error: '' },
  patchFile: 'C:/Users/x/.dsh/profiles/web/cordis.patch.yml',
  persistence: { writable: true, patchFile: 'C:/Users/x/.dsh/profiles/web/cordis.patch.yml' },
  servers: [
    {
      name: 'echo',
      transport: 'stdio',
      enabled: true,
      target: 'node test/mcp-echo-server.mjs',
      definition: { name: 'echo', enabled: true, transport: 'stdio', command: 'node', args: ['x'], env: { A: 'b' }, cwd: '', toolCallTimeoutMs: 60000 },
      state: 'connected',
      error: '',
      toolCount: 2,
      tools: [
        { rawName: 'echo', publicName: 'mcp__echo__echo', description: 'Echo the provided text back.' },
        { rawName: 'add', publicName: 'mcp__echo__add', description: '' },
      ],
      startedAt: 1,
      lastSyncAt: 2,
      timeoutMs: 60000,
    },
    {
      name: 'broken',
      transport: 'streamable-http',
      enabled: true,
      target: 'http://127.0.0.1:1/mcp',
      definition: { name: 'broken', enabled: true, transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp', headers: {}, toolCallTimeoutMs: 60000 },
      state: 'error',
      error: 'fetch failed',
      toolCount: 0,
      tools: [],
      startedAt: 0,
      lastSyncAt: 0,
      timeoutMs: 60000,
    },
    {
      name: 'off',
      transport: 'stdio',
      enabled: false,
      target: 'node off.mjs',
      definition: { name: 'off', enabled: false, transport: 'stdio', command: 'node', args: [], env: {}, cwd: '', toolCallTimeoutMs: 60000 },
      state: 'disabled',
      error: '',
      toolCount: 0,
      tools: [],
      startedAt: 0,
      lastSyncAt: 0,
      timeoutMs: 60000,
    },
  ],
  totals: { servers: 3, enabled: 2, connected: 1, tools: 2 },
}
const call = async (endpoint) => {
  if (endpoint === 'state') return snapshot
  if (endpoint === 'probe') return { name: 'probe', toolCount: 2, tools: [] }
  return { persisted: true, patchFile: snapshot.patchFile, generation: 2, reloading: true, snapshot }
}

const { McpServersSection, ServerCard, ServerForm, StateBadge } = plugin.__components
check('components are exported for the render check', [McpServersSection, ServerCard, ServerForm, StateBadge].every((value) => typeof value === 'function'))
walk(React.createElement(McpServersSection, { call, t: strictT, close: () => {} }))
for (const server of snapshot.servers) {
  walk(
    React.createElement(ServerCard, {
      server,
      t: strictT,
      busy: '',
      expanded: server.name === 'echo',
      onToggle: () => {},
      onEdit: () => {},
      onRemove: () => {},
      onRefresh: () => {},
      onToggleDetails: () => {},
    }),
  )
}
walk(React.createElement(ServerForm, { t: strictT, original: null, onCancel: () => {}, onSubmit: () => {}, onProbe: async () => ({ toolCount: 1 }) }))
walk(
  React.createElement(ServerForm, {
    t: strictT,
    original: snapshot.servers[1].definition,
    onCancel: () => {},
    onSubmit: () => {},
    onProbe: async () => ({ toolCount: 1 }),
  }),
)

// ── the save mapping (regression: the add form is `{ server: null }`, not `null`) ──
{
  const { saveAction, definitionFromDraft, draftFromDefinition, draftProblem } = plugin.__helpers
  check('helpers are exported', typeof saveAction === 'function' && typeof definitionFromDraft === 'function')
  const definition = { name: 'echo', enabled: true, transport: 'stdio', command: 'node', args: [], env: {}, cwd: '', toolCallTimeoutMs: 60000 }
  const closed = saveAction(null, definition)
  check('closed editor saves as add', closed.endpoint === 'add' && closed.payload.name === undefined)
  const adding = saveAction({ server: null }, definition)
  check('add form saves as add', adding.endpoint === 'add' && adding.payload.name === undefined, JSON.stringify(adding))
  const editing = saveAction({ server: { name: 'echo' } }, definition)
  check('edit form saves as update', editing.endpoint === 'update' && editing.payload.name === 'echo', JSON.stringify(editing))
  check('edit form forwards the definition', editing.payload.definition === definition)

  // The form's own round trip: a definition it was given comes back unchanged.
  const canonical = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort())
  const draft = draftFromDefinition(snapshot.servers[0].definition)
  const rebuilt = definitionFromDraft(draft)
  check('definition survives the form round trip', canonical(rebuilt) === canonical(snapshot.servers[0].definition), JSON.stringify(rebuilt))
  check('timeout falls back when blank', definitionFromDraft({ ...draft, timeout: '' }).toolCallTimeoutMs === 60000)
  check('missing scheme is not the form\'s business', draftProblem({ ...draft, transport: 'streamable-http', url: 'localhost:3000/mcp' }, strictT) === '')
  check('empty url is refused by the form', draftProblem({ ...draft, transport: 'streamable-http', url: '' }, strictT) !== '')
}

// ── apply() wiring ─────────────────────────────────────────────────────────
let capturedSlot = null
const ctx = {
  effect(fn) {
    fn()
    return { dispose() {} }
  },
  get(name) {
    if (name === 'connection') return { rpc: { call: async () => ({ ok: true, value: snapshot }) } }
    if (name === 'locale') return { register: () => () => {}, bind: () => strictT }
    return undefined
  },
  slots: {
    inject(slot, callback) {
      callback()
      return { dispose() {} }
    },
    register(options, Component) {
      capturedSlot = { options, Component }
      return () => {}
    },
  },
}
plugin.apply(ctx)
check('apply registers a slot entry', capturedSlot !== null)
if (capturedSlot !== null) {
  check('slot is settings.section', capturedSlot.options.name === 'settings.section')
  check('section id is mcp-servers', capturedSlot.options.id === 'mcp-servers')
  const injected = capturedSlot.options.inject()
  check('inject supplies call and translator', typeof injected.call === 'function' && typeof injected.t === 'function')
  const value = await injected.call('state', {})
  check('call unwraps the RPC envelope', value.generation === 1)
}

if (failures.length > 0) {
  console.error(`client check FAILED (${failures.length})`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log(`client check OK (${String(usedKeys.size)} translation keys verified)`)
