/**
 * Offline checks for the browser bundle: it must register itself through the
 * shell's module-loader facade, export the plugin surface, carry every literal
 * translation key in both dictionaries, and render each component without a
 * browser (a React-shaped shim mounts the page and walks the element tree).
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

// ── a React-shaped shim, enough to mount and walk function components ───────
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
    // keeps its state even while another component renders after the render pass
    // has restored the outer hook array.
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
    if (!(slot in owner)) owner[slot] = { fn, ran: false }
    else owner[slot].fn = fn
  },
}

const requireShim = (id) => {
  if (id === 'react') return React
  throw new Error(`bundle required an unexpected module: ${id}`)
}

// The page polls; an interval would keep this process alive forever.
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.clearTimeout = (handle) => {
  if (typeof handle === 'number') return
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
check('bundle id equals the package name', registered.id === 'dsh-skill-manager', registered.id)
check('exports apply', typeof plugin.apply === 'function')
check('exports inject', Array.isArray(plugin.inject))
check('inject lists slots and connection', plugin.inject.includes('slots') && plugin.inject.includes('connection'))
check('exports components', Object.keys(plugin.__components).length >= 4)

// ── dictionary coverage for every literal t("…") key ───────────────────────
const source = readFileSync(bundlePath, 'utf8')
const usedKeys = new Set([...source.matchAll(/\bt\("([^"]+)"\)/g)].map((match) => match[1]))
const lookupKey = (dictionary, key) => {
  let value = dictionary
  for (const part of key.split('.')) value = value === undefined ? undefined : value[part]
  return value
}
for (const key of usedKeys) {
  for (const [dictionaryName, dictionary] of Object.entries(plugin.__dictionaries)) {
    check(`dictionary ${dictionaryName} has ${key}`, typeof lookupKey(dictionary, key) === 'string')
  }
}
for (const key of ['secondsAgo', 'minutesAgo', 'hoursAgo', 'daysAgo']) {
  for (const [dictionaryName, dictionary] of Object.entries(plugin.__dictionaries)) {
    check(`dictionary ${dictionaryName}.time has ${key}`, typeof dictionary.time?.[key] === 'string')
  }
}

// ── mount the real page ────────────────────────────────────────────────────
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/** Mount one component, running its effects and settling its async state. */
async function mount(component, props) {
  hooks = []
  let tree = null
  for (let pass = 0; pass < 8; pass += 1) {
    cursor = 0
    tree = component(props)
    let ran = false
    for (const slot of hooks) {
      if (slot && typeof slot.fn === 'function' && slot.ran !== true) {
        slot.ran = true
        slot.fn()
        ran = true
      }
    }
    await tick()
    if (!ran) break
  }
  return tree
}

/** Render one element tree to searchable text, expanding function components once. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node.type === 'function') {
    let rendered
    try {
      rendered = withHooks(() => node.type(node.props))
    } catch (error) {
      failures.push(`render failed in ${node.type.name || 'anonymous'}: ${error.message}`)
      return ''
    }
    return textOf(rendered)
  }
  return textOf(node.props?.children)
}

/** Whether any element in the tree carries one exact prop value. */
function hasProp(node, property, value) {
  if (node === null || node === undefined || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((child) => hasProp(child, property, value))
  if (typeof node.type === 'function') {
    let rendered
    try {
      rendered = withHooks(() => node.type(node.props))
    } catch {
      return false
    }
    return hasProp(rendered, property, value)
  }
  if ((node.props ?? {})[property] === value) return true
  return hasProp(node.props?.children, property, value)
}

const strictT = (key) => {
  const value = lookupKey(plugin.__dictionaries.zh, key)
  if (typeof value !== 'string') throw new Error(`missing translation for ${key}`)
  return value
}

const now = Date.now()
const rootPath = 'C:/Users/x/.dsh/skills'
const snapshot = {
  generation: 7,
  version: '0.2.0',
  rowId: 'skill-manager',
  channel: { path: '/skill-manager', state: 'registered', error: '' },
  workspace: { cwd: 'D:/work/demo', dshHome: 'C:/Users/x/.dsh' },
  skillRoot: rootPath,
  roots: [{ id: 'user-dsh', source: 'user-dsh', rank: 400, path: rootPath, custom: false, exists: true, skillCount: 3, issueCount: 1 }],
  skills: [
    {
      name: 'code-review',
      description: 'Review a diff for correctness, style, and missing tests.',
      whenToUse: 'When the user asks for a review.',
      invocation: { modelInvocable: true, userInvocable: true },
      metadata: { owner: 'platform' },
      bodyBytes: 842,
      path: 'C:/Users/x/.dsh/skills/code-review/SKILL.md',
      directory: 'C:/Users/x/.dsh/skills/code-review',
      layout: 'bundle',
      updatedAt: now - 90 * 1000,
      warnings: [],
      status: 'active',
      shadowedBy: '',
    },
    {
      name: 'commit-message',
      description: 'Write a Conventional Commits message from staged changes.',
      whenToUse: '',
      invocation: { modelInvocable: false, userInvocable: true },
      metadata: undefined,
      bodyBytes: 120,
      path: 'C:/Users/x/.dsh/skills/commit-message.md',
      directory: rootPath,
      layout: 'file',
      updatedAt: now - 3 * 60 * 1000,
      warnings: ['文件位置名 "commit-message" 与 frontmatter 的 name 不一致'],
      status: 'active',
      shadowedBy: '',
    },
    {
      name: 'code-review-old',
      description: 'An older review skill that lost the name race.',
      whenToUse: '',
      invocation: { modelInvocable: true, userInvocable: false },
      metadata: undefined,
      bodyBytes: 40,
      path: 'C:/Users/x/.dsh/skills/code-review-old/SKILL.md',
      directory: 'C:/Users/x/.dsh/skills/code-review-old',
      layout: 'bundle',
      updatedAt: now - 2 * 60 * 60 * 1000,
      warnings: [],
      status: 'shadowed',
      shadowedBy: 'C:/Users/x/.dsh/skills/code-review/SKILL.md',
    },
    {
      // An older host whose project root coincided with the skill root listed
      // the same file twice; the second row was shadowed by its own path.
      name: 'code-review',
      description: 'Duplicate row for the same instruction file.',
      whenToUse: '',
      invocation: { modelInvocable: true, userInvocable: true },
      metadata: undefined,
      bodyBytes: 842,
      path: 'C:/Users/x/.dsh/skills/code-review/SKILL.md',
      directory: 'C:/Users/x/.dsh/skills/code-review',
      layout: 'bundle',
      updatedAt: now - 90 * 1000,
      warnings: [],
      status: 'shadowed',
      shadowedBy: 'C:/Users/x/.dsh/skills/code-review/SKILL.md',
    },
    {
      // A skill outside the managed root; an older host still scanned project
      // roots, the current design must not show it.
      name: 'project-only',
      description: 'A project skill that must stay out of this page.',
      whenToUse: '',
      invocation: { modelInvocable: true, userInvocable: true },
      metadata: undefined,
      bodyBytes: 10,
      path: 'D:/work/demo/.dsh/skills/project-only/SKILL.md',
      directory: 'D:/work/demo/.dsh/skills/project-only',
      layout: 'bundle',
      updatedAt: now - 30 * 60 * 1000,
      warnings: [],
      status: 'active',
      shadowedBy: '',
    },
  ],
  issues: [
    { path: 'C:/Users/x/.dsh/skills/broken/SKILL.md', message: '缺少 YAML frontmatter：文件必须以单独一行 --- 开头，并以单独一行 --- 结束' },
  ],
  totals: { skills: 3, active: 2, shadowed: 1, issues: 1, model: 2, user: 2, disabled: 0, roots: 1, bundles: 2, files: 1 },
}

const page = await mount(plugin.__components.SkillsSection, {
  call: async (endpoint) => {
    if (endpoint === 'get') return { body: '# Review\n\nCheck the diff carefully.', raw: '', skill: snapshot.skills[0] }
    return snapshot
  },
  t: strictT,
})
const pageText = textOf(page)
check('the page renders the title', pageText.includes('技能'))
check('the page renders the version badge', pageText.includes('v0.2.0'))
check('the page lists every managed skill', ['code-review', 'commit-message', 'code-review-old'].every((name) => pageText.includes(name)))
check('the page shows the summary counts', pageText.includes('模型可见') && pageText.includes('已遮蔽'))
check('the page shows the skill root in the footer', pageText.includes('技能根目录') && pageText.includes(rootPath))
check('the page shows the workspace footer', pageText.includes('D:/work/demo'))
check('the page reports unreadable files', pageText.includes('1 个文件无法被识别'))
check('the page has a create action', pageText.includes('新建技能'))
check('the page has a search box', hasProp(page, 'placeholder', '筛选名称、描述或路径'))
check('the page has filter options', pageText.includes('全部') && pageText.includes('已停用模型'))
check('the shadowed row explains its winner', pageText.includes('C:/Users/x/.dsh/skills/code-review/SKILL.md'))
check('the page has no root-management control', !pageText.includes('添加根目录') && !pageText.includes('附加根目录'))
check('the page hides skills outside the managed root', !pageText.includes('project-only'))
check('a current host shows no legacy warning', !pageText.includes('旧版技能管理器'))
check('no markup text is undefined', !pageText.includes('undefined'))
check('no markup text is NaN', !pageText.includes('NaN'))

// ── one expanded card with its body ────────────────────────────────────────
{
  const card = await mount(plugin.__components.SkillCard, {
    skill: snapshot.skills[0],
    t: strictT,
    busy: '',
    now,
    detailsOpen: true,
    bodyOpen: true,
    body: { loading: false, text: '# Review\n\nCheck the diff carefully.', error: '' },
    onToggleEnabled: () => {},
    onEdit: () => {},
    onRemove: () => {},
    onCopy: () => {},
    onToggleDetails: () => {},
    onToggleBody: () => {},
  })
  const cardText = textOf(card)
  check('the card shows the description', cardText.includes('Review a diff for correctness'))
  check('the card shows the full path', cardText.includes('C:/Users/x/.dsh/skills/code-review/SKILL.md'))
  check('the card shows the invocation policy', cardText.includes('模型可见 · 用户可调用'))
  check('the card shows the metadata', cardText.includes('"owner":"platform"'))
  check('the card renders the body', cardText.includes('Check the diff carefully.'))
  check('the card offers edit and remove', cardText.includes('编辑') && cardText.includes('删除'))
  check('the card offers copy', cardText.includes('复制'))
  check('the card offers the body toggle', cardText.includes('收起正文'))
}
{
  const card = await mount(plugin.__components.SkillCard, {
    skill: snapshot.skills[1],
    t: strictT,
    busy: '',
    now,
    detailsOpen: true,
    bodyOpen: false,
    body: undefined,
    onToggleEnabled: () => {},
    onEdit: () => {},
    onRemove: () => {},
    onCopy: () => {},
    onToggleDetails: () => {},
    onToggleBody: () => {},
  })
  const cardText = textOf(card)
  check('a model-hidden card offers a full disable', cardText.includes('停用'))
  check('a model-hidden card shows its chip', cardText.includes('模型不可见'))
  check('a warned card shows the warning chip', cardText.includes('注意'))
  check('a warned card explains the warning', cardText.includes('文件位置名'))
}

// ── the create form ────────────────────────────────────────────────────────
{
  const form = await mount(plugin.__components.SkillForm, {
    t: strictT,
    mode: 'create',
    original: null,
    rootPath,
    initial: plugin.__helpers.emptyDraft(),
    onCancel: () => {},
    onSubmit: () => {},
    onValidate: async () => ({ valid: true, warnings: [], issues: [], preview: '---\nname: x\n---\n', target: 'C:/Users/x/.dsh/skills/x/SKILL.md' }),
  })
  const formText = textOf(form)
  check('the create form has its title', formText.includes('新建技能'))
  check('the create form has every field', ['名称', '描述', '使用时机', '磁盘布局', '正文（Markdown）'].every((label) => formText.includes(label)))
  check('the create form offers both layouts', formText.includes('目录（<名称>/SKILL.md）') && formText.includes('单文件（<名称>.md）'))
  check('the create form names the single root', formText.includes('写入技能根目录') && formText.includes(rootPath))
  check('the create form has no root select', !formText.includes('目标根目录'))
  check('the create form has the actions', formText.includes('保存') && formText.includes('校验') && formText.includes('取消'))
}
{
  const form = await mount(plugin.__components.SkillForm, {
    t: strictT,
    mode: 'edit',
    original: snapshot.skills[0],
    rootPath,
    initial: plugin.__helpers.draftFromSkill(snapshot.skills[0], { body: 'body' }, 'edit'),
    onCancel: () => {},
    onSubmit: () => {},
    onValidate: async () => ({ valid: true }),
  })
  const formText = textOf(form)
  check('the edit form names the skill', formText.includes('编辑技能 code-review'))
  check('the edit form names the single root', formText.includes(rootPath))
  check('the edit form does not offer the layout hint', !formText.includes('目录布局为 <名称>/SKILL.md'))
}

// ── empty, filtered, and failing pages ─────────────────────────────────────
{
  const empty = { ...snapshot, skills: [], issues: [], totals: { ...snapshot.totals, skills: 0, active: 0, shadowed: 0, issues: 0, model: 0, user: 0 } }
  const pageEmpty = await mount(plugin.__components.SkillsSection, { call: async () => empty, t: strictT })
  const emptyText = textOf(pageEmpty)
  check('the empty page explains the first step', emptyText.includes('还没有发现本地技能'))
  check('the empty page names the root', emptyText.includes(rootPath))
  check('the empty page does not render a card', !emptyText.includes('code-review'))
}
{
  const pageError = await mount(plugin.__components.SkillsSection, {
    call: async () => {
      throw new Error('无法访问宿主插件')
    },
    t: strictT,
  })
  check('a transport failure is shown in a banner', textOf(pageError).includes('无法访问宿主插件'))
}
{
  const pageLegacy = await mount(plugin.__components.SkillsSection, {
    call: async () => ({ ...snapshot, skillRoot: undefined }),
    t: strictT,
  })
  const legacyText = textOf(pageLegacy)
  check('an older host shows the restart warning', legacyText.includes('旧版技能管理器'))
  check('an older host still lists one row per file', legacyText.includes('code-review'))
  check('an older host still hides outside-root rows', !legacyText.includes('project-only'))
}

// ── issues panel ───────────────────────────────────────────────────────────
{
  const issues = await mount(plugin.__components.IssuesPanel, { t: strictT, issues: snapshot.issues, open: true, onToggle: () => {} })
  const issuesText = textOf(issues)
  check('the issues panel names the file', issuesText.includes('C:/Users/x/.dsh/skills/broken/SKILL.md'))
  check('the issues panel explains the problem', issuesText.includes('缺少 YAML frontmatter'))
  check('the issues panel collapses', textOf(await mount(plugin.__components.IssuesPanel, { t: strictT, issues: snapshot.issues, open: false, onToggle: () => {} })).includes('查看'))
}

// ── pure helpers ───────────────────────────────────────────────────────────
{
  const helpers = plugin.__helpers
  const managed = helpers.visibleSkills(snapshot)
  check('filter by name', helpers.filterSkills(managed, 'review', 'all').length === 2)
  check('filter by description', helpers.filterSkills(managed, 'conventional', 'all').length === 1)
  check('filter by shadowed', helpers.filterSkills(managed, '', 'shadowed').length === 1)
  check('filter by disabled model', helpers.filterSkills(managed, '', 'disabled').length === 1)
  check('filter by warning', helpers.filterSkills(managed, '', 'warned').length === 1)
  check('filter is case-insensitive', helpers.filterSkills(managed, 'CONVENTIONAL', 'all').length === 1)
  check('a copy draft gets a -copy suffix', helpers.draftFromSkill(snapshot.skills[0], { body: 'b' }, 'copy').name === 'code-review-copy')
  check('an edit draft keeps the name', helpers.draftFromSkill(snapshot.skills[0], { body: 'b' }, 'edit').name === 'code-review')
  check('a draft keeps the invocation policy', helpers.draftFromSkill(snapshot.skills[1], { body: 'b' }, 'edit').modelInvocable === false)
  check('a draft keeps the loaded body', helpers.draftFromSkill(snapshot.skills[0], { body: 'hello' }, 'edit').body === 'hello')
  check('a draft carries no root', !Object.hasOwn(helpers.draftFromSkill(snapshot.skills[0], {}, 'edit'), 'root'))
  check('a new draft carries no root', !Object.hasOwn(helpers.emptyDraft(), 'root'))
  check('definitionFromDraft trims fields', helpers.definitionFromDraft({ name: ' a ', description: ' b ', whenToUse: ' c ', layout: 'file', body: 'd' }).name === 'a')
  check('definitionFromDraft carries no root', !Object.hasOwn(helpers.definitionFromDraft({ name: 'a', description: 'b' }), 'root'))
  check('draftProblem rejects a bad name', helpers.draftProblem({ name: 'Bad Name', description: 'x' }, strictT) !== '')
  check('draftProblem accepts a good draft', helpers.draftProblem({ name: 'good-name', description: 'x' }, strictT) === '')
  check('saveAction creates', helpers.saveAction({ mode: 'create', skill: null }, { name: 'x' }).endpoint === 'create')
  check('saveAction updates by path', helpers.saveAction({ mode: 'edit', skill: snapshot.skills[0] }, { name: 'x' }).payload.path === snapshot.skills[0].path)
  check('saveAction copies by path', helpers.saveAction({ mode: 'copy', skill: snapshot.skills[1] }, { name: 'x' }).endpoint === 'copy')
  check('saveAction defaults to create', helpers.saveAction(null, { name: 'x' }).endpoint === 'create')
  check('formatBytes renders bytes', helpers.formatBytes(842) === '842 B')
  check('formatBytes renders kilobytes', helpers.formatBytes(2048) === '2.0 KB')
  check('formatBytes handles zero', helpers.formatBytes(0) === '0 B')
  check('formatAgo renders seconds', helpers.formatAgo(strictT, now - 5000, now) === '5 秒前')
  check('formatAgo renders hours', helpers.formatAgo(strictT, now - 3 * 60 * 60 * 1000, now) === '3 小时前')
  check('formatAgo hides a missing timestamp', helpers.formatAgo(strictT, 0, now) === '')
  check('invocationLabel both', helpers.invocationLabel(strictT, { modelInvocable: true, userInvocable: true }) === '模型可见 · 用户可调用')
  check('invocationLabel none', helpers.invocationLabel(strictT, { modelInvocable: false, userInvocable: false }) === '模型不可见 · 用户不可调用')
  check('skillRootOf prefers skillRoot', helpers.skillRootOf(snapshot) === rootPath)
  check('skillRootOf falls back to the user root', helpers.skillRootOf({ roots: [{ id: 'project-dsh', path: 'C:/project' }, { id: 'user-dsh', path: 'C:/fallback' }] }) === 'C:/fallback')
  check('skillRootOf tolerates no snapshot', helpers.skillRootOf(null) === '')
  check('visibleSkills hides outside-root rows', helpers.visibleSkills(snapshot).every((skill) => !skill.path.includes('project-only')))
  check('visibleSkills keeps one row per file', helpers.visibleSkills(snapshot).filter((skill) => skill.path === 'C:/Users/x/.dsh/skills/code-review/SKILL.md').length === 1)
  check('visibleSkills drops a self-shadowed duplicate', helpers.visibleSkills(snapshot).every((skill) => !(skill.status === 'shadowed' && skill.shadowedBy === skill.path)))
  check('visibleSkills keeps a genuine name shadow', helpers.visibleSkills(snapshot).some((skill) => skill.status === 'shadowed'))
  check('visibleSkills tolerates a null snapshot', helpers.visibleSkills(null).length === 0)
  check('visibleSkills uses the roots fallback on an older host', helpers.visibleSkills({ ...snapshot, skillRoot: undefined }).length === 3)
  check('editorKey distinguishes targets', helpers.editorKey({ mode: 'edit', skill: { path: 'a' } }) !== helpers.editorKey({ mode: 'edit', skill: { path: 'b' } }))
  check('editorKey distinguishes modes', helpers.editorKey({ mode: 'edit', skill: { path: 'a' } }) !== helpers.editorKey({ mode: 'copy', skill: { path: 'a' } }))
  check('editorKey handles create', helpers.editorKey({ mode: 'create', skill: null }) === 'create:')
  check('editorKey handles no editor', helpers.editorKey(null) === 'none')
  check('a bundle removal prompt names the directory', helpers.removePrompt(strictT, snapshot.skills[0]).includes('C:/Users/x/.dsh/skills/code-review'))
  check('a file removal prompt names the file', helpers.removePrompt(strictT, snapshot.skills[1]).includes('C:/Users/x/.dsh/skills/commit-message.md'))
}

if (failures.length > 0) {
  console.error(`client check FAILED (${failures.length})`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log('client check OK')
