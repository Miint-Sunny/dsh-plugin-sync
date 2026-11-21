import assert from 'node:assert/strict'
import test from 'node:test'
import { catalogOf, manifestCatalog, rowOwner } from '../lib/core/catalog.js'
import { buildChanges, validateSnapshot } from '../lib/core/plan.js'

const pairs = [
  ['dsh-plugin-sync', '@miint-sunny/dsh-plugin-sync'],
  ['dsh-workbench', '@miint-sunny/dsh-workbench'],
  ['dsh-media-look', '@miint-sunny/dsh-media-look'],
  ['dsh-model-settings', '@miint-sunny/dsh-model-settings'],
  ['dsh-session-title-headtail', '@miint-sunny/dsh-session-title-headtail'],
  ['dsh-nai5-prompting', '@miint-sunny/dsh-nai-desk'],
  ...['usage', 'checkpoints', 'review', 'navigation', 'pages', 'settings', 'essentials'].map(part => [
    `dsh-workbench-${part}`, `@miint-sunny/dsh-workbench-${part}`,
  ]),
]

for (const [oldName, newName] of pairs) {
  test(`module rows keep their installed bundle owner across ${oldName} renaming`, () => {
    for (const installed of [oldName, newName]) {
      const manifest = { dependencies: { [installed]: '1.0.0' } }
      const catalog = manifestCatalog(manifest)
      for (const module of [oldName, newName]) {
        for (const suffix of ['', '/host', '#component']) {
          assert.equal(rowOwner({ id: 'stable-row', name: `${module}${suffix}` }, catalog, [installed]), installed)
        }
      }
      assert.equal(rowOwner({ id: 'unrelated', name: `${newName}-unrelated/host` }, catalog, [installed]), undefined)
    }
  })
}

test('exact package owners win over aliases when old and scoped packages coexist', () => {
  const names = ['dsh-workbench', '@miint-sunny/dsh-workbench']
  const catalog = manifestCatalog({ dependencies: Object.fromEntries(names.map(name => [name, '1.0.0'])) })
  for (const name of names) assert.equal(rowOwner({ id: 'row', name: `${name}/host` }, catalog, names), name)
  const declared = catalogOf([{ name: 'declared-bundle', enabled: true, installed: true, rows: [{ rowId: 'stable-row', moduleName: 'dsh-workbench/host' }] }], {})
  assert.equal(rowOwner({ id: 'stable-row', name: '@miint-sunny/dsh-workbench/host' }, declared, names), 'declared-bundle')
})

function snapshot(exporterName = 'dsh-plugin-sync', plugins = []) {
  return {
    format: 'dsh-plugin-sync/snapshot-2', machine: 'Fixture Mac', machineId: 'fixture', createdAt: '2026-11-15T00:00:00Z',
    exporter: { name: exporterName, version: '0.4.0' }, dsh: { desktopVersion: '0.2.2-rc.3' }, excluded: [],
    profiles: { desktop: {
      plugins: plugins.map(name => ({ name, version: '1.0.0', source: 'npm', spec: `${name}@1.0.0`, integrity: 'sha512-Zml4dHVyZQ==', bundle: true, selected: true })),
      official: [], bundles: plugins, rows: [], exemptions: {},
      workspace: { patchedDependencies: {}, allowBuilds: {}, overrides: {} }, patches: {},
      lockfile: "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\nsnapshots: {}\n",
    } },
  }
}

test('snapshot-2 accepts both old and scoped exporter identities without changing its data format', () => {
  for (const name of ['dsh-plugin-sync', '@miint-sunny/dsh-plugin-sync']) {
    const value = snapshot(name)
    assert.equal(validateSnapshot(value), value)
    assert.equal(value.format, 'dsh-plugin-sync/snapshot-2')
  }
  assert.throws(() => validateSnapshot(snapshot('@other/dsh-plugin-sync')), /导出器信息无效/)
})

test('default uninstall protection covers both sync identities and leaves other renamed plugins manageable', () => {
  for (const index of [0, 1]) {
    const names = pairs.map(pair => pair[index])
    const local = {
      manifest: { dependencies: Object.fromEntries(names.map(name => [name, '1.0.0'])), dsh: { profile: { bundles: names } } },
      versions: Object.fromEntries(names.map(name => [name, '1.0.0'])), rows: {},
    }
    const options = { snapshot: snapshot(), previous: snapshot('dsh-plugin-sync', names), local, currentDesktopVersion: '0.2.2-rc.3' }
    assert.deepEqual(buildChanges(options).changes.map(change => change.name).sort(), names.slice(1).sort())
    assert.deepEqual(buildChanges({ ...options, protectedPlugins: [] }).changes.map(change => change.name).sort(), [...names].sort())
  }
})
