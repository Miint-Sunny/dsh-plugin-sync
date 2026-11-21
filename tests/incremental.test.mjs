import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { buildChanges, createApplyPlan } from '../lib/core/plan.js'
import { stageApplyPlan } from '../lib/core/apply.js'
import * as incremental from '../lib/core/incremental.js'

const app = process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app'
const cli = join(app, 'Contents/Resources/runtime/cli/bin/dsh')
const version = '0.2.2-rc.2'
const sha = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64')
function write(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, value)
}
function json(file, value) { write(file, JSON.stringify(value, null, 2) + '\n') }
function archive(root, name, body, extra = {}) {
  const dir = join(root, name + '-source', 'package')
  json(join(dir, 'package.json'), { name, version: '1.0.0', type: 'module', main: 'index.js', ...extra })
  write(join(dir, 'index.js'), body)
  const file = name + '-' + createHash('sha256').update(body).digest('hex').slice(0, 16) + '.tgz'
  const out = join(root, 'packages', file)
  mkdirSync(dirname(out), { recursive: true })
  execFileSync('tar', ['-czf', out, '-C', dirname(dir), 'package'])
  return { name, version: extra.version ?? '1.0.0', source: 'packed', file, spec: 'file:local-plugins/' + file, integrity: sha(readFileSync(out)), bundle: false, selected: false }
}
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'sync-incremental-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'dsh'), profile = join(home, 'profiles/desktop')
  const manifest = { name: 'dsh-profile-desktop', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }
  json(join(profile, 'package.json'), manifest)
  write(join(profile, 'pnpm-workspace.yaml'), 'packages: ["."]\nnodeLinker: hoisted\nautoInstallPeers: false\npackageImportMethod: copy\nstoreDir: ' + join(root, 'store') + '\ncacheDir: ' + join(root, 'cache') + '\n')
  const patch = '# an external plugin owns this comment\n- id: external-row\n  name: external-broken\n  config: { value: untouched }\n'
  write(join(profile, 'cordis.patch.yml'), patch)
  const runDsh = async args => execFileSync(cli, ['plugin', '--profile', 'desktop', ...args], {
    cwd: profile, env: { ...process.env, DSH_HOME: home, npm_config_offline: 'true' }, stdio: 'pipe',
  })
  const runPnpm = async (args, cwd) => execFileSync(join(app, 'Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node'),
    [join(app, 'Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'), ...args],
    { cwd, env: { ...process.env, npm_config_offline: 'true' }, stdio: 'pipe' })
  return { root, profile, home, dshHome: home, runDsh, runPnpm, patch }
}
function localOf(profile) {
  const read = file => existsSync(join(profile, file)) ? readFileSync(join(profile, file), 'utf8') : undefined
  const manifest = JSON.parse(read('package.json'))
  const versions = Object.fromEntries(Object.keys(manifest.dependencies).map(name => [name, JSON.parse(read('node_modules/' + name + '/package.json')).version]))
  return { manifest, versions, workspace: parse(read('pnpm-workspace.yaml')), lockfile: read('pnpm-lock.yaml') }
}
async function stage(data, plugins, previous) {
  const snapshot = { format: 'dsh-plugin-sync/snapshot-2', machine: 'installer', machineId: 'installer', createdAt: '2026-11-12', exporter: { name: 'dsh-plugin-sync', version: '0.4.0' }, dsh: { desktopVersion: version }, excluded: [],
    profiles: { desktop: { plugins, official: [], bundles: [], rows: [], exemptions: {}, workspace: {}, patches: {}, lockfile: "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\nsnapshots: {}\n" } } }
  const options = { snapshot, previous, local: localOf(data.profile), currentDesktopVersion: version, protectedPlugins: [], comparePackedContent: true }
  const set = buildChanges(options)
  const plan = await createApplyPlan({ ...options, selected: set.changes.map(change => change.id) })
  const stagedDir = join(data.root, 'stage-' + plan.id)
  await stageApplyPlan({ plan, sourceDir: data.root, stagedDir })
  return { plan, stagedDir, snapshot }
}

test('incremental apply replaces equal-version content, removes previous managed packages and preserves another installation', async t => {
  const d = setup(t)
  const other = archive(d.root, 'external-fixture', 'export const original = true\n')
  write(join(d.profile, 'local-plugins', other.file), readFileSync(join(d.root, 'packages', other.file)))
  await d.runDsh(['add', other.spec, '--ignore-scripts'])
  const external = readFileSync(join(d.profile, 'node_modules/external-fixture/index.js'))
  const first = archive(d.root, 'managed-fixture', 'export const locale = "zh"\n')
  const initial = await stage(d, [first])
  await incremental.applyProfilePlan({ ...d, stagedDir: initial.stagedDir })
  const second = archive(d.root, 'managed-fixture', 'export const locale = "en"\n')
  const update = await stage(d, [second], initial.snapshot)
  await incremental.applyProfilePlan({ ...d, stagedDir: update.stagedDir })
  assert.match(readFileSync(join(d.profile, 'node_modules/managed-fixture/index.js'), 'utf8'), /"en"/)
  assert.deepEqual(readFileSync(join(d.profile, 'node_modules/external-fixture/index.js')), external)
  assert.equal(readFileSync(join(d.profile, 'cordis.patch.yml'), 'utf8'), d.patch)
  assert.equal(localOf(d.profile).manifest.dependencies['external-fixture'], other.spec)
  const removal = await stage(d, [], update.snapshot)
  await incremental.applyProfilePlan({ ...d, stagedDir: removal.stagedDir })
  assert.equal(localOf(d.profile).manifest.dependencies['managed-fixture'], undefined)
  assert.equal(existsSync(join(d.profile, 'node_modules/managed-fixture')), false)
  assert.deepEqual(readFileSync(join(d.profile, 'node_modules/external-fixture/index.js')), external)
})

test('stale plans and corrupted staged archives are rejected before the profile is written', async t => {
  const d = setup(t), plugin = archive(d.root, 'managed-fixture', 'export {}\n')
  const prepared = await stage(d, [plugin])
  const manifest = readFileSync(join(d.profile, 'package.json'), 'utf8')
  write(join(prepared.stagedDir, 'packages', plugin.file), 'corrupt')
  await assert.rejects(incremental.applyProfilePlan({ ...d, stagedDir: prepared.stagedDir }), /integrity/)
  assert.equal(readFileSync(join(d.profile, 'package.json'), 'utf8'), manifest)
  write(join(prepared.stagedDir, 'packages', plugin.file), readFileSync(join(d.root, 'packages', plugin.file)))
  const changed = JSON.parse(manifest)
  changed.dependencies.newcomer = '^1.0.0'
  json(join(d.profile, 'package.json'), changed)
  const before = readFileSync(join(d.profile, 'package.json'), 'utf8')
  await assert.rejects(incremental.applyProfilePlan({ ...d, stagedDir: prepared.stagedDir }), /已改变/)
  assert.equal(readFileSync(join(d.profile, 'package.json'), 'utf8'), before)
})

test('an enclosing transaction retains the shared apply lock across profile application', async t => {
  const { acquireApplyLock, readApplyLock, releaseApplyLock } = await import('../lib/core/apply-lock.js')
  const d = setup(t), plugin = archive(d.root, 'managed-fixture', 'export {}\n')
  const prepared = await stage(d, [plugin])
  const owner = await acquireApplyLock(d.home, 'whole-transaction')
  try {
    await incremental.applyProfilePlan({ ...d, stagedDir: prepared.stagedDir, lockOwner: owner })
    assert.equal((await readApplyLock(d.home))?.owner, owner)
  } finally { await releaseApplyLock(d.home, owner) }
})

test('feat115-r2-1 a physical profile behind a profiles symlink always uses the explicit DSH home lock, including a second install', async t => {
  const { acquireApplyLock, readApplyLock, releaseApplyLock } = await import('../lib/core/apply-lock.js')
  const d = setup(t), linked = join(d.root, 'external', 'profiles')
  mkdirSync(dirname(linked)); renameSync(join(d.home, 'profiles'), linked)
  symlinkSync(linked, join(d.home, 'profiles'), 'dir'); d.profile = realpathSync(d.profile)
  const plugin = archive(d.root, 'managed-fixture', 'export const linked = true\n')
  let previous
  for (let count = 0; count < 2; count++) {
    const prepared = await stage(d, [plugin], previous), owner = await acquireApplyLock(d.home, 'linked-install')
    try { await incremental.applyProfilePlan({ ...d, stagedDir: prepared.stagedDir, lockOwner: owner }) }
    finally { await releaseApplyLock(d.home, owner) }
    previous = prepared.snapshot
  }
  assert.equal(await readApplyLock(d.home), null)
  assert.equal(existsSync(join(dirname(linked), 'plugin-sync', 'apply.lock')), false)
  assert.match(readFileSync(join(d.profile, 'node_modules/managed-fixture/index.js'), 'utf8'), /linked = true/)
})

test('feat115-peer changing a consumer preserves its unchanged providers and nested peer bindings', async t => {
  const d = setup(t)
  const leaf = archive(d.root, 'peer-leaf', 'export const value = 1\n')
  const provider = archive(d.root, 'peer-provider', 'export { value } from "peer-leaf"\n', { peerDependencies: { 'peer-leaf': '^1.0.0' } })
  const original = archive(d.root, 'peer-consumer', 'export const revision = "first"\n', { peerDependencies: { 'peer-provider': '^1.0.0' } })
  const initial = await stage(d, [leaf, provider, original])
  await incremental.applyProfilePlan({ ...d, stagedDir: initial.stagedDir })
  const before = parse(readFileSync(join(d.profile, 'pnpm-lock.yaml'), 'utf8'))
  const providerRef = before.importers['.'].dependencies['peer-provider'].version
  assert.ok(providerRef.includes('(peer-leaf@'), 'the initial provider has its own peer binding')
  assert.ok(before.importers['.'].dependencies['peer-consumer'].version.includes('(peer-provider@'))
  const changed = archive(d.root, 'peer-consumer', 'export const revision = "second"\n', { peerDependencies: { 'peer-provider': '^1.0.0' } })
  const update = await stage(d, [leaf, provider, changed], initial.snapshot)
  assert.deepEqual(update.plan.plugins.map(plugin => plugin.name), ['peer-consumer'], 'only actual changed content is selected')
  await incremental.applyProfilePlan({ ...d, stagedDir: update.stagedDir })
  assert.match(readFileSync(join(d.profile, 'node_modules/peer-consumer/index.js'), 'utf8'), /second/)
  const after = parse(readFileSync(join(d.profile, 'pnpm-lock.yaml'), 'utf8'))
  const deps = after.importers['.'].dependencies
  assert.deepEqual(deps['peer-provider'], before.importers['.'].dependencies['peer-provider'])
  assert.deepEqual(deps['peer-leaf'], before.importers['.'].dependencies['peer-leaf'])
  assert.ok(deps['peer-consumer'].version.includes('(peer-provider@'), 'upgrading content must not strip the unchanged provider binding')
  assert.equal(after.snapshots['peer-consumer@' + deps['peer-consumer'].version].dependencies['peer-provider'], providerRef)
  await d.runDsh(['install', '--no-frozen-lockfile', '--ignore-scripts'])
  const normalized = parse(readFileSync(join(d.profile, 'pnpm-lock.yaml'), 'utf8'))
  assert.deepEqual(normalized.importers['.'].dependencies, deps, 'a subsequent ordinary pnpm operation must not repair missing peer bindings')
})

// These fixtures use the same optional peer chain as Workbench + the LSP option,
// with local archives so all resolution and follow-up operations stay offline.
function peerOptionFixture(t) {
  const d = setup(t)
  const peers = { 'option-lsp': '*', 'option-stdio': '*', 'option-tool': '*' }
  const metadata = Object.fromEntries(Object.keys(peers).map(name => [name, { optional: true }]))
  const lsp = archive(d.root, 'option-lsp', 'export const version = 1\n')
  const stdio = archive(d.root, 'option-stdio', 'export {}\n', { peerDependencies: { 'option-lsp': '*' } })
  const tool = archive(d.root, 'option-tool', 'export {}\n', { peerDependencies: { 'option-lsp': '*' } })
  const consumer = archive(d.root, 'option-consumer', 'export const unchanged = true\n', { peerDependencies: peers, peerDependenciesMeta: metadata })
  const outer = archive(d.root, 'option-outer', 'export const untouched = true\n', { peerDependencies: { 'option-consumer': '*' } })
  const unrelated = archive(d.root, 'option-unrelated', 'export const keep = true\n')
  return { ...d, providers: [lsp, stdio, tool], consumers: [consumer, outer], unrelated }
}
const readLock = d => parse(readFileSync(join(d.profile, 'pnpm-lock.yaml'), 'utf8'))
async function assertOrdinaryOperationsKeepBindings(d) {
  const before = readLock(d), other = archive(d.root, 'later-plugin', 'export {}\n')
  write(join(d.profile, 'local-plugins', other.file), readFileSync(join(d.root, 'packages', other.file)))
  await d.runDsh(['add', other.spec, '--ignore-scripts'])
  for (const name of Object.keys(before.importers['.'].dependencies)) {
    assert.deepEqual(readLock(d).importers['.'].dependencies[name], before.importers['.'].dependencies[name], 'ordinary add must not repair ' + name)
  }
  await d.runDsh(['remove', other.name, '--config.ignore-scripts=true'])
  const after = readLock(d)
  assert.deepEqual(after.importers, before.importers, 'ordinary remove keeps bindings')
  assert.deepEqual(after.packages, before.packages)
  assert.deepEqual(after.snapshots, before.snapshots)
}

test('feat115-r3-1 provider version upgrade rebinds unchanged consumers without nested old copies', async t => {
  const d = peerOptionFixture(t)
  const initial = await stage(d, [...d.providers, ...d.consumers, d.unrelated])
  await incremental.applyProfilePlan({ ...d, stagedDir: initial.stagedDir })
  const oldLock = readLock(d), own = readFileSync(join(d.profile, 'node_modules/option-consumer/index.js'))
  const newer = archive(d.root, 'option-lsp', 'export const version = 2\n', { version: '2.0.0' })
  const update = await stage(d, [newer, ...d.providers.slice(1), ...d.consumers, d.unrelated], initial.snapshot)
  assert.deepEqual(update.plan.plugins.map(p => p.name), ['option-lsp'])
  await incremental.applyProfilePlan({ ...d, stagedDir: update.stagedDir })
  const lock = readLock(d), deps = lock.importers['.'].dependencies
  assert.equal(JSON.parse(readFileSync(join(d.profile, 'node_modules/option-lsp/package.json'))).version, '2.0.0')
  for (const name of ['option-stdio', 'option-tool', 'option-consumer', 'option-outer']) {
    assert.ok(deps[name].version.includes('option-lsp@' + newer.spec), name + ' includes the new provider')
    assert.equal(existsSync(join(d.profile, 'node_modules', name, 'node_modules/option-lsp')), false, 'no nested old provider')
  }
  assert.deepEqual(readFileSync(join(d.profile, 'node_modules/option-consumer/index.js')), own)
  assert.deepEqual(deps['option-unrelated'], oldLock.importers['.'].dependencies['option-unrelated'])
  assert.ok(!JSON.stringify(lock.packages).includes(d.providers[0].file), 'old provider archive is unreachable')
  await assertOrdinaryOperationsKeepBindings(d)
})

test('feat115-r3-1 removing the LSP peer option removes providers before the next plugin operation', async t => {
  const d = peerOptionFixture(t)
  const initial = await stage(d, [...d.providers, ...d.consumers, d.unrelated])
  await incremental.applyProfilePlan({ ...d, stagedDir: initial.stagedDir })
  const update = await stage(d, [...d.consumers, d.unrelated], initial.snapshot)
  assert.equal(update.plan.plugins.length, 0, 'only removals, no changed consumer archives')
  await incremental.applyProfilePlan({ ...d, stagedDir: update.stagedDir })
  const lock = readLock(d)
  for (const p of d.providers) {
    assert.equal(existsSync(join(d.profile, 'node_modules', p.name)), false, p.name + ' really removed')
    assert.ok(!Object.keys(lock.packages).some(k => k.startsWith(p.name + '@')))
    assert.ok(!Object.keys(lock.snapshots).some(k => k.startsWith(p.name + '@')))
  }
  assert.equal(lock.importers['.'].dependencies['option-consumer'].version, d.consumers[0].spec)
  await assertOrdinaryOperationsKeepBindings(d)
})

test('feat115-r3-1 adding the LSP peer option binds unchanged consumers immediately', async t => {
  const d = peerOptionFixture(t)
  const initial = await stage(d, [...d.consumers, d.unrelated])
  await incremental.applyProfilePlan({ ...d, stagedDir: initial.stagedDir })
  const update = await stage(d, [...d.providers, ...d.consumers, d.unrelated], initial.snapshot)
  assert.deepEqual(update.plan.plugins.map(p => p.name).sort(), d.providers.map(p => p.name).sort())
  await incremental.applyProfilePlan({ ...d, stagedDir: update.stagedDir })
  const lock = readLock(d), deps = lock.importers['.'].dependencies
  for (const p of d.providers) assert.ok(deps['option-consumer'].version.includes('(' + p.name + '@' + deps[p.name].version + ')'))
  assert.ok(deps['option-outer'].version.includes(deps['option-consumer'].version))
  await assertOrdinaryOperationsKeepBindings(d)
})

test('feat115-r3-review a nested dependency keeps its stable second peer when the first provider upgrades', async t => {
  const d = setup(t)
  const p = archive(d.root, 'nested-provider-p', 'export const version = 1\n')
  const q = archive(d.root, 'nested-provider-q', 'export const stable = true\n')
  const nested = archive(d.root, 'nested-peer', 'export {}\n', { peerDependencies: { [p.name]: '*', [q.name]: '*' } })
  const consumer = archive(d.root, 'regular-consumer', 'export const unchanged = true\n', { dependencies: { [nested.name]: 'file:' + join(d.root, 'packages', nested.file) } })
  const initial = await stage(d, [p, q, consumer])
  await incremental.applyProfilePlan({ ...d, stagedDir: initial.stagedDir })
  const before = readLock(d), newer = archive(d.root, p.name, 'export const version = 2\n', { version: '2.0.0' })
  const update = await stage(d, [newer, q, consumer], initial.snapshot)
  await incremental.applyProfilePlan({ ...d, stagedDir: update.stagedDir })
  const lock = readLock(d), nestedKey = Object.keys(lock.snapshots).find(key => key.startsWith('nested-peer@'))
  assert.equal(lock.snapshots[nestedKey].dependencies[q.name], lock.importers['.'].dependencies[q.name].version, 'stable peer Q must be supplied to nested resolution')
  assert.equal(lock.snapshots[nestedKey].dependencies[p.name], lock.importers['.'].dependencies[p.name].version)
  assert.deepEqual(lock.importers['.'].dependencies[q.name], before.importers['.'].dependencies[q.name])
  await assertOrdinaryOperationsKeepBindings(d)
})

test('feat115-r3-review enabling an unchanged consumer while removing its peer option still rebinds it', async t => {
  const d = peerOptionFixture(t), consumer = { ...d.consumers[0], bundle: true, selected: true }
  const initial = await stage(d, [...d.providers, consumer])
  await incremental.applyProfilePlan({ ...d, stagedDir: initial.stagedDir })
  const manifest = JSON.parse(readFileSync(join(d.profile, 'package.json')))
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== consumer.name)
  json(join(d.profile, 'package.json'), manifest)
  const update = await stage(d, [consumer], initial.snapshot)
  assert.equal(update.plan.plugins.length, 0)
  assert.equal(update.plan.untouched.includes(consumer.name), false, 'bundle-only selection is outside untouched')
  await incremental.applyProfilePlan({ ...d, stagedDir: update.stagedDir })
  assert.ok(JSON.parse(readFileSync(join(d.profile, 'package.json'))).dsh.profile.bundles.includes(consumer.name))
  const lock = readLock(d)
  assert.equal(lock.importers['.'].dependencies[consumer.name].version, consumer.spec)
  for (const p of d.providers) assert.ok(!Object.keys(lock.packages).some(key => key.startsWith(p.name + '@')))
  await assertOrdinaryOperationsKeepBindings(d)
})
