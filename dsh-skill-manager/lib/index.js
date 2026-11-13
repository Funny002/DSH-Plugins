/**
 * `dsh-skill-manager` — host half.
 *
 * A profile-plane row with three jobs:
 *
 * 1. **Discover.** It scans one directory — `<DSH_HOME>/skills`, which is the
 *    same `user-dsh` root `@deepseek-ai/dsh-skill-filesystem` scans at rank 400
 *    — and parses every `SKILL.md` bundle and flat `<name>.md` file exactly the
 *    way that provider does, including a report of files the provider would
 *    silently skip.
 * 2. **Author.** It creates, edits, renames, copies, imports, enables, disables,
 *    and deletes those files on disk. Because the provider watches that root, a
 *    saved skill reaches the next model catalog without a restart; there is no
 *    second copy of the skill in this plugin's config. A file the provider would
 *    skip (missing or malformed frontmatter, a BOM, an oversized file) is
 *    reported as an issue and can be deleted from the page, so an unreadable
 *    skill is never a dead end nobody can fix.
 * 3. **Answer.** It provides the `skillManager` service and an authenticated
 *    `/skill-manager` RPC channel on `ctx.connection`, which is how the browser
 *    settings page reads the catalog and mutates skill files.
 *
 * There is no configurable root list and no persisted server/skill definition:
 * the skill files are the whole state, so the only configuration is an optional
 * `dshHome` override for deployments whose harness home is not `$DSH_HOME` or
 * `~/.dsh`.
 *
 * @module dsh-skill-manager
 */
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { serveChannelRequest } from './channel.js'
import {
  SKILL_FILENAME,
  SKILL_NAME,
  USER_ROOT_RANK,
  errorMessage,
  findRow,
  forgetSkillHeader,
  isInside,
  isRecord,
  normalizeDefinition,
  normalizeForCompare,
  parseSkillText,
  readSkillFile,
  renderSkillFile,
  resolveCatalog,
  resolveDshHome,
  scanRoot,
  skillPathFor,
  userSkillRoot,
  validateDefinition,
  writeSkillFile,
} from './scanner.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-manager'
/** Services required before this plugin activates; none — skills are plain files. */
export const inject = []
/** Absolute RPC channel the browser settings page calls. */
export const CHANNEL = '/skill-manager'
/** Shown when the manifest cannot be read; never a valid published version. */
const UNKNOWN_VERSION = '0.0.0'
/**
 * The installed package version, read from this package's own `package.json` so
 * the settings page can show a single version identity. A missing or unreadable
 * manifest must not fail the row: the badge is diagnostic, not functional. The
 * fallback constant is declared above this call because module evaluation order
 * would otherwise read it in its temporal dead zone.
 */
export const VERSION = readPackageVersion()

/**
 * Read `version` from the package manifest beside this module.
 * @returns the declared version, or `0.0.0` when it cannot be read.
 */
function readPackageVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : UNKNOWN_VERSION
  } catch {
    return UNKNOWN_VERSION
  }
}

/**
 * Row configuration.
 *
 * `dshHome` mirrors the filesystem provider's own override so both halves scan
 * the same directory; everything else is discovered from disk.
 */
export const Config = z.object({
  dshHome: z.string().default(''),
})

/**
 * The `skillManager` service: the live catalog plus every write to its files.
 */
export class SkillManager extends Service {
  /*
   * State lives in ordinary fields, not `#private` ones: Cordis hands a service
   * to other fibers through a tracked proxy, and an ECMAScript private field
   * rejects a receiver that is not the exact instance — so `ctx.skillManager`
   * would read fine but calling any method on it would throw. Shipped services
   * follow the same convention.
   */
  /** @type {string} harness home whose `skills` directory is the managed root. */
  dshHome
  /** @type {string} directory reported as the workspace in the settings page. */
  cwd
  /** @type {number} changes on every persisted mutation; the settings page polls it. */
  generation
  /**
   * Registration state of the browser RPC channel, reported in every snapshot so
   * the settings page can tell "the plugin is mounted but its channel is not"
   * apart from "the profile has no browser transport at all".
   * @type {{path: string, state: 'pending'|'registered'|'failed'|'unavailable', error: string}}
   */
  channel = { path: CHANNEL, state: 'pending', error: '' }

  /**
   * @param ctx - host plugin context.
   * @param config - resolved row config.
   */
  constructor(ctx, config) {
    super(ctx, 'skillManager')
    this.dshHome = resolveDshHome(config.dshHome)
    const workingDirectory = ctx.get('workingDirectory')
    const fallback =
      workingDirectory !== undefined && typeof workingDirectory.defaultDirectory === 'string' && workingDirectory.defaultDirectory !== ''
        ? workingDirectory.defaultDirectory
        : process.cwd()
    this.cwd = resolve(fallback)
    this.generation = Date.now()
    ctx.logger.info('skill-manager: root %s, workspace %s', this.root().path, this.cwd)
  }

  /**
   * The managed root descriptor.
   * @returns `{ id, path, skipSystem }` for `<dshHome>/skills`.
   */
  root() {
    return userSkillRoot(this.dshHome)
  }

  /**
   * Scan the managed root and resolve duplicate names.
   * @returns the root, its discovered skills, resolved rows, issues, and existence.
   */
  scan() {
    const root = this.root()
    const scan = scanRoot(root)
    return {
      root,
      skills: scan.skills,
      rows: resolveCatalog(scan.skills),
      issues: scan.issues,
      exists: scan.exists,
    }
  }

  /**
   * Every discovered skill, the root, and the files that could not be parsed.
   * @returns a plain JSON-safe snapshot (the RPC `state` payload).
   */
  list() {
    const { root, rows, issues, exists } = this.scan()
    /*
     * One pass over the rows: the page polls this payload, and a root with a few
     * hundred skills should not be walked six times per request.
     */
    const totals = { skills: rows.length, active: 0, shadowed: 0, issues: issues.length, model: 0, user: 0, disabled: 0, roots: 1, bundles: 0, files: 0 }
    for (const row of rows) {
      if (row.layout === 'bundle') totals.bundles += 1
      else totals.files += 1
      if (row.status !== 'active') {
        totals.shadowed += 1
        continue
      }
      totals.active += 1
      if (row.invocation.modelInvocable) totals.model += 1
      else totals.disabled += 1
      if (row.invocation.userInvocable) totals.user += 1
    }
    return {
      generation: this.generation,
      version: VERSION,
      rowId: 'skill-manager',
      channel: { ...this.channel },
      workspace: {
        cwd: this.cwd,
        dshHome: this.dshHome,
      },
      skillRoot: root.path,
      roots: [
        {
          id: 'user-dsh',
          source: 'user-dsh',
          rank: USER_ROOT_RANK,
          path: root.path,
          custom: false,
          exists,
          skillCount: rows.length,
          issueCount: issues.length,
        },
      ],
      skills: rows,
      issues,
      totals,
    }
  }

  /**
   * Read one skill file for the editor.
   *
   * The row is re-read from disk rather than served from the snapshot, so an
   * external edit between two polls is what the form shows and what a save is
   * based on.
   * @param path - absolute instruction-file path from a snapshot row.
   * @returns the current row plus its body, raw text, and parsed frontmatter.
   */
  get(path) {
    const { rows } = this.scan()
    const row = findRow(rows, path)
    const parsed = readSkillFile(row.path)
    return {
      skill: {
        ...row,
        name: parsed.name,
        description: parsed.description,
        whenToUse: parsed.whenToUse ?? '',
        invocation: parsed.invocation,
        warnings: dedupe([...row.warnings, ...parsed.warnings]),
      },
      body: parsed.body,
      raw: parsed.raw,
      frontmatter: parsed.data,
    }
  }

  /**
   * Validate a definition and render a preview without writing anything.
   * @param input - untrusted definition from the form.
   * @returns validity, issues, warnings, the normalized definition, and the preview.
   */
  validate(input) {
    const definition = isRecord(input) ? input : {}
    const layout = definition.layout === 'file' ? 'file' : 'bundle'
    const result = validateDefinition(definition, { layout })
    const target = result.normalized === undefined ? '' : skillPathFor(this.root().path, result.normalized.name, layout)
    return { ...result, layout, target }
  }

  /**
   * Create one skill file under the managed root.
   * @param input - definition; `layout` selects bundle or flat file.
   * @returns the write receipt plus the refreshed snapshot.
   */
  create(input) {
    if (!isRecord(input)) throw new Error('技能定义必须是一个对象')
    const layout = input.layout === 'file' ? 'file' : 'bundle'
    const definition = normalizeDefinition(input, { layout })
    const { rows } = this.scan()
    this.assertUniqueName(definition.name, undefined, rows)
    const target = skillPathFor(this.root().path, definition.name, layout)
    try {
      writeSkillFile(target, renderSkillFile(definition), { root: this.root().path, exclusive: true })
    } catch (error) {
      throw this.existingTargetError(error, target)
    }
    this.generation = Date.now()
    return {
      created: true,
      path: target,
      layout,
      snapshot: this.list(),
    }
  }

  /**
   * Replace one skill file, supporting rename.
   *
   * The on-disk layout never changes here: a bundle stays a bundle and a flat
   * file stays flat. Renaming a bundle renames its directory, so bundled
   * resources move with the skill.
   * @param path - current instruction-file path.
   * @param input - the complete next definition.
   * @returns the write receipt plus the refreshed snapshot.
   */
  update(path, input) {
    if (!isRecord(input)) throw new Error('技能定义必须是一个对象')
    const { rows } = this.scan()
    const row = findRow(rows, path)
    const base = readSkillFile(row.path)
    const definition = normalizeDefinition({ name: row.name, ...input }, { layout: row.layout })
    // A shadowed row may keep its name: it was created outside this page and
    // must stay editable. Only an actual rename can introduce a new collision.
    if (definition.name !== row.name) this.assertUniqueName(definition.name, row.path, rows)
    let target = row.path
    if (definition.name !== row.name) {
      target = skillPathFor(this.root().path, definition.name, row.layout)
      // `rename` replaces the destination on POSIX, so the destination must be
      // known absent before the move; on Windows the rename itself also refuses.
      if (existsSync(target)) throw new Error(`目标文件已存在：${target}`)
      if (row.layout === 'bundle') {
        const fromDirectory = dirname(row.path)
        const toDirectory = dirname(target)
        if (normalizeForCompare(fromDirectory) !== normalizeForCompare(toDirectory)) {
          if (existsSync(toDirectory)) throw new Error(`目标目录已存在：${toDirectory}`)
          renameSync(fromDirectory, toDirectory)
        }
      } else {
        renameSync(row.path, target)
      }
    }
    try {
      writeSkillFile(target, renderSkillFile(definition, base.data), { root: this.root().path })
    } catch (error) {
      /*
       * A failed write after a successful move would leave the bundle under a
       * name its frontmatter no longer matches. Put it back and say so, rather
       * than reporting only the write failure.
       */
      const rollback = target === row.path ? '' : restoreRenamedPath(target, row.path)
      throw new Error(`${errorMessage(error)}${rollback}`, { cause: error })
    }
    this.generation = Date.now()
    return {
      updated: true,
      path: target,
      renamedFrom: target === row.path ? '' : row.path,
      snapshot: this.list(),
    }
  }

  /**
   * Delete one skill file, or its whole bundle directory.
   * @param path - instruction-file path.
   * @returns the removal receipt plus the refreshed snapshot.
   */
  remove(path) {
    const { rows } = this.scan()
    const row = findRow(rows, path)
    const root = this.root().path
    if (row.layout === 'bundle') {
      const directory = dirname(row.path)
      // Defensive: a bundle instruction file is always one directory below the
      // root; never let a path quirk turn "delete skill" into "delete root" or
      // into a delete outside the managed root. A junction or symlink is removed
      // as a link, never as its target.
      if (normalizeForCompare(directory) === normalizeForCompare(root) || !isInside(root, directory)) {
        throw new Error(`拒绝删除技能根目录本身（或根目录之外的位置）：${directory}`)
      }
      rmSync(directory, { recursive: true, force: true })
    } else {
      if (!isInside(root, row.path)) throw new Error(`拒绝删除技能根目录之外的文件：${row.path}`)
      rmSync(row.path, { force: true })
    }
    forgetSkillHeader(row.path)
    this.generation = Date.now()
    return {
      removed: true,
      path: row.path,
      directory: row.directory,
      snapshot: this.list(),
    }
  }

  /**
   * Rewrite only the invocation frontmatter of one skill.
   * @param path - instruction-file path.
   * @param input - `modelInvocable` and/or `userInvocable`; omitted fields keep their value.
   * @returns the write receipt plus the refreshed snapshot.
   */
  setInvocation(path, input) {
    const values = isRecord(input) ? input : {}
    const { rows } = this.scan()
    const row = findRow(rows, path)
    const current = readSkillFile(row.path)
    const definition = {
      name: current.name,
      description: current.description,
      whenToUse: current.whenToUse ?? '',
      modelInvocable: values.modelInvocable === undefined ? current.invocation.modelInvocable : values.modelInvocable !== false,
      userInvocable: values.userInvocable === undefined ? current.invocation.userInvocable : values.userInvocable !== false,
      metadata: current.metadata,
      body: current.body,
      layout: row.layout,
    }
    writeSkillFile(row.path, renderSkillFile(definition, current.data), { root: this.root().path })
    this.generation = Date.now()
    return {
      updated: true,
      path: row.path,
      invocation: { modelInvocable: definition.modelInvocable, userInvocable: definition.userInvocable },
      snapshot: this.list(),
    }
  }

  /**
   * Fully enable or fully disable a skill: both the model and the user surface.
   * @param path - instruction-file path.
   * @param enabled - next enablement.
   * @returns the write receipt plus the refreshed snapshot.
   */
  setEnabled(path, enabled) {
    return this.setInvocation(path, { modelInvocable: enabled !== false, userInvocable: enabled !== false })
  }

  /**
   * Copy one skill, optionally under a new name and layout.
   *
   * This is how a shadowed file becomes an active skill again under a new name.
   * Unknown frontmatter keys, invocation policy, and body are preserved; only
   * `name` changes when the copy is renamed.
   * @param path - source instruction-file path.
   * @param input - `name` and `layout` for the copy.
   * @returns the write receipt plus the refreshed snapshot.
   */
  copy(path, input) {
    const values = isRecord(input) ? input : {}
    const { rows } = this.scan()
    const row = findRow(rows, path)
    const source = readSkillFile(row.path)
    const name = String(values.name ?? `${source.name}-copy`).trim()
    if (!SKILL_NAME.test(name)) {
      throw new Error(`技能名称 ${JSON.stringify(name)} 无效：只能使用小写字母、数字，并用单个连字符分隔（kebab-case）`)
    }
    const layout = values.layout === 'file' || values.layout === 'bundle' ? values.layout : row.layout
    this.assertUniqueName(name, undefined, rows)
    const target = skillPathFor(this.root().path, name, layout)
    const definition = {
      name,
      description: source.description,
      whenToUse: source.whenToUse ?? '',
      modelInvocable: source.invocation.modelInvocable,
      userInvocable: source.invocation.userInvocable,
      metadata: source.metadata,
      body: source.body,
      layout,
    }
    try {
      writeSkillFile(target, renderSkillFile(definition, source.data), { root: this.root().path, exclusive: true })
    } catch (error) {
      throw this.existingTargetError(error, target)
    }
    this.generation = Date.now()
    return {
      copied: true,
      from: row.path,
      path: target,
      layout,
      snapshot: this.list(),
    }
  }

  /**
   * Create one skill from the full text of a `SKILL.md`.
   *
   * The form edits fields; this path is the other direction — a skill pasted
   * from a chat, a gist, or another machine. The text is parsed with the same
   * rules as a file on disk, so what the import accepts is exactly what the
   * provider would load. When the text is kept as-is, its formatting and unknown
   * frontmatter keys survive byte for byte; only a forced rename re-renders it.
   * @param input - `{ text, name?, layout? }`.
   * @returns the import receipt plus the refreshed snapshot.
   */
  importSkill(input) {
    const values = isRecord(input) ? input : {}
    const text = typeof values.text === 'string' ? values.text : ''
    if (text.trim() === '') throw new Error('导入内容为空：请粘贴完整的 SKILL.md（frontmatter 与正文）')
    const parsed = parseSkillText(text)
    const requested = String(values.name ?? '').trim()
    const name = requested === '' ? parsed.name : requested
    if (!SKILL_NAME.test(name)) {
      throw new Error(`技能名称 ${JSON.stringify(name)} 无效：只能使用小写字母、数字，并用单个连字符分隔（kebab-case）`)
    }
    const layout = values.layout === 'file' ? 'file' : 'bundle'
    const { rows } = this.scan()
    this.assertUniqueName(name, undefined, rows)
    const target = skillPathFor(this.root().path, name, layout)
    const rendered =
      name === parsed.name
        ? text
        : renderSkillFile(
            {
              name,
              description: parsed.description,
              whenToUse: parsed.whenToUse ?? '',
              modelInvocable: parsed.invocation.modelInvocable,
              userInvocable: parsed.invocation.userInvocable,
              metadata: parsed.metadata,
              body: parsed.body,
              layout,
            },
            parsed.data,
          )
    try {
      writeSkillFile(target, rendered, { root: this.root().path, exclusive: true })
    } catch (error) {
      throw this.existingTargetError(error, target)
    }
    this.generation = Date.now()
    return {
      imported: true,
      name,
      path: target,
      layout,
      snapshot: this.list(),
    }
  }

  /**
   * Delete one entry that the scan could not read as a skill.
   *
   * A malformed `SKILL.md` is invisible to the model and therefore to every
   * other surface, and the page offers no way to fix or remove it: this closes
   * that dead end. Only a path the current scan reports as an issue is eligible,
   * so a valid skill can never be deleted through this endpoint by mistake.
   * @param path - issue path from the snapshot's `issues` list.
   * @returns the removal receipt plus the refreshed snapshot.
   */
  discard(path) {
    const root = this.root().path
    const { issues } = this.scan()
    const wanted = normalizeForCompare(String(path ?? ''))
    const issue = issues.find((candidate) => normalizeForCompare(candidate.path) === wanted)
    if (issue === undefined) {
      throw new Error(`没有找到该异常条目（可能已被修复或删除）：${String(path ?? '')}`)
    }
    if (normalizeForCompare(issue.path) === normalizeForCompare(root) || !isInside(root, issue.path)) {
      throw new Error(`拒绝删除技能根目录本身（或根目录之外的位置）：${issue.path}`)
    }
    // An unreadable bundle is still a bundle: its directory goes, resources and all.
    const bundle = normalizeForCompare(basename(issue.path)) === normalizeForCompare(SKILL_FILENAME)
    if (bundle) rmSync(dirname(issue.path), { recursive: true, force: true })
    else rmSync(issue.path, { recursive: true, force: true })
    forgetSkillHeader(issue.path)
    this.generation = Date.now()
    return {
      removed: true,
      path: issue.path,
      directory: bundle ? dirname(issue.path) : root,
      snapshot: this.list(),
    }
  }

  /**
   * Re-scan the root. The model-side registry refreshes itself through its own
   * watcher; this endpoint exists so the page can force a read of the disk.
   * @returns the refreshed snapshot.
   */
  refresh() {
    return this.list()
  }

  /**
   * Refuse an authoring change that would introduce a new shadowed duplicate.
   *
   * Already shadowed rows are allowed to keep their name: they were created
   * outside this page and the page's job is to explain them, not to make them
   * unfixable.
   * @param name - candidate skill name.
   * @param exceptPath - the file being renamed, excluded from the comparison.
   * @param scanned - rows a caller already scanned, so a mutation reads the disk once.
   */
  assertUniqueName(name, exceptPath, scanned) {
    const rows = scanned ?? this.scan().rows
    const conflict = rows.find(
      (row) =>
        row.name === name &&
        row.status === 'active' &&
        (exceptPath === undefined || normalizeForCompare(row.path) !== normalizeForCompare(exceptPath)),
    )
    if (conflict !== undefined) {
      throw new Error(`技能名 "${name}" 已被 ${conflict.path} 使用：名称必须唯一，否则后一个会被遮蔽`)
    }
  }

  /**
   * Translate a lost create race into the same message a pre-check would give.
   *
   * The exclusive write is what makes the check race-free; without this
   * translation the user would see a raw `EEXIST` from the filesystem instead.
   * @param error - rejection from `writeSkillFile`.
   * @param target - the path that was being created.
   * @returns the error to throw.
   */
  existingTargetError(error, target) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') return new Error(`目标文件已存在：${target}`)
    return error
  }

  /**
   * Dispatch one RPC endpoint.
   * @param endpoint - channel-relative endpoint name.
   * @param payload - decoded JSON payload.
   * @returns the endpoint result envelope's value.
   */
  dispatch(endpoint, payload) {
    const args = isRecord(payload) ? payload : {}
    switch (endpoint) {
      case 'state':
        return this.list()
      case 'get':
        return this.get(args.path)
      case 'validate':
        return this.validate(args.definition ?? args)
      case 'create':
        return this.create(args.definition ?? args)
      case 'update':
        return this.update(args.path, args.definition ?? args)
      case 'remove':
        return this.remove(args.path)
      case 'setInvocation':
        return this.setInvocation(args.path, args)
      case 'start':
        return this.setEnabled(args.path, true)
      case 'stop':
        return this.setEnabled(args.path, false)
      case 'copy':
        return this.copy(args.path, args.definition ?? args)
      case 'import':
        return this.importSkill(args.definition ?? args)
      case 'discard':
        return this.discard(args.path)
      case 'refresh':
        return this.refresh()
      default:
        throw new Error(`未知的接口 ${JSON.stringify(endpoint)}`)
    }
  }
}

/**
 * De-duplicate a list of strings while keeping order.
 * @param values - candidate strings.
 * @returns the unique strings.
 */
function dedupe(values) {
  return [...new Set(values)]
}

/**
 * Move a renamed skill back after its rewrite failed.
 * @param from - the path the skill now occupies.
 * @param to - the path it came from.
 * @returns a suffix for the failure message: empty on success, an explanation otherwise.
 */
function restoreRenamedPath(from, to) {
  try {
    renameSync(from, to)
    return '（原路径已恢复）'
  } catch (error) {
    return `（并且无法恢复到原路径 ${to}：${errorMessage(error)}）`
  }
}

/**
 * Plugin entry: build the manager and answer the browser channel. Both halves
 * read the skill files directly, so there is nothing else to keep alive.
 * @param ctx - host plugin context.
 * @param config - resolved row config.
 */
export function apply(ctx, config) {
  const manager = new SkillManager(ctx, config)
  /*
   * The channel route is registered directly on the web server rather than
   * through `ctx.connection.rpc.handle`: Connection hosts one interceptor on the
   * shared `/api` channel and the Typert gateway already owns it, and its
   * per-channel route registration resolves `webServer` through the service's
   * own bound context. A prefix route plus `connection.requestRejection` is the
   * same shape the gateway uses for its Remote-stream upgrade route, and the
   * envelope it speaks is Connection's, so the browser half still calls
   * `ctx.connection.rpc.call(CHANNEL, …)`.
   */
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    try {
      const connection = webCtx.connection
      webCtx.effect(() => {
        const disposeRoute = webCtx.webServer.register({
          kind: 'prefix',
          path: CHANNEL,
          handler: (req, res) => {
            /*
             * The route handler cannot await, so it must own the rejection: an
             * unawaited failure here would surface as an unhandled rejection and
             * take the host process down instead of failing one request.
             */
            serveChannelRequest(
              {
                channel: CHANNEL,
                connection,
                dispatch: (endpoint, payload) => manager.dispatch(endpoint, payload),
              },
              req,
              res,
            ).catch((error) => {
              webCtx.logger.error('skill-manager: %s request failed: %s', CHANNEL, errorMessage(error))
              if (res.writableEnded || res.destroyed) return
              try {
                res.writeHead(500, { 'content-type': 'text/plain' })
                res.end('internal error')
              } catch {
                /* the socket is already gone; the log above is the record */
              }
            })
          },
        })
        manager.channel.state = 'registered'
        manager.channel.error = ''
        webCtx.logger.info('skill-manager: browser channel %s is live', CHANNEL)
        // The snapshot reports the route's real state, so HMR disposal must not
        // keep claiming a channel that no longer answers.
        return () => {
          manager.channel.state = 'closed'
          manager.channel.error = ''
          disposeRoute()
        }
      }, `dsh-skill-manager: ${CHANNEL} RPC route`)
    } catch (error) {
      manager.channel.state = 'failed'
      manager.channel.error = errorMessage(error)
      ctx.logger.error('skill-manager: browser channel %s could not be registered: %s', CHANNEL, manager.channel.error)
    }
  })
}
