import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse, stringify } from 'yaml'
import { assertPlanAllowed, stageApplyPlan, verifyApplied } from '../lib/core/apply.js'
import { manifestCatalog } from '../lib/core/catalog.js'
import { exportSnapshot } from '../lib/core/export.js'
import { buildChanges, createApplyPlan, validateSnapshot } from '../lib/core/plan.js'
import { previewEntries } from '../lib/core/view.js'
import { defaultSelection, selectedChangeIds } from '../lib/client/model.js'

const version = '0.2.2-rc.3'
const pairs = [
  ['dsh-plugin-sync', '@miint-sunny/dsh-plugin-sync'],
  ['dsh-workbench', '@miint-sunny/dsh-workbench'],
  ['dsh-media-look', '@miint-sunny/dsh-media-look'],
  ['dsh-model-settings', '@miint-sunny/dsh-model-settings'],
  ['dsh-session-title-headtail', '@miint-sunny/dsh-session-title-headtail'],
  ['dsh-nai5-prompting', '@miint-sunny/dsh-nai-desk'],
  ...['usage', 'checkpoints', 'review', 'navigation', 'pages', 'settings', 'essentials'].map(part => [`dsh-workbench-${part}`, `@miint-sunny/dsh-workbench-${part}`]),
]
const emptyLock = "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\nsnapshots: {}\n"
const project = fileURLToPath(new URL('..', import.meta.url))
const sha = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64')
function write(file, value) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value) }
function snapshot(names = []) {
  return {
    format: 'dsh-plugin-sync/snapshot-2', createdAt: '2026-11-15T00:00:00Z', machine: 'Source', machineId: 'source',
    exporter: { name: 'dsh-plugin-sync', version: '0.4.0' }, dsh: { desktopVersion: version }, excluded: [],
    profiles: { desktop: {
      plugins: names.map(name => ({ name, version: '1.0.0', spec: '1.0.0', source: 'npm', bundle: true, selected: true })),
      bundles: names, official: [], rows: [], exemptions: {}, workspace: {}, patches: {}, lockfile: emptyLock,
    } },
  }
}
function local(names) {
  return { manifest: { dependencies: Object.fromEntries(names.map(name => [name, '1.0.0'])), dsh: { profile: { bundles: names } } }, versions: Object.fromEntries(names.map(name => [name, '1.0.0'])) }
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sync-aliases-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

// Restoring literal-name comparison must offer install+remove (or install+local-only)
// instead of the single migration, and these real preview/plan assertions catch it.
for (const direction of ['old-to-scoped', 'scoped-to-old']) {
  test(`mixed-name ${direction} import is one atomic selectable change, including sync itself`, async () => {
    for (const pair of pairs) {
      const [source, target] = direction === 'old-to-scoped' ? pair : [...pair].reverse()
      const options = { snapshot: snapshot([target]), previous: snapshot([source]), local: local([source]), currentDesktopVersion: version }
      const set = buildChanges(options)
      assert.deepEqual(set.changes.map(change => [change.kind, change.name, change.replaces]), [['rename', target, source]])
      assert.deepEqual(set.unchanged, [])
      const preview = previewEntries(set, options.snapshot, manifestCatalog(options.local.manifest), options.local.versions, () => ['fixture-build'])
      assert.equal(preview.plugins.length, 1)
      assert.equal(preview.plugins[0].name, target)
      assert.equal(preview.plugins[0].localVersion, '1.0.0')
      assert.deepEqual(preview.plugins[0].newBuildPermissions, ['fixture-build'])
      const selected = selectedChangeIds(preview.plugins, defaultSelection(preview.plugins))
      assert.equal(selected.length, 1)
      const plan = await createApplyPlan({ ...options, selected })
      assert.deepEqual(plan.manifest.dependencies, { [target]: '1.0.0' })
      assert.deepEqual(plan.manifest.dsh.profile.bundles, [target])
      assert.deepEqual(plan.removed, [source])
      assert.deepEqual(plan.plugins.map(plugin => plugin.name), [target])
      assert.deepEqual(plan.untouched, [])
      assert.doesNotThrow(() => assertPlanAllowed(plan))
      const skipped = await createApplyPlan({ ...options, selected: selectedChangeIds(preview.plugins, new Set()) })
      assert.deepEqual(skipped.manifest, options.local.manifest)
      assert.deepEqual(skipped.removed, [])
      assert.deepEqual(skipped.plugins, [])
      await assert.rejects(createApplyPlan({ ...options, selected: [`plugin:${source}`] }), /不存在的变更/)
    }
  })
}

test('a receiver with no previous snapshot replaces its existing alias instead of duplicating it', async () => {
  for (const [source, target] of [pairs[5], [...pairs[5]].reverse()]) {
    const options = { snapshot: snapshot([target]), local: local([source]), currentDesktopVersion: version }
    const set = buildChanges(options)
    assert.deepEqual(set.changes.map(change => [change.kind, change.replaces]), [['rename', source]])
    const plan = await createApplyPlan({ ...options, selected: set.changes.map(change => change.id) })
    assert.deepEqual(plan.manifest.dependencies, { [target]: '1.0.0' })
    assert.deepEqual(plan.removed, [source])
  }
})

test('previous remains a name-only history contract for installer adapters that track both aliases', () => {
  const [source, target] = pairs[1]
  const previous = snapshot([target])
  // kitPreviousSnapshot appends original installed names for managed removal;
  // these historical records intentionally have no version/spec/source fields.
  previous.profiles.desktop.plugins.push({ name: source })
  const options = { previous, local: local([source]), currentDesktopVersion: version, protectedPlugins: [] }
  const migration = buildChanges({ ...options, snapshot: snapshot([target]) })
  assert.deepEqual(migration.changes.map(change => [change.kind, change.name, change.replaces]), [['rename', target, source]])
  const removal = buildChanges({ ...options, snapshot: snapshot() })
  assert.deepEqual(removal.changes.map(change => [change.kind, change.name]), [['remove', source]])
})

test('rename preserves the source bundle position and keeps a lower target version unselected', async () => {
  const [source, target] = pairs[1]
  const incoming = snapshot([target])
  incoming.profiles.desktop.plugins[0].version = '0.9.0'
  const here = local(['before-plugin', source, 'after-plugin'])
  const options = { snapshot: incoming, local: here, currentDesktopVersion: version }
  const set = buildChanges(options)
  assert.equal(set.changes.length, 1)
  assert.equal(set.changes[0].defaultOn, false)
  assert.equal(set.changes[0].downgrade, true)
  const plan = await createApplyPlan({ ...options, selected: [set.changes[0].id] })
  assert.deepEqual(plan.manifest.dsh.profile.bundles, ['before-plugin', target, 'after-plugin'])
  assert.deepEqual(plan.untouched, ['after-plugin', 'before-plugin'])
})

test('real export feeds either mixed-name endpoint a complete atomic rename plan', async t => {
  const root = fixture(t)
  for (const index of [0, 1]) {
    const targetNames = pairs.map(pair => pair[index]), sourceNames = pairs.map(pair => pair[1 - index])
    const profile = join(root, `profile-${index}`)
    write(join(profile, 'package.json'), JSON.stringify(local(targetNames).manifest))
    write(join(profile, 'pnpm-lock.yaml'), stringify({ lockfileVersion: '9.0', importers: { '.': { dependencies: Object.fromEntries(targetNames.map(name => [name, { specifier: '1.0.0', version: '1.0.0' }])) } }, packages: {}, snapshots: {} }))
    const { snapshot: exported } = await exportSnapshot({ profileDir: profile, outputDir: join(root, `snapshot-${index}`), machine: 'Source', machineId: 'source', desktopVersion: version })
    const options = { snapshot: exported, local: local(sourceNames), currentDesktopVersion: version }
    const set = buildChanges(options)
    assert.equal(set.changes.length, 13)
    assert.ok(set.changes.every(change => change.kind === 'rename'))
    const plan = await createApplyPlan({ ...options, selected: set.changes.map(change => change.id) })
    assert.deepEqual(Object.keys(plan.manifest.dependencies).sort(), [...targetNames].sort())
    assert.deepEqual(plan.removed.sort(), [...sourceNames].sort())
    assert.deepEqual(plan.manifest.dsh.profile.bundles, targetNames)
  }
})

test('a cross-name snapshot exclusion prevents removal of either installed alias', () => {
  for (const pair of pairs) for (const [source, excluded] of [pair, [...pair].reverse()]) {
    const incoming = snapshot(); incoming.excluded = [excluded]
    const set = buildChanges({ snapshot: incoming, previous: snapshot([source]), local: local([source]), currentDesktopVersion: version })
    assert.deepEqual(set.changes, [])
    assert.deepEqual(set.unchanged, [{ name: source, reason: 'not-exported' }])
  }
})

test('cross-name export exclusions remove the package, rows, exemption, patch and lock entries', async t => {
  const root = fixture(t)
  for (const [index, [excluded, installed]] of [pairs[5], [...pairs[5]].reverse()].entries()) {
    const profile = join(root, `profile-${index}`)
    write(join(profile, 'package.json'), JSON.stringify(local([installed]).manifest))
    write(join(profile, 'pnpm-lock.yaml'), stringify({ lockfileVersion: '9.0', importers: { '.': { dependencies: { [installed]: { specifier: '1.0.0', version: '1.0.0' } }, devDependencies: { [excluded]: { specifier: '1.0.0', version: '1.0.0' } } } }, packages: { [`${installed}@1.0.0`]: { resolution: { integrity: 'sha512-Zml4dHVyZQ==' } }, [`${excluded}@1.0.0`]: {} }, snapshots: { [`${installed}@1.0.0`]: {}, [`${excluded}@1.0.0`]: {} } }))
    write(join(profile, 'cordis.patch.yml'), stringify([{ id: 'nai-component', name: excluded + '/host', disabled: true }]))
    write(join(profile, 'compatibility.json'), JSON.stringify({ [`${installed}@1.0.0`]: [version] }))
    write(join(profile, 'pnpm-workspace.yaml'), stringify({ patchedDependencies: { [`${installed}@1.0.0`]: 'patches/nai.patch' }, allowBuilds: { [installed]: true }, overrides: { [installed]: '1.0.0' } }))
    write(join(profile, 'patches/nai.patch'), 'fixture patch\n')
    const { snapshot: exported } = await exportSnapshot({ profileDir: profile, outputDir: join(root, `snapshot-${index}`), machine: 'Source', machineId: 'source', desktopVersion: version, excluded: [excluded] })
    assert.deepEqual(exported.excluded, [installed])
    assert.deepEqual(exported.profiles.desktop.plugins, [])
    assert.deepEqual(exported.profiles.desktop.bundles, [])
    assert.deepEqual(exported.profiles.desktop.rows, [])
    assert.deepEqual(exported.profiles.desktop.exemptions, {})
    assert.deepEqual(exported.profiles.desktop.patches, {})
    assert.deepEqual(exported.profiles.desktop.workspace, { patchedDependencies: {}, allowBuilds: {}, overrides: {} })
    assert.deepEqual(parse(exported.profiles.desktop.lockfile).importers['.'].dependencies, {})
    assert.deepEqual(parse(exported.profiles.desktop.lockfile).importers['.'].devDependencies, {})
    assert.deepEqual(parse(exported.profiles.desktop.lockfile).packages, {})
    assert.equal(validateSnapshot(exported), exported)
  }
})

test('installed-result verification rejects a surviving counterpart alias', async t => {
  const root = fixture(t), profile = join(root, 'profile'), [source, target] = pairs[1]
  write(join(profile, 'package.json'), JSON.stringify(local([target]).manifest))
  write(join(profile, 'pnpm-lock.yaml'), emptyLock)
  for (const name of [source, target]) write(join(profile, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  await assert.rejects(verifyApplied(profile, { manifest: local([target]).manifest, plugins: snapshot([target]).profiles.desktop.plugins, workspaceYaml: '{}', patches: {} }), /冲突|并存|只保留/)
})

test('conflicting old and scoped aliases are rejected at snapshot, export and apply boundaries', async t => {
  const pair = pairs[1], root = fixture(t)
  assert.throws(() => validateSnapshot(snapshot(pair)), /冲突|重复/)
  assert.throws(() => buildChanges({ snapshot: snapshot(), local: local(pair), currentDesktopVersion: version }), /冲突|重复/)
  const excluded = snapshot([pair[1]]); excluded.excluded = [pair[0]]
  assert.throws(() => validateSnapshot(excluded), /不导出/)
  const bundles = snapshot([pair[1]]); bundles.profiles.desktop.bundles.push(pair[0])
  assert.throws(() => validateSnapshot(bundles), /冲突|重复/)
  const lockConflict = snapshot([pair[1]])
  lockConflict.profiles.desktop.lockfile = stringify({ lockfileVersion: '9.0', packages: { [`${pair[0]}@1.0.0`]: {}, [`${pair[1]}@1.0.0`]: {} } })
  assert.throws(() => validateSnapshot(lockConflict), /冲突|重复/)
  const profile = join(root, 'profile')
  write(join(profile, 'package.json'), JSON.stringify(local(pair).manifest))
  write(join(profile, 'pnpm-lock.yaml'), emptyLock)
  await assert.rejects(exportSnapshot({ profileDir: profile, outputDir: join(root, 'snapshot'), machine: 'Source', machineId: 'source', desktopVersion: version }), /冲突|重复/)
  const options = { snapshot: snapshot([pair[1]]), local: local([pair[0]]), currentDesktopVersion: version }
  const set = buildChanges(options)
  const plan = await createApplyPlan({ ...options, selected: set.changes.map(change => change.id) })
  const duplicate = structuredClone(plan); duplicate.manifest.dependencies[pair[0]] = '1.0.0'
  assert.throws(() => assertPlanAllowed(duplicate), /冲突|重复/)
  const half = structuredClone(plan); half.removed = []
  assert.throws(() => assertPlanAllowed(half), /换名|卸载/)
  await assert.rejects(stageApplyPlan({ plan: duplicate, sourceDir: root, stagedDir: join(root, 'stage') }), /冲突|重复/)
  assert.equal(existsSync(join(root, 'stage')), false)
})

test('default self protection still blocks standalone removal after alias-aware planning', () => {
  for (const name of pairs[0]) {
    const options = { snapshot: snapshot(), previous: snapshot([name]), local: local([name]), currentDesktopVersion: version }
    assert.deepEqual(buildChanges(options).changes, [])
    assert.deepEqual(buildChanges({ ...options, protectedPlugins: [] }).changes.map(change => change.kind), ['remove'])
  }
})

// This uses the real detached worker from the package that the transaction moves
// away, and the App's real offline CLI, so in-memory test doubles cannot hide an
// import failure or a half-migrated installed profile.
for (const [source, target] of [pairs[0], [...pairs[0]].reverse()]) test(`detached self rename to ${target} survives moving its own package and installs only the target identity`, async t => {
  const app = process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app'
  const cli = join(app, 'Contents/Resources/runtime/cli/bin/dsh')
  if (!existsSync(cli)) { t.skip('requires an existing DSH App copy'); return }
  const root = fixture(t), home = join(root, 'home'), profile = join(home, 'profiles/desktop')
  const old = join(profile, 'node_modules', source)
  cpSync(join(project, 'lib'), join(old, 'lib'), { recursive: true })
  write(join(old, 'package.json'), JSON.stringify({ name: source, version: '1.0.0', type: 'module' }))
  symlinkSync(join(project, 'node_modules'), join(old, 'node_modules'), 'dir')
  // The plan rewrites pnpm-workspace.yaml from the local workspace, so the fixture store has to be part of it.
  // Otherwise the install falls back to the account's global pnpm store and records this profile in its projects/.
  const localState = { ...local([source]), workspace: { packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false, storeDir: join(root, 'store'), cacheDir: join(root, 'cache') } }
  write(join(profile, 'package.json'), JSON.stringify(localState.manifest))
  write(join(profile, 'pnpm-lock.yaml'), emptyLock)
  write(join(profile, 'pnpm-workspace.yaml'), stringify(localState.workspace))
  write(join(profile, 'cordis.patch.yml'), '[]\n')
  const pkg = join(root, 'target/package')
  write(join(pkg, 'package.json'), JSON.stringify({ name: target, version: '1.0.0', type: 'module', main: 'index.js' }))
  write(join(pkg, 'index.js'), 'export const migrated = true\n')
  const file = 'sync-target.tgz', archive = join(root, 'packages', file)
  mkdirSync(dirname(archive), { recursive: true }); execFileSync('tar', ['-czf', archive, '-C', dirname(pkg), 'package'])
  const incoming = snapshot([target])
  incoming.profiles.desktop.plugins[0] = { name: target, version: '1.0.0', source: 'packed', file, spec: `file:local-plugins/${file}`, integrity: sha(readFileSync(archive)), bundle: true, selected: true }
  const options = { snapshot: incoming, local: localState, currentDesktopVersion: version }
  const changes = buildChanges(options).changes
  assert.deepEqual(changes.map(change => change.kind), ['rename'])
  const plan = await createApplyPlan({ ...options, selected: changes.map(change => change.id) })
  const stagedDir = join(root, 'stage')
  await stageApplyPlan({ plan, sourceDir: root, stagedDir })
  const output = execFileSync(process.execPath, [join(old, 'lib/apply-process.js'), '--staged', stagedDir, '--home', home, '--app', app, '--no-app'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: undefined, npm_config_offline: 'true', DSH_HOME: home }, timeout: 90_000 })
  assert.match(output, /应用成功/)
  const actual = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.deepEqual(actual.dependencies, { [target]: `file:local-plugins/${file}` })
  assert.deepEqual(actual.dsh.profile.bundles, [target])
  assert.equal(existsSync(old), false)
  assert.equal(JSON.parse(readFileSync(join(profile, 'node_modules', target, 'package.json'), 'utf8')).name, target)
})
