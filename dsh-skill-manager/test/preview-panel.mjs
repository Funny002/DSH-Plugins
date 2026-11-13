/**
 * Static preview of the skills settings panel, rendered from the real component
 * code with the same React-shaped shim the offline check uses.
 *
 *   node test/preview-panel.mjs <output.html>
 *
 * It exists so a display change can be inspected without a browser session:
 * the markup is the component's own output, and the stylesheet is the bundle's
 * own CSS over a stand-in for the GUI theme variables.
 */
import { writeFileSync } from 'node:fs'

// The panel schedules a status poll; a static preview does not need it, and a
// live interval would keep this process alive forever.
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
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || typeof value === 'function' || value === undefined || value === null || value === false) continue
    const name = key === 'className' ? 'class' : key
    if (value === true) attrs.push(name)
    else attrs.push(`${name}="${escape(String(value))}"`)
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
      registered = {
        id: entry.id,
        exports: entry.factory((id) => {
          if (id === 'react') return React
          throw new Error(`unexpected module ${id}`)
        }),
      }
    },
  },
}
await import(new URL('../lib/client.js', import.meta.url).href)
const plugin = registered.exports
const { SkillsSection, SkillCard, SkillForm, ImportForm, IssuesPanel } = plugin.__components
const dictionary = plugin.__dictionaries.zh
const t = (key) => {
  let value = dictionary
  for (const part of String(key).split('.')) value = value === undefined ? undefined : value[part]
  return typeof value === 'string' ? value : key
}

const now = Date.now()
const skill = (overrides) => ({
  name: 'example',
  description: 'What this skill does.',
  whenToUse: '',
  invocation: { modelInvocable: true, userInvocable: true },
  metadata: undefined,
  bodyBytes: 640,
  path: 'C:/Users/dev/.dsh/skills/example/SKILL.md',
  directory: 'C:/Users/dev/.dsh/skills/example',
  layout: 'bundle',
  updatedAt: now - 4 * 60 * 1000,
  warnings: [],
  status: 'active',
  shadowedBy: '',
  ...overrides,
})

const snapshot = {
  generation: 12,
  version: '0.2.0',
  rowId: 'skill-manager',
  channel: { path: '/skill-manager', state: 'registered', error: '' },
  workspace: { cwd: 'D:\\work\\demo', dshHome: 'C:\\Users\\dev\\.dsh' },
  skillRoot: 'C:\\Users\\dev\\.dsh\\skills',
  roots: [
    { id: 'user-dsh', source: 'user-dsh', rank: 400, path: 'C:\\Users\\dev\\.dsh\\skills', custom: false, exists: true, skillCount: 4, issueCount: 1 },
  ],
  skills: [
    skill({
      name: 'code-review',
      description: 'Review a diff for correctness, style, edge cases, and missing tests before it is committed.',
      whenToUse: 'When the user asks for a code review or to check a pending change.',
      metadata: { owner: 'platform', version: '2' },
      bodyBytes: 2140,
      path: 'C:\\Users\\dev\\.dsh\\skills\\code-review\\SKILL.md',
      directory: 'C:\\Users\\dev\\.dsh\\skills\\code-review',
      updatedAt: now - 40 * 1000,
    }),
    skill({
      name: 'commit-message',
      description: 'Write a Conventional Commits message from the staged diff.',
      invocation: { modelInvocable: false, userInvocable: true },
      bodyBytes: 540,
      path: 'C:\\Users\\dev\\.dsh\\skills\\commit-message.md',
      directory: 'C:\\Users\\dev\\.dsh\\skills',
      layout: 'file',
      updatedAt: now - 12 * 60 * 1000,
      warnings: ['文件位置名 "commit-message" 与 frontmatter 的 name 不一致'],
    }),
    skill({
      name: 'release-notes',
      description: 'Turn a range of commits into release notes grouped by change type.',
      invocation: { modelInvocable: true, userInvocable: false },
      bodyBytes: 980,
      path: 'C:\\Users\\dev\\.dsh\\skills\\release-notes\\SKILL.md',
      directory: 'C:\\Users\\dev\\.dsh\\skills\\release-notes',
      updatedAt: now - 3 * 60 * 60 * 1000,
    }),
    skill({
      name: 'code-review',
      description: 'An older copy of the review skill that loses the name race inside the same root.',
      invocation: { modelInvocable: true, userInvocable: true },
      bodyBytes: 1200,
      path: 'C:\\Users\\dev\\.dsh\\skills\\review-old\\SKILL.md',
      directory: 'C:\\Users\\dev\\.dsh\\skills\\review-old',
      status: 'shadowed',
      shadowedBy: 'C:\\Users\\dev\\.dsh\\skills\\code-review\\SKILL.md',
      updatedAt: now - 26 * 60 * 60 * 1000,
    }),
  ],
  issues: [
    {
      path: 'C:\\Users\\dev\\.dsh\\skills\\broken\\SKILL.md',
      message: '缺少 YAML frontmatter：文件必须以单独一行 --- 开头，并以单独一行 --- 结束',
    },
  ],
  totals: { skills: 4, active: 3, shadowed: 1, issues: 1, model: 2, user: 3, disabled: 1, roots: 1, bundles: 3, files: 1 },
}

const call = async (endpoint) => {
  if (endpoint === 'get') {
    return {
      body: [
        '# Code review',
        '',
        'Read the full diff before writing anything. Check, in order:',
        '',
        '1. correctness against the stated intent;',
        '2. error handling at every new boundary;',
        '3. tests for each new branch;',
        '4. naming and comment accuracy.',
        '',
        'Report findings by file and line. Do not rewrite the patch unless asked.',
      ].join('\n'),
      raw: '',
      skill: snapshot.skills[0],
    }
  }
  return snapshot
}

const panel = await mount(SkillsSection, { call, t })

// The shape an older host produces: the project root and the skill root are the
// same directory, so the same file arrives twice (shadowed by its own path) and
// a project skill leaks in. The page must show one row per file and warn.
const legacySnapshot = {
  ...snapshot,
  version: '0.1.0',
  skillRoot: undefined,
  roots: [
    { id: 'project-dsh', source: 'project-dsh', rank: 100, path: 'C:\\Users\\dev\\.dsh\\skills', custom: false, exists: true, skillCount: 4, issueCount: 0 },
    { id: 'user-dsh', source: 'user-dsh', rank: 400, path: 'C:\\Users\\dev\\.dsh\\skills', custom: false, exists: true, skillCount: 4, issueCount: 0 },
  ],
  skills: [
    ...snapshot.skills,
    {
      ...snapshot.skills[0],
      description: 'Duplicate row produced by scanning the same directory twice.',
      status: 'shadowed',
      shadowedBy: snapshot.skills[0].path,
    },
    {
      ...snapshot.skills[0],
      name: 'project-only',
      description: 'A project skill outside the managed root.',
      path: 'D:\\work\\demo\\.dsh\\skills\\project-only\\SKILL.md',
      directory: 'D:\\work\\demo\\.dsh\\skills\\project-only',
      status: 'active',
      shadowedBy: '',
    },
  ],
}
const legacyPanel = await mount(SkillsSection, { call: async () => legacySnapshot, t })
const expandedSkill = {
  ...snapshot.skills[0],
  description: 'Review a diff for correctness, style, edge cases, and missing tests before it is committed.',
}
const expandedCard = await mount(SkillCard, {
  skill: expandedSkill,
  t,
  busy: '',
  now,
  detailsOpen: true,
  bodyOpen: true,
  body: { loading: false, text: (await call('get')).body, error: '' },
  onToggleEnabled: () => {},
  onEdit: () => {},
  onRemove: () => {},
  onCopy: () => {},
  onToggleDetails: () => {},
  onToggleBody: () => {},
})
const form = await mount(SkillForm, {
  t,
  mode: 'create',
  original: null,
  rootPath: snapshot.skillRoot,
  initial: plugin.__helpers.emptyDraft(),
  onCancel: () => {},
  onSubmit: () => {},
  onValidate: async () => ({
    valid: true,
    warnings: ['正文为空：模型加载该技能时只会看到说明文字'],
    issues: [],
    preview: '---\nname: new-skill\ndescription: 一句话说明这个技能做什么。\nwhenToUse: 什么时候该加载它。\ndisable-model-invocation: false\nuser-invocable: true\n---\n\n## Steps\n\n1. …',
    target: 'C:/Users/dev/.dsh/skills/new-skill/SKILL.md',
  }),
})
const importForm = await mount(ImportForm, {
  t,
  rootPath: snapshot.skillRoot,
  initial: plugin.__helpers.emptyImportDraft(),
  onCancel: () => {},
  onSubmit: () => {},
})
const issuesPanel = await mount(IssuesPanel, {
  t,
  issues: snapshot.issues,
  open: true,
  onToggle: () => {},
  onDiscard: () => {},
})

// The stylesheet lives inside the factory scope; re-read it from the bundle text.
const bundleSource = await import('node:fs').then((fs) => fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
const css = /const CSS = `([\s\S]*?)`;/.exec(bundleSource)?.[1] ?? ''

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>dsh-skill-manager panel preview</title>
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
<div class="preview-note">离线预览：组件与样式均取自 <code>lib/client.js</code>。示例数据含「生效 / 已停用模型 / 已遮蔽 / 有警告」四种状态，全部位于同一个技能根目录；卡片为默认折叠态，下方另有展开卡片、异常面板、新建表单与导入表单。</div>
${serialize(panel)}
<div class="preview-split">旧宿主快照（v0.1.0：同一文件被项目根与用户根各扫一次，另有一个项目根技能混入）——页面只渲染根目录内的一行并提示重启：</div>
<div class="dsh-skm" style="max-width:860px;margin:12px auto 0;">${serialize(legacyPanel)}</div>
<div class="preview-split">一张展开的卡片（真实的 SkillCard，detailsOpen = true、bodyOpen = true）：</div>
<div class="dsh-skm" style="max-width:860px;margin:12px auto 0;">${serialize(expandedCard)}</div>
<div class="preview-split">异常面板（真实的 IssuesPanel，展开并带「删除」动作）：</div>
<div class="dsh-skm" style="max-width:860px;margin:12px auto 0;">${serialize(issuesPanel)}</div>
<div class="preview-split">新建表单（真实的 SkillForm）：</div>
<div class="dsh-skm" style="max-width:860px;margin:12px auto 0;">${serialize(form)}</div>
<div class="preview-split">导入表单（真实的 ImportForm）：</div>
<div class="dsh-skm" style="max-width:860px;margin:12px auto 0;">${serialize(importForm)}</div>
</body></html>`

const output = process.argv[2] ?? new URL('../panel-preview.html', import.meta.url).pathname.replace(/^\//, '')
writeFileSync(output, html, 'utf8')
console.log(`wrote ${output} (${html.length} bytes)`)
