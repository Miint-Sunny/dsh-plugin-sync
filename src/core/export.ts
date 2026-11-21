import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { manifestCatalog, rowOwner } from './catalog.js'
import type { Catalog } from './catalog.js'
import { assertUniquePackageIdentities, packageIdentity } from './package-names.js'
import { collectSecretValues, secretScanHits } from './secrets.js'
import type { PackedResult, Packer, SnapshotOfficial, SnapshotPlugin, SnapshotRow, SyncSnapshot } from './types.js'
import { packageNameFromKey } from './util.js'

const DEFAULT_APP = '/Applications/DeepSeek Harness.app'

interface ExportOptions {
  profileDir: string
  outputDir: string
  /** Display name of the exporting machine. */
  machine: string
  /** Stable directory name of the exporting machine in a Git repository. */
  machineId: string
  desktopVersion: string
  createdAt?: string
  /** Plugins to leave out, third-party or official. */
  excluded?: string[]
  /** This machine's plugins and row ownership; defaults to {@link manifestCatalog}. */
  catalog?: Catalog
  packer?: Packer
}

function run(command: string, args: string[], cwd?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

async function jsonFile(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf8'))
}

function yamlFile(text: string): any {
  return parse(text, { logLevel: 'error' })
}

function resolveLinked(profileDir: string, spec: string): string {
  const value = spec.slice('link:'.length)
  return value.startsWith('~') ? resolve(homedir(), value.slice(2)) : resolve(profileDir, value)
}

function safePackageFile(name: string, version: string): string {
  const stem = `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}`.replace(/[^A-Za-z0-9._-]/g, '-')
  return `${stem}.tgz`
}

async function sha512(path: string): Promise<string> {
  return `sha512-${createHash('sha512').update(await readFile(path)).digest('base64')}`
}

export async function tarManifest(path: string): Promise<any> {
  return JSON.parse(await run('tar', ['-xOf', path, 'package/package.json']))
}

async function defaultPacker(sourceDir: string, destinationDir: string): Promise<PackedResult> {
  const source = await realpath(sourceDir)
  const root = (await run('git', ['-C', source, 'rev-parse', '--show-toplevel'])).trim()
  if (await realpath(root) !== source) throw new Error(`link: 插件必须指向 Git 仓库根目录：${source}`)
  if ((await run('git', ['-C', source, 'status', '--porcelain'])).trim() !== '') {
    throw new Error(`本地仓库有未提交的更改，无法导出：${source}`)
  }
  const commit = (await run('git', ['-C', source, 'rev-parse', 'HEAD'])).trim()
  const app = process.env.DSH_APP ?? DEFAULT_APP
  const node = join(app, 'Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node')
  const pnpm = join(app, 'Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
  const env: NodeJS.ProcessEnv = { ...process.env, npm_config_update_notifier: 'false', npm_config_ignore_scripts: 'true' }
  delete env.DEEPSEEK_API_KEY
  delete env.DEEPSEC_SCOPE_SIGNING_KEY
  const output = await run(node, [pnpm, 'pack', '--pack-destination', destinationDir, '--config.ignore-scripts=true', '--json'], source, env)
  const parsed = JSON.parse(output)
  const result = Array.isArray(parsed) ? parsed[0] : parsed
  if (typeof result?.filename !== 'string') throw new Error('pnpm pack 没有返回包文件名')
  return { file: basename(result.filename), commit }
}

function lockedDependency(lock: any, name: string): { specifier?: string; version?: string } {
  for (const importer of Object.values(lock.importers ?? {}) as any[]) {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const dependency = importer?.[section]?.[name]
      if (dependency !== undefined) return dependency
    }
  }
  return {}
}

function lockIntegrity(lock: any, name: string, version: string): string | undefined {
  for (const [key, value] of Object.entries(lock.packages ?? {}) as [string, any][]) {
    if (packageNameFromKey(key) === name && key.slice(name.length + 1).replace(/\(.*\)$/, '') === version) {
      const integrity = value?.resolution?.integrity
      if (typeof integrity === 'string') return integrity
    }
  }
  return undefined
}

function cleanLock(lock: any, removed: Set<string>, linked: Set<string>): string {
  const blockedNames = new Set([...removed, ...linked].map(packageIdentity))
  if (lock.lockfileVersion === 9 || lock.lockfileVersion === '9') lock.lockfileVersion = '9.0'
  else if (typeof lock.lockfileVersion !== 'string') throw new Error('lockfileVersion 必须是字符串')
  for (const importer of Object.values(lock.importers ?? {}) as any[]) {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(importer?.[section] ?? {})) {
        if (blockedNames.has(packageIdentity(name))) delete importer[section][name]
      }
    }
  }
  const owned = (key: string) => {
    return blockedNames.has(packageIdentity(packageNameFromKey(key)))
  }
  for (const [key, snapshot] of Object.entries(lock.snapshots ?? {}) as [string, any][]) {
    if (owned(key)) continue
    const dependencies = { ...snapshot?.dependencies, ...snapshot?.optionalDependencies }
    const blocked = Object.keys(dependencies).find(name => blockedNames.has(packageIdentity(name)))
    if (blocked !== undefined) throw new Error(`${key} 依赖被过滤的 ${blocked}，无法生成一致锁文件`)
  }
  for (const section of ['packages', 'snapshots']) {
    for (const key of Object.keys(lock[section] ?? {})) if (owned(key)) delete lock[section][key]
  }
  return stringify(lock)
}

function withoutSharedMcp(text: string): string {
  return text.replace(/^[ \t]*# BEGIN macos-shared-mcp\s*$[\s\S]*?^[ \t]*# END macos-shared-mcp\s*$/gm, '')
}

/**
 * Collects the component switches of the profile patch: top-level entries with a boolean `disabled`,
 * reduced to `{ id, disabled }`. Entries the profile inserts itself carry machine-specific config and
 * stay out, as does the shared MCP block. A switch is exported only when a bundle of an exported
 * plugin declares the row; switches of unknown rows stay on this machine.
 */
function componentRows(text: string, catalog: Catalog, candidates: string[], exported: Set<string>): SnapshotRow[] {
  const parsed = yamlFile(withoutSharedMcp(text)) ?? []
  if (!Array.isArray(parsed)) throw new Error('cordis.patch.yml 不是 YAML 数组')
  const rows: SnapshotRow[] = []
  for (const entry of parsed) {
    if (typeof entry?.id !== 'string' || typeof entry.disabled !== 'boolean' || entry.insert !== undefined) continue
    const name = typeof entry.name === 'string' ? entry.name : undefined
    const owner = rowOwner({ id: entry.id, name }, catalog, candidates)
    if (owner === undefined || !exported.has(owner)) continue
    const title = catalog.rowTitles.get(entry.id)
    rows.push({ id: entry.id, ...(name !== undefined ? { name } : {}), disabled: entry.disabled, owner, ...(title !== undefined ? { title } : {}) })
  }
  return rows
}

async function workspaceSnapshot(profileDir: string, included: Set<string>, needed: Set<string>): Promise<{ workspace: any; patches: Record<string, string> }> {
  let source: any = {}
  try {
    source = yamlFile(await readFile(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')) ?? {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const patchedDependencies: Record<string, string> = {}
  const patches: Record<string, string> = {}
  for (const [key, path] of Object.entries(source.patchedDependencies ?? {})) {
    const name = packageNameFromKey(key)
    if (!included.has(name) && !needed.has(name) || typeof path !== 'string') continue
    const absolute = resolve(profileDir, path)
    const patchesRoot = resolve(profileDir, 'patches')
    if (dirname(absolute) !== patchesRoot) throw new Error(`补丁必须直接位于 profile 的 patches/ 下：${path}`)
    const file = basename(path)
    if (patches[file] !== undefined) throw new Error(`补丁文件名重复：${file}`)
    patchedDependencies[key] = `patches/${file}`
    patches[file] = await readFile(absolute, 'utf8')
  }
  const declared = Object.keys((await jsonFile(join(profileDir, 'package.json'))).dependencies ?? {})
  const removed = new Set(declared.filter(name => !included.has(name)).map(packageIdentity))
  const allowBuilds = Object.fromEntries(Object.entries(source.allowBuilds ?? {}).filter(([name]) => !removed.has(packageIdentity(name))))
  const overrides = Object.fromEntries(Object.entries(source.overrides ?? {}).filter(([name]) => !removed.has(packageIdentity(packageNameFromKey(name)))))
  return { workspace: { patchedDependencies, allowBuilds, overrides }, patches }
}

async function exporterManifest(): Promise<{ name: string; version: string }> {
  const manifest = await jsonFile(fileURLToPath(new URL('../../package.json', import.meta.url)))
  return { name: manifest.name, version: manifest.version }
}

export async function exportSnapshot(options: ExportOptions): Promise<{ snapshot: SyncSnapshot; snapshotDir: string }> {
  const { profileDir, outputDir } = options
  const existing = await readdir(outputDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  if (existing.length > 0) throw new Error(`输出目录不是空目录：${outputDir}`)
  await mkdir(join(outputDir, 'packages'), { recursive: true })
  try {
    const manifest = await jsonFile(join(profileDir, 'package.json'))
    const dependencies = Object.entries(manifest.dependencies ?? {}) as [string, string][]
    const catalog = options.catalog ?? manifestCatalog(manifest)
    const requested = new Set((options.excluded ?? []).map(packageIdentity))
    const present = new Set([...dependencies.map(([name]) => name), ...catalog.plugins.map(plugin => plugin.name)])
    assertUniquePackageIdentities([...present, ...(manifest.dsh?.profile?.bundles ?? [])])
    const excluded = [...present].filter(name => requested.has(packageIdentity(name))).sort()
    const never = new Set(excluded)
    const included = new Set(dependencies.map(([name]) => name).filter(name => !never.has(name)))
    const info = new Map(catalog.plugins.map(plugin => [plugin.name, plugin]))
    const display = (name: string) => {
      const plugin = info.get(name)
      return { ...(plugin?.title !== undefined ? { title: plugin.title } : {}), ...(plugin?.description !== undefined ? { description: plugin.description } : {}) }
    }
    const official: SnapshotOfficial[] = catalog.plugins
      .filter(plugin => plugin.group === 'official' && !plugin.installed && !never.has(plugin.name))
      .map(plugin => ({ name: plugin.name, enabled: plugin.enabled, ...display(plugin.name) }))
    const localPlugins = await realpath(join(profileDir, 'local-plugins')).catch(() => resolve(profileDir, 'local-plugins'))
    const lock = yamlFile(await readFile(join(profileDir, 'pnpm-lock.yaml'), 'utf8'))
    const originalBundles = (manifest.dsh?.profile?.bundles ?? []) as string[]
    const plugins: SnapshotPlugin[] = []
    const linked = new Set<string>()
    const packer = options.packer ?? defaultPacker
    for (const [name, spec] of dependencies) {
      if (!included.has(name)) continue
      const locked = lockedDependency(lock, name)
      const base = { name, bundle: originalBundles.includes(name), selected: originalBundles.includes(name), ...(info.get(name)?.group === 'official' ? { official: true } : {}), ...display(name) }
      if (spec.startsWith('link:')) {
        const sourceDir = resolveLinked(profileDir, spec)
        const sourceManifest = await jsonFile(join(sourceDir, 'package.json'))
        if (sourceManifest.name !== name) throw new Error(`link: 目录包名不符：${sourceManifest.name} ≠ ${name}`)
        const packed = await packer(sourceDir, join(outputDir, 'packages'))
        if (basename(packed.file) !== packed.file || packed.commit === undefined) throw new Error(`打包 ${name} 时未取得安全的文件名和提交号`)
        const file = safePackageFile(name, sourceManifest.version)
        if (packed.file !== file) {
          await copyFile(join(outputDir, 'packages', packed.file), join(outputDir, 'packages', file))
          await rm(join(outputDir, 'packages', packed.file))
        }
        plugins.push({ ...base, version: sourceManifest.version, spec: `file:local-plugins/${file}`, source: 'packed', integrity: await sha512(join(outputDir, 'packages', file)), file, commit: packed.commit })
        linked.add(name)
        continue
      }
      if (spec.startsWith('file:')) {
        const source = resolve(profileDir, spec.slice('file:'.length))
        const sourceParent = await realpath(dirname(source)).catch(() => dirname(source))
        if (sourceParent !== localPlugins || !source.endsWith('.tgz')) throw new Error(`只允许 profile 内 local-plugins/ 下的 tgz 作为 file: 依赖：${name}`)
        const sourceManifest = await tarManifest(source)
        if (sourceManifest.name !== name) throw new Error(`file: 包名不符：${sourceManifest.name} ≠ ${name}`)
        const file = basename(source)
        const relativeSpec = `file:local-plugins/${file}`
        await copyFile(source, join(outputDir, 'packages', file))
        plugins.push({ ...base, version: sourceManifest.version, spec: relativeSpec, source: 'packed', integrity: await sha512(source), file })
        // An absolute path in the lockfile names this machine's home; the receiver installs it after the frozen install, like a link: plugin.
        if (spec !== relativeSpec) linked.add(name)
        continue
      }
      const installedManifest = await jsonFile(join(profileDir, 'node_modules', name, 'package.json')).catch(() => undefined)
      const version = typeof locked.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\(.*\))?$/.test(locked.version)
        ? locked.version.replace(/\(.*\)$/, '')
        : installedManifest?.version
      if (typeof version !== 'string') throw new Error(`锁文件和安装目录都未取得 ${name} 的版本`)
      const integrity = lockIntegrity(lock, name, version)
      if (spec.startsWith('github:')) {
        const commit = /#([0-9a-f]{40})(?:$|\/)/.exec(spec)?.[1] ?? /tar\.gz\/([0-9a-f]{40})/.exec(String(locked.version))?.[1]
        plugins.push({ ...base, bundle: base.bundle || installedManifest?.dsh?.bundle?.patch !== undefined, version, spec, source: 'github', ...(integrity !== undefined ? { integrity } : {}), ...(commit !== undefined ? { commit } : {}) })
      } else if (/^https?:\/\//.test(spec)) {
        plugins.push({ ...base, bundle: base.bundle || installedManifest?.dsh?.bundle?.patch !== undefined, version, spec, source: 'tarball-url', ...(integrity !== undefined ? { integrity } : {}) })
      } else {
        plugins.push({ ...base, bundle: base.bundle || installedManifest?.dsh?.bundle?.patch !== undefined, version, spec: `${name}@${version}`, source: 'npm', ...(integrity !== undefined ? { integrity } : {}) })
      }
    }
    const removed = new Set(dependencies.map(([name]) => name).filter(name => !included.has(name)))
    const rowsText = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '[]\n'
      throw error
    })
    const cleanedLock = yamlFile(cleanLock(lock, removed, linked))
    const needed = new Set(Object.keys(cleanedLock.packages ?? {}).map(packageNameFromKey))
    assertUniquePackageIdentities([...included, ...needed, ...Object.keys(cleanedLock.snapshots ?? {}).map(packageNameFromKey)])
    const { workspace, patches } = await workspaceSnapshot(profileDir, included, needed)
    cleanedLock.patchedDependencies = Object.fromEntries(Object.entries(cleanedLock.patchedDependencies ?? {}).filter(([key]) => workspace.patchedDependencies[key] !== undefined))
    if (Object.keys(cleanedLock.patchedDependencies).length === 0) delete cleanedLock.patchedDependencies
    const lockfile = stringify(cleanedLock)
    const compatibility = await jsonFile(join(profileDir, 'compatibility.json')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return {}
      throw error
    })
    const exemptions = Object.fromEntries(Object.entries(compatibility).filter(([key, versions]) => {
      const name = packageNameFromKey(key)
      const plugin = plugins.find(entry => entry.name === name)
      return included.has(name) && key === `${name}@${plugin?.version}` && Array.isArray(versions) && versions.every(version => typeof version === 'string')
    })) as Record<string, string[]>
    const exported = new Set([...included, ...official.map(plugin => plugin.name)])
    const candidates = [...new Set([...present, ...originalBundles])]
    const snapshot: SyncSnapshot = {
      format: 'dsh-plugin-sync/snapshot-2',
      createdAt: options.createdAt ?? new Date().toISOString(),
      machine: options.machine,
      machineId: options.machineId,
      exporter: await exporterManifest(),
      dsh: { desktopVersion: options.desktopVersion },
      profiles: {
        desktop: {
          plugins,
          official,
          bundles: originalBundles.filter(name => !never.has(name)),
          rows: componentRows(rowsText, catalog, candidates, exported),
          exemptions,
          workspace,
          patches,
          lockfile,
        },
      },
      excluded,
    }
    await writeFile(join(outputDir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
    const secrets = collectSecretValues(yamlFile(rowsText))
    const hits = await secretScanHits(outputDir, secrets)
    if (hits.length > 0) throw new Error(`密钥扫描阻止导出：${hits.map(hit => `${hit.file} (${hit.count})`).join(', ')}`)
    return { snapshot, snapshotDir: outputDir }
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true })
    throw error
  }
}

export async function writeZip(snapshotDir: string, outputFile: string): Promise<void> {
  await mkdir(dirname(outputFile), { recursive: true })
  await run('ditto', ['-c', '-k', '--norsrc', '.', outputFile], snapshotDir)
}

/**
 * @param value - a host name or machine id.
 * @returns the machine's directory name under `machines/` in a Git repository.
 */
export function machineDirectory(value: string): string {
  const directory = value.replace(/\.local$/, '').replace(/[^A-Za-z0-9._-]/g, '-')
  if (directory === '' || directory === '.' || directory === '..') throw new Error('机器标识无法用作 Git 目录')
  return directory
}

/**
 * Replaces `machines/<machineId>/` in a Git working copy with the snapshot and commits it.
 * @param snapshotDir - exported snapshot directory.
 * @param repository - working copy root.
 * @param machineId - the exporting machine's directory name.
 * @param options - `cleanupOnCommitFailure` restores the machine directory of a clone this plugin owns when the commit fails.
 * @returns the new commit.
 */
export async function commitSnapshot(snapshotDir: string, repository: string, machineId: string, options: { cleanupOnCommitFailure?: boolean } = {}): Promise<string> {
  const root = await realpath((await run('git', ['-C', repository, 'rev-parse', '--show-toplevel'])).trim())
  if (root !== await realpath(repository)) throw new Error('Git 导出目标是仓库的子目录，请传仓库根目录')
  if ((await run('git', ['-C', root, 'status', '--porcelain'])).trim() !== '') throw new Error('Git 导出工作区有未提交改动，拒绝覆盖')
  const path = `machines/${machineDirectory(machineId)}`
  const target = join(root, path)
  const snapshot = await jsonFile(join(snapshotDir, 'snapshot.json')) as SyncSnapshot
  let previous: SyncSnapshot | undefined
  try {
    previous = JSON.parse(await run('git', ['-C', root, 'show', `HEAD:${path}/snapshot.json`]))
  } catch {}
  if (previous === undefined && await readdir(target).catch(() => []).then(files => files.length > 0)) {
    throw new Error(`目标目录存在但不是已跟踪快照，拒绝覆盖：${target}`)
  }
  await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await run('cp', ['-R', snapshotDir, target])
  const oldPlugins = new Map(previous?.profiles.desktop.plugins.map(plugin => [plugin.name, plugin.version]) ?? [])
  const changes = snapshot.profiles.desktop.plugins.map(plugin => {
    const before = oldPlugins.get(plugin.name)
    oldPlugins.delete(plugin.name)
    return before === undefined ? `+${plugin.name}` : before === plugin.version ? plugin.name : `~${plugin.name}`
  })
  changes.push(...[...oldPlugins.keys()].map(name => `-${name}`))
  await run('git', ['-C', root, 'add', '--', path])
  try {
    await run('git', ['-C', root, '-c', 'user.name=dsh-plugin-sync', '-c', 'user.email=dsh-plugin-sync@localhost', 'commit', '-q', '-m', `dsh-plugin-sync: ${snapshot.machine} ${snapshot.createdAt}\n\n${changes.join(' ')}`])
  } catch (error) {
    if (options.cleanupOnCommitFailure) {
      await run('git', ['-C', root, 'rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', path])
      if (previous !== undefined) await run('git', ['-C', root, 'checkout', 'HEAD', '--', path])
      await run('git', ['-C', root, 'clean', '-fdq', '--', path])
    }
    throw error
  }
  return (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim()
}

export type { SyncSnapshot } from './types.js'
