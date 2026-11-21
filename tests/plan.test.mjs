import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse, stringify } from 'yaml'
import { catalogOf } from '../lib/core/catalog.js'
import { commitSnapshot, writeZip } from '../lib/core/export.js'
import { buildChanges, createApplyPlan, readSnapshot, validateSnapshot, versionOrder } from '../lib/core/plan.js'
import { previewEntries } from '../lib/core/view.js'

const VERSION = '0.2.1-rc.5'
const SEARCH = '@deepseek-ai/dsh-experimental-session-search'
const WORKTREE = '@deepseek-ai/dsh-experimental-tool-worktree'

function plugin(name, version, extra = {}) {
  return { name, version, spec: `${name}@${version}`, source: 'npm', integrity: 'sha512-YWxwaGE=', bundle: true, selected: true, ...extra }
}

function snapshot(plugins = [plugin('alpha', '2.0.0')], extra = {}) {
  return {
    format: 'dsh-plugin-sync/snapshot-2',
    createdAt: '2026-11-01T12:00:00.000Z',
    machine: 'Test Mac A',
    machineId: 'source-mac',
    exporter: { name: 'dsh-plugin-sync', version: '0.4.0' },
    dsh: { desktopVersion: VERSION },
    profiles: {
      desktop: {
        plugins,
        official: [],
        bundles: ['@deepseek-ai/dsh-base', ...plugins.filter(entry => entry.selected).map(entry => entry.name)],
        rows: [],
        exemptions: {},
        workspace: { patchedDependencies: {}, allowBuilds: {}, overrides: {} },
        patches: {},
        lockfile: "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\nsnapshots: {}\n",
      },
    },
    excluded: [],
    ...extra,
  }
}

function local(dependencies, bundles = ['@deepseek-ai/dsh-base', ...Object.keys(dependencies)], extra = {}) {
  const versions = Object.fromEntries(Object.entries(dependencies).filter(([, spec]) => /^\d/.test(spec)))
  return { manifest: { name: 'dsh-profile-desktop', private: true, dependencies, dsh: { profile: { bundles } } }, versions, rows: {}, ...extra }
}

function changes(options) {
  return buildChanges({ currentDesktopVersion: VERSION, ...options })
}

function plan(options) {
  return createApplyPlan({ currentDesktopVersion: VERSION, ...options })
}

function summary(set) {
  return set.changes.map(change => `${change.kind}:${change.name}${change.defaultOn ? '' : '(off)'}`)
}

test('changes cover install, upgrade, downgrade and unchanged plugins with their defaults', () => {
  const set = changes({
    snapshot: snapshot([plugin('alpha', '2.0.0'), plugin('beta', '1.0.0'), plugin('same', '1.0.0'), plugin('fresh', '1.0.0')]),
    local: local({ alpha: '1.0.0', beta: '3.0.0', same: '1.0.0', mine: '1.0.0' }),
  })
  assert.deepEqual(summary(set), ['upgrade:alpha', 'downgrade:beta(off)', 'install:fresh'])
  assert.deepEqual(set.unchanged, [{ name: 'same', reason: 'same' }, { name: 'mine', reason: 'local-only' }])
  assert.ok(set.changes.every(change => change.owner === change.name))
})

test('a plugin is offered for uninstalling only when the last import from the same machine had it and the source did not leave it out', () => {
  const incoming = snapshot([plugin('alpha', '1.0.0')])
  const previous = snapshot([plugin('alpha', '1.0.0'), plugin('gone', '1.0.0')])
  const here = local({ alpha: '1.0.0', gone: '1.0.0', mine: '1.0.0', 'dsh-plugin-sync': 'link:/x' })
  assert.deepEqual(summary(changes({ snapshot: incoming, local: here, previous })), ['remove:gone'])
  assert.deepEqual(summary(changes({ snapshot: incoming, local: here })), [])
  const otherMachine = { ...previous, machineId: 'third-mac', machine: '第三台' }
  assert.deepEqual(summary(changes({ snapshot: incoming, local: here, previous: otherMachine })), [])
  const leftOut = changes({ snapshot: { ...incoming, excluded: ['gone'] }, local: here, previous })
  assert.deepEqual(summary(leftOut), [])
  assert.deepEqual(leftOut.unchanged.find(entry => entry.name === 'gone'), { name: 'gone', reason: 'not-exported' })
})

test('plugins outside the chosen changes keep their specs and bundle positions, and the plan names them', async () => {
  const incoming = snapshot([plugin('alpha', '2.0.0'), plugin('subscriptions', '1.0.0')])
  const here = local(
    { alpha: '1.0.0', 'fixture-private-a': 'link:/fixture-private-a', 'fixture-private-b': 'link:/fixture-private-b', subscriptions: '1.0.0', keepme: '1.0.0' },
    ['@deepseek-ai/dsh-base', 'fixture-private-b', 'fixture-private-a', 'alpha', 'subscriptions', 'keepme'],
  )
  const set = changes({ snapshot: incoming, local: here })
  assert.deepEqual(summary(set), ['upgrade:alpha'])
  assert.deepEqual(set.unchanged.map(entry => `${entry.name}:${entry.reason}`), ['subscriptions:same', 'fixture-private-a:local-only', 'fixture-private-b:local-only', 'keepme:local-only'])
  const result = await plan({ snapshot: incoming, local: here, selected: ['plugin:alpha'] })
  assert.deepEqual(Object.keys(result.manifest.dependencies), ['alpha', 'fixture-private-a', 'fixture-private-b', 'subscriptions', 'keepme'])
  assert.equal(result.manifest.dependencies['fixture-private-b'], 'link:/fixture-private-b')
  assert.deepEqual(result.manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'fixture-private-b', 'fixture-private-a', 'alpha', 'subscriptions', 'keepme'])
  assert.deepEqual(result.untouched, ['@deepseek-ai/dsh-base', 'fixture-private-a', 'fixture-private-b', 'keepme', 'subscriptions'])
  await assert.rejects(plan({ snapshot: incoming, local: here, selected: ['plugin:fixture-private-b'] }), /不存在的变更/)
})

test('a snapshot in another format, or one that lists a plugin it left out, is rejected', () => {
  assert.throws(() => validateSnapshot({ ...snapshot(), format: 'dsh-plugin-sync/snapshot-1' }), /快照格式.*不支持/)
  assert.throws(() => validateSnapshot(snapshot([plugin('fixture-private-b', '0.1.0')], { excluded: ['fixture-private-b'] })), /不导出/)
  const withRow = snapshot()
  withRow.profiles.desktop.rows = [{ id: 'private-b-host', disabled: true, owner: 'fixture-private-b' }]
  assert.throws(() => validateSnapshot({ ...withRow, excluded: ['fixture-private-b'] }), /不导出插件的组件/)
  const packedAbsolute = plugin('packed', '1.0.0', { source: 'packed', file: 'packed-1.0.0.tgz', spec: 'file:/Users/x/packed-1.0.0.tgz' })
  assert.throws(() => validateSnapshot(snapshot([packedAbsolute])), /相对路径/)
})

test('bundle selections follow the source for third-party plugins and for the official plugins it exported', () => {
  const incoming = snapshot([plugin('alpha', '1.0.0', { selected: false }), plugin('beta', '1.0.0')])
  incoming.profiles.desktop.official = [{ name: SEARCH, enabled: true }, { name: WORKTREE, enabled: false }]
  const here = local({ alpha: '1.0.0', beta: '1.0.0' }, ['@deepseek-ai/dsh-base', WORKTREE, 'alpha'])
  assert.deepEqual(summary(changes({ snapshot: incoming, local: here })), ['disable:alpha', 'enable:beta', `enable:${SEARCH}`, `disable:${WORKTREE}`])
  const withoutSearch = changes({ snapshot: incoming, local: { ...here, official: [WORKTREE, '@deepseek-ai/dsh-experimental-voice'] } })
  assert.deepEqual(summary(withoutSearch), ['disable:alpha', 'enable:beta', `disable:${WORKTREE}`])
  assert.match(withoutSearch.warnings[0], /在本机不可用/)
  assert.deepEqual(withoutSearch.unchanged, [{ name: '@deepseek-ai/dsh-experimental-voice', reason: 'local-only' }])
})

test('component switches compare with this machine and skip rows whose plugin is absent', async () => {
  const incoming = snapshot([plugin('alpha', '1.0.0'), plugin('fresh', '1.0.0')])
  incoming.profiles.desktop.official = [{ name: SEARCH, enabled: false }]
  incoming.profiles.desktop.rows = [
    { id: 'alpha-feature', name: 'alpha', disabled: true, owner: 'alpha', title: { en: 'Feature', zh: '功能' } },
    { id: 'alpha-same', disabled: true, owner: 'alpha' },
    { id: 'official-row', disabled: false, owner: SEARCH },
    { id: 'fresh-row', disabled: true, owner: 'fresh' },
    { id: 'absent-row', disabled: true, owner: 'absent' },
  ]
  const here = local({ alpha: '1.0.0' }, undefined, { rows: { 'alpha-same': true, 'official-row': true } })
  const set = changes({ snapshot: incoming, local: here })
  const rows = set.changes.filter(change => change.kind === 'row')
  assert.deepEqual(rows.map(change => [change.name, change.owner, change.from, change.to]), [
    ['alpha-feature', 'alpha', 'default', 'disabled'],
    ['official-row', SEARCH, 'disabled', 'enabled'],
    ['fresh-row', 'fresh', 'default', 'disabled'],
  ])
  assert.deepEqual(rows[0].title, { en: 'Feature', zh: '功能' })
  const withoutInstall = await plan({ snapshot: incoming, local: here, selected: ['row:alpha-feature', 'row:fresh-row'] })
  assert.deepEqual(withoutInstall.rows, [{ id: 'alpha-feature', disabled: true, owner: 'alpha' }])
  const withInstall = await plan({ snapshot: incoming, local: here, selected: ['plugin:fresh', 'row:fresh-row', 'row:official-row'] })
  assert.deepEqual(withInstall.rows, [{ id: 'fresh-row', disabled: true, owner: 'fresh' }, { id: 'official-row', disabled: false, owner: SEARCH }])
})

test('version ordering blocks an older App and warns on a newer one', () => {
  assert.equal(versionOrder('0.2.1-rc.4', '0.2.1-rc.5'), 'older')
  assert.equal(versionOrder('0.2.1-rc.5', '0.2.1-rc.5'), 'same')
  assert.equal(versionOrder('0.2.1', '0.2.1-rc.5'), 'newer')
  assert.throws(() => changes({ snapshot: snapshot(), local: local({}), currentDesktopVersion: '0.2.1-rc.4' }), /需要先将本机 App 升级到 0\.2\.1-rc\.5/)
  assert.match(changes({ snapshot: snapshot(), local: local({}), currentDesktopVersion: '0.2.1' }).warnings[0], /不适用于本机/)
})

test('compatibility exemptions are offered only for this exact DSH version and need the risk confirmation', async () => {
  const incoming = snapshot([plugin('alpha', '1.0.0')])
  incoming.profiles.desktop.exemptions = { 'alpha@1.0.0': [VERSION] }
  const here = local({})
  assert.deepEqual(summary(changes({ snapshot: incoming, local: here })), ['install:alpha', 'exemption:alpha@1.0.0(off)'])
  assert.equal(changes({ snapshot: incoming, local: here }).changes[1].owner, 'alpha')
  assert.deepEqual(summary(changes({ snapshot: incoming, local: { ...here, exemptions: { 'alpha@1.0.0': [VERSION] } } })), ['install:alpha'])
  const selected = ['plugin:alpha', 'exemption:alpha@1.0.0']
  await assert.rejects(plan({ snapshot: incoming, local: here, selected }), /确认/)
  const result = await plan({ snapshot: incoming, local: here, selected, acceptRisk: true })
  assert.deepEqual(result.exemptions, { 'alpha@1.0.0': [VERSION] })
})

test('the plan installs new bundles in the source order and uninstalls dropped plugins with their bundles', async () => {
  const incoming = snapshot([plugin('alpha', '1.0.0'), plugin('fresh', '1.0.0'), plugin('omega', '1.0.0')])
  incoming.profiles.desktop.bundles = ['@deepseek-ai/dsh-base', 'alpha', 'fresh', 'omega']
  const here = local({ alpha: '1.0.0', gone: '1.0.0', omega: '1.0.0' }, ['@deepseek-ai/dsh-base', 'alpha', 'gone', 'omega'])
  const previous = snapshot([plugin('alpha', '1.0.0'), plugin('gone', '1.0.0'), plugin('omega', '1.0.0')])
  const result = await plan({ snapshot: incoming, local: here, previous, selected: ['plugin:fresh', 'plugin:gone'] })
  assert.deepEqual(Object.keys(result.manifest.dependencies), ['alpha', 'omega', 'fresh'])
  assert.deepEqual(result.manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'alpha', 'fresh', 'omega'])
  assert.deepEqual(result.removed, ['gone'])
  assert.deepEqual(result.plugins.map(entry => entry.name), ['fresh'])
  assert.deepEqual(result.untouched, ['@deepseek-ai/dsh-base', 'alpha', 'omega'])
})

test('frozen install is used only when the result matches the snapshot lockfile', async () => {
  const incoming = snapshot([plugin('alpha', '1.0.0')])
  incoming.profiles.desktop.lockfile = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      alpha: {specifier: 1.0.0, version: 1.0.0}\npackages:\n  alpha@1.0.0: {}\nsnapshots:\n  alpha@1.0.0: {}\n"
  const fresh = await plan({ snapshot: incoming, local: local({}), selected: ['plugin:alpha'] })
  assert.equal(fresh.frozen, true)
  const withLocal = await plan({ snapshot: incoming, local: local({ mine: '1.0.0' }), selected: ['plugin:alpha'] })
  assert.equal(withLocal.frozen, false)
})

test('patches of untouched plugins stay, changed plugins take the snapshot patches, removed trees drop theirs', async () => {
  const incoming = snapshot([plugin('alpha', '2.0.0'), plugin('webui', '1.0.0')])
  incoming.profiles.desktop.lockfile = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      alpha: {specifier: 2.0.0, version: 2.0.0}\n      webui: {specifier: 1.0.0, version: 1.0.0}\npackages: {}\nsnapshots:\n  alpha@2.0.0:\n    dependencies: {alpha-core: 2.0.0}\n  alpha-core@2.0.0: {}\n  webui@1.0.0:\n    dependencies: {webui-part: 1.0.0}\n  webui-part@1.0.0: {}\n"
  incoming.profiles.desktop.workspace.patchedDependencies = { 'alpha-core@2.0.0': 'patches/alpha-core-2.patch', 'webui-part@1.0.0': 'patches/webui-part.patch' }
  incoming.profiles.desktop.patches = { 'alpha-core-2.patch': 'new alpha patch', 'webui-part.patch': 'snapshot webui patch' }
  const here = local({ alpha: '1.0.0', webui: '1.0.0', gone: '1.0.0' }, undefined, {
    lockfile: "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      alpha: {specifier: 1.0.0, version: 1.0.0}\n      webui: {specifier: 1.0.0, version: 1.0.0}\n      gone: {specifier: 1.0.0, version: 1.0.0}\npackages: {}\nsnapshots:\n  alpha@1.0.0:\n    dependencies: {alpha-core: 1.0.0}\n  alpha-core@1.0.0: {}\n  webui@1.0.0:\n    dependencies: {webui-part: 1.0.0}\n  webui-part@1.0.0: {}\n  gone@1.0.0:\n    dependencies: {gone-part: 1.0.0}\n  gone-part@1.0.0: {}\n",
    workspace: { packages: ['.'], patchedDependencies: { 'alpha-core@1.0.0': 'patches/alpha-core-1.patch', 'webui-part@1.0.0': 'patches/webui-part.patch', 'gone-part@1.0.0': 'patches/gone-part.patch' } },
    patches: { 'alpha-core-1.patch': 'old alpha patch', 'webui-part.patch': 'local webui patch', 'gone-part.patch': 'gone patch' },
  })
  const previous = snapshot([plugin('alpha', '1.0.0'), plugin('webui', '1.0.0'), plugin('gone', '1.0.0')])
  const result = await plan({ snapshot: incoming, local: here, previous, selected: ['plugin:alpha', 'plugin:gone'] })
  assert.deepEqual(parse(result.workspaceYaml).patchedDependencies, { 'webui-part@1.0.0': 'patches/webui-part.patch', 'alpha-core@2.0.0': 'patches/alpha-core-2.patch' })
  assert.deepEqual(result.patches, { 'webui-part.patch': 'local webui patch', 'alpha-core-2.patch': 'new alpha patch' })
  assert.deepEqual(result.snapshotPatchedDependencies, { 'alpha-core@2.0.0': 'patches/alpha-core-2.patch' })
})

test('the plan keeps local workspace keys and takes build permissions and overrides only for the changed trees', async () => {
  const incoming = snapshot()
  incoming.profiles.desktop.lockfile = "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\nsnapshots:\n  alpha@2.0.0:\n    dependencies: {changed: 1.0.0, new-script: 1.0.0, remote: 1.0.0, existing: 1.0.0}\n  changed@1.0.0: {}\n  new-script@1.0.0: {}\n  remote@1.0.0: {}\n  existing@1.0.0: {}\n  unrelated@1.0.0: {}\n"
  incoming.profiles.desktop.workspace.allowBuilds = { existing: true, changed: true, 'new-script': true, unrelated: true }
  incoming.profiles.desktop.workspace.overrides = { remote: '2.0.0', stray: '3.0.0' }
  const here = local({}, undefined, {
    workspace: { packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false, nodeVersion: '24.0.0', allowBuilds: { existing: true, changed: false }, overrides: { local: '1.0.0' } },
  })
  const result = await plan({ snapshot: incoming, local: here, selected: ['plugin:alpha'] })
  const workspace = parse(result.workspaceYaml)
  assert.equal(workspace.nodeVersion, '24.0.0')
  assert.deepEqual(workspace.allowBuilds, { existing: true, changed: true, 'new-script': true })
  assert.deepEqual(workspace.overrides, { local: '1.0.0', remote: '2.0.0' })
  assert.deepEqual(result.newBuildPermissions, ['changed', 'new-script'])
})

function patchLock(roots, snapshots) {
  return stringify({ lockfileVersion: '9.0', importers: { '.': { dependencies: Object.fromEntries(Object.entries(roots).map(([name, version]) => [name, { specifier: version.split('(')[0], version }])) } }, packages: Object.fromEntries(Object.keys(snapshots).map(key => [key.split('(')[0], { resolution: { integrity: 'sha512-YWxwaGE=' } }])), snapshots })
}

function sharedPatchFixture(upgrade = false, betaVersion = '1.0.0') {
  const incoming = snapshot([...(upgrade ? [plugin('alpha', '2.0.0')] : []), plugin('beta', '1.0.0')])
  const previous = snapshot([plugin('alpha', '1.0.0'), plugin('beta', '1.0.0')])
  const snapshots = { 'alpha@1.0.0': { dependencies: { shared: '1.0.0' } }, 'beta@1.0.0': { optionalDependencies: { shared: betaVersion } }, 'shared@1.0.0': {}, [`shared@${betaVersion}`]: {} }
  const lockfile = patchLock({ alpha: '1.0.0', beta: '1.0.0' }, snapshots)
  const nextSnapshots = { ...snapshots }; delete nextSnapshots['alpha@1.0.0']
  if (upgrade) nextSnapshots['alpha@2.0.0'] = { dependencies: { shared: '1.0.0' } }
  incoming.profiles.desktop.lockfile = patchLock({ ...(upgrade ? { alpha: '2.0.0' } : {}), beta: '1.0.0' }, nextSnapshots)
  const here = local({ alpha: '1.0.0', beta: '1.0.0' }, undefined, {
    lockfile, workspace: { patchedDependencies: { 'shared@1.0.0': 'patches/shared.patch', ...(betaVersion !== '1.0.0' ? { [`shared@${betaVersion}`]: 'patches/shared-v2.patch' } : {}) } },
    patches: { 'shared.patch': 'original shared patch', ...(betaVersion !== '1.0.0' ? { 'shared-v2.patch': 'beta patch' } : {}) },
  })
  return { snapshot: incoming, local: here, previous, selected: ['plugin:alpha'] }
}

test('TS-004 removing one plugin preserves the patch used by an untouched plugin', async () => {
  const result = await plan(sharedPatchFixture())
  assert.deepEqual(result.removed, ['alpha'])
  assert.deepEqual(parse(result.workspaceYaml).patchedDependencies, { 'shared@1.0.0': 'patches/shared.patch' })
  assert.equal(result.patches['shared.patch'], 'original shared patch')
})

test('TS-004 an upgrade cannot replace an untouched plugin shared dependency patch', async () => {
  const fixture = sharedPatchFixture(true)
  fixture.snapshot.profiles.desktop.workspace.patchedDependencies = { 'shared@1.0.0': 'patches/incoming.patch' }
  fixture.snapshot.profiles.desktop.patches = { 'incoming.patch': 'different shared patch' }
  await assert.rejects(plan(fixture), /补丁.*冲突/)
})

test('TS-004 an incoming patch filename cannot overwrite a retained patch for another dependency', async () => {
  const fixture = sharedPatchFixture(true)
  const lock = parse(fixture.snapshot.profiles.desktop.lockfile)
  lock.snapshots['alpha@2.0.0'].dependencies = { 'new-part': '2.0.0' }
  lock.snapshots['new-part@2.0.0'] = {}
  lock.packages['new-part@2.0.0'] = { resolution: { integrity: 'sha512-YWxwaGE=' } }
  fixture.snapshot.profiles.desktop.lockfile = stringify(lock)
  fixture.snapshot.profiles.desktop.workspace.patchedDependencies = { 'new-part@2.0.0': 'patches/shared.patch' }
  fixture.snapshot.profiles.desktop.patches = { 'shared.patch': 'different dependency patch' }
  await assert.rejects(plan(fixture), /补丁.*冲突/)
})

test('TS-004 an identical shared patch can remain during a selected upgrade', async () => {
  const fixture = sharedPatchFixture(true)
  fixture.snapshot.profiles.desktop.workspace.patchedDependencies = { 'shared@1.0.0': 'patches/shared.patch' }
  fixture.snapshot.profiles.desktop.patches = { 'shared.patch': 'original shared patch' }
  const result = await plan(fixture)
  assert.equal(result.patches['shared.patch'], 'original shared patch')
  assert.equal(result.manifest.dependencies.beta, '1.0.0')
})

test('the preview groups changes by plugin and identifies plugins by this Mac first, the snapshot otherwise', () => {
  const incoming = snapshot([
    plugin('alpha', '2.0.0', { title: 'Alpha from source' }),
    plugin('beta', '1.0.0'),
    plugin('fresh', '1.0.0', { title: { en: 'Fresh', zh: '新插件' }, description: 'Fresh plugin' }),
    plugin('same', '1.0.0'),
  ])
  incoming.profiles.desktop.rows = [{ id: 'alpha-feature', disabled: true, owner: 'alpha' }]
  incoming.profiles.desktop.official = [{ name: SEARCH, enabled: true, title: { en: 'Session search' } }]
  const here = local({ alpha: '1.0.0', beta: '3.0.0', same: '1.0.0', mine: '1.0.0' })
  const catalog = catalogOf([
    { name: 'alpha', enabled: true, installed: true, description: 'Local alpha', meta: { title: 'Alpha here', icon: 'data:image/svg+xml;base64,PHN2Zy8+' } },
    { name: SEARCH, official: true, optional: true, enabled: false, installed: false, availability: 'installation' },
  ], here.manifest)
  const set = changes({ snapshot: incoming, local: { ...here, official: [SEARCH] } })
  const view = previewEntries(set, incoming, catalog, here.versions, name => name === 'fresh' ? ['esbuild'] : [])
  assert.deepEqual(view.plugins.map(entry => [entry.name, entry.group, entry.changes.map(change => change.kind).join('+'), entry.defaultOn]), [
    ['alpha', 'third-party', 'upgrade+row', true],
    ['beta', 'third-party', 'downgrade', false],
    ['fresh', 'third-party', 'install', true],
    [SEARCH, 'official', 'enable', true],
  ])
  const [alpha, , fresh, search] = view.plugins
  assert.deepEqual([alpha.title, alpha.description, alpha.icon, alpha.localVersion, alpha.snapshotVersion], ['Alpha here', 'Local alpha', 'data:image/svg+xml;base64,PHN2Zy8+', '1.0.0', '2.0.0'])
  assert.deepEqual([fresh.title, fresh.description, fresh.newBuildPermissions], [{ en: 'Fresh', zh: '新插件' }, 'Fresh plugin', ['esbuild']])
  assert.deepEqual([search.title, search.experimental], [{ en: 'Session search' }, true])
  assert.deepEqual(view.unchanged.map(entry => `${entry.name}:${entry.reason}`), ['mine:local-only', 'same:same'])
})

async function sourceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-read-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const snapshotDir = join(root, 'snapshot')
  mkdirSync(join(snapshotDir, 'packages'), { recursive: true })
  const content = Buffer.from('fixture package')
  const integrity = `sha512-${createHash('sha512').update(content).digest('base64')}`
  const value = snapshot([plugin('packed', '1.0.0', { spec: 'file:local-plugins/packed-1.0.0.tgz', source: 'packed', file: 'packed-1.0.0.tgz', integrity })])
  writeFileSync(join(snapshotDir, 'snapshot.json'), JSON.stringify(value))
  writeFileSync(join(snapshotDir, 'packages', 'packed-1.0.0.tgz'), content)
  return { root, snapshotDir }
}

test('directory, zip and local git sources return the same validated snapshot', async t => {
  const { root, snapshotDir } = await sourceFixture(t)
  const direct = await readSnapshot({ kind: 'directory', path: snapshotDir })
  assert.equal(direct.snapshot.profiles.desktop.plugins[0].name, 'packed')
  const zipPath = join(root, 'snapshot.zip')
  await writeZip(snapshotDir, zipPath)
  const zipped = await readSnapshot({ kind: 'zip', path: zipPath })
  assert.equal(zipped.snapshot.format, 'dsh-plugin-sync/snapshot-2')
  await zipped.cleanup()
  const repository = join(root, 'repository')
  mkdirSync(repository)
  execFileSync('git', ['init', '-q', repository])
  const commit = await commitSnapshot(snapshotDir, repository, 'source-mac')
  const fromGit = await readSnapshot({ kind: 'git', repository, machine: 'source-mac', commit })
  assert.equal(fromGit.snapshot.machine, 'Test Mac A')
  assert.equal(readFileSync(join(fromGit.sourceDir, 'packages', 'packed-1.0.0.tgz'), 'utf8'), 'fixture package')
  await fromGit.cleanup()
})


for (const upgrade of [false, true]) {
  test(`TS-004 ${upgrade ? 'upgrading' : 'removing'} alpha does not protect its shared v1 patch merely because beta uses v2`, async () => {
    const fixture = sharedPatchFixture(upgrade, '2.0.0')
    if (upgrade) {
      fixture.snapshot.profiles.desktop.workspace.patchedDependencies = { 'shared@1.0.0': 'patches/incoming.patch' }
      fixture.snapshot.profiles.desktop.patches = { 'incoming.patch': 'new alpha patch' }
    }
    const result = await plan(fixture), patches = parse(result.workspaceYaml).patchedDependencies
    assert.equal(patches['shared@2.0.0'], 'patches/shared-v2.patch')
    assert.equal(result.patches['shared-v2.patch'], 'beta patch')
    assert.equal(patches['shared@1.0.0'], upgrade ? 'patches/incoming.patch' : undefined)
    assert.equal(result.patches['shared.patch'], undefined)
    if (upgrade) assert.equal(result.patches['incoming.patch'], 'new alpha patch')
  })
}

for (const edge of ['importer', 'dependency']) {
  test(`TS-004 follows the selected ${edge} peer variant instead of all snapshots with the same name`, async () => {
    const fixture = sharedPatchFixture(true, '2.0.0')
    const lock = parse(fixture.local.lockfile)
    for (const version of ['1.0.0', '2.0.0']) {
      lock.packages[`peer@${version}`] = { resolution: { integrity: 'sha512-YWxwaGE=' } }
      lock.snapshots[`peer@${version}`] = {}
    }
    if (edge === 'importer') {
      lock.packages['beta@1.0.0'].peerDependencies = { peer: '*' }
      delete lock.snapshots['beta@1.0.0']
      lock.importers['.'].dependencies.beta.version = '1.0.0(peer@2.0.0)'
      lock.snapshots['beta@1.0.0(peer@2.0.0)'] = { dependencies: { shared: '2.0.0', peer: '2.0.0' } }
      lock.snapshots['beta@1.0.0(peer@1.0.0)'] = { dependencies: { shared: '1.0.0', peer: '1.0.0' } }
    } else {
      lock.snapshots['beta@1.0.0'] = { dependencies: { bridge: '1.0.0(peer@2.0.0)' } }
      lock.packages['bridge@1.0.0'] = { resolution: { integrity: 'sha512-YWxwaGE=' }, peerDependencies: { peer: '*' } }
      lock.snapshots['bridge@1.0.0(peer@2.0.0)'] = { dependencies: { shared: '2.0.0', peer: '2.0.0' } }
      lock.snapshots['bridge@1.0.0(peer@1.0.0)'] = { dependencies: { shared: '1.0.0', peer: '1.0.0' } }
    }
    fixture.local.lockfile = stringify(lock)
    fixture.snapshot.profiles.desktop.workspace.patchedDependencies = { 'shared@1.0.0': 'patches/incoming.patch' }
    fixture.snapshot.profiles.desktop.patches = { 'incoming.patch': 'new alpha patch' }
    const result = await plan(fixture)
    assert.equal(result.patches['incoming.patch'], 'new alpha patch')
    assert.equal(result.patches['shared-v2.patch'], 'beta patch')
  })
}

test('TS-004 missing retained dependency resolution cannot discard its possible patch', async () => {
  const fixture = sharedPatchFixture(false)
  const lock = parse(fixture.local.lockfile)
  delete lock.importers['.'].dependencies.beta
  fixture.local.lockfile = stringify(lock)
  const result = await plan(fixture)
  assert.equal(result.patches['shared.patch'], 'original shared patch')
})

test('TS-004 packed references use package version metadata when selecting their patches', async () => {
  const incoming = snapshot([plugin('alpha', '2.0.0', { source: 'packed', file: 'alpha-2.0.0.tgz', spec: 'file:local-plugins/alpha-2.0.0.tgz' })])
  const ref = 'file:local-plugins/alpha-2.0.0.tgz'
  const instance = `alpha@${ref}(patch_hash=fixturehash)`
  const lock = parse(patchLock({ alpha: `${ref}(patch_hash=fixturehash)` }, { [instance]: {} }))
  lock.packages[`alpha@${ref}`].version = '2.0.0'
  lock.packages[`alpha@${ref}`].resolution.tarball = ref
  incoming.profiles.desktop.lockfile = stringify(lock)
  incoming.profiles.desktop.workspace.patchedDependencies = { 'alpha@2.0.0': 'patches/alpha.patch' }
  incoming.profiles.desktop.patches = { 'alpha.patch': 'packed alpha patch' }
  const result = await plan({ snapshot: incoming, local: local({}), selected: ['plugin:alpha'] })
  assert.equal(result.patches['alpha.patch'], 'packed alpha patch')
  assert.equal(parse(result.workspaceYaml).patchedDependencies['alpha@2.0.0'], 'patches/alpha.patch')
})

test('TS-004 incoming patches follow alpha references and do not import beta other-version patches', async () => {
  const fixture = sharedPatchFixture(true, '2.0.0')
  fixture.snapshot.profiles.desktop.workspace.patchedDependencies = { 'shared@1.0.0': 'patches/incoming.patch', 'shared@2.0.0': 'patches/source-beta.patch' }
  fixture.snapshot.profiles.desktop.patches = { 'incoming.patch': 'new alpha patch', 'source-beta.patch': 'unselected source patch' }
  const result = await plan(fixture)
  assert.equal(result.patches['incoming.patch'], 'new alpha patch')
  assert.equal(result.patches['shared-v2.patch'], 'beta patch')
  assert.equal(result.patches['source-beta.patch'], undefined)
})

test('TS-004 qualified dependency references preserve the real package version behind an alias', async () => {
  const fixture = sharedPatchFixture(true, '2.0.0')
  const lock = parse(fixture.local.lockfile)
  lock.snapshots['beta@1.0.0'].optionalDependencies = { alias: 'shared@2.0.0' }
  fixture.local.lockfile = stringify(lock)
  fixture.snapshot.profiles.desktop.workspace.patchedDependencies = { 'shared@1.0.0': 'patches/incoming.patch' }
  fixture.snapshot.profiles.desktop.patches = { 'incoming.patch': 'new alpha patch' }
  const result = await plan(fixture)
  assert.equal(result.patches['incoming.patch'], 'new alpha patch')
  assert.equal(result.patches['shared-v2.patch'], 'beta patch')
})

test('TS-004 unresolved incoming patch ownership is rejected instead of guessing', async () => {
  const fixture = sharedPatchFixture(true)
  const lock = parse(fixture.snapshot.profiles.desktop.lockfile)
  delete lock.importers['.'].dependencies.alpha
  fixture.snapshot.profiles.desktop.lockfile = stringify(lock)
  fixture.snapshot.profiles.desktop.workspace.patchedDependencies = { 'shared@1.0.0': 'patches/shared.patch' }
  fixture.snapshot.profiles.desktop.patches = { 'shared.patch': 'original shared patch' }
  await assert.rejects(plan(fixture), error => {
    assert.match(error.message, /alpha.*锁文件依赖引用/)
    assert.doesNotMatch(error.message, /^快照无效/)
    return true
  })
})

function patchMigrationFixture({ linked = false, fresh = false } = {}) {
  const incoming = snapshot([plugin('alpha', '2.0.0'), plugin('webui', '1.0.0'), ...(fresh ? [plugin('fresh', '1.0.0')] : [])])
  incoming.profiles.desktop.lockfile = patchLock({ alpha: '2.0.0', webui: '1.0.0', ...(fresh ? { fresh: '1.0.0' } : {}) }, {
    'alpha@2.0.0': { dependencies: { 'alpha-core': '2.0.0' } }, 'alpha-core@2.0.0': {},
    'webui@1.0.0': { dependencies: { 'webui-part': '1.0.0' } }, 'webui-part@1.0.0': {},
    ...(fresh ? { 'fresh@1.0.0': {} } : {}),
  })
  incoming.profiles.desktop.workspace.patchedDependencies = { 'alpha-core@2.0.0': 'patches/alpha-core-2.patch', 'webui-part@1.0.0': 'patches/webui-part.patch' }
  incoming.profiles.desktop.patches = { 'alpha-core-2.patch': 'new alpha patch', 'webui-part.patch': 'source webui patch' }
  const here = local({ alpha: '1.0.0', webui: '1.0.0', gone: '1.0.0', ...(linked ? { mine: 'link:/fixture/mine' } : {}) }, undefined, {
    lockfile: patchLock({ alpha: '1.0.0', webui: '1.0.0', gone: '1.0.0', ...(linked ? { mine: 'link:/fixture/mine' } : {}) }, {
      'alpha@1.0.0': { dependencies: { 'alpha-core': '1.0.0' } }, 'alpha-core@1.0.0': {},
      'webui@1.0.0': { dependencies: { 'webui-part': '1.0.0' } }, 'webui-part@1.0.0': {},
      'gone@1.0.0': { dependencies: { 'gone-part': '1.0.0' } }, 'gone-part@1.0.0': {},
    }),
    workspace: { patchedDependencies: { 'alpha-core@1.0.0': 'patches/alpha-core-1.patch', 'webui-part@1.0.0': 'patches/webui-part.patch', 'gone-part@1.0.0': 'patches/gone-part.patch' } },
    patches: { 'alpha-core-1.patch': 'old alpha patch', 'webui-part.patch': 'local webui patch', 'gone-part.patch': 'removed patch' },
  })
  return { snapshot: incoming, local: here, previous: snapshot([plugin('alpha', '1.0.0'), plugin('webui', '1.0.0'), plugin('gone', '1.0.0')]), selected: ['plugin:alpha', 'plugin:gone', ...(fresh ? ['plugin:fresh'] : [])] }
}

test('TS-004 P1 deferred packed plugins import without unrelated source patches', async () => {
  const incoming = snapshot([plugin('third', '1.0.0'), plugin('mine', '1.0.0', { source: 'packed', spec: 'file:local-plugins/mine.tgz', file: 'mine.tgz' })])
  incoming.profiles.desktop.lockfile = patchLock({ third: '1.0.0' }, { 'third@1.0.0': {} })
  incoming.profiles.desktop.workspace.patchedDependencies = { 'third@1.0.0': 'patches/source.patch' }
  incoming.profiles.desktop.patches = { 'source.patch': 'unselected patch' }
  const here = local({ keep: '1.0.0' }, undefined, {
    lockfile: patchLock({ keep: '1.0.0' }, { 'keep@1.0.0': {} }),
    workspace: { patchedDependencies: { 'keep@1.0.0': 'patches/keep.patch' } }, patches: { 'keep.patch': 'local patch' },
  })
  const result = await plan({ snapshot: incoming, local: here, selected: ['plugin:mine'] })
  assert.equal(result.manifest.dependencies.mine, 'file:local-plugins/mine.tgz')
  assert.deepEqual(parse(result.workspaceYaml).patchedDependencies, { 'keep@1.0.0': 'patches/keep.patch' })
  assert.deepEqual(result.patches, { 'keep.patch': 'local patch' })
})

test('TS-004 P1 deferred packed plugins take only their own exact-version patch', async () => {
  const incoming = snapshot([plugin('mine', '1.0.0', { source: 'packed', spec: 'file:local-plugins/mine.tgz', file: 'mine.tgz' })])
  incoming.profiles.desktop.workspace.patchedDependencies = { 'mine@1.0.0': 'patches/mine.patch', 'mine@2.0.0': 'patches/other-version.patch', 'mine-part@1.0.0': 'patches/part.patch' }
  incoming.profiles.desktop.patches = { 'mine.patch': 'own patch', 'other-version.patch': 'other version', 'part.patch': 'unresolved dependency' }
  const result = await plan({ snapshot: incoming, local: local({}), selected: ['plugin:mine'] })
  assert.deepEqual(result.snapshotPatchedDependencies, { 'mine@1.0.0': 'patches/mine.patch' })
  assert.deepEqual(result.patches, { 'mine.patch': 'own patch' })
})

for (const [name, options] of [['P2 a retained link is a leaf', { linked: true }], ['P3 a fresh plugin has no previous lock instance', { fresh: true }]]) {
  test(`TS-004 ${name} and obsolete patches are removed`, async () => {
    const result = await plan(patchMigrationFixture(options))
    assert.deepEqual(parse(result.workspaceYaml).patchedDependencies, { 'webui-part@1.0.0': 'patches/webui-part.patch', 'alpha-core@2.0.0': 'patches/alpha-core-2.patch' })
    assert.deepEqual(result.patches, { 'webui-part.patch': 'local webui patch', 'alpha-core-2.patch': 'new alpha patch' })
  })
}

test('S-O02 a new shared dependency patch names untouched plugins in the preview warning', async () => {
  const fixture = sharedPatchFixture(true)
  fixture.local.workspace.patchedDependencies = {}
  fixture.local.patches = {}
  fixture.snapshot.profiles.desktop.workspace.patchedDependencies = { 'shared@1.0.0': 'patches/new.patch' }
  fixture.snapshot.profiles.desktop.patches = { 'new.patch': 'new shared patch' }
  const result = await plan(fixture)
  assert.equal(result.manifest.dependencies.beta, '1.0.0')
  assert.ok(result.untouched.includes('beta'))
  assert.deepEqual(parse(result.workspaceYaml).patchedDependencies, { 'shared@1.0.0': 'patches/new.patch' })
  assert.deepEqual(result.warnings, ['依赖 shared@1.0.0 的补丁也会应用于未选择的插件 beta'])
})

for (const dependency of ['shared', '@scope/shared']) {
  test(`S-O02 a versionless ${dependency} patch warns for every affected untouched plugin`, async () => {
    const incoming = snapshot([plugin('alpha', '2.0.0')])
    incoming.profiles.desktop.lockfile = patchLock({ alpha: '2.0.0' }, {
      'alpha@2.0.0': { dependencies: { [dependency]: '1.0.0' } }, [`${dependency}@1.0.0`]: {},
    })
    incoming.profiles.desktop.workspace.patchedDependencies = { [dependency]: 'patches/all.patch' }
    incoming.profiles.desktop.patches = { 'all.patch': 'patch for every version' }
    const here = local({ alpha: '1.0.0', beta: '1.0.0', gamma: '1.0.0', unrelated: '1.0.0' }, undefined, {
      lockfile: patchLock({ alpha: '1.0.0', beta: '1.0.0', gamma: '1.0.0', unrelated: '1.0.0' }, {
        'alpha@1.0.0': {},
        'beta@1.0.0': { dependencies: { [dependency]: '1.0.0' } },
        'gamma@1.0.0': { optionalDependencies: { [dependency]: '2.0.0' } },
        'unrelated@1.0.0': {}, [`${dependency}@1.0.0`]: {}, [`${dependency}@2.0.0`]: {},
      }),
    })
    const result = await plan({ snapshot: incoming, local: here, selected: ['plugin:alpha'] })
    assert.deepEqual(parse(result.workspaceYaml).patchedDependencies, { [dependency]: 'patches/all.patch' })
    assert.deepEqual(result.warnings, [`依赖 ${dependency} 的补丁也会应用于未选择的插件 beta、gamma`])
    here.workspace = { patchedDependencies: { [dependency]: 'patches/all.patch' } }
    here.patches = { 'all.patch': 'patch for every version' }
    assert.deepEqual((await plan({ snapshot: incoming, local: here, selected: ['plugin:alpha'] })).warnings, [])
  })
}

test('S-O02 existing patches and different-version dependencies do not add a shared-impact warning', async () => {
  for (const version of ['1.0.0', '2.0.0']) {
    const fixture = sharedPatchFixture(true, version)
    fixture.snapshot.profiles.desktop.workspace.patchedDependencies = { 'shared@1.0.0': 'patches/shared.patch' }
    fixture.snapshot.profiles.desktop.patches = { 'shared.patch': 'original shared patch' }
    if (version === '2.0.0') {
      delete fixture.local.workspace.patchedDependencies['shared@1.0.0']
      delete fixture.local.patches['shared.patch']
    }
    assert.deepEqual((await plan(fixture)).warnings, [])
  }
})

test('S-O02 a range selector does not claim it applies to an untouched dependency outside that range', async () => {
  const fixture = sharedPatchFixture(true, '2.0.0')
  fixture.local.workspace.patchedDependencies = {}
  fixture.local.patches = {}
  fixture.snapshot.profiles.desktop.workspace.patchedDependencies = { 'shared@^1': 'patches/v1.patch' }
  fixture.snapshot.profiles.desktop.patches = { 'v1.patch': 'patch for version one' }
  const result = await plan(fixture)
  assert.deepEqual(parse(result.workspaceYaml).patchedDependencies, { 'shared@^1': 'patches/v1.patch' })
  assert.deepEqual(result.warnings, [])
})

test('S-O02 a plugin selected for a bundle change is not described as unselected', async () => {
  const fixture = sharedPatchFixture(true)
  fixture.local.workspace.patchedDependencies = {}
  fixture.local.patches = {}
  fixture.snapshot.profiles.desktop.workspace.patchedDependencies = { 'shared@1.0.0': 'patches/new.patch' }
  fixture.snapshot.profiles.desktop.patches = { 'new.patch': 'new shared patch' }
  fixture.snapshot.profiles.desktop.plugins.find(entry => entry.name === 'beta').selected = false
  fixture.snapshot.profiles.desktop.bundles = fixture.snapshot.profiles.desktop.bundles.filter(name => name !== 'beta')
  fixture.selected.push('bundle:beta')
  const result = await plan(fixture)
  assert.ok(!result.untouched.includes('beta'))
  assert.deepEqual(result.warnings, [])
})

test('App import leaves same-version link and registry installs unchanged when the snapshot is packed', async () => {
  const incoming = snapshot([plugin('alpha', '1.0.0', { source: 'packed', file: 'alpha-new.tgz', spec: 'file:local-plugins/alpha-new.tgz' })])
  for (const spec of ['link:../alpha', '^1.0.0']) {
    const here = local({ alpha: spec }, undefined, { versions: { alpha: '1.0.0' }, workspace: { overrides: { alpha: spec } } })
    const before = structuredClone(here)
    const set = changes({ snapshot: incoming, local: here })
    assert.deepEqual(summary(set), [])
    assert.deepEqual(set.unchanged, [{ name: 'alpha', reason: 'same' }])
    const result = await plan({ snapshot: incoming, local: here, selected: [] })
    assert.equal(result.manifest.dependencies.alpha, spec)
    assert.equal(parse(result.workspaceYaml).overrides.alpha, spec)
    assert.deepEqual(here, before)
  }
})

test('packed content is compared even at the same version, including migration from registry and link', async () => {
  const packed = plugin('alpha', '1.0.0', { source: 'packed', file: 'alpha-new.tgz', spec: 'file:local-plugins/alpha-new.tgz' })
  const incoming = snapshot([packed])
  for (const spec of ['^1.0.0', 'link:kit-presets', 'file:local-plugins/alpha-old.tgz']) {
    const here = local({ alpha: spec, other: 'github:example/plugin#release', local: 'file:local-plugins/other.tgz', registry: '^2.0.0' }, undefined, { versions: { alpha: '1.0.0' } })
    const set = changes({ snapshot: incoming, local: here, comparePackedContent: true })
    assert.deepEqual(summary(set), ['upgrade:alpha'])
    const result = await plan({ snapshot: incoming, local: here, comparePackedContent: true, selected: ['plugin:alpha'] })
    assert.equal(result.manifest.dependencies.alpha, packed.spec)
    assert.equal(result.manifest.dependencies.other, 'github:example/plugin#release')
    assert.equal(result.manifest.dependencies.local, 'file:local-plugins/other.tgz')
    assert.equal(result.manifest.dependencies.registry, '^2.0.0')
  }
  const lock = integrity => stringify({
    lockfileVersion: '9.0', importers: { '.': { dependencies: { alpha: { specifier: packed.spec, version: packed.spec } } } },
    packages: { ['alpha@' + packed.spec]: { resolution: { integrity } } }, snapshots: { ['alpha@' + packed.spec]: {} },
  })
  const here = local({ alpha: packed.spec }, undefined, { versions: { alpha: '1.0.0' }, lockfile: lock('sha512-b2xk') })
  assert.deepEqual(summary(changes({ snapshot: incoming, local: here, comparePackedContent: true })), ['upgrade:alpha'])
  here.lockfile = lock(packed.integrity)
  assert.deepEqual(summary(changes({ snapshot: incoming, local: here, comparePackedContent: true })), [])
})

test('an external installer can remove the sync plugin only when its own prior snapshot managed it', () => {
  const here = local({ 'dsh-plugin-sync': '1.0.0', outsider: '^1.0.0' })
  const previous = snapshot([plugin('dsh-plugin-sync', '1.0.0')])
  const incoming = snapshot([])
  assert.deepEqual(summary(changes({ snapshot: incoming, local: here, previous })), [])
  assert.deepEqual(summary(changes({ snapshot: incoming, local: here, previous, protectedPlugins: [] })), ['remove:dsh-plugin-sync'])
  assert.deepEqual(summary(changes({ snapshot: incoming, local: here, protectedPlugins: [] })), [])
})

test('replacing a linked package drops only that root link override', async () => {
  const incoming = snapshot([plugin('alpha', '1.0.0', { source: 'packed', spec: 'file:local-plugins/alpha.tgz', file: 'alpha.tgz' })])
  const here = local({ alpha: 'link:kit-presets', other: '^1.0.0' }, undefined, { versions: { alpha: '1.0.0' }, workspace: { overrides: { alpha: 'link:kit-presets', other: '2.0.0' } } })
  const result = await plan({ snapshot: incoming, local: here, comparePackedContent: true, selected: ['plugin:alpha'] })
  assert.deepEqual(parse(result.workspaceYaml).overrides, { other: '2.0.0' })
})

test('feat115-peer unchanged packed content with simple or nested peer bindings stays unchanged', async () => {
  const packed = plugin('alpha', '1.0.0', { source: 'packed', file: 'alpha.tgz', spec: 'file:local-plugins/alpha.tgz' })
  for (const suffix of ['(peer@2.0.0)', '(peer@file:local-plugins/peer.tgz(other@3.0.0))(other@3.0.0)']) {
    const reference = packed.spec + suffix
    const here = local({ alpha: packed.spec }, undefined, { versions: { alpha: '1.0.0' }, lockfile: stringify({
      lockfileVersion: '9.0', importers: { '.': { dependencies: { alpha: { specifier: packed.spec, version: reference } } } },
      packages: { ['alpha@' + packed.spec]: { resolution: { integrity: packed.integrity } } },
      snapshots: { ['alpha@' + reference]: {} },
    }) })
    const incoming = snapshot([packed])
    assert.deepEqual(summary(changes({ snapshot: incoming, local: here, comparePackedContent: true })), [])
    assert.deepEqual(summary(changes({ snapshot: incoming, local: here })), [], 'the default App comparison remains version-based')
    const planned = await plan({ snapshot: incoming, local: here, comparePackedContent: true, selected: [] })
    assert.equal(planned.plugins.length, 0)
    assert.ok(planned.untouched.includes('alpha'))
    const changed = structuredClone(incoming); changed.profiles.desktop.plugins[0].integrity = 'sha512-bmV3'
    assert.deepEqual(summary(changes({ snapshot: changed, local: here, comparePackedContent: true })), ['upgrade:alpha'])
    assert.deepEqual(summary(changes({ snapshot: changed, local: here })), [], 'the kit option does not alter App defaults')
  }
})
