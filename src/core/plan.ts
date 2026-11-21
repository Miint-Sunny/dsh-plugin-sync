import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { LocalizedText } from './catalog.js'
import { assertUniquePackageIdentities, packageAlias, packageIdentity, SYNC_PACKAGE_NAMES } from './package-names.js'
import type { SnapshotPlugin, SyncSnapshot } from './types.js'
import { packageNameFromKey } from './util.js'

export type VersionOrder = 'older' | 'same' | 'newer'

/** What an import can do to a plugin, a bundle selection, a component switch or a compatibility exemption. */
export type ChangeKind = 'install' | 'rename' | 'upgrade' | 'downgrade' | 'remove' | 'enable' | 'disable' | 'row' | 'exemption'

/** One change an import offers. The page selects all changes of one plugin together. */
export interface Change {
  /** `plugin:<name>`, `bundle:<name>`, `row:<id>` or `exemption:<key>`. */
  id: string
  kind: ChangeKind
  /** Plugin or bundle name, row id, or exemption key. */
  name: string
  /** The plugin the change belongs to. */
  owner: string
  /** Installed alias atomically uninstalled when this rename installs `name`. */
  replaces?: string
  /** A rename may also install a lower version; keep the existing downgrade warning. */
  downgrade?: boolean
  from?: string
  to?: string
  /** Display title of a component row. */
  title?: LocalizedText
  defaultOn: boolean
}

/** Why an import leaves a plugin alone. */
export type UnchangedReason = 'same' | 'local-only' | 'not-exported'

/** Everything an import of one snapshot would change on this machine. */
export interface ChangeSet {
  changes: Change[]
  unchanged: { name: string; reason: UnchangedReason }[]
  warnings: string[]
}

/** This machine's desktop profile as an import sees it. */
export interface LocalProfile {
  manifest: any
  workspace?: any
  patches?: Record<string, string>
  /** `pnpm-lock.yaml` text. */
  lockfile?: string
  /** Installed versions by package name. */
  versions?: Record<string, string>
  /** `disabled` of the top-level rows in the profile patch, by id. */
  rows?: Record<string, boolean>
  /** `compatibility.json` entries. */
  exemptions?: Record<string, string[]>
  /** Official bundles the installation ships here; absent means every official bundle of the snapshot. */
  official?: string[]
}

/** Inputs of {@link buildChanges}. */
export interface ChangeOptions {
  snapshot: SyncSnapshot
  local: LocalProfile
  /** Last source history; only machineId and plugin names are used. Installer adapters may append name-only records. */
  previous?: SyncSnapshot | undefined
  currentDesktopVersion: string
  /** A plugin cannot remove itself while running; external installers may supply an empty list. */
  protectedPlugins?: readonly string[]
  /** Kit-only replacement of same-version packed contents; App import stays version-based. */
  comparePackedContent?: boolean
}

/** Inputs of {@link createApplyPlan}. */
export interface ApplyPlanOptions extends ChangeOptions {
  /** Ids of the chosen changes. */
  selected: string[]
  acceptRisk?: boolean
  id?: string
  createdAt?: string
}

type SnapshotSource =
  | { kind: 'directory'; path: string }
  | { kind: 'zip'; path: string }
  | { kind: 'git'; repository: string; machine: string; commit?: string }

function run(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function runBuffer(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function parsedVersion(version: string): { core: number[]; pre: string[] | undefined } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) throw new Error(`无效版本号：${version}`)
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') }
}

/**
 * @param have - the version present.
 * @param want - the version compared against.
 * @returns whether `have` is older than, the same as or newer than `want`, by semver precedence.
 */
export function versionOrder(have: string, want: string): VersionOrder {
  const left = parsedVersion(have)
  const right = parsedVersion(want)
  for (let index = 0; index < 3; index++) {
    const difference = left.core[index]! - right.core[index]!
    if (difference !== 0) return difference < 0 ? 'older' : 'newer'
  }
  if (left.pre === undefined || right.pre === undefined) {
    if (left.pre === right.pre) return 'same'
    return left.pre === undefined ? 'newer' : 'older'
  }
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index++) {
    const a = left.pre[index]
    const b = right.pre[index]
    if (a === undefined) return 'older'
    if (b === undefined) return 'newer'
    if (a === b) continue
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) < Number(b) ? 'older' : 'newer'
    if (/^\d+$/.test(a)) return 'older'
    if (/^\d+$/.test(b)) return 'newer'
    return a < b ? 'older' : 'newer'
  }
  return 'same'
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`快照无效：${message}`)
}

function validText(value: unknown): boolean {
  if (value === undefined || typeof value === 'string') return true
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string')
}

/**
 * Checks a snapshot read from a file, an upload or a Git commit.
 * @param value - parsed `snapshot.json`.
 * @returns the snapshot, typed.
 */
export function validateSnapshot(value: unknown): SyncSnapshot {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), '顶层不是对象')
  const snapshot = value as SyncSnapshot
  invariant(snapshot.format === 'dsh-plugin-sync/snapshot-2', `快照格式 ${String(snapshot.format)} 不支持，请在来源机器上更新 dsh-plugin-sync 后重新导出`)
  invariant(typeof snapshot.createdAt === 'string' && typeof snapshot.machine === 'string' && snapshot.machine.length > 0, '缺少创建时间或机器名')
  invariant(typeof snapshot.machineId === 'string' && /^[A-Za-z0-9._-]+$/.test(snapshot.machineId) && !['.', '..'].includes(snapshot.machineId), 'machineId 无效')
  invariant(SYNC_PACKAGE_NAMES.some(name => name === snapshot.exporter?.name) && typeof snapshot.exporter.version === 'string', '导出器信息无效')
  invariant(typeof snapshot.dsh?.desktopVersion === 'string', '缺少桌面端版本')
  parsedVersion(snapshot.dsh.desktopVersion)
  invariant(Array.isArray(snapshot.excluded) && snapshot.excluded.every(name => typeof name === 'string'), '缺少不导出的插件列表')
  const never = new Set(snapshot.excluded.map(packageIdentity))
  const desktop = snapshot.profiles?.desktop
  invariant(desktop !== undefined, '缺少 desktop profile')
  for (const field of ['plugins', 'official', 'bundles', 'rows']) invariant(Array.isArray(desktop[field as keyof typeof desktop]), `desktop.${field} 不是数组`)
  invariant(typeof desktop.lockfile === 'string', '缺少锁文件')
  invariant(desktop.workspace !== null && typeof desktop.workspace === 'object', '缺少 workspace')
  invariant(desktop.patches !== null && typeof desktop.patches === 'object', '缺少 patches')
  invariant(desktop.exemptions !== null && typeof desktop.exemptions === 'object', '缺少 exemptions')
  const names = new Set<string>()
  for (const plugin of desktop.plugins) {
    invariant(typeof plugin.name === 'string' && !never.has(packageIdentity(plugin.name)), `包含不导出的插件 ${plugin.name}`)
    invariant(validText(plugin.title) && validText(plugin.description), `${plugin.name} 的标题或说明无效`)
    invariant(!names.has(plugin.name), `插件重复：${plugin.name}`)
    names.add(plugin.name)
    invariant(typeof plugin.version === 'string' && typeof plugin.spec === 'string', `${plugin.name} 缺少版本或 spec`)
    invariant(!plugin.spec.startsWith('link:'), `${plugin.name} 仍带本机 link: 路径`)
    invariant(['npm', 'github', 'tarball-url', 'packed'].includes(plugin.source), `${plugin.name} 来源无效`)
    invariant(typeof plugin.bundle === 'boolean' && typeof plugin.selected === 'boolean', `${plugin.name} 缺少 bundle 状态`)
    if (plugin.integrity !== undefined) invariant(/^sha512-[A-Za-z0-9+/]+=*$/.test(plugin.integrity), `${plugin.name} integrity 无效`)
    if (plugin.source === 'packed') {
      invariant(typeof plugin.file === 'string' && basename(plugin.file) === plugin.file && plugin.file.endsWith('.tgz'), `${plugin.name} 包文件名无效`)
      invariant(plugin.integrity !== undefined, `${plugin.name} 缺少包 integrity`)
      invariant(plugin.spec === `file:local-plugins/${plugin.file}`, `${plugin.name} 的 spec 不是 local-plugins/ 下的相对路径`)
    }
  }
  for (const official of desktop.official) {
    invariant(typeof official?.name === 'string' && official.name.startsWith('@deepseek-ai/') && !never.has(packageIdentity(official.name)) && !names.has(official.name), `official 条目无效：${official?.name}`)
    invariant(typeof official.enabled === 'boolean' && validText(official.title) && validText(official.description), `${official.name} 的启用状态、标题或说明无效`)
  }
  for (const name of desktop.bundles) invariant(typeof name === 'string' && !never.has(packageIdentity(name)), `bundles 包含不导出的插件 ${name}`)
  assertUniquePackageIdentities([...names, ...desktop.bundles])
  for (const row of desktop.rows) {
    invariant(typeof row.id === 'string' && typeof row.disabled === 'boolean' && typeof row.owner === 'string', 'rows 条目无效')
    invariant(row.name === undefined || typeof row.name === 'string', 'rows.name 无效')
    invariant(validText(row.title), `rows.${row.id} 的标题无效`)
    invariant(!('config' in row), `rows.${row.id} 含有 config`)
    invariant(!never.has(packageIdentity(row.owner)), `rows 包含不导出插件的组件：${row.id}`)
  }
  for (const [key, versions] of Object.entries(desktop.exemptions)) {
    invariant(!never.has(packageIdentity(packageNameFromKey(key))), `exemptions 包含不导出的插件：${key}`)
    invariant(Array.isArray(versions) && versions.every(version => typeof version === 'string'), `exemptions.${key} 无效`)
  }
  for (const [key, path] of Object.entries(desktop.workspace.patchedDependencies ?? {})) {
    invariant(typeof path === 'string' && basename(path) === path.replace(/^patches\//, ''), `patchedDependencies.${key} 路径无效`)
    invariant(!never.has(packageIdentity(packageNameFromKey(key))), `补丁属于不导出的插件：${key}`)
    invariant(typeof desktop.patches[path.replace(/^patches\//, '')] === 'string', `缺少补丁文件：${path}`)
  }
  const lock = parse(desktop.lockfile, { logLevel: 'error' })
  invariant(lock !== null && typeof lock === 'object', '锁文件 YAML 无效')
  invariant(typeof lock.lockfileVersion === 'string', 'lockfileVersion 必须是字符串')
  for (const importer of Object.values(lock.importers ?? {}) as any[]) {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(importer?.[section] ?? {})) invariant(!never.has(packageIdentity(name)), `锁文件包含不导出的插件 ${name}`)
    }
  }
  for (const section of ['packages', 'snapshots']) {
    for (const key of Object.keys(lock[section] ?? {})) invariant(!never.has(packageIdentity(packageNameFromKey(key))), `锁文件包含不导出的插件 ${key}`)
  }
  const lockedNames = Object.values(lock.importers ?? {}).flatMap((importer: any) =>
    ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap(section => Object.keys(importer?.[section] ?? {})))
  assertUniquePackageIdentities([...names, ...desktop.bundles, ...lockedNames,
    ...Object.keys(lock.packages ?? {}).map(packageNameFromKey), ...Object.keys(lock.snapshots ?? {}).map(packageNameFromKey)])
  return snapshot
}

function dependencyVersion(name: string, spec: unknown): string | undefined {
  if (typeof spec !== 'string') return undefined
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) return spec
  const prefix = `${name}@`
  if (spec.startsWith(prefix)) {
    const version = spec.slice(prefix.length)
    if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return version
  }
  return undefined
}

function orderOf(have: string, want: string): VersionOrder | undefined {
  try {
    return versionOrder(have, want)
  } catch {
    // A version outside semver (a Git commit, say) has no order; the change is shown as an upgrade.
    return undefined
  }
}

function sameSource(previous: SyncSnapshot | undefined, snapshot: SyncSnapshot): boolean {
  return previous !== undefined && previous.machineId === snapshot.machineId
}

/**
 * Lists what importing a snapshot would change here, with the default for each change.
 * A plugin missing from the snapshot is offered for uninstalling only when the last snapshot
 * applied from the same machine had it and the source did not leave it out of this export.
 * @param options - snapshot, this machine's profile and the previously applied snapshot.
 * @returns the changes, the plugins left alone with the reason, and warnings.
 */
export function buildChanges(options: ChangeOptions): ChangeSet {
  const snapshot = validateSnapshot(options.snapshot)
  const desktop = snapshot.profiles.desktop
  const { local, currentDesktopVersion } = options
  const order = versionOrder(currentDesktopVersion, snapshot.dsh.desktopVersion)
  if (order === 'older') throw new Error(`本机 App 是 ${currentDesktopVersion}，快照来自 ${snapshot.dsh.desktopVersion}：需要先将本机 App 升级到 ${snapshot.dsh.desktopVersion}`)
  const warnings: string[] = []
  if (order === 'newer') warnings.push(`本机 App（${currentDesktopVersion}）比快照（${snapshot.dsh.desktopVersion}）新，快照中的兼容性豁免不适用于本机`)
  const protectedPlugins = new Set((options.protectedPlugins ?? SYNC_PACKAGE_NAMES).map(packageIdentity))
  const localLock = parse(local.lockfile ?? '', { logLevel: 'error' }) ?? {}
  const dependencies: Record<string, string> = local.manifest.dependencies ?? {}
  const bundles: string[] = local.manifest.dsh?.profile?.bundles ?? []
  assertUniquePackageIdentities([...Object.keys(dependencies), ...bundles])
  const versions = local.versions ?? {}
  const excluded = new Set(snapshot.excluded.map(packageIdentity))
  const snapshotNames = new Set(desktop.plugins.map(plugin => packageIdentity(plugin.name)))
  const previousNames = new Set(sameSource(options.previous, snapshot) ? options.previous!.profiles.desktop.plugins.map(plugin => packageIdentity(plugin.name)) : [])
  const availableOfficial = new Set(local.official ?? desktop.official.map(official => official.name))
  const present = new Set([...Object.keys(dependencies), ...availableOfficial])
  const changes: Change[] = []
  const unchanged: ChangeSet['unchanged'] = []
  for (const plugin of desktop.plugins) {
    const spec = dependencies[plugin.name]
    const alias = packageAlias(plugin.name)
    if (spec === undefined && alias !== undefined && dependencies[alias] !== undefined) {
      const current = versions[alias] ?? dependencyVersion(alias, dependencies[alias])
      const downgrade = current !== undefined && orderOf(current, plugin.version) === 'newer'
      changes.push({ id: `plugin:${plugin.name}`, kind: 'rename', name: plugin.name, owner: plugin.name, replaces: alias,
        from: current ?? dependencies[alias], to: plugin.version, ...(downgrade ? { downgrade: true } : {}), defaultOn: !downgrade })
      present.add(plugin.name)
      continue
    }
    if (spec === undefined) {
      changes.push({ id: `plugin:${plugin.name}`, kind: 'install', name: plugin.name, owner: plugin.name, to: plugin.version, defaultOn: true })
      present.add(plugin.name)
      continue
    }
    const current = versions[plugin.name] ?? dependencyVersion(plugin.name, spec)
    const direction = current === undefined ? undefined : orderOf(current, plugin.version)
    const before = changes.length
    const reference = localLock.importers?.['.']?.dependencies?.[plugin.name]?.version
    // Importer/snapshot references include the peer instance; packages stores
    // the archive metadata under the peer-free reference, including nested peers.
    const packageReference = typeof reference === 'string' ? reference.split('(')[0] : reference
    const packageKey = Object.hasOwn(localLock.packages ?? {}, packageReference) ? packageReference : `${plugin.name}@${packageReference}`
    const packedChanged = options.comparePackedContent === true && plugin.source === 'packed' && (spec !== plugin.spec ||
      String(local.workspace?.overrides?.[plugin.name] ?? '').startsWith('link:') ||
      localLock.packages?.[packageKey]?.resolution?.integrity !== plugin.integrity)
    if (current !== plugin.version || packedChanged) {
      if (direction === 'newer') changes.push({ id: `plugin:${plugin.name}`, kind: 'downgrade', name: plugin.name, owner: plugin.name, from: current!, to: plugin.version, defaultOn: false })
      else changes.push({ id: `plugin:${plugin.name}`, kind: 'upgrade', name: plugin.name, owner: plugin.name, from: current ?? spec, to: plugin.version, defaultOn: true })
    }
    if (plugin.bundle && plugin.selected !== bundles.includes(plugin.name)) {
      changes.push({ id: `bundle:${plugin.name}`, kind: plugin.selected ? 'enable' : 'disable', name: plugin.name, owner: plugin.name, defaultOn: true })
    }
    if (changes.length === before) unchanged.push({ name: plugin.name, reason: 'same' })
  }
  for (const name of Object.keys(dependencies)) {
    const identity = packageIdentity(name)
    if (snapshotNames.has(identity)) continue
    if (excluded.has(identity)) unchanged.push({ name, reason: 'not-exported' })
    else if (!protectedPlugins.has(identity) && previousNames.has(identity)) changes.push({ id: `plugin:${name}`, kind: 'remove', name, owner: name, ...(versions[name] !== undefined ? { from: versions[name] } : {}), defaultOn: true })
    else unchanged.push({ name, reason: 'local-only' })
  }
  for (const official of desktop.official) {
    if (!availableOfficial.has(official.name)) {
      warnings.push(`官方插件 ${official.name} 在本机不可用，已跳过其启用状态`)
      continue
    }
    if (official.enabled === bundles.includes(official.name)) unchanged.push({ name: official.name, reason: 'same' })
    else changes.push({ id: `bundle:${official.name}`, kind: official.enabled ? 'enable' : 'disable', name: official.name, owner: official.name, defaultOn: true })
  }
  for (const name of local.official ?? []) {
    if (desktop.official.some(official => official.name === name) || snapshotNames.has(packageIdentity(name))) continue
    unchanged.push({ name, reason: excluded.has(packageIdentity(name)) ? 'not-exported' : 'local-only' })
  }
  for (const row of desktop.rows) {
    const owner = desktop.plugins.find(plugin => packageIdentity(plugin.name) === packageIdentity(row.owner))?.name ?? row.owner
    if (!present.has(owner)) continue
    const here = local.rows?.[row.id]
    if (here === row.disabled) continue
    changes.push({
      id: `row:${row.id}`,
      kind: 'row',
      name: row.id,
      owner,
      from: here === undefined ? 'default' : here ? 'disabled' : 'enabled',
      to: row.disabled ? 'disabled' : 'enabled',
      ...(row.title !== undefined ? { title: row.title } : {}),
      defaultOn: true,
    })
  }
  for (const [key, keyVersions] of Object.entries(desktop.exemptions)) {
    const name = packageNameFromKey(key)
    const plugin = desktop.plugins.find(entry => entry.name === name)
    if (plugin === undefined || key !== `${name}@${plugin.version}`) continue
    if (local.exemptions?.[key]?.includes(currentDesktopVersion)) continue
    if (!keyVersions.includes(currentDesktopVersion)) {
      warnings.push(`${key} 的兼容性豁免只适用于 DSH ${keyVersions.join('、')}，不适用于本机的 ${currentDesktopVersion}`)
      continue
    }
    changes.push({ id: `exemption:${key}`, kind: 'exemption', name: key, owner: name, to: currentDesktopVersion, defaultOn: false })
  }
  const changedOwners = new Set(changes.map(change => packageIdentity(change.owner)))
  return { changes, unchanged: unchanged.filter(entry => !changedOwners.has(packageIdentity(entry.name))), warnings }
}

async function verifyPackages(snapshot: SyncSnapshot, sourceDir: string): Promise<void> {
  for (const plugin of snapshot.profiles.desktop.plugins) {
    if (plugin.source !== 'packed') continue
    const content = await readFile(join(sourceDir, 'packages', plugin.file!))
    const integrity = `sha512-${createHash('sha512').update(content).digest('base64')}`
    invariant(integrity === plugin.integrity, `${plugin.name} 的包 integrity 不一致`)
  }
}

function validArchiveEntry(entry: string): boolean {
  if (entry.endsWith('/')) return validArchiveEntry(entry.slice(0, -1))
  if (entry === 'snapshot.json' || entry === 'packages') return true
  return entry.startsWith('packages/') && basename(entry) === entry.slice('packages/'.length) && entry.endsWith('.tgz')
}

async function readDirectory(path: string): Promise<{ snapshot: SyncSnapshot; sourceDir: string; cleanup: () => Promise<void> }> {
  const snapshot = validateSnapshot(JSON.parse(await readFile(join(path, 'snapshot.json'), 'utf8')))
  await verifyPackages(snapshot, path)
  return { snapshot, sourceDir: path, cleanup: async () => {} }
}

/**
 * Reads and checks a snapshot from a directory, a zip, or a machine directory in a Git commit.
 * Zip and Git sources are extracted to a temporary directory that `cleanup` removes.
 * @param source - where the snapshot is.
 * @returns the snapshot, the directory holding its `packages/`, and the cleanup.
 */
export async function readSnapshot(source: SnapshotSource): Promise<{ snapshot: SyncSnapshot; sourceDir: string; cleanup: () => Promise<void> }> {
  if (source.kind === 'directory') return readDirectory(source.path)
  if (source.kind === 'zip') {
    const entries = (await run('unzip', ['-Z1', source.path])).split('\n').filter(Boolean)
    for (const entry of entries) {
      invariant(!entry.startsWith('/') && !entry.includes('\\') && !entry.split('/').includes('..') && validArchiveEntry(entry), `zip 含不安全或多余路径：${entry}`)
    }
    invariant(entries.includes('snapshot.json'), 'zip 缺少 snapshot.json')
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-sync-zip-'))
    try {
      await run('ditto', ['-x', '-k', source.path, root])
      const result = await readDirectory(root)
      return { ...result, cleanup: async () => { await rm(root, { recursive: true, force: true }) } }
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }
  const machine = source.machine.replace(/[^A-Za-z0-9._-]/g, '-')
  invariant(machine !== '' && machine !== '.' && machine !== '..', '机器名无效')
  const commit = source.commit ?? (await run('git', ['-C', source.repository, 'rev-parse', 'HEAD'])).trim()
  invariant(/^[0-9a-f]{40}$/.test(commit), 'Git 提交号无效')
  const path = `machines/${machine}`
  const entries = (await run('git', ['-C', source.repository, 'ls-tree', '-r', '--name-only', commit, '--', path])).split('\n').filter(Boolean)
  invariant(entries.includes(`${path}/snapshot.json`), 'Git 提交缺少 snapshot.json')
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-sync-git-'))
  try {
    for (const entry of entries) {
      const relative = entry.slice(path.length + 1)
      invariant(validArchiveEntry(relative), `Git 快照含不安全或多余路径：${entry}`)
      const destination = join(root, relative)
      await mkdir(join(destination, '..'), { recursive: true })
      await writeFile(destination, await runBuffer('git', ['-C', source.repository, 'show', `${commit}:${entry}`]), { mode: 0o600 })
    }
    const result = await readDirectory(root)
    return { ...result, cleanup: async () => { await rm(root, { recursive: true, force: true }) } }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

function closure(lockfile: string | undefined, roots: Set<string>): Set<string> {
  const needed = new Set(roots)
  if (lockfile === undefined) return needed
  const lock = parse(lockfile, { logLevel: 'error' }) ?? {}
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.shift()!
    for (const [key, snapshot] of Object.entries(lock.snapshots ?? {}) as [string, any][]) {
      if (packageNameFromKey(key) !== name) continue
      for (const dependency of Object.keys({ ...snapshot?.dependencies, ...snapshot?.optionalDependencies })) {
        if (!needed.has(dependency)) {
          needed.add(dependency)
          queue.push(dependency)
        }
      }
    }
  }
  return needed
}

const PATCH_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** Follow only the lockfile instances selected by importer and dependency references.
 * An incomplete graph must never justify removing an untouched plugin's patch.
 */
function patchClosure(lockfile: string | undefined, roots: Set<string>): { instances: Set<string>; complete: boolean } {
  const instances = new Set<string>(), visited = new Set<string>()
  if (roots.size === 0) return { instances, complete: true }
  if (lockfile === undefined) return { instances, complete: false }
  const lock = parse(lockfile, { logLevel: 'error' }) ?? {}
  const snapshots = lock.snapshots ?? {}
  const importer = lock.importers?.['.'] ?? {}
  const rootRefs = { ...importer.devDependencies, ...importer.optionalDependencies, ...importer.dependencies }
  const queue: [string, unknown][] = [...roots].map(name => [name, rootRefs[name]?.version])
  let complete = true
  while (queue.length > 0) {
    const [name, ref] = queue.shift()!
    if (typeof ref !== 'string') { complete = false; continue }
    // Linked packages keep their own dependencies outside this profile lockfile.
    if (ref.startsWith('link:')) continue
    const key = Object.hasOwn(snapshots, `${name}@${ref}`) ? `${name}@${ref}` : ref
    if (!Object.hasOwn(snapshots, key)) { complete = false; continue }
    if (visited.has(key)) continue
    visited.add(key)
    const packageKey = key.split('(')[0]!
    const packageName = packageNameFromKey(packageKey)
    const reference = packageKey.slice(packageName.length + 1)
    const version = PATCH_VERSION.test(reference) ? reference : lock.packages?.[packageKey]?.version
    if (typeof version !== 'string' || !PATCH_VERSION.test(version)) complete = false
    else instances.add(`${packageName}@${version}`)
    const entry = snapshots[key]
    for (const [dependency, version] of Object.entries({ ...entry?.dependencies, ...entry?.optionalDependencies })) {
      queue.push([dependency, version])
    }
  }
  return { instances, complete }
}

function usesPatch(tree: ReturnType<typeof patchClosure>, selector: string): boolean {
  const name = packageNameFromKey(selector)
  const version = selector.slice(name.length + 1)
  // Exact-version patches apply across peer/patch-hash variants. Other selectors
  // are conservatively treated as applying to all encountered versions of a name.
  const exact = PATCH_VERSION.test(version)
  return [...tree.instances].some(key => packageNameFromKey(key) === name && (!exact || key === selector))
}

/** Use the same patch closure when unchanged peers are borrowed for package resolution. */
export function peerContextPatches(lockfile: string, names: string[], patches: Record<string, string>): Record<string, string> {
  if (!Object.keys(patches).length || !names.length) return {}
  const tree = patchClosure(lockfile, new Set(names))
  invariant(tree.complete, '未选 peer 的锁文件引用不完整，不能安全解析补丁')
  return Object.fromEntries(Object.entries(patches).filter(([selector]) => usesPatch(tree, selector)))
}

/**
 * @param snapshot - the snapshot being imported.
 * @param local - this machine's profile.
 * @param plugins - plugins the import installs or changes.
 * @returns the dependencies in those plugins' trees whose install scripts the import would newly allow, sorted.
 */
export function newBuildPermissions(snapshot: SyncSnapshot, local: LocalProfile, plugins: Iterable<string>): string[] {
  const before = local.workspace?.allowBuilds ?? {}
  const tree = closure(snapshot.profiles.desktop.lockfile, new Set(plugins))
  return Object.entries(snapshot.profiles.desktop.workspace.allowBuilds ?? {})
    .filter(([name, value]) => value === true && before[name] !== true && tree.has(name))
    .map(([name]) => name)
    .sort()
}

function withinTree(entries: unknown, tree: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries ?? {}).filter(([key]) => tree.has(packageNameFromKey(key))))
}

/**
 * Keeps this machine's patches for everything the import leaves alone, and takes the snapshot's
 * patches, build permissions and overrides only for the dependency trees of the plugins it installs or changes.
 */
function plannedWorkspace(local: LocalProfile, snapshot: SyncSnapshot, changed: Set<string>, removed: Set<string>, deferred: Set<string>, untouched: string[]): { workspace: any; patches: Record<string, string>; snapshotPatchedDependencies: Record<string, string>; warnings: string[] } {
  const desktop = snapshot.profiles.desktop
  const incoming = closure(desktop.lockfile, changed)
  const currentEntries = Object.entries(local.workspace?.patchedDependencies ?? {}) as [string, string][]
  const sourceEntries = Object.entries(desktop.workspace.patchedDependencies ?? {}) as [string, string][]
  const hasPatches = currentEntries.length > 0 || sourceEntries.length > 0
  const localImporter = parse(local.lockfile ?? '', { logLevel: 'error' })?.importers?.['.'] ?? {}
  const localRoots = { ...localImporter.devDependencies, ...localImporter.optionalDependencies, ...localImporter.dependencies }
  const leaving = patchClosure(local.lockfile, hasPatches ? new Set([...changed, ...removed].filter(name => Object.hasOwn(localRoots, name))) : new Set())
  const retained = patchClosure(local.lockfile, hasPatches ? new Set(Object.keys(local.manifest.dependencies ?? {}).filter(name => !changed.has(name) && !removed.has(name))) : new Set())
  const arrivingRoots = sourceEntries.length > 0 ? new Set([...changed].filter(name => !deferred.has(name))) : new Set<string>()
  const arriving = patchClosure(desktop.lockfile, arrivingRoots)
  if (!arriving.complete) {
    const unresolved = [...arrivingRoots].filter(name => !patchClosure(desktop.lockfile, new Set([name])).complete)
    throw new Error(`无法确认插件 ${unresolved.join('、')} 的锁文件依赖引用，不能安全选择补丁`)
  }
  const kept = currentEntries.filter(([key]) => !usesPatch(leaving, key) || !retained.complete || usesPatch(retained, key))
  const deferredPatches = new Set(desktop.plugins.filter(plugin => deferred.has(plugin.name)).map(plugin => `${plugin.name}@${plugin.version}`))
  const incomingPatched = sourceEntries.filter(([key]) => usesPatch(arriving, key) || deferredPatches.has(key))
  const warnings: string[] = []
  for (const [key] of incomingPatched) {
    const name = packageNameFromKey(key)
    // Name-only selectors apply to every version; ranges need exact semver
    // matching before we can claim that an untouched dependency is affected.
    if ((key !== name && !PATCH_VERSION.test(key.slice(name.length + 1))) || currentEntries.some(([existing]) => existing === key)) continue
    const affected = untouched.filter(name => usesPatch(patchClosure(local.lockfile, new Set([name])), key))
    if (affected.length > 0) warnings.push(`依赖 ${key} 的补丁也会应用于未选择的插件 ${affected.join('、')}`)
  }
  const keptPaths = new Map(kept)
  for (const [key, path] of incomingPatched) {
    const existing = keptPaths.get(key)
    if (existing !== undefined) {
      const content = local.patches?.[basename(existing)]
      invariant(content !== undefined && content === desktop.patches[basename(path)], `共享依赖 ${key} 的补丁内容冲突，不能修改未选插件使用的补丁`)
    }
  }
  const patchedDependencies = Object.fromEntries([...kept, ...incomingPatched])
  const keptFiles = new Set(kept.map(([, path]) => basename(path)))
  const incomingFiles = new Set(incomingPatched.map(([, path]) => basename(path)))
  for (const file of incomingFiles) {
    if (keptFiles.has(file)) invariant(local.patches?.[file] === desktop.patches[file], `补丁文件 ${file} 内容冲突，不能覆盖未选插件使用的补丁`)
  }
  const patches = Object.fromEntries([
    ...Object.entries(local.patches ?? {}).filter(([file]) => keptFiles.has(file)),
    ...Object.entries(desktop.patches).filter(([file]) => incomingFiles.has(file)),
  ])
  return {
    workspace: {
      ...(local.workspace ?? { packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false }),
      patchedDependencies,
      allowBuilds: Object.assign({}, local.workspace?.allowBuilds, withinTree(desktop.workspace.allowBuilds, incoming)),
      overrides: Object.assign({}, Object.fromEntries(Object.entries(local.workspace?.overrides ?? {}).filter(([key, spec]) =>
        !(typeof spec === 'string' && spec.startsWith('link:') && (removed.has(key) ||
          (changed.has(key) && desktop.plugins.some(plugin => plugin.name === key && plugin.source === 'packed')))))),
      withinTree(desktop.workspace.overrides, incoming)),
    },
    patches,
    snapshotPatchedDependencies: Object.fromEntries(incomingPatched),
    warnings,
  }
}

function insertInOrder(list: string[], name: string, order: string[]): string[] {
  if (list.includes(name)) return list
  const index = order.indexOf(name)
  if (index < 0) return [...list, name]
  for (let previous = index - 1; previous >= 0; previous--) {
    const position = list.indexOf(order[previous]!)
    if (position >= 0) return [...list.slice(0, position + 1), name, ...list.slice(position + 1)]
  }
  for (let next = index + 1; next < order.length; next++) {
    const position = list.indexOf(order[next]!)
    if (position >= 0) return [...list.slice(0, position), name, ...list.slice(position)]
  }
  return [...list, name]
}

/**
 * Turns the chosen changes into the staged plan the apply process executes. Dependencies and
 * bundles start from this machine's lists, so plugins outside the chosen changes keep their specs
 * and positions; the plan names them in `untouched` for the apply process to check again.
 * @param options - the {@link buildChanges} inputs plus the chosen change ids.
 * @returns the plan.
 */
export async function createApplyPlan(options: ApplyPlanOptions): Promise<any> {
  const set = buildChanges(options)
  const snapshot = options.snapshot
  const desktop = snapshot.profiles.desktop
  const byId = new Map(set.changes.map(change => [change.id, change]))
  const chosen: Change[] = []
  for (const id of new Set(options.selected)) {
    const change = byId.get(id)
    if (change === undefined) throw new Error(`选择了不存在的变更：${id}`)
    chosen.push(change)
  }
  if (chosen.some(change => change.kind === 'exemption') && options.acceptRisk !== true) throw new Error('应用兼容性豁免前必须确认不兼容的插件可能导致崩溃或数据丢失')
  const local = options.local
  const currentDependencies: Record<string, string> = local.manifest.dependencies ?? {}
  const dependencies: Record<string, string> = { ...currentDependencies }
  const pluginByName = new Map(desktop.plugins.map(plugin => [plugin.name, plugin]))
  const changed = new Set<string>()
  const removed = new Set<string>()
  for (const change of chosen) {
    if (change.kind === 'install' || change.kind === 'rename' || change.kind === 'upgrade' || change.kind === 'downgrade') {
      const plugin = pluginByName.get(change.name)!
      if (change.kind === 'rename') {
        delete dependencies[change.replaces!]
        removed.add(change.replaces!)
      }
      dependencies[change.name] = plugin.source === 'npm' ? plugin.version : plugin.spec
      changed.add(change.name)
    } else if (change.kind === 'remove') {
      delete dependencies[change.name]
      removed.add(change.name)
    }
  }
  const renames = new Map(chosen.filter(change => change.kind === 'rename').map(change => [change.replaces!, change.name]))
  let bundles = ((local.manifest.dsh?.profile?.bundles ?? []) as string[]).flatMap(name => {
    const target = renames.get(name)
    if (target === undefined) return removed.has(name) ? [] : [name]
    const plugin = pluginByName.get(target)!
    return plugin.bundle && plugin.selected ? [target] : []
  })
  for (const change of chosen) {
    if (change.kind === 'enable') bundles = insertInOrder(bundles, change.name, desktop.bundles)
    else if (change.kind === 'disable') bundles = bundles.filter(name => name !== change.name)
    else if (change.kind === 'install' || change.kind === 'rename') {
      const plugin = pluginByName.get(change.name)!
      if (plugin.bundle && plugin.selected) bundles = insertInOrder(bundles, change.name, desktop.bundles)
    }
  }
  const official = new Set(options.local.official ?? desktop.official.map(entry => entry.name))
  const rows = chosen
    .filter(change => change.kind === 'row' && (dependencies[change.owner] !== undefined || official.has(change.owner)))
    .map(change => ({ id: change.name, disabled: change.to === 'disabled', owner: change.owner }))
  const exemptions: Record<string, string[]> = {}
  for (const change of chosen) {
    if (change.kind === 'exemption' && dependencies[packageNameFromKey(change.name)] !== undefined) exemptions[change.name] = [options.currentDesktopVersion]
  }
  const plugins: SnapshotPlugin[] = [...changed].map(name => pluginByName.get(name)!)
  const packages = plugins.filter(plugin => plugin.source === 'packed').map(plugin => ({ name: plugin.name, file: plugin.file, integrity: plugin.integrity }))
  const lockDependencies = parse(desktop.lockfile, { logLevel: 'error' })?.importers?.['.']?.dependencies ?? {}
  const deferred = new Set(packages.filter(entry => lockDependencies[entry.name] === undefined).map(entry => entry.name))
  assertUniquePackageIdentities([...Object.keys(dependencies), ...bundles])
  const untouched = [...new Set([...Object.keys(currentDependencies), ...(local.manifest.dsh?.profile?.bundles ?? [])])].filter(name => !chosen.some(change => packageIdentity(change.owner) === packageIdentity(name))).sort()
  const { workspace, patches, snapshotPatchedDependencies, warnings } = plannedWorkspace(local, snapshot, changed, removed, deferred, untouched)
  const installed = Object.entries(dependencies).filter(([name]) => !deferred.has(name))
  const frozen = installed.length === Object.keys(lockDependencies).length && installed.every(([name, spec]) => lockDependencies[name]?.specifier === spec)
  return {
    format: 'dsh-plugin-sync/plan-1',
    id: options.id ?? randomUUID(),
    createdAt: options.createdAt ?? new Date().toISOString(),
    sourceSnapshot: { createdAt: snapshot.createdAt, machine: snapshot.machine, ...(snapshot.machineId !== undefined ? { machineId: snapshot.machineId } : {}), desktopVersion: snapshot.dsh.desktopVersion },
    currentDesktopVersion: options.currentDesktopVersion,
    baseProfile: { manifest: local.manifest, workspace: local.workspace ?? null, lockfile: local.lockfile ?? null },
    warnings: [...set.warnings, ...warnings],
    newBuildPermissions: newBuildPermissions(snapshot, local, changed),
    changes: chosen,
    manifest: { ...local.manifest, dependencies, dsh: { ...local.manifest.dsh, profile: { ...local.manifest.dsh?.profile, bundles } } },
    workspaceYaml: stringify(workspace),
    lockfile: desktop.lockfile,
    patches,
    snapshotPatchedDependencies,
    plugins,
    removed: [...removed],
    packages,
    rows,
    exemptions,
    frozen,
    untouched,
  }
}
