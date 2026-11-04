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
    // Bind the setter to the array this render belongs to: a mounted instance
    // must keep its state even while another component renders (or a promise
    // resolves) after the render pass has restored the outer hook array.
    const owner = hooks
    const slot = cursor++
    if (!(slot in owner)) owner[slot] = typeof initial === 'function' ? initial() : initial
    return [owner[slot], (next) => { owner[slot] = typeof next === 'function' ? next(owner[slot]) : next }]
  },
  useRef(initial) {
    const owner = hooks
    const slot = cursor++
    if (!(slot in owner)) owner[slot] = { current: initial }
    return owner[slot]
  },
  useCallback(fn) {
    cursor += 1
    return fn
  },
  useEffect(fn) {
    const owner = hooks
    const slot = cursor++
    if (!(slot in owner)) owner[slot] = { fn }
    else owner[slot].fn = fn
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
for (const status of ['connected', 'connecting', 'reconnecting', 'error', 'idle', 'disabled']) {
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
      definition: {
        name: 'echo',
        enabled: true,
        transport: 'stdio',
        command: 'node',
        args: ['x'],
        env: { A: 'b' },
        cwd: '',
        toolCallTimeoutMs: 60000,
        reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
      },
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
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10, attempts: 0, nextRetryAt: 0 },
    },
    {
      name: 'broken',
      transport: 'streamable-http',
      enabled: true,
      target: 'http://127.0.0.1:1/mcp',
      definition: {
        name: 'broken',
        enabled: true,
        transport: 'streamable-http',
        url: 'http://127.0.0.1:1/mcp',
        headers: {},
        toolCallTimeoutMs: 60000,
        reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
      },
      state: 'error',
      error: 'fetch failed',
      toolCount: 0,
      tools: [],
      startedAt: 0,
      lastSyncAt: 0,
      timeoutMs: 60000,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10, attempts: 11, nextRetryAt: 0 },
    },
    {
      name: 'retrying',
      transport: 'stdio',
      enabled: true,
      target: 'node retry.mjs',
      definition: {
        name: 'retrying',
        enabled: true,
        transport: 'stdio',
        command: 'node',
        args: [],
        env: {},
        cwd: '',
        toolCallTimeoutMs: 60000,
        reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 3 },
      },
      state: 'reconnecting',
      error: 'spawn ENOENT',
      toolCount: 1,
      tools: [{ rawName: 'ping', publicName: 'mcp__retrying__ping', description: 'ping' }],
      startedAt: 0,
      lastSyncAt: 0,
      timeoutMs: 60000,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 3, attempts: 2, nextRetryAt: 1700000000000 },
    },
    {
      name: 'off',
      transport: 'stdio',
      enabled: false,
      target: 'node off.mjs',
      definition: {
        name: 'off',
        enabled: false,
        transport: 'stdio',
        command: 'node',
        args: [],
        env: {},
        cwd: '',
        toolCallTimeoutMs: 60000,
        reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
      },
      state: 'disabled',
      error: '',
      toolCount: 0,
      tools: [],
      startedAt: 0,
      lastSyncAt: 0,
      timeoutMs: 60000,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10, attempts: 0, nextRetryAt: 0 },
    },
  ],
  totals: { servers: 4, enabled: 3, connected: 1, reconnecting: 1, tools: 3 },
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
  for (const open of [false, true]) {
    walk(
      React.createElement(ServerCard, {
        server,
        t: strictT,
        busy: '',
        metaOpen: open,
        toolsOpen: server.name === 'echo',
        onToggle: () => {},
        onEdit: () => {},
        onRemove: () => {},
        onRefresh: () => {},
        onToggleMeta: () => {},
        onToggleTools: () => {},
      }),
    )
  }
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

// ── rendered card content: meta grid, retry countdown, tool list ───────────
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (typeof node.type === 'function') return collectText(withHooks(() => node.type(node.props)), out)
  if (typeof node.type === 'string') return collectText(node.props?.children, out)
  return out
}

{
  const { filterTools, formatAgo, formatDuration, formatReconnectPolicy, formatRetryIn } = plugin.__helpers
  const rows = [
    { rawName: 'add', publicName: 'mcp__echo__add', description: 'Add two numbers' },
    { rawName: 'echo', publicName: 'mcp__echo__echo', description: 'Echo the provided text back' },
  ]
  check('an empty filter keeps every tool', filterTools(rows, '  ').length === 2)
  check('the filter matches a public name', filterTools(rows, 'echo__ad').length === 1)
  check('the filter matches a raw name', filterTools(rows, 'add').length === 1)
  check('the filter matches a description', filterTools(rows, 'numbers').length === 1)
  check('the filter ignores case', filterTools(rows, 'ECHO').length === 2)
  check('the filter can match nothing', filterTools(rows, 'zzz').length === 0)
  check('durations render milliseconds', formatDuration(500) === '500ms')
  check('durations render fractional seconds', formatDuration(1500) === '1.5s')
  check('durations render whole seconds', formatDuration(30000) === '30s')
  check('durations render minutes', formatDuration(120000) === '2m')
  check('relative time: just now', formatAgo(strictT, 1_700_000_000_000, 1_700_000_002_000) === strictT('time.justNow'))
  check('relative time: seconds', formatAgo(strictT, 1_700_000_000_000, 1_700_000_012_000) === '12 秒前')
  check('relative time: minutes', formatAgo(strictT, 1_700_000_000_000, 1_700_000_300_000) === '5 分钟前')
  check('relative time: hours', formatAgo(strictT, 1_700_000_000_000, 1_700_007_200_000) === '2 小时前')
  check('relative time: absent timestamp', formatAgo(strictT, 0, 1_700_000_000_000) === '')
  check(
    'reconnect policy is summarised',
    formatReconnectPolicy(strictT, { enabled: true, maxAttempts: 10, initialDelayMs: 500, maxDelayMs: 30000 }) ===
      '最多 10 次 · 500ms → 30s',
  )
  check('a disabled policy says so', formatReconnectPolicy(strictT, { enabled: false }) === '已关闭')
  check('the retry countdown counts down', formatRetryIn(strictT, 1_700_000_002_000, 1_700_000_000_000) === '2.0 秒后重试')
  check('no scheduled retry has no countdown', formatRetryIn(strictT, 0, 1_700_000_000_000) === '')

  const card = (server, now, open = { meta: true, tools: true }) =>
    collectText(
      React.createElement(ServerCard, {
        server,
        t: strictT,
        busy: '',
        now,
        metaOpen: open.meta,
        toolsOpen: open.tools,
        onToggle: () => {},
        onEdit: () => {},
        onRemove: () => {},
        onRefresh: () => {},
        onToggleMeta: () => {},
        onToggleTools: () => {},
      }),
    ).join(' | ')

  const retrying = card(snapshot.servers.find((server) => server.name === 'retrying'), 1_700_000_000_500)
  check('the card shows the retry budget', retrying.includes('2/3'), retrying)
  check('the card shows the retry countdown', retrying.includes('秒后重试'), retrying)
  check('the card summarises the reconnect policy', retrying.includes('最多 3 次'), retrying)
  check('the card shows the per-call timeout', retrying.includes('60s'), retrying)
  check('the card labels the last error', retrying.includes('最近错误') && retrying.includes('spawn ENOENT'), retrying)
  check('the card names the tool it exposes', retrying.includes('mcp__retrying__ping'), retrying)
  check('the card offers a copy action', retrying.includes('复制'), retrying)

  const healthy = card(snapshot.servers.find((server) => server.name === 'echo'), 1_700_000_000_000)
  check('a connected card shows the connection age', healthy.includes('已连接'), healthy)
  check('a connected card keeps the renamed tool readable', healthy.includes('mcp__echo__add') && healthy.includes('mcp__echo__echo'), healthy)

  // Progressive disclosure: the default card is the identity line, one target
  // line, the error, and two disclosures — the policy grid stays folded.
  const folded = card(snapshot.servers.find((server) => server.name === 'echo'), 1_700_000_000_000, { meta: false, tools: false })
  check('a folded card still shows the target', folded.includes('node test/mcp-echo-server.mjs'), folded)
  check('a folded card hides the policy grid', !folded.includes('重连策略') && !folded.includes('单次调用超时'), folded)
  check('a folded card hides the tool rows', !folded.includes('mcp__echo__add'), folded)
  check('a folded card still offers both disclosures', folded.includes('详情') && folded.includes('工具列表 (2)'), folded)
  check('an open card offers the collapse label', healthy.includes('隐藏详情') && healthy.includes('收起'), healthy)

  const errorFolded = card(snapshot.servers.find((server) => server.name === 'retrying'), 1_700_000_000_500, {
    meta: false,
    tools: false,
  })
  check('an error stays visible while folded', errorFolded.includes('spawn ENOENT'), errorFolded)
}

// ── the loaded page: title, description, summary, and the one-line footer ───
/** Real timer, captured before any test stubs the global. */
const realSetTimeout = globalThis.setTimeout
// The panel's status poll and retry countdown are intervals; the check drives
// renders itself, and a live interval would keep this process from exiting.
globalThis.setInterval = () => 0

/**
 * Mount one component instance whose hook slots persist across re-renders, so a
 * click can be followed by a re-render that observes the resulting state.
 * @param component - the component under test.
 * @param props - its props.
 * @returns `{ settle }`, which renders until no new effect runs.
 */
function createMount(component, props) {
  const store = []
  const renderOnce = () => {
    const outerHooks = hooks
    const outerCursor = cursor
    hooks = store
    cursor = 0
    let tree
    let ran = false
    try {
      tree = component(props)
      for (const slot of store) {
        if (slot && typeof slot.fn === 'function' && slot.ran !== true) {
          slot.ran = true
          slot.fn()
          ran = true
        }
      }
    } finally {
      hooks = outerHooks
      cursor = outerCursor
    }
    return { tree, ran }
  }
  return {
    async settle() {
      let tree = null
      // Always render a second time: an async load (or a click's promise chain)
      // settles during the wait, and only a later render shows its state.
      for (let pass = 0; pass < 8; pass += 1) {
        const result = renderOnce()
        tree = result.tree
        await new Promise((resolve) => realSetTimeout(resolve, 5))
        if (!result.ran && pass > 0) break
      }
      return tree
    },
  }
}

/** Find one plain element (not a component) without consuming component hooks. */
function findElement(node, predicate) {
  if (node === null || node === undefined || typeof node === 'boolean') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof node !== 'object') return undefined
  if (typeof node.type === 'function') return undefined
  if (predicate(node)) return node
  return findElement(node.props?.children, predicate)
}

{
  const page = createMount(McpServersSection, { call, t: strictT, close: () => {} })
  const tree = await page.settle()
  const text = collectText(tree).join(' | ')
  check('the page title is MCP 服务器', text.includes('MCP 服务器'), text)
  check(
    'the page description is the short form',
    text.includes('连接外部 MCP 服务器并把它们的工具注册给模型（热生效）。'),
    text,
  )
  check('the footer names the config file', text.includes('配置文件') && text.includes(snapshot.patchFile), text)
  check('the footer no longer lists the row id', !text.includes('行 id'), text)
  check(
    'the loaded page lists every server',
    ['echo', 'broken', 'retrying', 'off'].every((name) => text.includes(name)),
    text,
  )
  check('the loaded page summarises the live state', text.includes('重连'), text)
}

// ── a status notice dismisses itself ───────────────────────────────────────
{
  const scheduled = []
  const realTimeout = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = (fn, ms) => {
    scheduled.push({ fn, ms })
    return scheduled.length
  }
  globalThis.clearTimeout = () => {}
  try {
    const page = createMount(McpServersSection, { call, t: strictT, close: () => {} })
    let tree = await page.settle()
    const refresh = findElement(tree, (node) => node.type === 'button' && node.props?.children === '刷新')
    check('the panel renders a refresh action', refresh !== undefined)
    refresh.props.onClick()
    tree = await page.settle()
    const shown = collectText(tree).join(' | ')
    check('a refreshed panel shows its status notice', shown.includes('工具列表已刷新'), shown)

    const dismissal = scheduled.find((entry) => entry.ms > 1000)
    check('the notice schedules its own dismissal', dismissal !== undefined, JSON.stringify(scheduled.map((entry) => entry.ms)))
    dismissal.fn()
    tree = await page.settle()
    const hidden = collectText(tree).join(' | ')
    check('the notice hides itself once its lifetime elapses', !hidden.includes('工具列表已刷新'), hidden)
  } finally {
    globalThis.setTimeout = realTimeout
    globalThis.clearTimeout = realClear
  }
}

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
  check('reconnect survives the form round trip', rebuilt.reconnect.maxAttempts === 10 && rebuilt.reconnect.enabled === true)
  check('a disabled reconnect policy is preserved', definitionFromDraft({ ...draft, reconnect: false }).reconnect.enabled === false)
  check('a blank attempt count falls back', definitionFromDraft({ ...draft, reconnectAttempts: '' }).reconnect.maxAttempts === 10)
  check('reconnecting has its own status key', plugin.__helpers.statusKey({ state: 'reconnecting' }) === 'reconnecting')
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
