/**
 * Local skill discovery, frontmatter handling, and safe writes for the skill
 * manager.
 *
 * There is exactly one managed root: `<DSH_HOME>/skills` (on Windows typically
 * `C:\Users\<user>\.dsh\skills`). It is the same directory
 * `@deepseek-ai/dsh-skill-filesystem` scans as its `user-dsh` root at rank 400,
 * so a skill written here reaches the next model-facing catalog without a
 * restart, and there is no second place a skill could hide.
 *
 * The catalog model is the provider's:
 *
 * - a skill is a directory bundle `<root>/<name>/SKILL.md` or a flat file
 *   `<root>/<name>.md` at the top level of the root;
 * - the file starts with YAML frontmatter: required `name` (kebab-case) and
 *   `description`, optional `whenToUse`, `metadata`, `disable-model-invocation`,
 *   and `user-invocable`;
 * - the invocation keys follow the provider's strict grammar — YAML booleans
 *   plus the case-insensitive `true`/`false`, `yes`/`no`, `on`/`off`, and
 *   `1`/`0` spellings, while the legacy aliases are rejected;
 * - the body after the closing `---` is the instruction text loaded on demand.
 *
 * Unlike a provider, this module also reports what it could not parse: the
 * settings page shows those files as `issues`, because a malformed `SKILL.md`
 * is invisible to the model and therefore invisible everywhere else.
 * {@link parseSkillText} is the single parser behind both reading a file and
 * importing pasted text, so the two paths cannot drift.
 *
 * Nothing here writes outside the root: {@link writeSkillFile} checks
 * containment with {@link isInside} and publishes through a unique sibling
 * temporary file, so a reader never sees a half-written skill.
 *
 * @module dsh-skill-manager/scanner
 */
import {
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** Instruction filename of a directory bundle. */
export const SKILL_FILENAME = 'SKILL.md'
/** Public skill-name grammar: lowercase kebab-case. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Supported on-disk layouts. */
const SKILL_LAYOUTS = Object.freeze({ bundle: 'bundle', file: 'file' })
/** Directory skipped inside the user root, exactly like the provider. */
const SKIPPED_ROOT_CHILDREN = Object.freeze(['.system'])
/** Frontmatter keys this plugin owns; everything else is preserved verbatim. */
const MANAGED_FRONTMATTER_KEYS = Object.freeze([
  'name',
  'description',
  'whenToUse',
  'disable-model-invocation',
  'user-invocable',
  'metadata',
])
/** Rank the filesystem provider assigns to the user root. Reported for diagnostics. */
export const USER_ROOT_RANK = 400
/** Longest description the settings page suggests (catalog text is capped by consumers). */
const DESCRIPTION_SOFT_LIMIT = 1024
/** Longest `whenToUse` the settings page suggests. */
const WHEN_TO_USE_SOFT_LIMIT = 512
/**
 * Largest instruction file this plugin reads. A `SKILL.md` is an index that
 * points at `references/`, so anything past a megabyte is a resource file in the
 * wrong place; the cap keeps one oversized file from being read into memory on
 * every scan.
 */
export const MAX_SKILL_FILE_BYTES = 1048576
/**
 * Largest body the settings page accepts. It is the file cap minus room for the
 * frontmatter and the YAML rendering overhead, so a saved body always produces a
 * file that this plugin can read back.
 */
const MAX_BODY_BYTES = MAX_SKILL_FILE_BYTES - 16384
/** Error codes from filesystems that cannot create hard links. */
const NO_HARD_LINK_CODES = new Set(['EPERM', 'ENOSYS', 'EXDEV', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])
/**
 * How many parsed file headers the scan cache keeps.
 *
 * Every RPC request scans the root, and the settings page polls every eight
 * seconds, so re-reading and re-parsing each unchanged `SKILL.md` is the bulk of
 * the work. A header is reused while the file's mtime and size are unchanged and
 * dropped as soon as this plugin writes or deletes the file. The bound keeps a
 * large root from pinning memory for files that no longer exist.
 */
const SCAN_CACHE_ENTRIES = 1024
/** @type {Map<string, {mtimeMs: number, size: number, header: object}>} */
const headerCache = new Map()

/**
 * The parsed header of one unchanged skill file, from cache or from disk.
 * @param path - absolute instruction-file path.
 * @param stats - the stat that decided the cache key.
 * @returns the header fields a catalog row needs.
 * @throws the same errors as {@link readSkillFile}.
 */
function cachedHeader(path, stats) {
  const cached = headerCache.get(path)
  if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    // Re-insert to keep Map order least-recently-used.
    headerCache.delete(path)
    headerCache.set(path, cached)
    return cached.header
  }
  const parsed = readSkillFile(path)
  const header = {
    name: parsed.name,
    description: parsed.description,
    whenToUse: parsed.whenToUse,
    invocation: parsed.invocation,
    metadata: parsed.metadata,
    bodyBytes: Buffer.byteLength(parsed.body, 'utf8'),
    warnings: parsed.warnings,
  }
  headerCache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, header })
  if (headerCache.size > SCAN_CACHE_ENTRIES) {
    const oldest = headerCache.keys().next()
    if (oldest.done !== true) headerCache.delete(oldest.value)
  }
  return header
}

/**
 * Drop one path from the scan cache.
 *
 * Writes and deletes go through here: a same-size rewrite on a filesystem with
 * coarse timestamps must never be served from the previous parse.
 * @param path - absolute instruction-file path.
 */
export function forgetSkillHeader(path) {
  headerCache.delete(path)
}

/**
 * Whether a value is a JSON object (not null, not an array).
 * @param value - candidate value.
 * @returns true for a plain record-shaped value.
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Render a thrown value as one diagnostic line.
 * @param error - rejected value.
 * @returns the message text.
 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Expand a leading `~`, `~/`, or `~\` against the operating-system home.
 * @param path - configured path.
 * @returns the expanded path; unsupported forms are returned unchanged.
 */
function expandHomePath(path) {
  const value = String(path ?? '')
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the harness home: explicit config, then `$DSH_HOME`, then `~/.dsh`.
 * @param configured - explicit harness-home override.
 * @param env - environment mapping (defaults to `process.env`).
 * @returns the normalized absolute harness home.
 */
export function resolveDshHome(configured = '', env = process.env) {
  const explicit = String(configured ?? '').trim()
  if (explicit !== '') return resolve(expandHomePath(explicit))
  const fromEnv = String(env?.DSH_HOME ?? '').trim()
  if (fromEnv !== '') return resolve(expandHomePath(fromEnv))
  return join(homedir(), '.dsh')
}

/**
 * The single managed root descriptor.
 * @param dshHome - absolute harness home.
 * @returns the root descriptor consumed by {@link scanRoot}.
 */
export function userSkillRoot(dshHome) {
  return {
    id: 'user-dsh',
    path: join(dshHome, 'skills'),
    skipSystem: true,
  }
}

/**
 * Whether a resolved path is the same as, or a descendant of, a root.
 *
 * The comparison is case-insensitive on Windows because the filesystem is, and
 * it respects path-segment boundaries so `/a/skills-old` is not inside
 * `/a/skills`.
 * @param root - root directory.
 * @param target - candidate path.
 * @returns whether the target is contained by the root.
 */
export function isInside(root, target) {
  const normalize = (value) => {
    const absolute = resolve(value)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  const parent = normalize(root)
  const child = normalize(target)
  if (child === parent) return true
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

/**
 * The canonical file path for one skill inside the root.
 * @param rootPath - managed root directory.
 * @param name - kebab-case skill name.
 * @param layout - `bundle` or `file`.
 * @returns the absolute instruction-file path.
 */
export function skillPathFor(rootPath, name, layout) {
  return layout === SKILL_LAYOUTS.file ? join(rootPath, `${name}.md`) : join(rootPath, name, SKILL_FILENAME)
}

/**
 * The top-level entry name a skill's path belongs to.
 * @param path - absolute instruction-file path.
 * @param layout - `bundle` or `file`.
 * @returns the bundle directory name or the flat filename without `.md`.
 */
function fileBaseName(path, layout) {
  return layout === SKILL_LAYOUTS.file ? basename(path).replace(/\.md$/i, '') : basename(dirname(path))
}

/**
 * Parse the YAML frontmatter block of a skill file.
 *
 * The grammar is the provider's: a first line of exactly `---`, a closing line
 * of exactly `---`, and a YAML object in between. Anything else returns
 * `undefined` rather than throwing, so callers can tell “no frontmatter” from
 * “bad YAML”.
 * @param raw - whole file text.
 * @returns the parsed data and the body after the closing marker, or `undefined`.
 */
export function parseFrontmatter(raw) {
  if (typeof raw !== 'string') return undefined
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      const data = parseYaml(raw.slice(start, lineStart))
      if (!isRecord(data)) return undefined
      return { data, body: raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1) }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/**
 * Read one strict frontmatter boolean.
 * @param data - parsed frontmatter object.
 * @param key - field name.
 * @returns the boolean, or `undefined` when the field is absent.
 * @throws when the field is present but not a recognized boolean spelling.
 */
function frontmatterBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new Error(`frontmatter 字段 "${key}" 必须是布尔值（true/false、yes/no、on/off 或 1/0）`)
}

/**
 * Reject the invocation field names the provider refuses, so the settings page
 * fails with the same explanation instead of writing a file the model ignores.
 * @param data - parsed frontmatter object.
 * @param legacy - unsupported field name.
 * @param canonical - the supported replacement.
 */
function rejectLegacyInvocationKey(data, legacy, canonical) {
  if (Object.hasOwn(data, legacy)) {
    throw new Error(`不支持 frontmatter 字段 "${legacy}"，请改用 "${canonical}"`)
  }
}

/**
 * Resolve the model and user invocation policy from frontmatter.
 * @param data - parsed frontmatter object.
 * @returns the resolved policy.
 * @throws when a field is malformed or uses a legacy alias.
 */
export function parseInvocation(data) {
  rejectLegacyInvocationKey(data, 'disableModelInvocation', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'modelInvocable', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'userInvocable', 'user-invocable')
  return {
    modelInvocable: frontmatterBoolean(data, 'disable-model-invocation') !== true,
    userInvocable: frontmatterBoolean(data, 'user-invocable') !== false,
  }
}

/**
 * Read a non-empty string field from frontmatter.
 * @param data - parsed frontmatter object.
 * @param key - field name.
 * @returns the value, or `undefined` when absent or not a non-empty string.
 */
function stringField(data, key) {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Parse and validate one skill file.
 *
 * The returned record is what the settings page shows; `data` is the raw
 * frontmatter object so a later write can preserve keys this plugin does not
 * understand.
 * @param path - absolute instruction-file path.
 * @returns the parsed skill.
 * @throws with a user-facing Chinese message when the file cannot be a skill.
 */
export function readSkillFile(path) {
  let stats
  try {
    stats = statSync(path)
  } catch (error) {
    throw new Error(`无法读取技能文件 ${path}：${errorMessage(error)}`, { cause: error })
  }
  if (!stats.isFile()) {
    throw new Error(`技能文件不是一个普通文件：${path}`)
  }
  if (stats.size > MAX_SKILL_FILE_BYTES) {
    throw new Error(
      `技能文件过大（${stats.size} 字节，上限 ${MAX_SKILL_FILE_BYTES}）：请把大段内容移进同目录的 references/ 资源文件，SKILL.md 只保留索引`,
    )
  }
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`无法读取技能文件 ${path}：${errorMessage(error)}`, { cause: error })
  }
  return parseSkillText(raw)
}

/**
 * Parse and validate the text of one skill file.
 *
 * This is the single parser behind reading a file and importing pasted text, so
 * the import path accepts exactly what the provider would accept.
 * @param raw - whole file text.
 * @returns the parsed skill, including the raw text and frontmatter object.
 * @throws with a user-facing Chinese message when the text cannot be a skill.
 */
export function parseSkillText(raw) {
  if (typeof raw !== 'string') throw new Error('技能文件内容必须是文本')
  if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_FILE_BYTES) {
    throw new Error(`技能文件过大（上限 ${MAX_SKILL_FILE_BYTES} 字节）：请把大段内容移进 references/ 资源文件`)
  }
  /*
   * The provider compares the first line byte for byte, so a BOM-prefixed file
   * is invisible to the model. Reporting it as "missing frontmatter" sends the
   * user looking for a frontmatter bug that is not there; name the byte instead.
   */
  if (raw.charCodeAt(0) === 0xfeff) {
    throw new Error('文件以 UTF-8 BOM（U+FEFF）开头：provider 要求第一行恰好是 ---，请以「UTF-8 无 BOM」重新保存')
  }
  let parsed
  try {
    parsed = parseFrontmatter(raw)
  } catch (error) {
    throw new Error(`frontmatter 不是合法的 YAML：${errorMessage(error)}`, { cause: error })
  }
  if (parsed === undefined) {
    throw new Error('缺少 YAML frontmatter：文件必须以单独一行 --- 开头，并以单独一行 --- 结束')
  }
  const name = stringField(parsed.data, 'name')
  const description = stringField(parsed.data, 'description')
  if (name === undefined || description === undefined) {
    throw new Error('frontmatter 需要 name 与 description 两个非空字符串字段')
  }
  if (!SKILL_NAME.test(name)) {
    throw new Error(`技能名称 ${JSON.stringify(name)} 无效：只能使用小写字母、数字，并用单个连字符分隔（kebab-case）`)
  }
  const warnings = []
  const metadata = parsed.data.metadata
  if (metadata !== undefined && !isRecord(metadata)) {
    warnings.push('frontmatter 的 metadata 不是对象，已被忽略')
  }
  return {
    name,
    description,
    whenToUse: stringField(parsed.data, 'whenToUse'),
    invocation: parseInvocation(parsed.data),
    metadata: isRecord(metadata) ? metadata : undefined,
    body: parsed.body.trim(),
    raw,
    data: parsed.data,
    warnings,
  }
}

/**
 * The canonical identity of one skill file.
 *
 * Symlinks and junctions are followed so an alias of an existing skill cannot be
 * listed as a second, self-shadowed skill; a path that cannot be resolved keeps
 * its lexical identity.
 * @param path - absolute instruction-file path.
 * @returns the real path when resolvable, else the given path.
 */
function realPathOf(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Read the managed root's direct entries and classify them like the provider.
 *
 * A directory without `SKILL.md` is not a skill (it may be a resource folder)
 * and is skipped silently. A `SKILL.md` or flat `.md` that exists but cannot be
 * parsed is reported in `issues` instead of disappearing. Scanning never
 * recurses, so a symlink loop inside the root cannot make discovery diverge.
 * @param root - root descriptor: `{ path, skipSystem }`.
 * @returns discovered skills and unreadable entries.
 */
export function scanRoot(root) {
  const skills = []
  const issues = []
  const skipSystem = root.skipSystem === true
  let entries
  try {
    entries = readdirSync(root.path, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') return { skills, issues, exists: false }
    issues.push({ path: root.path, message: `无法读取技能根目录：${errorMessage(error)}` })
    return { skills, issues, exists: true }
  }
  const ordered = [...entries].sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of ordered) {
    if (skipSystem && SKIPPED_ROOT_CHILDREN.includes(entry.name)) continue
    let type
    if (entry.isDirectory()) type = SKILL_LAYOUTS.bundle
    else if (entry.isFile() && /\.md$/i.test(entry.name)) type = SKILL_LAYOUTS.file
    else if (entry.isSymbolicLink()) {
      let info
      try {
        info = statSync(join(root.path, entry.name))
      } catch (error) {
        issues.push({ path: join(root.path, entry.name), message: `无法跟随符号链接：${errorMessage(error)}` })
        continue
      }
      if (info.isDirectory()) type = SKILL_LAYOUTS.bundle
      else if (info.isFile() && /\.md$/i.test(entry.name)) type = SKILL_LAYOUTS.file
    }
    if (type === undefined) continue
    const path = type === SKILL_LAYOUTS.bundle ? join(root.path, entry.name, SKILL_FILENAME) : join(root.path, entry.name)
    /*
     * One stat decides existence, size, and mtime. A `SKILL.md` removed between
     * `readdir` and here is a directory that is not (or no longer) a skill, which
     * is ordinary state rather than an error; every other failure is reported.
     */
    let stats
    try {
      stats = statSync(path)
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT' && code !== 'ENOTDIR') issues.push({ path, message: `无法读取技能文件：${errorMessage(error)}` })
      continue
    }
    if (stats.size > MAX_SKILL_FILE_BYTES) {
      issues.push({ path, message: `技能文件过大（${stats.size} 字节，上限 ${MAX_SKILL_FILE_BYTES}），已跳过` })
      continue
    }
    let parsed
    try {
      parsed = cachedHeader(path, stats)
    } catch (error) {
      issues.push({ path, message: errorMessage(error) })
      continue
    }
    const warnings = [...parsed.warnings]
    const entryName = fileBaseName(path, type)
    if (entryName !== parsed.name) {
      warnings.push(`文件位置名 "${entryName}" 与 frontmatter 的 name 不一致`)
    }
    /*
     * The provider matches the flat-file extension case-sensitively. Discovery
     * here stays forgiving (a `.MD` file is still worth showing), but the row
     * says so instead of claiming the model can load it.
     */
    if (type === SKILL_LAYOUTS.file && !path.endsWith('.md')) {
      warnings.push('扩展名不是小写 .md：provider 只识别 <name>.md，模型不会加载这个文件')
    }
    skills.push({
      name: parsed.name,
      description: parsed.description,
      whenToUse: parsed.whenToUse ?? '',
      invocation: parsed.invocation,
      metadata: parsed.metadata,
      bodyBytes: parsed.bodyBytes,
      path,
      /*
       * `realpath` is a relatively expensive call on Windows, and an ordinary
       * entry's lexical path already is its identity; only a link can reach a
       * file that is also listed under another name.
       */
      realPath: entry.isSymbolicLink() ? realPathOf(path) : path,
      directory: type === SKILL_LAYOUTS.bundle ? dirname(path) : root.path,
      layout: type,
      updatedAt: Math.round(stats.mtimeMs),
      warnings,
    })
  }
  return { skills, issues, exists: true }
}

/**
 * Resolve duplicate names inside the single root.
 *
 * Two entries can describe the same name; scan order decides the winner (first
 * entry listed by the provider wins), and the losers stay in the result as
 * `shadowed` rows so the settings page can explain why a file the user can see
 * is not the one the model loads. An entry whose instruction file is the same
 * file as one already seen is dropped outright: one file is one skill, and a
 * self-shadowed duplicate must never reach the page. Identity is the resolved
 * real path, so a symlink or junction alias inside the root collapses onto the
 * file it points at instead of shadowing it.
 * @param skills - discovered skills in scan order.
 * @returns rows sorted by name, active before shadowed.
 */
export function resolveCatalog(skills) {
  const candidates = []
  const seenPaths = new Set()
  for (const skill of skills) {
    const key = normalizeForCompare(skill.realPath ?? skill.path)
    if (seenPaths.has(key)) continue
    seenPaths.add(key)
    candidates.push(skill)
  }
  const winners = new Map()
  for (const candidate of candidates) {
    const winner = winners.get(candidate.name)
    if (winner === undefined) winners.set(candidate.name, candidate)
  }
  const rows = candidates.map((skill) => {
    const winner = winners.get(skill.name)
    const shadowed = winner !== undefined && winner !== skill
    return { ...skill, status: shadowed ? 'shadowed' : 'active', shadowedBy: shadowed ? winner.path : '' }
  })
  rows.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      (left.status === right.status ? 0 : left.status === 'active' ? -1 : 1) ||
      left.path.localeCompare(right.path),
  )
  return rows
}

/**
 * Normalize one skill definition from the settings page or a hand-written
 * config. Unknown fields are dropped; the result is exactly what
 * {@link renderSkillFile} accepts.
 * @param input - untrusted definition.
 * @param options - `layout` pins the on-disk layout (used by updates and copies).
 * @returns the normalized definition.
 * @throws with a user-facing Chinese message when a field is invalid.
 */
export function normalizeDefinition(input, options = {}) {
  if (!isRecord(input)) throw new Error('技能定义必须是一个对象')
  const name = String(input.name ?? '').trim()
  if (name === '') throw new Error('技能名称不能为空')
  if (!SKILL_NAME.test(name)) {
    throw new Error(`技能名称 ${JSON.stringify(name)} 无效：只能使用小写字母、数字，并用单个连字符分隔（kebab-case）`)
  }
  const description = String(input.description ?? '').trim()
  if (description === '') {
    throw new Error(`技能 "${name}"：必须填写描述（description），模型靠它决定是否加载该技能`)
  }
  const whenToUse = String(input.whenToUse ?? '').trim()
  if (whenToUse.length > WHEN_TO_USE_SOFT_LIMIT * 8) {
    throw new Error(`技能 "${name}"：whenToUse 过长（超过 ${WHEN_TO_USE_SOFT_LIMIT * 8} 个字符）`)
  }
  const metadata = isRecord(input.metadata) ? input.metadata : undefined
  if (input.metadata !== undefined && input.metadata !== null && !isRecord(input.metadata)) {
    throw new Error(`技能 "${name}"：metadata 必须是一个对象`)
  }
  const body = String(input.body ?? '').replace(/\r\n/g, '\n').trim()
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new Error(
      `技能 "${name}"：正文过大（${Buffer.byteLength(body, 'utf8')} 字节，上限 ${MAX_BODY_BYTES}）：大段内容应放进 references/ 资源文件`,
    )
  }
  const layout = options.layout ?? (input.layout === SKILL_LAYOUTS.file ? SKILL_LAYOUTS.file : SKILL_LAYOUTS.bundle)
  return {
    name,
    description,
    whenToUse,
    modelInvocable: input.modelInvocable !== false,
    userInvocable: input.userInvocable !== false,
    metadata,
    body,
    layout,
  }
}

/**
 * Render one complete skill file: canonical frontmatter first, then the body.
 *
 * Managed keys are written explicitly (`disable-model-invocation` and
 * `user-invocable` always carry a boolean), so the settings page's toggles and
 * the file can never disagree. Every other frontmatter key is preserved from
 * `baseData`, in its original order, which keeps hand-written fields such as
 * `license`, `allowed-tools`, or a nested `metadata` object intact.
 * @param definition - normalized definition.
 * @param baseData - frontmatter object of the file being replaced, when any.
 * @returns the file text, with a trailing newline.
 */
export function renderSkillFile(definition, baseData) {
  const data = {}
  data.name = definition.name
  data.description = definition.description
  if (definition.whenToUse !== undefined && definition.whenToUse !== '') data.whenToUse = definition.whenToUse
  data['disable-model-invocation'] = definition.modelInvocable === false
  data['user-invocable'] = definition.userInvocable !== false
  const preserved = isRecord(baseData) ? baseData : {}
  for (const [key, value] of Object.entries(preserved)) {
    if (MANAGED_FRONTMATTER_KEYS.includes(key)) continue
    if (value === undefined) continue
    data[key] = value
  }
  const metadata = definition.metadata ?? preserved.metadata
  if (isRecord(metadata) && Object.keys(metadata).length > 0) data.metadata = metadata
  const yamlText = stringifyYaml(data, { lineWidth: 0 }).trimEnd()
  const body = String(definition.body ?? '').trim()
  return `---\n${yamlText}\n---\n${body === '' ? '\n' : `\n${body}\n`}`
}

/**
 * Validate a definition and render a preview without touching the filesystem.
 * @param input - untrusted definition.
 * @param options - `layout` and `baseData` (the file being replaced).
 * @returns validity, the normalized definition, warnings, and the preview text.
 */
export function validateDefinition(input, options = {}) {
  try {
    const normalized = normalizeDefinition(input, options)
    const warnings = []
    if (normalized.body === '') warnings.push('正文为空：模型加载该技能时只会看到说明文字')
    if (normalized.description.length > DESCRIPTION_SOFT_LIMIT) {
      warnings.push(`描述有 ${normalized.description.length} 个字符，超过建议的 ${DESCRIPTION_SOFT_LIMIT}，目录展示时会被截断`)
    }
    if (normalized.whenToUse.length > WHEN_TO_USE_SOFT_LIMIT) {
      warnings.push(`whenToUse 有 ${normalized.whenToUse.length} 个字符，超过建议的 ${WHEN_TO_USE_SOFT_LIMIT}`)
    }
    if (normalized.name.length > 64) warnings.push('技能名超过 64 个字符，调用与检索都会变得困难')
    return {
      valid: true,
      issues: [],
      warnings,
      normalized,
      preview: renderSkillFile(normalized, options.baseData),
    }
  } catch (error) {
    return { valid: false, issues: [errorMessage(error)], warnings: [], normalized: undefined, preview: '' }
  }
}

/**
 * Monotonic suffix making every temporary name unique within this process.
 *
 * A fixed `.tmp` name let two concurrent writes to the same skill interleave:
 * the second writer's rename could publish the first writer's bytes, and the
 * loser's `rename` would fail with a message that named neither request.
 */
let temporaryCounter = 0

/**
 * Publish a fully written temporary file as the target without overwriting.
 *
 * `rename` replaces an existing file on POSIX, so creation goes through a hard
 * link, which fails with `EEXIST` instead. Filesystems that cannot link (some
 * network shares, exFAT) fall back to an exclusive create of the target itself.
 * @param temporary - sibling file that already holds the full text.
 * @param target - destination path that must not exist yet.
 * @param text - the same text, for the no-hard-link fallback.
 * @throws `EEXIST` when the target appeared first.
 */
function publishExclusive(temporary, target, text) {
  try {
    linkSync(temporary, target)
    return
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    if (!NO_HARD_LINK_CODES.has(code)) throw error
  }
  writeFileSync(target, text, { encoding: 'utf8', flag: 'wx' })
}

/**
 * Write a skill file atomically: a sibling temporary file is renamed over the
 * target, so a partial write can never be discovered as a skill.
 *
 * The temporary file is removed on every path, including failure, so a hard
 * kill between write and rename leaves neither a stray skill nor a stray file
 * inside the bundle.
 * @param target - absolute instruction-file path.
 * @param text - full file text.
 * @param options - `root` refuses writes outside the managed root; `exclusive`
 * refuses to replace an existing file (create and copy).
 * @returns the written path.
 * @throws with a Chinese message that keeps the underlying error as `cause`.
 */
export function writeSkillFile(target, text, options = {}) {
  const root = options.root
  if (typeof root === 'string' && !isInside(root, target)) {
    throw new Error(`拒绝写入技能根目录之外的文件：${target}`)
  }
  const temporary = `${target}.${process.pid.toString(36)}-${(temporaryCounter += 1).toString(36)}.tmp`
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(temporary, text, 'utf8')
    if (options.exclusive === true) publishExclusive(temporary, target, text)
    else renameSync(temporary, target)
    forgetSkillHeader(target)
  } catch (error) {
    const failure = new Error(`无法写入技能文件 ${target}：${errorMessage(error)}`, { cause: error })
    failure.code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
    throw failure
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      /* renamed into place, or never created */
    }
  }
  return target
}

/**
 * Normalize a path for identity comparisons.
 * @param path - path to normalize.
 * @returns the resolved path, lowercased on Windows.
 */
export function normalizeForCompare(path) {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * Find a skill row by its instruction-file path.
 * @param rows - resolved catalog rows.
 * @param path - absolute instruction-file path from the settings page.
 * @returns the exact row.
 * @throws when the path is not a currently discovered skill file.
 */
export function findRow(rows, path) {
  const wanted = normalizeForCompare(String(path ?? ''))
  const row = rows.find((candidate) => normalizeForCompare(candidate.path) === wanted)
  if (row === undefined) {
    throw new Error(`没有找到该技能文件（可能已在磁盘上被改名或删除）：${String(path ?? '')}`)
  }
  return row
}
