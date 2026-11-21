import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parse, stringify } from 'yaml'
import { assertPlanAllowed, assertUntouchedKept, updateRows, verifyApplied } from './apply.js'
import { releaseApplyLock, verifyApplyLock } from './apply-lock.js'
import { exists } from './util.js'
import { mergeInstallLock, preserveLockText, retainedLock } from './install-lock.js'
import { tarManifest } from './export.js'
import { peerContextPatches } from './plan.js'

const hash = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
async function optionalText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.sync-${process.pid}`
  await writeFile(temporary, text, { mode: 0o600 })
  await rename(temporary, path)
}

async function fingerprint(path: string): Promise<any> {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (entry === null) return null
  if (entry.isSymbolicLink()) return { link: await readlink(path) }
  if (entry.isFile()) return { mode: entry.mode & 0o777, hash: hash(await readFile(path)) }
  if (!entry.isDirectory()) throw new Error('未选插件含特殊文件，不能安全核验')
  const files: Record<string, any> = {}
  for (const name of (await readdir(path)).sort()) files[name] = await fingerprint(join(path, name))
  return files
}

interface IncrementalOptions {
  /** The logical installation home; a realpath profile may be on another volume. */
  dshHome: string
  profile: string
  stagedDir: string
  /** Invokes the selected App's `dsh plugin --profile <name>` without starting a Host. */
  runDsh: (args: string[]) => Promise<unknown>
  /** Runs the same App pnpm in a disposable resolution directory. */
  runPnpm: (args: string[], cwd: string) => Promise<unknown>
  /** An enclosing whole-directory transaction owns and releases this lock. */
  lockOwner?: string
}

/** Rebind unchanged consumers only when one of their peers changes, including nested consumers. */
async function affectedPeerConsumers(profile: string, plan: any, currentLock: any): Promise<string[]> {
  const affected = new Set<string>([...plan.plugins.map((plugin: any) => plugin.name), ...plan.removed])
  const candidates = new Map<string, Set<string>>()
  // Row/bundle-only selections are outside plan.untouched, but their package
  // sources are unchanged and need the same peer rebinding.
  for (const [name, spec] of Object.entries(plan.baseProfile.manifest.dependencies ?? {})) {
    if (affected.has(name) || plan.manifest.dependencies[name] !== spec) continue
    const manifest = await json(join(profile, 'node_modules', name, 'package.json'))
    const packages = Object.values(retainedLock(currentLock, [name]).packages) as any[]
    candidates.set(name, new Set([manifest, ...packages].flatMap(pkg => Object.keys(pkg.peerDependencies ?? {}))))
  }
  const rebound: string[] = []
  let added = true
  while (added) {
    added = false
    for (const [name, peers] of candidates) {
      if (!affected.has(name) && [...peers].some(peer => affected.has(peer))) {
        affected.add(name); rebound.push(name); added = true
      }
    }
  }
  return rebound
}

/** A peer suffix may change; an unselected consumer's source and own package may not. */
function assertConsumerSources(before: any, after: any, names: string[]): void {
  for (const name of names) {
    const original = before.importers?.['.']?.dependencies?.[name], current = after.importers?.['.']?.dependencies?.[name]
    const key = (entry: any) => typeof entry?.version === 'string' ? entry.version.split('(')[0] : undefined
    const ref = key(original), next = key(current)
    const pkg = (lock: any, reference: string) => lock.packages?.[`${name}@${reference}`] ?? lock.packages?.[reference]
    if (!ref || ref !== next || original.specifier !== current.specifier || !isDeepStrictEqual(pkg(before, ref), pkg(after, next))) {
      throw new Error(`peer 重绑改变了未选插件自身的来源：${name}`)
    }
  }
}

/** Resolve changed roots and affected consumers, borrowing only their stable peer context. */
async function resolveIncoming(profile: string, stagedDir: string, plan: any, before: any, lockText: string,
  runPnpm: IncrementalOptions['runPnpm'], rebound: string[]): Promise<{ lock: string; peers: string[] }> {
  const currentLock = parse(lockText) ?? {}, changed = new Set<string>([...plan.plugins.map((plugin: any) => plugin.name), ...rebound])
  const providers = new Set<string>(), queue: any[] = []
  const queueInstalled = async (name: string) => {
    queue.push(await json(join(profile, 'node_modules', name, 'package.json')),
      ...Object.values(retainedLock(currentLock, [name]).packages))
  }
  for (const plugin of plan.plugins) {
    queue.push(plugin.source === 'packed' ? await tarManifest(join(stagedDir, 'packages', plugin.file))
      : parse(plan.lockfile)?.packages?.[`${plugin.name}@${plugin.version}`] ?? {})
  }
  for (const name of rebound) await queueInstalled(name)
  while (queue.length) {
    const manifest = queue.shift()
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (changed.has(name) || providers.has(name) || !Object.hasOwn(before.dependencies ?? {}, name) ||
          plan.manifest.dependencies[name] !== before.dependencies[name]) continue
      if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('peer 包名无效')
      providers.add(name)
      await queueInstalled(name)
    }
  }
  const peers = [...providers], context = [...peers, ...rebound]
  const retained = retainedLock(currentLock, peers), seed = retainedLock(currentLock, context)
  // A sibling preserves ../ relative specs. In-profile local archives/directories
  // are copied or linked into the disposable project; the real profile stays read-only.
  const resolution = await mkdtemp(join(dirname(profile), '.plugin-sync-resolution-'))
  try {
    await mkdir(join(resolution, 'local-plugins'))
    const dependencies = Object.fromEntries(context.map(name => [name, before.dependencies[name]]))
    for (const plugin of plan.plugins) dependencies[plugin.name] = plugin.source === 'npm' ? plugin.version : plugin.spec
    await write(join(resolution, 'package.json'), JSON.stringify({ name: 'plugin-sync-resolution', private: true, dependencies }))
    for (const name of context) {
      const spec = before.dependencies[name] as string
      if (!/^(file|link):/.test(spec)) continue
      const value = spec.slice(spec.indexOf(':') + 1)
      if (isAbsolute(value)) continue
      const source = resolve(profile, value), inside = relative(profile, source)
      if (inside === '..' || inside.startsWith('..' + sep)) continue
      const destination = join(resolution, inside)
      await mkdir(dirname(destination), { recursive: true })
      if ((await lstat(source)).isDirectory() || spec.startsWith('link:')) await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
      else await copyFile(source, destination)
    }
    for (const entry of plan.packages ?? []) await copyFile(join(stagedDir, 'packages', entry.file), join(resolution, 'local-plugins', entry.file))
    const workspace = parse(plan.workspaceYaml)
    const contextPatches = peerContextPatches(lockText, context, workspace.patchedDependencies ?? {})
    workspace.patchedDependencies = { ...contextPatches, ...plan.snapshotPatchedDependencies }
    await write(join(resolution, 'pnpm-workspace.yaml'), stringify(workspace))
    for (const file of Object.values(workspace.patchedDependencies) as string[]) {
      await write(join(resolution, 'patches', basename(file)), plan.patches[basename(file)])
    }
    if (context.length) await write(join(resolution, 'pnpm-lock.yaml'), stringify({
      lockfileVersion: currentLock.lockfileVersion, settings: currentLock.settings,
      // Keep the cached graph but omit affected root refs: otherwise pnpm reuses a
      // consumer's old peer suffix when a provider was removed from the manifest.
      importers: { '.': { dependencies: retained.dependencies } }, packages: seed.packages, snapshots: seed.snapshots,
      ...(currentLock.overrides ? { overrides: currentLock.overrides } : {}),
      ...(Object.keys(contextPatches).length ? { patchedDependencies: Object.fromEntries(Object.keys(contextPatches).map(key => [key, currentLock.patchedDependencies[key]])) } : {}),
    }))
    await runPnpm(['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts'], resolution)
    const lock = await readFile(join(resolution, 'pnpm-lock.yaml'), 'utf8')
    if (!isDeepStrictEqual(retainedLock(parse(lock), peers), retained)) throw new Error('解析改变了未选 peer 的锁文件条目，不能应用')
    assertConsumerSources(currentLock, parse(lock), rebound)
    return { lock, peers }
  } finally { await rm(resolution, { recursive: true, force: true }) }
}

/**
 * Apply in an existing installation. The caller must hold an outer, whole-directory transaction
 * and check that its App/Host is closed. On failure this throws: only the caller restores that
 * transaction. Unlike applyStagedPlan this never quits/reopens an App or replaces node_modules.
 * Both entry points use the same plan, staged-package, untouched and installed-result checks.
 */
export async function applyProfilePlan({ dshHome, profile, stagedDir, runDsh, runPnpm, lockOwner }: IncrementalOptions): Promise<{ appendedRows: string[]; untouched: string[] }> {
  if (typeof dshHome !== 'string' || !dshHome) throw new Error('Incremental apply requires an explicit dshHome')
  const plan = await json(join(stagedDir, 'plan.json'))
  if (plan?.format !== 'dsh-plugin-sync/plan-1' || !plan.baseProfile) throw new Error('增量应用计划缺少本机基线')
  assertPlanAllowed(plan)
  if (await exists(join(profile, 'lock'))) throw new Error('profile 有 lock 文件，不能应用')
  const home = dshHome
  const owner = await verifyApplyLock(home, plan.id, lockOwner)
  try {
    const before = await json(join(profile, 'package.json'))
    const lockText = await optionalText(join(profile, 'pnpm-lock.yaml'))
    const workspaceText = await optionalText(join(profile, 'pnpm-workspace.yaml'))
    if (!isDeepStrictEqual(before, plan.baseProfile.manifest) || lockText !== plan.baseProfile.lockfile ||
      !isDeepStrictEqual(workspaceText === null ? null : parse(workspaceText), plan.baseProfile.workspace)) {
      throw new Error('profile 在制定计划后已改变，请重新生成计划')
    }
    await assertUntouchedKept(profile, plan)
    // Verify staged bytes again immediately before writing anything in the profile.
    for (const entry of plan.packages ?? []) {
      if (basename(entry.file) !== entry.file || hash(await readFile(join(stagedDir, 'packages', entry.file))) !== entry.integrity) {
        throw new Error(`${entry.name} 的包 integrity 不一致`)
      }
    }
    const untouched = plan.untouched.filter((name: string) => before.dependencies?.[name] !== undefined)
    const currentLock = parse(lockText ?? '') ?? {}
    const rebound = await affectedPeerConsumers(profile, plan, currentLock)
    const stable = untouched.filter((name: string) => !rebound.includes(name))
    const retained = retainedLock(currentLock, stable)
    const installed = new Map<string, any>()
    for (const name of new Set([...untouched, ...rebound])) installed.set(name, await fingerprint(join(profile, 'node_modules', name)))
    let incomingLock = '', resolutionPeers: string[] = []
    if (plan.plugins?.length || rebound.length) {
      const resolved = await resolveIncoming(profile, stagedDir, plan, before, lockText ?? '', runPnpm, rebound)
      incomingLock = resolved.lock; resolutionPeers = resolved.peers
    }
    const mergedLock = mergeInstallLock(lockText ?? '', incomingLock, plan, resolutionPeers, rebound)
    await mkdir(join(profile, 'local-plugins'), { recursive: true })
    for (const entry of plan.packages ?? []) {
      const destination = join(profile, 'local-plugins', entry.file)
      // Another package may refer to this archive. Never silently overwrite different bytes.
      if (await exists(destination) && hash(await readFile(destination)) !== entry.integrity) throw new Error(`包文件已存在且内容不同：${entry.file}`)
      if (!await exists(destination)) await copyFile(join(stagedDir, 'packages', entry.file), destination)
    }
    for (const [file, content] of Object.entries(plan.patches ?? {}) as [string, string][]) {
      if (basename(file) !== file) throw new Error('补丁路径无效')
      if (await optionalText(join(profile, 'patches', file)) !== content) await write(join(profile, 'patches', file), content)
    }
    await write(join(profile, 'package.json'), `${JSON.stringify(plan.manifest, null, 2)}\n`)
    await write(join(profile, 'pnpm-workspace.yaml'), plan.workspaceYaml)
    await write(join(profile, 'pnpm-lock.yaml'), mergedLock)
    for (const [key, versions] of Object.entries(plan.exemptions ?? {}) as [string, string[]][]) {
      for (const version of versions) await runDsh(['allow-version', key, '--dsh-version', version, '--accept-risk'])
    }
    if ((plan.plugins?.length ?? 0) || (plan.removed?.length ?? 0)) {
      await runDsh(['install', '--frozen-lockfile', '--ignore-scripts'])
    }
    const actual = await json(join(profile, 'package.json'))
    if (!isDeepStrictEqual(actual.dependencies, plan.manifest.dependencies)) throw new Error('安装后的 dependencies 与计划不一致')
    await assertUntouchedKept(profile, plan)
    // DSH may enable an installed bundle as part of install. Restore only the explicitly planned list.
    actual.dsh = plan.manifest.dsh
    await write(join(profile, 'package.json'), `${JSON.stringify(actual, null, 2)}\n`)
    const afterLock = parse(await optionalText(join(profile, 'pnpm-lock.yaml')) ?? '') ?? {}
    if (!isDeepStrictEqual(retainedLock(afterLock, stable), retained)) throw new Error('安装改变了未选插件的锁文件条目')
    assertConsumerSources(currentLock, afterLock, rebound)
    const lockPath = join(profile, 'pnpm-lock.yaml')
    const actualLockText = await readFile(lockPath, 'utf8')
    const exactLock = preserveLockText(lockText ?? '', actualLockText, stable)
    if (exactLock !== actualLockText) await write(lockPath, exactLock)
    for (const [name, state] of installed) {
      if (!isDeepStrictEqual(await fingerprint(join(profile, 'node_modules', name)), state)) throw new Error(`安装改变了未选插件的文件：${name}`)
    }
    const rows = await updateRows(join(profile, 'cordis.patch.yml'), plan.rows ?? [])
    if (plan.plugins?.length) await verifyApplied(profile, plan)
    // A removed direct dependency can still be required by an untouched plugin's locked graph.
    return { appendedRows: rows.appended, untouched }
  } finally {
    if (lockOwner === undefined) await releaseApplyLock(home, owner)
  }
}
