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
 * 2. **Author.** It creates, edits, renames, copies, enables, disables, and
 *    deletes those files on disk. Because the provider watches that root, a
 *    saved skill reaches the next model catalog without a restart; there is no
 *    second copy of the skill in this plugin's config.
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
import { dirname, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { serveChannelRequest } from './channel.js'
import {
  SKILL_NAME,
  errorMessage,
  findRow,
  isRecord,
  normalizeDefinition,
  normalizeForCompare,
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
/**
 * The installed package version, read from this package's own `package.json` so
 * the settings page can show a single version identity. A missing or unreadable
 * manifest must not fail the row: the badge is diagnostic, not functional.
 */
export const VERSION = readPackageVersion()
/** Shown when the manifest cannot be read; never a valid published version. */
const UNKNOWN_VERSION = '0.0.0'

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
    const active = rows.filter((row) => row.status === 'active')
    const totals = {
      skills: rows.length,
      active: active.length,
      shadowed: rows.length - active.length,
      issues: issues.length,
      model: active.filter((row) => row.invocation.modelInvocable).length,
      user: active.filter((row) => row.invocation.userInvocable).length,
      disabled: active.filter((row) => !row.invocation.modelInvocable).length,
      roots: 1,
      bundles: rows.filter((row) => row.layout === 'bundle').length,
      files: rows.filter((row) => row.layout === 'file').length,
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
          rank: 400,
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
    this.assertUniqueName(definition.name)
    const target = skillPathFor(this.root().path, definition.name, layout)
    if (existsSync(target)) throw new Error(`目标文件已存在：${target}`)
    writeSkillFile(target, renderSkillFile(definition))
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
    if (definition.name !== row.name) this.assertUniqueName(definition.name, row.path)
    let target = row.path
    if (definition.name !== row.name) {
      target = skillPathFor(this.root().path, definition.name, row.layout)
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
    writeSkillFile(target, renderSkillFile(definition, base.data))
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
    if (row.layout === 'bundle') {
      const directory = dirname(row.path)
      // Defensive: a bundle instruction file is always one directory below the
      // root; never let a path quirk turn "delete skill" into "delete root".
      if (normalizeForCompare(directory) === normalizeForCompare(this.root().path)) {
        throw new Error(`拒绝删除技能根目录本身：${directory}`)
      }
      rmSync(directory, { recursive: true, force: true })
    } else {
      rmSync(row.path, { force: true })
    }
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
    writeSkillFile(row.path, renderSkillFile(definition, current.data))
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
    this.assertUniqueName(name)
    const target = skillPathFor(this.root().path, name, layout)
    if (existsSync(target)) throw new Error(`目标文件已存在：${target}`)
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
    writeSkillFile(target, renderSkillFile(definition, source.data))
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
   */
  assertUniqueName(name, exceptPath) {
    const { rows } = this.scan()
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

  /** Release nothing today; kept as the HMR disposal seam for future state. */
  dispose() {}

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
  const result = []
  for (const value of values) if (!result.includes(value)) result.push(value)
  return result
}

/**
 * Plugin entry: build the manager, answer the browser channel, and release the
 * managed state with the fiber.
 * @param ctx - host plugin context.
 * @param config - resolved row config.
 */
export function apply(ctx, config) {
  const manager = new SkillManager(ctx, config)
  ctx.effect(() => () => manager.dispose(), 'skill-manager: managed skill files')
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
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: 'prefix',
            path: CHANNEL,
            handler: (req, res) => {
              void serveChannelRequest(
                {
                  channel: CHANNEL,
                  connection,
                  dispatch: (endpoint, payload) => manager.dispatch(endpoint, payload),
                },
                req,
                res,
              )
            },
          }),
        `dsh-skill-manager: ${CHANNEL} RPC route`,
      )
      manager.channel.state = 'registered'
      manager.channel.error = ''
      webCtx.logger.info('skill-manager: browser channel %s is live', CHANNEL)
    } catch (error) {
      manager.channel.state = 'failed'
      manager.channel.error = errorMessage(error)
      ctx.logger.error('skill-manager: browser channel %s could not be registered: %s', CHANNEL, manager.channel.error)
    }
  })
}
