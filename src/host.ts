import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { hostname, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { pluginSyncBackupPrefix, stageApplyPlan } from './core/apply.js'
import { acquireApplyLock, clearStaleApplyLock, readApplyLock, releaseApplyLock, writeApplyLockPid } from './core/apply-lock.js'
import { catalogOf, manifestCatalog } from './core/catalog.js'
import type { Catalog } from './core/catalog.js'
import { launchDetached } from './core/detached.js'
import { commitSnapshot, exportSnapshot, machineDirectory, writeZip } from './core/export.js'
import { inspectRepository, listMachines, prepareRepository, pushRepository, testRepository, unpushedCount } from './core/git-sync.js'
import type { MachineEntry, PreparedRepository } from './core/git-sync.js'
import { buildChanges, createApplyPlan, newBuildPermissions, readSnapshot, validateSnapshot } from './core/plan.js'
import type { LocalProfile } from './core/plan.js'
import { assertUniquePackageIdentities, packageIdentity } from './core/package-names.js'
import { readPreferencesFile, updatePreferencesFile } from './core/preferences.js'
import type { PluginSyncPreferences } from './core/preferences.js'
import { pruneDirectory } from './core/retention.js'
import type { SyncSnapshot } from './core/types.js'
import { previewEntries } from './core/view.js'
import { guard, HttpError, readJsonBody, sendError, sendJson } from './host/http.js'
import type { HttpContextLike, HttpRequestLike, HttpResponseLike } from './host/http.js'

/** Every route this plugin registers; each one passes {@link guard} first. */
export const PLUGIN_SYNC_ROUTES = [
  '/dsh-plugin-sync/state',
  '/dsh-plugin-sync/preferences',
  '/dsh-plugin-sync/export',
  '/dsh-plugin-sync/push',
  '/dsh-plugin-sync/download',
  '/dsh-plugin-sync/git-machines',
  '/dsh-plugin-sync/git-test',
  '/dsh-plugin-sync/preview',
  '/dsh-plugin-sync/apply',
  '/dsh-plugin-sync/apply-lock/clear',
  '/dsh-plugin-sync/last-apply/acknowledge',
]

const METHODS: Record<string, string> = {
  '/dsh-plugin-sync/state': 'GET',
  '/dsh-plugin-sync/preferences': 'PATCH',
  '/dsh-plugin-sync/download': 'GET',
}

/** Exports and staged imports kept before older ones move to the Trash. */
const KEEP = 5

interface ApplyLaunchOptions {
  stagedDir: string
  dshHome: string
  noApp: boolean
  appPath: string
  dshPath: string
  lockOwner?: string | undefined
}

interface PluginSyncConfig {
  dshHome?: string
  appPath?: string
  /** Directory name of this machine in a Git repository; defaults to the host name. */
  machineId?: string
  /** Display name used until the owner sets one; defaults to the macOS computer name. */
  machineName?: string
  bodyLimit?: number
  trashDir?: string
  allowFileRepositoryForTests?: boolean
  applyLauncher?: (options: ApplyLaunchOptions) => Promise<{ pid: number }>
}

interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (request: HttpRequestLike, response: HttpResponseLike) => Promise<void> }): () => void
}

interface HostContext extends HttpContextLike {
  webServer: WebServerLike
  effect?: (dispose: () => void, label?: string) => unknown
}

interface PreviewState {
  snapshot: SyncSnapshot
  sourceDir: string
  cleanup: () => Promise<void>
}

/** What `last-export.json` records; the export tab shows it after the App restarts. */
interface ExportRecord {
  exportedAt: string
  target: 'zip' | 'git'
  pluginCount: number
  filename?: string
  size?: number
  downloadId?: string
  commit?: string
  pushed?: boolean
  pushError?: string
  unpushed?: number
}

function run(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function readOptional<T>(path: string, fallback: T, read: (text: string) => T): Promise<T> {
  try {
    return read(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

function sourceKind(spec: string): 'link' | 'file' | 'github' | 'tarball' | 'npm' {
  if (spec.startsWith('link:')) return 'link'
  if (spec.startsWith('file:')) return 'file'
  if (spec.startsWith('github:')) return 'github'
  if (/^https?:\/\//.test(spec)) return 'tarball'
  return 'npm'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0]! : String(error)
}

async function defaultApplyLauncher(options: ApplyLaunchOptions): Promise<{ pid: number }> {
  const script = fileURLToPath(new URL('./apply-process.js', import.meta.url))
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: options.dshHome, ...(options.lockOwner !== undefined ? { DSH_PLUGIN_SYNC_LOCK_TOKEN: options.lockOwner } : {}) }
  delete env.DEEPSEEK_API_KEY
  delete env.DEEPSEC_SCOPE_SIGNING_KEY
  const pid = await launchDetached({
    command: process.execPath,
    args: [script, '--staged', options.stagedDir, '--home', options.dshHome, ...(options.noApp ? ['--no-app'] : []),
      ...(options.appPath !== undefined ? ['--app', options.appPath] : []), ...(options.dshPath !== undefined ? ['--dsh', options.dshPath] : [])],
    logPath: `${options.stagedDir}.log`,
    env,
  })
  return { pid }
}

/** Cordis service `pluginSync`: the routes behind the plugin's page. */
export class PluginSyncService {
  readonly dshHome: string
  readonly profileDir: string
  readonly stateDir: string
  readonly appPath: string
  readonly dshPath: string
  readonly machineId: string
  readonly bodyLimit: number
  private readonly configuredMachineName: string | undefined
  private machineNamePromise: Promise<string> | undefined
  private readonly allowFileRepositoryForTests: boolean
  private readonly configuredTrashDir: string | undefined
  private readonly previews = new Map<string, PreviewState>()
  private readonly downloads = new Map<string, { path: string; filename: string; type: string }>()
  private readonly applyLauncher: (options: ApplyLaunchOptions) => Promise<{ pid: number }>

  constructor(ctx: any, config: PluginSyncConfig = {}) {
    ctx.provide('pluginSync', this)
    this.dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
    this.profileDir = join(this.dshHome, 'profiles', 'desktop')
    this.stateDir = join(this.dshHome, 'plugin-sync')
    this.appPath = config.appPath ?? '/Applications/DeepSeek Harness.app'
    this.dshPath = join(this.appPath, 'Contents/Resources/runtime/cli/bin/dsh')
    this.machineId = machineDirectory(config.machineId ?? hostname())
    this.configuredMachineName = config.machineName
    this.bodyLimit = config.bodyLimit ?? 32 * 1024 * 1024
    this.allowFileRepositoryForTests = config.allowFileRepositoryForTests === true
    this.configuredTrashDir = config.trashDir
    this.applyLauncher = config.applyLauncher ?? defaultApplyLauncher
    ctx.inject(['webServer'], (scope: HostContext) => { this.install(scope) })
  }

  install(ctx: HostContext): void {
    for (const path of PLUGIN_SYNC_ROUTES) {
      const dispose = ctx.webServer.register({ kind: 'exact', path, handler: (request, response) => this.handle(ctx, path, request, response) })
      ctx.effect?.(() => dispose, `pluginSync.http.${path}`)
    }
    // A comparison that is never applied keeps its snapshot copy in the system temporary directory.
    // Remove it when the routes go away: the row is disabled or the App quits.
    ctx.effect?.(() => () => this.clearPreviews(), 'pluginSync.previews')
  }

  private get temporaryHome(): boolean {
    return resolve(this.dshHome) !== resolve(homedir(), '.dsh')
  }

  private trashDirectory(): string {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    return this.configuredTrashDir ?? join(this.temporaryHome ? join(dirname(this.dshHome), '.Trash') : join(homedir(), '.Trash'), `dsh-plugin-sync-${date}`)
  }

  private backupPattern(): string {
    return pluginSyncBackupPrefix(this.dshHome) + '*'
  }

  private desktopVersion(): string {
    return JSON.parse(readFileSync(join(this.appPath, 'Contents/Resources/runtime/primary-runtime/runtime.json'), 'utf8')).desktopVersion
  }

  private defaultMachineName(): Promise<string> {
    const fallback = hostname().replace(/\.local$/, '')
    this.machineNamePromise ??= this.configuredMachineName !== undefined
      ? Promise.resolve(this.configuredMachineName)
      : run('scutil', ['--get', 'ComputerName']).then(output => output.trim() || fallback, () => fallback)
    return this.machineNamePromise
  }

  private preferences(): Promise<PluginSyncPreferences> {
    return readPreferencesFile(join(this.stateDir, 'preferences.json'), this.allowFileRepositoryForTests)
  }

  private async machineName(preferences: PluginSyncPreferences): Promise<string> {
    return preferences.machineName ?? await this.defaultMachineName()
  }

  /** This machine's plugins from the official plugin manager, or from the profile manifest without it. */
  private async catalog(ctx: HttpContextLike, manifest: any): Promise<Catalog & { managed: boolean }> {
    const manager = ctx.get('pluginManager', false)
    if (typeof manager?.listBundles === 'function') return { ...catalogOf(await manager.listBundles(), manifest), managed: true }
    const descriptions: Record<string, string> = {}
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const installed = await readJson(join(this.profileDir, 'node_modules', name, 'package.json')).catch(() => undefined)
      if (typeof installed?.description === 'string' && installed.description !== '') descriptions[name] = installed.description
    }
    return { ...manifestCatalog(manifest, descriptions), managed: false }
  }

  private async localProfile(catalog?: Catalog & { managed: boolean }): Promise<LocalProfile> {
    const lockfile = await readFile(join(this.profileDir, 'pnpm-lock.yaml'), 'utf8')
    const lock = parse(lockfile, { logLevel: 'error' }) ?? {}
    const versions: Record<string, string> = {}
    for (const importer of Object.values(lock.importers ?? {}) as any[]) {
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, dependency] of Object.entries(importer?.[section] ?? {}) as [string, any][]) {
          if (typeof dependency.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\(.*\))?$/.test(dependency.version)) versions[name] = dependency.version.replace(/\(.*\)$/, '')
          else {
            const manifest = await readJson(join(this.profileDir, 'node_modules', name, 'package.json')).catch(() => undefined)
            if (typeof manifest?.version === 'string') versions[name] = manifest.version
          }
        }
      }
    }
    const patches: Record<string, string> = {}
    for (const file of await readdir(join(this.profileDir, 'patches')).catch(() => [])) {
      if (file.endsWith('.patch')) patches[file] = await readFile(join(this.profileDir, 'patches', file), 'utf8')
    }
    const rows: Record<string, boolean> = {}
    const patch = await readOptional(join(this.profileDir, 'cordis.patch.yml'), [], text => parse(text, { logLevel: 'error' }))
    if (Array.isArray(patch)) {
      for (const entry of patch) if (typeof entry?.id === 'string' && typeof entry.disabled === 'boolean') rows[entry.id] = entry.disabled
    }
    return {
      manifest: await readJson(join(this.profileDir, 'package.json')),
      workspace: parse(await readFile(join(this.profileDir, 'pnpm-workspace.yaml'), 'utf8'), { logLevel: 'error' }),
      patches,
      lockfile,
      versions,
      rows,
      exemptions: await readOptional(join(this.profileDir, 'compatibility.json'), {}, text => JSON.parse(text)),
      ...(catalog?.managed === true ? { official: catalog.plugins.filter(plugin => plugin.group === 'official' && !plugin.installed).map(plugin => plugin.name) } : {}),
    }
  }

  private async previousSnapshot(): Promise<SyncSnapshot | undefined> {
    try {
      return validateSnapshot(await readJson(join(this.stateDir, 'last-snapshot.json')))
    } catch {
      // No snapshot applied yet, or one this version cannot read: nothing counts as previously synced.
      return undefined
    }
  }

  private async ensureRepository(input: string): Promise<PreparedRepository> {
    if (input === '') throw new Error('未配置远程地址，请在「设置」中填写')
    return prepareRepository(input, this.stateDir, this.allowFileRepositoryForTests)
  }

  /** Commit and working-tree state of a `link:` dependency's repository. */
  private async linkStatus(spec: string): Promise<{ commit?: string; dirty?: boolean }> {
    const value = spec.slice('link:'.length)
    const directory = value.startsWith('~') ? resolve(homedir(), value.slice(2)) : resolve(this.profileDir, value)
    try {
      const commit = (await run('git', ['-C', directory, 'rev-parse', '--short', 'HEAD'])).trim()
      const dirty = (await run('git', ['-C', directory, 'status', '--porcelain'])).trim() !== ''
      return { commit, dirty }
    } catch {
      // Not a Git repository: the export refuses it with the packer's own message.
      return {}
    }
  }

  private async machines(repository: string, head: string | undefined): Promise<(MachineEntry & { self: boolean })[]> {
    const machines = head === undefined ? [] : await listMachines(repository, head)
    return machines.map(machine => ({ ...machine, self: machine.id === this.machineId }))
  }

  private async repositoryState(preferences: PluginSyncPreferences): Promise<unknown> {
    if (preferences.repository === '') return { configured: false }
    try {
      const status = await inspectRepository(preferences.repository, this.stateDir, this.allowFileRepositoryForTests)
      return {
        configured: true,
        kind: status.kind,
        ...(status.fetchedAt !== undefined ? { fetchedAt: status.fetchedAt } : {}),
        machines: status.repository === undefined ? null : await this.machines(status.repository, status.head),
      }
    } catch (error) {
      return { configured: true, error: messageOf(error) }
    }
  }

  private async state(ctx: HttpContextLike): Promise<unknown> {
    const preferences = await this.preferences()
    const manifest = await readJson(join(this.profileDir, 'package.json'))
    const catalog = await this.catalog(ctx, manifest)
    const local = await this.localProfile(catalog)
    assertUniquePackageIdentities([...Object.keys(manifest.dependencies ?? {}), ...catalog.plugins.map(plugin => plugin.name)])
    const excluded = new Set(preferences.exportExcluded.map(packageIdentity))
    const installedNames = new Map(catalog.plugins.map(plugin => [packageIdentity(plugin.name), plugin.name]))
    // Present saved exclusions using the installed name, so the page can recheck
    // a renamed plugin by deleting that row's name from its existing Set.
    const exportExcluded = [...new Set(preferences.exportExcluded.map(name => installedNames.get(packageIdentity(name)) ?? name))].sort()
    const desktopVersion = this.desktopVersion()
    const plugins = []
    for (const plugin of catalog.plugins) {
      const spec = manifest.dependencies?.[plugin.name] as string | undefined
      const version = local.versions?.[plugin.name] ?? plugin.version
      plugins.push({
        ...plugin,
        ...(version !== undefined ? { version } : {}),
        ...(spec !== undefined ? { source: sourceKind(spec) } : {}),
        ...(spec?.startsWith('link:') ? await this.linkStatus(spec) : {}),
        exported: !excluded.has(packageIdentity(plugin.name)),
        exempted: version !== undefined && local.exemptions?.[`${plugin.name}@${version}`]?.includes(desktopVersion) === true,
      })
    }
    const lastExport = await readOptional<ExportRecord | null>(join(this.stateDir, 'last-export.json'), null, text => JSON.parse(text))
    return {
      desktopVersion,
      temporaryHome: this.temporaryHome,
      machineId: this.machineId,
      machineName: await this.machineName(preferences),
      defaultMachineName: await this.defaultMachineName(),
      preferences: { ...preferences, exportExcluded },
      plugins,
      lastApply: await readOptional(join(this.stateDir, 'last-apply.json'), null, text => JSON.parse(text)),
      lastExport: lastExport === null ? null : { ...lastExport, downloadable: lastExport.downloadId !== undefined && this.downloads.has(lastExport.downloadId) },
      applying: await readApplyLock(this.dshHome) !== null,
      repository: await this.repositoryState(preferences),
      paths: { data: this.stateDir, backups: this.backupPattern() },
      keep: KEEP,
    }
  }

  private async export(ctx: HttpContextLike, body: any): Promise<ExportRecord> {
    const preferences = await this.preferences()
    const target = body.target ?? preferences.exportTarget
    if (target !== 'zip' && target !== 'git') throw new Error('导出位置必须是 zip 或 git')
    const manifest = await readJson(join(this.profileDir, 'package.json'))
    const catalog = await this.catalog(ctx, manifest)
    const exportId = randomUUID()
    const directory = join(this.stateDir, 'exports', exportId)
    const snapshotDir = join(directory, 'snapshot')
    const { snapshot } = await exportSnapshot({
      profileDir: this.profileDir,
      outputDir: snapshotDir,
      machine: await this.machineName(preferences),
      machineId: this.machineId,
      desktopVersion: this.desktopVersion(),
      excluded: preferences.exportExcluded,
      catalog,
    })
    const desktop = snapshot.profiles.desktop
    const record: ExportRecord = { exportedAt: snapshot.createdAt, target, pluginCount: desktop.plugins.length + desktop.official.length }
    if (target === 'zip') {
      const output = join(directory, 'snapshot.zip')
      await writeZip(snapshotDir, output)
      const downloadId = randomUUID()
      const filename = `dsh-plugin-sync-${this.machineId}-${snapshot.createdAt.slice(0, 10)}.zip`
      this.downloads.set(downloadId, { path: output, filename, type: 'application/zip' })
      Object.assign(record, { filename, size: (await stat(output)).size, downloadId })
    } else {
      const prepared = await this.ensureRepository(preferences.repository)
      record.commit = await commitSnapshot(snapshotDir, prepared.repository, this.machineId, { cleanupOnCommitFailure: prepared.kind === 'url' })
      if (prepared.kind === 'url') {
        try {
          await pushRepository(prepared.repository, prepared.branch)
          record.pushed = true
        } catch (error) {
          record.pushed = false
          record.pushError = messageOf(error)
        }
        record.unpushed = await unpushedCount(prepared.repository, prepared.branch)
      }
    }
    await writeJsonAtomic(join(this.stateDir, 'last-export.json'), record)
    await pruneDirectory(join(this.stateDir, 'exports'), this.trashDirectory(), KEEP)
    return record
  }

  private async push(): Promise<unknown> {
    const prepared = await this.ensureRepository((await this.preferences()).repository)
    if (prepared.kind === 'path') throw new Error('本机路径的仓库无需推送')
    const head = await pushRepository(prepared.repository, prepared.branch)
    const unpushed = await unpushedCount(prepared.repository, prepared.branch)
    const recordPath = join(this.stateDir, 'last-export.json')
    const record = await readOptional<ExportRecord | null>(recordPath, null, text => JSON.parse(text))
    if (record?.target === 'git') await writeJsonAtomic(recordPath, { ...record, pushed: true, unpushed, pushError: undefined })
    return { head, unpushed }
  }

  private async loadPreview(source: any): Promise<PreviewState> {
    if (source?.kind === 'zip') {
      if (typeof source.base64 !== 'string') throw new Error('压缩包上传缺少内容')
      await mkdir(join(this.stateDir, 'uploads'), { recursive: true })
      const directory = await mkdtemp(join(this.stateDir, 'uploads', 'upload-'))
      const path = join(directory, 'snapshot.zip')
      await writeFile(path, Buffer.from(source.base64, 'base64'), { mode: 0o600 })
      const result = await readSnapshot({ kind: 'zip', path })
      await pruneDirectory(join(this.stateDir, 'uploads'), this.trashDirectory(), KEEP)
      return result
    }
    if (source?.kind === 'git') {
      if (typeof source.machine !== 'string') throw new Error('选择要导入的机器')
      const preferences = await this.preferences()
      if (preferences.repository === '') throw new Error('未配置远程地址，请在「设置」中填写')
      const status = await inspectRepository(preferences.repository, this.stateDir, this.allowFileRepositoryForTests)
      if (status.repository === undefined || status.head === undefined) throw new Error('Git 仓库中暂无快照，请先拉取')
      return readSnapshot({ kind: 'git', repository: status.repository, machine: source.machine, commit: status.head })
    }
    throw new Error('不支持的快照来源')
  }

  private async preview(ctx: HttpContextLike, body: any): Promise<unknown> {
    await this.clearPreviews()
    const preview = await this.loadPreview(body.source)
    try {
      const manifest = await readJson(join(this.profileDir, 'package.json'))
      const catalog = await this.catalog(ctx, manifest)
      const local = await this.localProfile(catalog)
      const snapshot = preview.snapshot
      const set = buildChanges({ snapshot, local, previous: await this.previousSnapshot(), currentDesktopVersion: this.desktopVersion() })
      const view = previewEntries(set, snapshot, catalog, local.versions ?? {}, name => newBuildPermissions(snapshot, local, [name]))
      const previewId = randomUUID()
      this.previews.set(previewId, preview)
      return {
        previewId,
        source: { machine: snapshot.machine, machineId: snapshot.machineId, createdAt: snapshot.createdAt, desktopVersion: snapshot.dsh.desktopVersion, exporterVersion: snapshot.exporter.version },
        ...view,
        warnings: set.warnings,
      }
    } catch (error) {
      await preview.cleanup()
      throw error
    }
  }

  private async apply(ctx: HttpContextLike, body: any): Promise<unknown> {
    if (await readApplyLock(this.dshHome) !== null) throw new HttpError(409, 'APPLY_IN_PROGRESS', '已有导入正在进行')
    const preview = typeof body.previewId === 'string' ? this.previews.get(body.previewId) : undefined
    if (preview === undefined) throw new HttpError(404, 'NOT_FOUND', '比较结果已失效，请重新比较')
    if (!Array.isArray(body.selected) || !body.selected.every((id: unknown) => typeof id === 'string')) throw new Error('selected 必须是变更 id 列表')
    const manifest = await readJson(join(this.profileDir, 'package.json'))
    const plan = await createApplyPlan({
      snapshot: preview.snapshot,
      local: await this.localProfile(await this.catalog(ctx, manifest)),
      previous: await this.previousSnapshot(),
      currentDesktopVersion: this.desktopVersion(),
      selected: body.selected,
      acceptRisk: body.acceptRisk === true,
    })
    if (plan.changes.length === 0) throw new Error('没有选择任何变更')
    const stagedDir = join(this.stateDir, 'staged', plan.id)
    await stageApplyPlan({ plan, sourceDir: preview.sourceDir, stagedDir })
    await writeFile(join(stagedDir, 'source-snapshot.json'), `${JSON.stringify(preview.snapshot, null, 2)}\n`, { mode: 0o600 })
    this.previews.delete(body.previewId)
    await preview.cleanup()
    await pruneDirectory(join(this.stateDir, 'staged'), this.trashDirectory(), KEEP)
    const noApp = body.noApp === true && this.temporaryHome
    const owner = await acquireApplyLock(this.dshHome, plan.id)
    try {
      const launched = await this.applyLauncher({ stagedDir, dshHome: this.dshHome, noApp, appPath: this.appPath, dshPath: this.dshPath, lockOwner: owner })
      await writeApplyLockPid(this.dshHome, owner, launched.pid)
      return { status: 'started', stagedId: plan.id, ...launched }
    } catch (error) {
      await releaseApplyLock(this.dshHome, owner)
      throw error
    }
  }

  private async clearPreviews(): Promise<void> {
    for (const [id, preview] of this.previews) {
      this.previews.delete(id)
      await preview.cleanup()
    }
  }

  private async handle(ctx: HostContext, path: string, request: HttpRequestLike, response: HttpResponseLike): Promise<void> {
    try {
      guard(ctx, request)
      const method = METHODS[path] ?? 'POST'
      if (request.method !== method) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `只接受 ${method}`)
      if (path.endsWith('/state')) {
        sendJson(response, 200, await this.state(ctx))
        return
      }
      if (path.endsWith('/download')) {
        const url = new URL(request.url ?? path, 'http://127.0.0.1')
        const download = this.downloads.get(url.searchParams.get('id') ?? '')
        if (download === undefined) throw new HttpError(404, 'NOT_FOUND', '下载链接已失效，请重新导出')
        response.writeHead(200, { 'content-type': download.type, 'content-disposition': `attachment; filename="${download.filename.replace(/[^A-Za-z0-9._-]/g, '-')}"`, 'cache-control': 'no-store' })
        response.end(await readFile(download.path))
        return
      }
      const body = await readJsonBody(request, this.bodyLimit)
      if (path.endsWith('/preferences')) {
        sendJson(response, 200, await updatePreferencesFile(join(this.stateDir, 'preferences.json'), body, this.allowFileRepositoryForTests))
        return
      }
      if (path.endsWith('/export')) {
        sendJson(response, 200, await this.export(ctx, body))
        return
      }
      if (path.endsWith('/push')) {
        sendJson(response, 200, await this.push())
        return
      }
      if (path.endsWith('/git-machines')) {
        const preferences = await this.preferences()
        if (body.fetch === true) {
          const prepared = await this.ensureRepository(preferences.repository)
          const status = await inspectRepository(preferences.repository, this.stateDir, this.allowFileRepositoryForTests)
          sendJson(response, 200, { machines: await this.machines(prepared.repository, prepared.head), ...(status.fetchedAt !== undefined ? { fetchedAt: status.fetchedAt } : {}) })
        } else {
          sendJson(response, 200, await this.repositoryState(preferences))
        }
        return
      }
      if (path.endsWith('/git-test')) {
        if (typeof body.repository !== 'string') throw new Error('缺少远程地址')
        sendJson(response, 200, await testRepository(body.repository.trim(), this.allowFileRepositoryForTests))
        return
      }
      if (path.endsWith('/preview')) {
        sendJson(response, 200, await this.preview(ctx, body))
        return
      }
      if (path.endsWith('/apply')) {
        sendJson(response, 202, await this.apply(ctx, body))
        return
      }
      if (path.endsWith('/apply-lock/clear')) {
        if (body.confirm !== true) throw new HttpError(400, 'CONFIRM_REQUIRED', '清除应用锁需要明确确认')
        sendJson(response, 200, { cleared: await clearStaleApplyLock(this.dshHome) })
        return
      }
      if (path.endsWith('/last-apply/acknowledge')) {
        const resultPath = join(this.stateDir, 'last-apply.json')
        const result = await readOptional<any>(resultPath, null, text => JSON.parse(text))
        if (result !== null) await writeJsonAtomic(resultPath, { ...result, acknowledged: true })
        sendJson(response, 200, { acknowledged: result !== null })
        return
      }
      throw new HttpError(404, 'NOT_FOUND', '路由不存在')
    } catch (error) {
      if (error instanceof HttpError) sendError(response, error)
      else sendError(response, new HttpError(400, 'OPERATION_FAILED', messageOf(error)))
    }
  }
}
