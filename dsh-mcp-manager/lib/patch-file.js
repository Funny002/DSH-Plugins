/**
 * Persistence of managed MCP server definitions in the profile patch layer.
 *
 * Every change the settings page makes is written back to the profile's
 * `cordis.patch.yml` — the layer `dsh` watches with `patchReload: live` — so the
 * running tree hot-swaps this plugin's row and the new server set takes effect
 * without a restart.
 *
 * The file is user-owned and full of prose comments, so this module never
 * re-serializes it. It owns exactly one delimited block, and that block has two
 * shapes, because the row can be mounted two ways:
 *
 * **`insert`** — this plugin was installed as loose files under the profile and
 * *this block is what puts the row into the tree*. The block must therefore
 * create the row:
 *
 *   # >>> dsh-mcp-manager managed block ... >>>
 *   - insert:
 *       - id: mcp-manager
 *         name: './plugins/dsh-mcp-manager/lib/index.js'
 *         config:
 *           servers:
 *             - {"name":"echo","transport":"stdio",...}
 *   # <<< dsh-mcp-manager managed block <<<
 *
 * **`override`** — the row already exists because an installed bundle layer
 * inserts it (the documented `dsh.bundle` distribution). Repeating the row here
 * would mount it twice, so the block only retargets the existing row by id and
 * replaces its `config` (the loader replaces the whole config value, it does not
 * deep-merge keys):
 *
 *   # >>> dsh-mcp-manager managed block ... >>>
 *   - id: mcp-manager
 *     config:
 *       servers:
 *         - {"name":"echo","transport":"stdio",...}
 *   # <<< dsh-mcp-manager managed block <<<
 *
 * Each server is one JSON object on its own line. JSON is valid YAML, so the
 * loader parses it natively, and one-object-per-line keeps the managed block
 * readable and diffable while leaving every other line of the file untouched.
 *
 * @module dsh-mcp-manager/patch-file
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** First line of the managed block. */
export const BLOCK_START = '# >>> dsh-mcp-manager managed block — rewritten by the MCP settings page; do not edit by hand >>>'
/** Last line of the managed block. */
export const BLOCK_END = '# <<< dsh-mcp-manager managed block <<<'
/** Loader row id owned by the generated block. */
export const ROW_ID = 'mcp-manager'
/** Default row specifier: a path anchored beside the patch file it lives in. */
export const DEFAULT_ROW_NAME = './plugins/dsh-mcp-manager/lib/index.js'
/** User patch layer filename inside a profile directory. */
export const PATCH_FILENAME = 'cordis.patch.yml'
/** Root composition filename inside a profile directory. */
const ROOT_CONFIG_FILENAME = 'cordis.yml'
/** How the managed block claims the row: create it, or retarget it. */
export const MANAGED_MODES = Object.freeze({ insert: 'insert', override: 'override' })

/**
 * Locate the profile's user patch layer.
 *
 * The Loader's root include entry carries the absolute path of the profile's
 * `cordis.yml`; the patch layer is its sibling. That keeps the plugin
 * profile-agnostic — it works in `web`, in a custom profile, and in a
 * `--patch`-overlaid run — and it needs no environment variable that a session
 * does not have.
 *
 * @param ctx - host plugin context carrying the Loader service.
 * @returns the absolute patch-file path, or `''` when it cannot be resolved.
 */
export function discoverPatchFile(ctx) {
  const loader = ctx.get('loader')
  if (loader === undefined || typeof loader.entries !== 'function') return ''
  for (const entry of loader.entries()) {
    const options = entry.options ?? {}
    const config = options.config
    if (typeof config !== 'object' || config === null) continue
    const path = config.path
    if (typeof path !== 'string' || !path.startsWith('file:')) continue
    let rootPath
    try {
      rootPath = fileURLToPath(path)
    } catch {
      continue
    }
    if (!rootPath.endsWith(ROOT_CONFIG_FILENAME)) continue
    return join(dirname(rootPath), PATCH_FILENAME)
  }
  return ''
}

/**
 * Split file text into lines, tolerating CRLF.
 * @param text - file content.
 * @returns the lines without terminators.
 */
function toLines(text) {
  return text.split(/\r?\n/)
}

/**
 * Read the managed block out of a patch file's text.
 * @param text - patch file content (possibly `''` or `undefined`).
 * @returns whether the block exists plus its mode, parsed servers, and row options.
 */
export function readManagedBlock(text) {
  const lines = toLines(typeof text === 'string' ? text : '')
  const start = lines.findIndex((line) => line.includes(BLOCK_START))
  if (start === -1) {
    return { found: false, mode: MANAGED_MODES.insert, servers: [], rowName: DEFAULT_ROW_NAME, patchFile: '' }
  }
  const end = lines.findIndex((line, index) => index > start && line.includes(BLOCK_END))
  const body = lines.slice(start + 1, end === -1 ? lines.length : end)
  const mode = body.some((line) => /^\s*-\s+insert:\s*$/.test(line)) ? MANAGED_MODES.insert : MANAGED_MODES.override
  const nameLine = body.find((line) => /^\s{4,}name:/.test(line))
  const rowName = nameLine === undefined
    ? DEFAULT_ROW_NAME
    : nameLine.replace(/^\s*name:\s*/, '').trim().replace(/^['"]|['"]$/g, '')
  const patchLine = body.find((line) => /^\s*patchFile:/.test(line))
  const patchFile = patchLine === undefined
    ? ''
    : patchLine.replace(/^\s*patchFile:\s*/, '').trim().replace(/^['"]|['"]$/g, '')
  const serversIndex = body.findIndex((line) => /^\s*servers:/.test(line))
  if (serversIndex === -1) return { found: true, mode, servers: [], rowName, patchFile }
  const inline = body[serversIndex].replace(/^\s*servers:\s*/, '').trim()
  if (inline !== '') {
    if (inline === '[]') return { found: true, mode, servers: [], rowName, patchFile }
    throw new Error(`dsh-mcp-manager：受管区块里的 servers 值无法识别：${inline}`)
  }
  const servers = []
  for (let index = serversIndex + 1; index < body.length; index += 1) {
    const line = body[index]
    if (line.trim() === '') continue
    const match = /^\s*-\s+(\{.*\})\s*$/.exec(line)
    if (match === null) break
    servers.push(JSON.parse(match[1]))
  }
  return { found: true, mode, servers, rowName, patchFile }
}

/**
 * Render the managed block for one server list.
 * @param servers - normalized server definitions.
 * @param options - `mode` (`insert` | `override`), row specifier, and optional pinned patch path.
 * @returns the block text, without a trailing newline.
 */
export function renderManagedBlock(servers, options = {}) {
  const mode = options.mode === MANAGED_MODES.override ? MANAGED_MODES.override : MANAGED_MODES.insert
  const rowName = options.rowName ?? DEFAULT_ROW_NAME
  const lines = [BLOCK_START]
  if (mode === MANAGED_MODES.insert) {
    lines.push('- insert:', `    - id: ${ROW_ID}`, `      name: '${rowName}'`, '      config:')
  } else {
    lines.push(`- id: ${ROW_ID}`, '  config:')
  }
  const configIndent = mode === MANAGED_MODES.insert ? '        ' : '    '
  if (typeof options.patchFile === 'string' && options.patchFile !== '') {
    lines.push(`${configIndent}patchFile: '${options.patchFile.replaceAll('\\', '/')}'`)
  }
  if (servers.length === 0) {
    lines.push(`${configIndent}servers: []`)
  } else {
    lines.push(`${configIndent}servers:`)
    for (const server of servers) lines.push(`${configIndent}  - ${JSON.stringify(server)}`)
  }
  lines.push(BLOCK_END)
  return lines.join('\n')
}

/**
 * Replace or append the managed block inside patch-file text.
 * @param text - current file content.
 * @param block - rendered block text.
 * @returns the next file content.
 */
export function upsertManagedBlock(text, block) {
  const source = typeof text === 'string' ? text : ''
  const lines = toLines(source)
  const start = lines.findIndex((line) => line.includes(BLOCK_START))
  if (start === -1) return appendManagedBlock(source, lines, block)
  const end = lines.findIndex((line, index) => index > start && line.includes(BLOCK_END))
  const tail = lines.slice(end === -1 ? lines.length : end + 1)
  const head = lines.slice(0, start)
  const next = [...head, ...toLines(block), ...tail]
  return next.join('\n')
}

/** Content lines only: blanks and comments are not entries. */
function meaningfulLines(lines) {
  return lines.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
}

/**
 * Place the managed block into a patch layer that does not have one yet.
 *
 * A fresh profile's patch layer is the flow-style empty list `[]`, and a block
 * sequence entry may not follow a closed flow sequence — appending there would
 * produce a file the loader refuses to parse. So the empty list is replaced in
 * place; a non-empty flow-style list is refused with an actionable message
 * rather than silently rewritten.
 * @param source - current file content.
 * @param lines - source split into lines.
 * @param block - rendered block text.
 * @returns the next file content.
 */
function appendManagedBlock(source, lines, block) {
  const meaningful = meaningfulLines(lines)
  if (meaningful.length === 1 && meaningful[0].trim().startsWith('[')) {
    const inline = meaningful[0].trim()
    if (inline !== '[]') {
      throw new Error(
        `拒绝写入：patch 层使用的是 flow 风格列表（${inline.slice(0, 40)}…），块状条目无法接在其后；请先改成块状条目`,
      )
    }
    const index = lines.findIndex((line) => line.trim() === '[]')
    return [...lines.slice(0, index), ...toLines(block), ...lines.slice(index + 1)].join('\n')
  }
  if (meaningful.length > 0 && !/^\s*-\s/.test(meaningful[0])) {
    throw new Error('拒绝写入：patch 层不是顶层 patch 条目列表')
  }
  const head = source.trimEnd()
  return `${head === '' ? '' : `${head}\n\n`}${block}\n`
}

/**
 * Read the module specifier the managed block currently carries.
 *
 * The manager preserves whatever specifier the row already has instead of
 * rewriting its own default: a deployment may name this package through the
 * profile's `node_modules`, an absolute path, or a revision-suffixed URL, and
 * silently changing the module a running row resolves would swap the code under
 * the user.
 *
 * @param file - absolute patch-file path.
 * @returns the row specifier, or the default when the file or block is absent.
 */
export function readManagedRowName(file) {
  try {
    return readManagedBlock(readFileSync(file, 'utf8')).rowName || DEFAULT_ROW_NAME
  } catch {
    return DEFAULT_ROW_NAME
  }
}

/**
 * Initialize a missing patch file with the stock header comment.
 * @param file - absolute patch file path.
 * @returns file content to use when the file does not exist.
 */
function missingFileContent(file) {
  return `# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries.\n#\n# The dsh-mcp-manager block below is generated from the MCP settings page in the GUI.\n\n`
}

/**
 * Persist one server list into the managed block.
 *
 * The write is verified before it lands: the generated document is re-read and
 * its mode and server list compared with the intent, so a bug in rendering can
 * never overwrite the user's patch layer with something that does not
 * round-trip. The file is replaced by rename, which the profile's chokidar-based
 * watcher reports as an ordinary change.
 *
 * @param file - absolute path of the profile's `cordis.patch.yml`.
 * @param servers - normalized server definitions to persist.
 * @param options - `mode`, row specifier (insert mode only), and pinned patch path.
 * @returns the absolute path written.
 */
export function writeManagedServers(file, servers, options = {}) {
  if (typeof file !== 'string' || file === '') throw new Error('dsh-mcp-manager：没有可写入的 patch 文件；请在行配置里设置 patchFile')
  const before = existsSync(file) ? readFileSync(file, 'utf8') : missingFileContent(file)
  const block = renderManagedBlock(servers, options)
  const next = upsertManagedBlock(before, block)
  const verified = readManagedBlock(next)
  if (JSON.stringify(verified.servers) !== JSON.stringify(servers)) {
    throw new Error('dsh-mcp-manager：受管区块无法往返解析，拒绝写入（以免损坏 patch 层）')
  }
  if (verified.mode !== (options.mode === MANAGED_MODES.override ? MANAGED_MODES.override : MANAGED_MODES.insert)) {
    throw new Error('dsh-mcp-manager：受管区块的模式无法往返解析，拒绝写入（以免重复挂载该行）')
  }
  const temporary = `${file}.dsh-mcp-manager.tmp`
  writeFileSync(temporary, next, 'utf8')
  renameSync(temporary, file)
  return file
}
