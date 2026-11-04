/**
 * Static preview of the MCP settings panel, rendered from the real component
 * code with the same React-shaped shim the offline check uses.
 *
 *   node test/preview-panel.mjs <output.html>
 *
 * It exists so a display change can be inspected without a browser session:
 * the markup is the component's own output, and the stylesheet is the bundle's
 * own CSS over a stand-in for the GUI theme variables.
 */
import { writeFileSync } from 'node:fs'

// The panel schedules a one-second countdown only while a server is
// reconnecting. A static preview does not need it, and a live interval would
// keep this process alive forever.
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

let store = []
let cursor = 0
const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState(initial) {
    const slot = cursor++
    if (!(slot in store)) store[slot] = typeof initial === 'function' ? initial() : initial
    return [store[slot], (next) => { store[slot] = typeof next === 'function' ? next(store[slot]) : next }]
  },
  useRef(initial) {
    const slot = cursor++
    if (!(slot in store)) store[slot] = { current: initial }
    return store[slot]
  },
  useCallback(fn) {
    cursor += 1
    return fn
  },
  useEffect(fn) {
    const slot = cursor++
    if (!(slot in store)) store[slot] = { fn, ran: false }
  },
}

/** Render one component, running its effects once and settling its async state. */
async function mount(component, props) {
  store = []
  let tree = null
  for (let pass = 0; pass < 8; pass += 1) {
    cursor = 0
    tree = component(props)
    let ran = false
    for (const slot of store) {
      if (slot && typeof slot.fn === 'function' && slot.ran !== true) {
        slot.ran = true
        slot.fn()
        ran = true
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (!ran) break
  }
  return tree
}

/** Render one element tree to HTML, giving each component its own hook slots. */
function serialize(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(serialize).join('')
  if (typeof node === 'string') return escape(node)
  if (typeof node === 'number') return String(node)
  if (typeof node.type === 'function') {
    const savedStore = store
    const savedCursor = cursor
    store = []
    cursor = 0
    let rendered
    try {
      rendered = node.type(node.props)
    } finally {
      store = savedStore
      cursor = savedCursor
    }
    return serialize(rendered)
  }
  const props = node.props ?? {}
  const attrs = []
  if (props.className) attrs.push(`class="${escape(String(props.className))}"`)
  if (props.type) attrs.push(`type="${escape(String(props.type))}"`)
  if (props.placeholder) attrs.push(`placeholder="${escape(String(props.placeholder))}"`)
  if (props.checked) attrs.push('checked')
  if (props.value !== undefined && props.value !== null && props.type !== 'checkbox') {
    attrs.push(`value="${escape(String(props.value))}"`)
  }
  const open = `<${node.type}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}`
  if (['input', 'br', 'hr', 'img'].includes(node.type)) return `${open}>`
  return `${open}>${serialize(props.children)}</${node.type}>`
}

const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ── load the bundle the way the shell does ───────────────────────────────────
let registered = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registered = { id: entry.id, exports: entry.factory((id) => {
        if (id === 'react') return React
        throw new Error(`unexpected module ${id}`)
      }) }
    },
  },
}
await import(new URL('../lib/client.js', import.meta.url).href)
const plugin = registered.exports
const { McpServersSection, ServerCard } = plugin.__components
const dictionary = plugin.__dictionaries.zh
const t = (key) => {
  let value = dictionary
  for (const part of String(key).split('.')) value = value === undefined ? undefined : value[part]
  return typeof value === 'string' ? value : key
}

const now = Date.now()
const reconnectOn = { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10, attempts: 0, nextRetryAt: 0 }
const githubTools = [
  { rawName: 'create_issue', publicName: 'mcp__github__create_issue', description: 'Open a new issue in a repository.' },
  { rawName: 'list_prs', publicName: 'mcp__github__list_prs', description: 'List pull requests for a repository.' },
  { rawName: 'get_pr', publicName: 'mcp__github__get_pr', description: 'Read one pull request, its review state, and its comments.' },
  { rawName: 'list_issues', publicName: 'mcp__github__list_issues', description: 'List issues with optional label and state filters.' },
  { rawName: 'create_branch', publicName: 'mcp__github__create_branch', description: 'Create a branch from a ref.' },
  { rawName: 'commit_files', publicName: 'mcp__github__commit_files', description: 'Commit one or more files to a branch.' },
  { rawName: 'comment_on_pr', publicName: 'mcp__github__comment_on_pr', description: 'Post a review comment on a pull request.' },
  { rawName: 'search code', publicName: 'mcp__github__search_code_7f3a1c9d2e40', description: 'Search code across repositories.' },
]
const snapshot = {
  generation: 7,
  rowId: 'mcp-manager',
  patchMode: 'override',
  channel: { path: '/mcp-manager', state: 'registered', error: '' },
  patchFile: 'C:\\Users\\dev\\.dsh\\profiles\\web\\cordis.patch.yml',
  persistence: { writable: true, patchFile: 'C:\\Users\\dev\\.dsh\\profiles\\web\\cordis.patch.yml', mode: 'override' },
  servers: [
    {
      name: 'github',
      transport: 'stdio',
      enabled: true,
      target: 'npx -y @modelcontextprotocol/server-github',
      definition: { name: 'github', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: {}, cwd: '', toolCallTimeoutMs: 60000, reconnect: reconnectOn },
      state: 'connected',
      error: '',
      toolCount: githubTools.length,
      tools: githubTools,
      startedAt: now - 42 * 60 * 1000,
      lastSyncAt: now - 30 * 1000,
      timeoutMs: 60000,
      reconnect: reconnectOn,
    },
    {
      name: 'memory',
      transport: 'streamable-http',
      enabled: true,
      target: 'http://127.0.0.1:8931/mcp',
      definition: { name: 'memory', enabled: true, transport: 'streamable-http', url: 'http://127.0.0.1:8931/mcp', headers: {}, toolCallTimeoutMs: 30000, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 10000, maxAttempts: 5 } },
      state: 'reconnecting',
      error: 'fetch failed',
      toolCount: 1,
      tools: [{ rawName: 'remember', publicName: 'mcp__memory__remember', description: 'Store one fact.' }],
      startedAt: 0,
      lastSyncAt: now - 12 * 60 * 1000,
      timeoutMs: 30000,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 10000, maxAttempts: 5, attempts: 2, nextRetryAt: now + 1800 },
    },
    {
      name: 'offline-service',
      transport: 'streamable-http',
      enabled: false,
      target: 'https://mcp.example.test/v1',
      definition: { name: 'offline-service', enabled: false, transport: 'streamable-http', url: 'https://mcp.example.test/v1', headers: {}, toolCallTimeoutMs: 60000, reconnect: reconnectOn },
      state: 'disabled',
      error: '',
      toolCount: 0,
      tools: [],
      startedAt: 0,
      lastSyncAt: 0,
      timeoutMs: 60000,
      reconnect: { ...reconnectOn, attempts: 0, nextRetryAt: 0 },
    },
  ],
  totals: { servers: 3, enabled: 2, connected: 1, reconnecting: 1, tools: 4 },
}

const panel = await mount(McpServersSection, { call: async () => snapshot, t, close: () => {} })
const expandedCard = await mount(ServerCard, {
  server: snapshot.servers[0],
  t,
  busy: '',
  now,
  metaOpen: true,
  toolsOpen: true,
  onToggle: () => {},
  onEdit: () => {},
  onRemove: () => {},
  onRefresh: () => {},
  onToggleMeta: () => {},
  onToggleTools: () => {},
})

// The stylesheet lives inside the factory scope; re-read it from the bundle text.
const bundleSource = await import('node:fs').then((fs) => fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
const css = /const CSS = `([\s\S]*?)`;/.exec(bundleSource)?.[1] ?? ''

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>dsh-mcp-manager panel preview</title>
<style>
:root{
  --dsw-alias-bg-base:#ffffff; --dsw-alias-bg-layer-1:#ffffff; --dsw-alias-bg-layer-2:#f6f8fa;
  --dsw-alias-label-primary:#1f2328; --dsw-alias-label-secondary:#59636e;
  --dsw-alias-border-l1:#d8dee4; --dsw-alias-border-l2:#d0d7de;
  --dsw-alias-brand-primary:#0969da;
  --dsw-alias-state-success-primary:#1a7f37; --dsw-alias-state-warn-primary:#9a6700;
  --dsw-alias-state-error-primary:#cf222e;
}
body{margin:0;padding:28px;background:#ffffff;font-family:-apple-system,"Segoe UI","Noto Sans",sans-serif;}
.preview-note{max-width:860px;margin:0 auto 18px;padding:10px 12px;border:1px dashed #d0d7de;border-radius:8px;color:#59636e;font-size:12px;}
.preview-split{max-width:860px;margin:24px auto 0;padding-top:18px;border-top:1px solid #d8dee4;color:#59636e;font-size:12px;}
${css}
</style></head>
<body>
<div class="preview-note">离线预览：组件与样式均取自 <code>lib/client.js</code>；示例数据含“已连接 / 重连中 / 已禁用”三种状态，卡片为默认折叠态。</div>
${serialize(panel)}
<div class="preview-split">下面是一张展开的卡片（真实的 ServerCard，metaOpen = true、toolsOpen = true）：</div>
<div class="dsh-mcp" style="max-width:860px;margin:12px auto 0;">${serialize(expandedCard)}</div>
</body></html>`

const output = process.argv[2] ?? new URL('../panel-preview.html', import.meta.url).pathname.replace(/^\//, '')
writeFileSync(output, html, 'utf8')
console.log(`wrote ${output} (${html.length} bytes)`)
