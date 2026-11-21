import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isSeq, parse, parseDocument, stringify } from 'yaml'
import { releaseApplyLock, verifyApplyLock } from './apply-lock.js'
import { assertUniquePackageIdentities, packageAlias, packageIdentity } from './package-names.js'
import { moveToTrash, pruneDirectory } from './retention.js'
import type { SnapshotPlugin, SnapshotRow } from './types.js'
import { exists, packageNameFromKey } from './util.js'

const DEFAULT_APP = '/Applications/DeepSeek Harness.app'

/** Prefix of each saved desktop profile directory in the active DSH home. */
export function pluginSyncBackupPrefix(dshHome: string): string {
  return join(dshHome, 'backups', 'plugin-sync', 'backup-plugin-sync-')
}

export function assertNoAppAllowed(dshHome: string, realHome = join(homedir(), '.dsh')): void {
  if (resolve(dshHome) === resolve(realHome)) throw new Error('--no-app 只能用于临时 DSH_HOME，真实环境必须退出桌面端后应用')
}

/** Refuses a staged plan that installs, changes, removes or switches a plugin outside the chosen changes. */
export function assertPlanAllowed(plan: any): void {
  if (!Array.isArray(plan.untouched)) throw new Error('应用计划缺少不变更的插件列表')
  assertUniquePackageIdentities([...Object.keys(plan.manifest?.dependencies ?? {}), ...(plan.manifest?.dsh?.profile?.bundles ?? []),
    ...(plan.plugins ?? []).map((plugin: any) => plugin.name), ...(plan.packages ?? []).map((plugin: any) => plugin.name)])
  for (const change of plan.changes ?? []) {
    if (change.kind !== 'rename') continue
    if (typeof change.replaces !== 'string' || packageAlias(change.name) !== change.replaces || change.owner !== change.name ||
      !plan.removed?.includes(change.replaces) || plan.manifest?.dependencies?.[change.replaces] !== undefined ||
      plan.manifest?.dependencies?.[change.name] === undefined || !plan.plugins?.some((plugin: any) => plugin.name === change.name)) {
      throw new Error('换名计划必须一起卸载来源插件并安装目标插件，请重新比较快照')
    }
  }
  const untouched = new Set<string>(plan.untouched.map(packageIdentity))
  const touched = [...(plan.plugins ?? []).map((plugin: any) => plugin.name), ...(plan.packages ?? []).map((entry: any) => entry.name), ...(plan.removed ?? [])]
  for (const name of touched) if (untouched.has(packageIdentity(name))) throw new Error(`应用计划会改动未选中的插件：${name}`)
  for (const row of (plan.rows ?? []) as SnapshotRow[]) {
    if (typeof row.owner !== 'string' || untouched.has(packageIdentity(row.owner))) throw new Error(`应用计划会改动未选中插件的组件：${row.id}`)
  }
  for (const key of Object.keys(plan.exemptions ?? {})) if (untouched.has(packageIdentity(packageNameFromKey(key)))) throw new Error(`应用计划含未选中插件的兼容性豁免：${key}`)
  for (const key of Object.keys(plan.snapshotPatchedDependencies ?? {})) if (untouched.has(packageIdentity(packageNameFromKey(key)))) throw new Error(`应用计划含未选中插件的补丁：${key}`)
}

/** Refuses a plan whose manifest would change the spec or bundle selection of a plugin outside the chosen changes, against the profile as it is now. */
export async function assertUntouchedKept(profile: string, plan: any): Promise<void> {
  const current = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  const before: string[] = current.dsh?.profile?.bundles ?? []
  const after: string[] = plan.manifest.dsh?.profile?.bundles ?? []
  for (const name of plan.untouched as string[]) {
    if (current.dependencies?.[name] !== plan.manifest.dependencies?.[name] || before.includes(name) !== after.includes(name)) {
      throw new Error(`应用计划会改动未选中的插件：${name}`)
    }
  }
}

interface ApplyOptions {
  stagedDir: string
  dshHome: string
  noApp: boolean
  appPath?: string
  dshPath?: string
  timeoutMs?: number
  trashDir?: string
}

/** What `last-apply.json` records; the page shows it after the App reopens. */
interface ApplyResult {
  success: boolean
  finishedAt: string
  source?: { machine: string; createdAt: string } | undefined
  /** Applied changes by kind. */
  summary: Record<string, number>
  steps: { name: string; status: 'passed' | 'failed' }[]
  backupDir?: string | undefined
  logPath: string
  error?: string | undefined
  rollbackError?: string | undefined
  /** Row ids written as new overrides at the end of the profile patch. */
  appendedRows: string[]
  warnings: string[]
}

async function emptyDirectory(path: string): Promise<void> {
  const entries = await readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  if (entries.length > 0) throw new Error(`目录不是空目录：${path}`)
  await mkdir(path, { recursive: true })
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, path)
}

async function integrity(path: string): Promise<string> {
  return `sha512-${createHash('sha512').update(await readFile(path)).digest('base64')}`
}

export async function stageApplyPlan(options: { plan: any; sourceDir: string; stagedDir: string }): Promise<void> {
  const { plan, sourceDir, stagedDir } = options
  if (plan?.format !== 'dsh-plugin-sync/plan-1' || typeof plan.id !== 'string') throw new Error('应用计划格式无效')
  assertPlanAllowed(plan)
  await emptyDirectory(stagedDir)
  await mkdir(join(stagedDir, 'files', 'patches'), { recursive: true })
  await mkdir(join(stagedDir, 'packages'), { recursive: true })
  await atomicWrite(join(stagedDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
  await atomicWrite(join(stagedDir, 'files', 'package.json'), `${JSON.stringify(plan.manifest, null, 2)}\n`)
  await atomicWrite(join(stagedDir, 'files', 'pnpm-workspace.yaml'), plan.workspaceYaml)
  await atomicWrite(join(stagedDir, 'files', 'pnpm-lock.yaml'), plan.lockfile)
  for (const [file, content] of Object.entries(plan.patches ?? {}) as [string, string][]) {
    if (basename(file) !== file) throw new Error(`补丁路径无效：${file}`)
    await atomicWrite(join(stagedDir, 'files', 'patches', file), content)
  }
  for (const entry of plan.packages ?? []) {
    if (basename(entry.file) !== entry.file) throw new Error(`包路径无效：${entry.file}`)
    const source = join(sourceDir, 'packages', entry.file)
    if (await integrity(source) !== entry.integrity) throw new Error(`${entry.name} 的包 integrity 不一致`)
    await copyFile(source, join(stagedDir, 'packages', entry.file))
  }
}

function run(command: string, args: string[], options: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined; timeoutMs?: number | undefined } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    child.stdout.on('data', chunk => { if (output.length < 1024 * 1024) output += chunk })
    child.stderr.on('data', chunk => { if (output.length < 1024 * 1024) output += chunk })
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGTERM') } catch {}
        setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 2000).unref()
      }
    }, options.timeoutMs ?? 900000)
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`命令超过 ${options.timeoutMs ?? 900000}ms 未结束\n${output}`))
      else if (code !== 0) reject(new Error(`命令失败（退出码 ${code}）：${args.join(' ')}\n${output}`))
      else resolve(output)
    })
  })
}

function dshEnvironment(dshHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: dshHome, npm_config_update_notifier: 'false' }
  delete env.DEEPSEEK_API_KEY
  delete env.DEEPSEC_SCOPE_SIGNING_KEY
  return env
}

async function backupProfile(profile: string, backup: string): Promise<void> {
  await mkdir(backup, { recursive: true })
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'compatibility.json']) {
    if (await exists(join(profile, file))) await copyFile(join(profile, file), join(backup, file))
  }
  for (const directory of ['patches', 'local-plugins']) {
    if (await exists(join(profile, directory))) await cp(join(profile, directory), join(backup, directory), { recursive: true })
  }
}

async function restoreProfile(profile: string, backup: string): Promise<void> {
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'compatibility.json']) {
    await rm(join(profile, file), { force: true })
    if (await exists(join(backup, file))) await copyFile(join(backup, file), join(profile, file))
  }
  for (const directory of ['patches', 'local-plugins']) {
    await rm(join(profile, directory), { recursive: true, force: true })
    if (await exists(join(backup, directory))) await cp(join(backup, directory), join(profile, directory), { recursive: true })
  }
}

async function assertSameVolume(profile: string, backup: string): Promise<void> {
  const [source, destination] = await Promise.all([stat(profile), stat(backup)])
  if (source.dev !== destination.dev) throw new Error('备份目录与 desktop profile 不在同一个卷，未做任何改动')
}

async function moveIfExists(source: string, destination: string): Promise<void> {
  if (!await exists(source)) return
  await mkdir(dirname(destination), { recursive: true })
  await rename(source, destination)
}

async function restoreNodeModules(profile: string, backup: string): Promise<void> {
  await rm(join(profile, 'node_modules'), { recursive: true, force: true })
  await moveIfExists(join(backup, 'node_modules'), join(profile, 'node_modules'))
}

async function trashNodeModules(backup: string, trashDir: string): Promise<void> {
  await moveIfExists(join(backup, 'node_modules'), join(trashDir, `node_modules-${basename(backup)}`))
}

function lockHasDependency(lock: any, name: string): boolean {
  return Object.values(lock.importers ?? {}).some((importer: any) => ['dependencies', 'devDependencies', 'optionalDependencies'].some(section => importer?.[section]?.[name] !== undefined))
}

function rowId(line: string, topIndent: number): string | undefined {
  if (/^\s*/.exec(line)![0].length !== topIndent) return undefined
  const match = /^\s*- id:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/.exec(line)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

function updateRowText(lines: string[], row: SnapshotRow, topIndent: number): { found: boolean; changed: boolean } {
  let index = -1
  for (let current = 0; current < lines.length; current++) {
    if (rowId(lines[current]!, topIndent) === row.id) index = current
  }
  if (index < 0) return { found: false, changed: false }
  const indent = /^\s*/.exec(lines[index]!)![0].length
  let end = lines.length
  for (let current = index + 1; current < lines.length; current++) {
    const line = lines[current]!
    if (line.trimStart().startsWith('- ') && /^\s*/.exec(line)![0].length <= indent) {
      end = current
      break
    }
  }
  for (let current = index + 1; current < end; current++) {
    const match = /^(\s*)disabled:\s*(true|false)(\s*(?:#.*)?(?:\r?\n)?)$/.exec(lines[current]!)
    if (!match || match[1]!.length !== indent + 2) continue
    if (match[2] === String(row.disabled)) return { found: true, changed: false }
    lines[current] = `${match[1]}disabled: ${row.disabled}${match[3]}`
    return { found: true, changed: true }
  }
  const eol = lines[index]!.includes('\r\n') ? '\r\n' : '\n'
  lines.splice(index + 1, 0, `${' '.repeat(indent + 2)}disabled: ${row.disabled}${eol}`)
  return { found: true, changed: true }
}

function onlyTargetRowChanges(before: unknown, after: unknown, targets: ReadonlyMap<string, boolean>, changed: Set<string>, depth = 0): boolean {
  if (isDeepStrictEqual(before, after)) return true
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false
    return before.every((entry, index) => onlyTargetRowChanges(entry, after[index], targets, changed, depth + 1))
  }
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object') return false
  const oldObject = before as Record<string, unknown>
  const newObject = after as Record<string, unknown>
  for (const key of new Set([...Object.keys(oldObject), ...Object.keys(newObject)])) {
    const id = newObject.id
    if (depth === 1 && key === 'disabled' && typeof id === 'string' && targets.has(id) && targets.get(id) === newObject.disabled && !isDeepStrictEqual(oldObject.disabled, newObject.disabled)) {
      changed.add(id)
      continue
    }
    if (!onlyTargetRowChanges(oldObject[key], newObject[key], targets, changed, depth + 1)) return false
  }
  return true
}

/**
 * Sets `disabled` on the profile patch rows the import switches. A row with an entry keeps every
 * other byte; a row without one (a bundle row this machine never switched) gets a top-level
 * `{ id, disabled }` override appended at the end, the way the official switch writes it.
 * The edited text must parse to exactly those changes before it is written.
 * @param path - the profile's `cordis.patch.yml`.
 * @param rows - row switches to apply.
 * @returns whether the file changed and which ids were appended.
 */
export async function updateRows(path: string, rows: SnapshotRow[]): Promise<{ changed: boolean; appended: string[] }> {
  const source = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '[]\n'
    throw error
  })
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : ''
  const text = source.slice(bom.length)
  const document = parseDocument(text, { logLevel: 'error' })
  if (document.errors.length > 0 || !isSeq(document.contents)) throw new Error('cordis.patch.yml 不是有效 YAML 数组')
  const start = document.contents.range![0]
  const topIndent = start - (text.lastIndexOf('\n', start - 1) + 1)
  const lines = text.split(/(?<=\n)/)
  const appended: { id: string; disabled: boolean }[] = []
  const changedRows = new Set<string>()
  for (const row of rows) {
    const result = updateRowText(lines, row, topIndent)
    if (!result.found) appended.push({ id: row.id, disabled: row.disabled })
    else if (result.changed) changedRows.add(row.id)
  }
  if (changedRows.size === 0 && appended.length === 0) return { changed: false, appended: [] }
  let updatedText = lines.join('')
  if (appended.length > 0) {
    // An empty patch is the flow sequence `[]`, which block items cannot follow.
    const base = updatedText.replace(/^\[\]\s*$/m, '').replace(/\s*$/, '')
    const additions = stringify(appended).split('\n').map(line => line === '' ? line : ' '.repeat(topIndent) + line).join('\n')
    updatedText = `${base === '' ? '' : `${base}\n`}# dsh-plugin-sync 导入的组件开关\n${additions}`
  }
  const updated = parseDocument(updatedText, { logLevel: 'error' })
  if (updated.errors.length > 0 || !isSeq(updated.contents)) throw new Error('rows 修改后的 YAML 解析失败，未写入文件')
  const before = document.toJS() as unknown[]
  const after = updated.toJS() as unknown[]
  const parsedChanges = new Set<string>()
  const targets = new Map(rows.map(row => [row.id, row.disabled]))
  if (
    after.length !== before.length + appended.length
    || !onlyTargetRowChanges(before, after.slice(0, before.length), targets, parsedChanges)
    || [...changedRows].some(id => !parsedChanges.has(id))
    || !isDeepStrictEqual(after.slice(before.length), appended)
  ) {
    throw new Error('rows 文本修改与 YAML 解析结果不一致，未写入文件')
  }
  await atomicWrite(path, bom + updatedText)
  return { changed: true, appended: appended.map(row => row.id) }
}

function patchTargets(patch: string): string[] {
  return patch.split('\n').flatMap(line => {
    const match = /^\+\+\+ b\/(.+)$/.exec(line)
    if (!match || match[1] === '/dev/null') return []
    const path = match[1]!
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`补丁含不安全路径：${path}`)
    return [path]
  })
}

export async function verifyApplied(profile: string, plan: any): Promise<void> {
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assertUniquePackageIdentities([...Object.keys(manifest.dependencies ?? {}), ...(manifest.dsh?.profile?.bundles ?? [])])
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify(plan.manifest.dependencies)) throw new Error('安装后的 dependencies 与计划不一致')
  if (JSON.stringify(manifest.dsh?.profile?.bundles) !== JSON.stringify(plan.manifest.dsh?.profile?.bundles)) throw new Error('安装后的 bundles 与计划不一致')
  const lock = parse(await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8'), { logLevel: 'error' })
  for (const plugin of plan.plugins as SnapshotPlugin[]) {
    const alias = packageAlias(plugin.name)
    if (alias !== undefined && await exists(join(profile, 'node_modules', alias, 'package.json'))) throw new Error(`插件包名冲突：${plugin.name}、${alias} 并存；请只保留一个名称`)
    const installed = JSON.parse(await readFile(join(profile, 'node_modules', plugin.name, 'package.json'), 'utf8'))
    if (installed.version !== plugin.version) throw new Error(`${plugin.name} 安装版本不符：${installed.version} ≠ ${plugin.version}`)
    if (plugin.integrity !== undefined) {
      const matched = Object.entries(lock.packages ?? {}).some(([key, value]: [string, any]) => packageNameFromKey(key) === plugin.name && (value as any)?.resolution?.integrity === plugin.integrity)
      if (!matched) throw new Error(`${plugin.name} 的锁文件 integrity 与快照不一致`)
    }
  }
  const workspace = parse(plan.workspaceYaml, { logLevel: 'error' })
  const patchOwners = new Map(Object.entries(workspace.patchedDependencies ?? {}).map(([key, path]) => [basename(path as string), packageNameFromKey(key)]))
  for (const [file, content] of Object.entries(plan.patches ?? {}) as [string, string][]) {
    if (!content.includes('dsh-launcher patch')) continue
    const owner = patchOwners.get(file)
    if (owner === undefined) throw new Error(`补丁没有对应的包：${file}`)
    const targets = patchTargets(content)
    let verified = false
    for (const target of targets) {
      const installedTarget = target.startsWith('node_modules/') ? join(profile, target) : join(profile, 'node_modules', owner, target)
      if (await exists(installedTarget) && (await readFile(installedTarget, 'utf8')).includes('dsh-launcher patch')) verified = true
    }
    if (!verified) throw new Error('安装后未找到带 dsh-launcher patch 标记的补丁目标')
  }
}

async function quitAndWait(app: string, timeoutMs: number): Promise<void> {
  await run('osascript', ['-e', `quit app ${JSON.stringify(app)}`])
  const executable = `${app}/Contents/MacOS/DeepSeek Harness`
  const pattern = executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await run('pgrep', ['-f', pattern])
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('等待桌面端退出超时，未修改 profile')
}

function sourceOf(plan: any): ApplyResult['source'] {
  const source = plan?.sourceSnapshot
  return typeof source?.machine === 'string' && typeof source.createdAt === 'string' ? { machine: source.machine, createdAt: source.createdAt } : undefined
}

function summaryOf(plan: any): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const change of plan?.changes ?? []) counts[change.kind] = (counts[change.kind] ?? 0) + 1
  return counts
}

export async function applyStagedPlan(options: ApplyOptions): Promise<ApplyResult> {
  if (options.noApp) assertNoAppAllowed(options.dshHome)
  const profile = join(options.dshHome, 'profiles', 'desktop')
  const resultDir = join(options.dshHome, 'plugin-sync')
  const logPath = join(resultDir, 'last-apply.log')
  const resultPath = join(resultDir, 'last-apply.json')
  const steps: ApplyResult['steps'] = []
  const logs: string[] = []
  const warnings: string[] = []
  let backupDir: string | undefined
  let appendedRows: string[] = []
  let plan: any
  let lockOwner: string | undefined
  let changed = false
  let installing = false
  let result: ApplyResult
  const app = options.appPath ?? DEFAULT_APP
  const dshPath = options.dshPath ?? join(app, 'Contents/Resources/runtime/cli/bin/dsh')
  const runDsh = async (args: string[]) => {
    logs.push(`$ dsh ${args.join(' ')}`)
    const output = await run(dshPath, args, { cwd: profile, env: dshEnvironment(options.dshHome), timeoutMs: options.timeoutMs })
    logs.push(output)
  }
  const step = async (name: string, action: () => Promise<void>) => {
    logs.push(`开始：${name}`)
    await action()
    steps.push({ name, status: 'passed' })
  }
  const postCommitStep = async (name: string, action: () => Promise<void>) => {
    logs.push(`开始：${name}`)
    try {
      await action()
      steps.push({ name, status: 'passed' })
    } catch (error) {
      const warning = `${name}失败：${error instanceof Error ? error.message : String(error)}`
      warnings.push(warning)
      logs.push(`警告：${warning}`)
    }
  }
  const writeResult = async (result: ApplyResult) => {
    await mkdir(resultDir, { recursive: true })
    await atomicWrite(logPath, logs.join('\n'))
    await atomicWrite(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  }
  try {
    plan = JSON.parse(await readFile(join(options.stagedDir, 'plan.json'), 'utf8'))
    assertPlanAllowed(plan)
    await assertUntouchedKept(profile, plan)
    lockOwner = await verifyApplyLock(options.dshHome, plan.id, process.env.DSH_PLUGIN_SYNC_LOCK_TOKEN)
    if (!options.noApp) await quitAndWait(app, options.timeoutMs ?? 120000)
    if (await exists(join(profile, 'lock'))) throw new Error('desktop profile 有 lock 文件，不能应用')
    await step('备份当前 profile', async () => {
      const prefix = pluginSyncBackupPrefix(options.dshHome)
      await mkdir(dirname(prefix), { recursive: true })
      backupDir = await mkdtemp(prefix)
      await assertSameVolume(profile, backupDir)
      await backupProfile(profile, backupDir)
    })
    changed = true
    await step('写入暂存的 profile 文件', async () => {
      const lock = parse(plan.lockfile, { logLevel: 'error' })
      const deferred = (plan.packages ?? []).filter((entry: any) => !lockHasDependency(lock, entry.name))
      plan.deferredPackages = deferred
      const baseManifest = structuredClone(plan.manifest)
      for (const entry of deferred) delete baseManifest.dependencies[entry.name]
      await atomicWrite(join(profile, 'package.json'), `${JSON.stringify(baseManifest, null, 2)}\n`)
      for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml']) await atomicWrite(join(profile, file), await readFile(join(options.stagedDir, 'files', file), 'utf8'))
      await mkdir(join(profile, 'patches'), { recursive: true })
      for (const file of await readdir(join(options.stagedDir, 'files', 'patches'))) await copyFile(join(options.stagedDir, 'files', 'patches', file), join(profile, 'patches', file))
      await mkdir(join(profile, 'local-plugins'), { recursive: true })
      for (const file of await readdir(join(options.stagedDir, 'packages'))) await copyFile(join(options.stagedDir, 'packages', file), join(profile, 'local-plugins', file))
    })
    await step('写入已确认的兼容性豁免', async () => {
      for (const [key, versions] of Object.entries(plan.exemptions ?? {}) as [string, string[]][]) {
        for (const version of versions) await runDsh(['plugin', '--profile', 'desktop', 'allow-version', key, '--dsh-version', version, '--accept-risk'])
      }
    })
    await step('安装插件', async () => {
      await moveIfExists(join(profile, 'node_modules'), join(backupDir!, 'node_modules'))
      installing = true
      // pnpm defaults to a frozen lockfile when CI is set, and a partial plan must update the lockfile.
      await runDsh(['plugin', '--profile', 'desktop', 'install', plan.frozen ? '--frozen-lockfile' : '--no-frozen-lockfile'])
      for (const entry of plan.deferredPackages) await runDsh(['plugin', '--profile', 'desktop', 'add', `file:local-plugins/${entry.file}`, '--save-exact'])
      await atomicWrite(join(profile, 'package.json'), `${JSON.stringify(plan.manifest, null, 2)}\n`)
    })
    await step('写入组件开关', async () => {
      const outcome = await updateRows(join(profile, 'cordis.patch.yml'), plan.rows ?? [])
      appendedRows = outcome.appended
    })
    await step('校验版本、包完整性和补丁', async () => { await verifyApplied(profile, plan) })
    await step('记录已应用的快照', async () => {
      const source = join(options.stagedDir, 'source-snapshot.json')
      if (await exists(source)) await atomicWrite(join(resultDir, 'last-snapshot.json'), await readFile(source, 'utf8'))
    })
    await postCommitStep('旧的 node_modules 移到回收站', async () => {
      const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
      const trashDir = options.trashDir ?? (options.noApp ? join(dirname(options.dshHome), '.Trash', `dsh-plugin-sync-${date}`) : join(homedir(), '.Trash', `dsh-plugin-sync-${date}`))
      await trashNodeModules(backupDir!, trashDir)
    })
    await postCommitStep('清理已应用的暂存文件', async () => {
      const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
      const trashDir = options.trashDir ?? (options.noApp ? join(dirname(options.dshHome), '.Trash', `dsh-plugin-sync-${date}`) : join(homedir(), '.Trash', `dsh-plugin-sync-${date}`))
      await moveToTrash(options.stagedDir, trashDir)
      await pruneDirectory(join(options.dshHome, 'plugin-sync', 'staged'), trashDir)
    })
    result = { success: true, finishedAt: new Date().toISOString(), source: sourceOf(plan), summary: summaryOf(plan), steps, backupDir, logPath, appendedRows, warnings }
    await postCommitStep('写入导入结果', () => writeResult(result))
  } catch (error) {
    steps.push({ name: '应用', status: 'failed' })
    logs.push(error instanceof Error ? error.message : String(error))
    let rollbackError: string | undefined
    if (changed && backupDir !== undefined) {
      try {
        await restoreProfile(profile, backupDir)
        if (installing) await restoreNodeModules(profile, backupDir)
      } catch (caught) {
        rollbackError = caught instanceof Error ? caught.message : String(caught)
        logs.push(`回滚失败：${rollbackError}`)
      }
    }
    result = {
      success: false,
      finishedAt: new Date().toISOString(),
      source: sourceOf(plan),
      summary: {},
      steps,
      ...(backupDir !== undefined ? { backupDir } : {}),
      logPath,
      appendedRows,
      warnings,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error),
      ...(rollbackError !== undefined ? { rollbackError } : {}),
    }
    await writeResult(result)
  } finally {
    if (lockOwner !== undefined) await releaseApplyLock(options.dshHome, lockOwner).catch(() => undefined)
  }
  if (!options.noApp) await postCommitStep('重新打开 App', async () => { await run('open', ['-a', app]) })
  try {
    await writeResult(result)
  } catch (error) {
    warnings.push(`写入导入结果失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return result
}
