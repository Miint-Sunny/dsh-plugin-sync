import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import {
  commitSnapshot,
  exportSnapshot,
  machineDirectory,
  writeZip,
} from '../lib/core/export.js'
import { catalogOf } from '../lib/core/catalog.js'

const FIXTURE_SECRET = 'fixture-token-value-123'
const OFFICIAL = '@deepseek-ai/dsh-experimental-session-search'
const PRIVATE_PLUGINS = ['fixture-private-b', 'fixture-private-a']

function catalogFor(profileDir) {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  return catalogOf([
    { name: 'allowed-npm', enabled: true, installed: true, description: 'Allowed plugin', meta: { title: { en: 'Allowed', zh: '允许的插件' } }, rows: [{ rowId: 'allowed-row', moduleName: 'allowed-npm/part', meta: { title: 'Allowed part' } }] },
    { name: 'fixture-private-b', enabled: true, installed: true, rows: [{ rowId: 'private-b-host', moduleName: 'fixture-private-b/host' }] },
    { name: OFFICIAL, official: true, optional: true, enabled: false, installed: false, availability: 'installation', meta: { title: { en: 'Session search', zh: '会话搜索' } }, rows: [{ rowId: 'official-row', moduleName: '@deepseek-ai/dsh-session-search' }] },
    { name: '@deepseek-ai/dsh-base', enabled: true, installed: false, availability: 'installation', rows: [{ rowId: 'base-row', moduleName: '@deepseek-ai/dsh-base/part' }] },
  ], manifest)
}
const COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function makeTarball(root, name, version, filename) {
  const source = join(root, `${name}-source`)
  mkdirSync(join(source, 'package'), { recursive: true })
  writeFileSync(join(source, 'package', 'package.json'), JSON.stringify({ name, version, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  const destination = join(root, filename)
  execFileSync('tar', ['-czf', destination, '-C', source, 'package'])
  return destination
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-export-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profileDir = join(root, 'profile')
  const linked = join(root, 'linked')
  mkdirSync(join(profileDir, 'patches'), { recursive: true })
  mkdirSync(join(profileDir, 'local-plugins'), { recursive: true })
  mkdirSync(linked, { recursive: true })
  mkdirSync(join(profileDir, 'node_modules', 'github-plugin'), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', 'github-plugin', 'package.json'), JSON.stringify({ name: 'github-plugin', version: '4.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(linked, 'package.json'), JSON.stringify({ name: 'packed-link', version: '3.0.0' }))
  const linkedTarball = makeTarball(root, 'packed-link', '3.0.0', 'packed-link-3.0.0.tgz')
  makeTarball(root, 'packed-file', '2.0.0', 'packed-file-2.0.0.tgz')
  writeFileSync(join(profileDir, 'local-plugins', 'packed-file-2.0.0.tgz'), readFileSync(join(root, 'packed-file-2.0.0.tgz')))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    dependencies: {
      'allowed-npm': '1.0.0',
      'github-plugin': `github:acme/repo#${COMMIT}`,
      'packed-link': `link:${linked}`,
      'packed-file': 'file:local-plugins/packed-file-2.0.0.tgz',
      'fixture-private-b': 'link:/private/b',
      'fixture-private-a': 'link:/private/a',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'allowed-npm', 'packed-link', 'fixture-private-b', 'fixture-private-a'] } },
  }))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `- id: allowed-row\n  name: allowed-npm\n  disabled: false\n  config:\n    token: ${FIXTURE_SECRET}\n- id: private-b-host\n  name: fixture-private-b\n  disabled: false\n  config:\n    token: another-fixture-secret\n# BEGIN macos-shared-mcp\n- insert:\n    - id: shared-mcp-github\n      name: shared\n      disabled: false\n# END macos-shared-mcp\n`)
  writeFileSync(join(profileDir, 'compatibility.json'), JSON.stringify({
    'allowed-npm@1.0.0': ['0.2.1-rc.5'],
    'fixture-private-b@9.9.9': ['0.2.1-rc.5'],
  }))
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), `nodeLinker: hoisted\nallowBuilds:\n  allowed-npm: true\npatchedDependencies:\n  allowed-npm@1.0.0: patches/allowed.patch\n  transitive@1.0.0: patches/transitive.patch\n  fixture-private-b@9.9.9: patches/private-b.patch\noverrides:\n  transitive: 1.0.0\n`)
  writeFileSync(join(profileDir, 'patches', 'allowed.patch'), 'diff --git a/a b/a\n')
  writeFileSync(join(profileDir, 'patches', 'transitive.patch'), 'diff --git a/lib/index.js b/lib/index.js\n')
  writeFileSync(join(profileDir, 'patches', 'private-b.patch'), 'must not export\n')
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), `lockfileVersion: 9.0\nimporters:\n  .:\n    dependencies:\n      allowed-npm:\n        specifier: 1.0.0\n        version: 1.0.0\n      github-plugin:\n        specifier: github:acme/repo#${COMMIT}\n        version: https://codeload.github.com/acme/repo/tar.gz/${COMMIT}\n      packed-link:\n        specifier: link:${linked}\n        version: link:${linked}\n      packed-file:\n        specifier: file:local-plugins/packed-file-2.0.0.tgz\n        version: file:local-plugins/packed-file-2.0.0.tgz\n      fixture-private-b:\n        specifier: link:/private/b\n        version: link:/private/b\n      fixture-private-a:\n        specifier: link:/private/a\n        version: link:/private/a\npackages:\n  allowed-npm@1.0.0:\n    resolution: {integrity: sha512-allowed}\n  transitive@1.0.0:\n    resolution: {integrity: sha512-transitive}\n  packed-file@file:local-plugins/packed-file-2.0.0.tgz:\n    resolution: {integrity: sha512-file}\n  fixture-private-b@0.1.0:\n    resolution: {integrity: sha512-never}\n  fixture-private-a@0.4.6:\n    resolution: {integrity: sha512-never}\nsnapshots:\n  allowed-npm@1.0.0: {}\n  transitive@1.0.0: {}\n  packed-file@file:local-plugins/packed-file-2.0.0.tgz: {}\n  fixture-private-b@0.1.0: {}\n  fixture-private-a@0.4.6: {}\npatchedDependencies:\n  allowed-npm@1.0.0: hash-allowed\n  transitive@1.0.0: hash-transitive\n  fixture-private-b@9.9.9: hash-never\n`)
  return { root, profileDir, linked, linkedTarball }
}

async function exportFixture(t, options = {}) {
  const data = fixture(t)
  const snapshotDir = join(data.root, 'snapshot')
  const result = await exportSnapshot({
    profileDir: data.profileDir,
    outputDir: snapshotDir,
    machine: 'source-mac',
    machineId: 'source-mac',
    desktopVersion: '0.2.1-rc.5',
    createdAt: '2026-10-31T12:00:00.000Z',
    excluded: PRIVATE_PLUGINS,
    catalog: catalogFor(data.profileDir),
    packer: async (_source, destination) => {
      const file = 'packed-link-3.0.0.tgz'
      writeFileSync(join(destination, file), readFileSync(data.linkedTarball))
      return { file, integrity: 'sha512-packed-link', commit: COMMIT }
    },
    ...options,
  })
  return { ...data, ...result }
}

test('export leaves the excluded plugins out and carries only component switches, patches and lockfile entries of the rest', async t => {
  const { snapshot, snapshotDir } = await exportFixture(t)
  assert.equal(snapshot.format, 'dsh-plugin-sync/snapshot-2')
  assert.deepEqual(snapshot.excluded, ['fixture-private-a', 'fixture-private-b'])
  assert.deepEqual(snapshot.profiles.desktop.plugins.map(plugin => plugin.name), ['allowed-npm', 'github-plugin', 'packed-link', 'packed-file'])
  assert.deepEqual(snapshot.profiles.desktop.bundles, ['@deepseek-ai/dsh-base', 'allowed-npm', 'packed-link'])
  assert.deepEqual(snapshot.profiles.desktop.rows, [{ id: 'allowed-row', name: 'allowed-npm', disabled: false, owner: 'allowed-npm', title: 'Allowed part' }])
  const allowed = snapshot.profiles.desktop.plugins.find(plugin => plugin.name === 'allowed-npm')
  assert.deepEqual([allowed.title, allowed.description], [{ en: 'Allowed', zh: '允许的插件' }, 'Allowed plugin'])
  assert.deepEqual(snapshot.profiles.desktop.official, [{ name: OFFICIAL, enabled: false, title: { en: 'Session search', zh: '会话搜索' } }])
  assert.deepEqual(snapshot.profiles.desktop.exemptions, { 'allowed-npm@1.0.0': ['0.2.1-rc.5'] })
  assert.deepEqual(Object.keys(snapshot.profiles.desktop.patches), ['allowed.patch', 'transitive.patch'])
  assert.equal(snapshot.profiles.desktop.workspace.allowBuilds['allowed-npm'], true)
  assert.equal(snapshot.profiles.desktop.workspace.patchedDependencies['transitive@1.0.0'], 'patches/transitive.patch')
  assert.equal(snapshot.profiles.desktop.workspace.patchedDependencies['fixture-private-b@9.9.9'], undefined)
  assert.ok(!snapshot.profiles.desktop.lockfile.includes('fixture-private-b'))
  assert.ok(!snapshot.profiles.desktop.lockfile.includes('fixture-private-a'))
  assert.ok(!snapshot.profiles.desktop.lockfile.includes('packed-link'))
  assert.equal(snapshot.profiles.desktop.plugins.find(plugin => plugin.name === 'packed-link').source, 'packed')
  assert.equal(snapshot.profiles.desktop.plugins.find(plugin => plugin.name === 'packed-link').commit, COMMIT)
  assert.equal(snapshot.profiles.desktop.plugins.find(plugin => plugin.name === 'github-plugin').commit, COMMIT)
  assert.ok(existsSync(join(snapshotDir, 'packages', 'packed-link-3.0.0.tgz')))
  assert.ok(existsSync(join(snapshotDir, 'packages', 'packed-file-2.0.0.tgz')))
  const lock = parse(snapshot.profiles.desktop.lockfile)
  assert.equal(lock.lockfileVersion, '9.0')
  assert.equal(lock.importers['.'].dependencies['fixture-private-b'], undefined)
  assert.equal(lock.packages['fixture-private-b@0.1.0'], undefined)
})

test('export stops without printing a secret when it reaches a snapshot file', async t => {
  const data = fixture(t)
  writeFileSync(join(data.profileDir, 'patches', 'allowed.patch'), FIXTURE_SECRET)
  await assert.rejects(exportSnapshot({
    profileDir: data.profileDir,
    outputDir: join(data.root, 'snapshot'),
    machine: 'source-mac',
    machineId: 'source-mac',
    desktopVersion: '0.2.1-rc.5',
    excluded: PRIVATE_PLUGINS,
    packer: async (_source, destination) => {
      writeFileSync(join(destination, 'packed-link-3.0.0.tgz'), readFileSync(data.linkedTarball))
      return { file: 'packed-link-3.0.0.tgz', integrity: 'sha512-packed-link', commit: COMMIT }
    },
  }), error => {
    assert.match(error.message, /snapshot\.json/)
    assert.ok(!error.message.includes(FIXTURE_SECRET))
    return true
  })
})

test('zip carries snapshot.json and the packed plugins', async t => {
  const { root, snapshotDir } = await exportFixture(t)
  const zipPath = join(root, 'snapshot.zip')
  await writeZip(snapshotDir, zipPath)
  const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n')
  assert.ok(entries.includes('snapshot.json'))
  assert.ok(entries.includes('packages/packed-link-3.0.0.tgz'))
  assert.ok(entries.includes('packages/packed-file-2.0.0.tgz'))
})

test('git writer commits only the machine snapshot in a local worktree', async t => {
  const { root, snapshotDir } = await exportFixture(t)
  const repository = join(root, 'repository')
  mkdirSync(repository)
  execFileSync('git', ['init', '-q', repository])
  const commit = await commitSnapshot(snapshotDir, repository, 'source-mac')
  assert.match(commit, /^[0-9a-f]{40}$/)
  assert.ok(existsSync(join(repository, 'machines', 'source-mac', 'snapshot.json')))
  assert.match(execFileSync('git', ['-C', repository, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), /dsh-plugin-sync.*source-mac/)
  assert.equal(execFileSync('git', ['-C', repository, 'status', '--porcelain'], { encoding: 'utf8' }), '')
})

test('a failed commit leaves a local path repository untouched', async t => {
  const { root, snapshotDir } = await exportFixture(t)
  const repository = join(root, 'local-hook-repository')
  mkdirSync(repository)
  execFileSync('git', ['init', '-q', repository])
  const first = await commitSnapshot(snapshotDir, repository, 'source-mac')
  const value = JSON.parse(readFileSync(join(snapshotDir, 'snapshot.json'), 'utf8'))
  value.createdAt = '2026-11-01T12:00:00.000Z'
  writeFileSync(join(snapshotDir, 'snapshot.json'), JSON.stringify(value))
  const hook = join(repository, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n')
  execFileSync('chmod', ['755', hook])
  await assert.rejects(commitSnapshot(snapshotDir, repository, 'source-mac'))
  assert.notEqual(execFileSync('git', ['-C', repository, 'status', '--porcelain'], { encoding: 'utf8' }), '')
  assert.equal(execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), first)
})

test('App pnpm packs a clean linked repository and records its commit', async t => {
  const data = fixture(t)
  execFileSync('git', ['init', '-q', data.linked])
  execFileSync('git', ['-C', data.linked, 'add', 'package.json'])
  execFileSync('git', ['-C', data.linked, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-q', '-m', 'fixture'])
  const commit = execFileSync('git', ['-C', data.linked, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const { snapshot } = await exportSnapshot({
    profileDir: data.profileDir,
    outputDir: join(data.root, 'snapshot'),
    machine: 'source-mac',
    machineId: 'source-mac',
    desktopVersion: '0.2.1-rc.5',
    excluded: PRIVATE_PLUGINS,
  })
  assert.equal(snapshot.profiles.desktop.plugins.find(plugin => plugin.name === 'packed-link').commit, commit)
})

test('a dirty linked repository is refused before packing', async t => {
  const data = fixture(t)
  execFileSync('git', ['init', '-q', data.linked])
  writeFileSync(join(data.linked, 'uncommitted.txt'), 'dirty')
  await assert.rejects(exportSnapshot({
    profileDir: data.profileDir,
    outputDir: join(data.root, 'snapshot'),
    machine: 'source-mac',
    machineId: 'source-mac',
    desktopVersion: '0.2.1-rc.5',
    excluded: PRIVATE_PLUGINS,
  }), /未提交的更改/)
})

test('secret scan decompresses packed tgz files and blocks a secret inside', async t => {
  const data = fixture(t)
  const source = join(data.root, 'secret-package', 'package')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'packed-file', version: '2.0.0' }))
  writeFileSync(join(source, 'secret.txt'), FIXTURE_SECRET)
  execFileSync('tar', ['-czf', join(data.profileDir, 'local-plugins', 'packed-file-2.0.0.tgz'), '-C', dirname(source), 'package'])
  await assert.rejects(exportSnapshot({
    profileDir: data.profileDir,
    outputDir: join(data.root, 'snapshot'),
    machine: 'source-mac',
    machineId: 'source-mac',
    desktopVersion: '0.2.1-rc.5',
    excluded: PRIVATE_PLUGINS,
    packer: async (_source, destination) => {
      writeFileSync(join(destination, 'packed-link-3.0.0.tgz'), readFileSync(data.linkedTarball))
      return { file: 'packed-link-3.0.0.tgz', integrity: 'sha512-packed-link', commit: COMMIT }
    },
  }), error => {
    assert.match(error.message, /packages\/packed-file-2\.0\.0\.tgz/)
    assert.ok(!error.message.includes(FIXTURE_SECRET))
    return true
  })
})

test('a plugin the owner unchecks stays out with its component switches, patches and exemptions', async t => {
  const { snapshot } = await exportFixture(t, { excluded: [...PRIVATE_PLUGINS, 'allowed-npm', 'not-installed-here'] })
  const desktop = snapshot.profiles.desktop
  assert.deepEqual(snapshot.excluded, ['allowed-npm', 'fixture-private-a', 'fixture-private-b'])
  assert.ok(!desktop.plugins.some(plugin => plugin.name === 'allowed-npm'))
  assert.ok(!desktop.bundles.includes('allowed-npm'))
  assert.deepEqual(desktop.rows, [])
  assert.deepEqual(desktop.exemptions, {})
  assert.equal(desktop.workspace.patchedDependencies['allowed-npm@1.0.0'], undefined)
  assert.equal(parse(desktop.lockfile).importers['.'].dependencies['allowed-npm'], undefined)
})

test('an absolute file: path into local-plugins exports as the relative spec and leaves the lockfile', async t => {
  const data = fixture(t)
  const manifest = JSON.parse(readFileSync(join(data.profileDir, 'package.json'), 'utf8'))
  const absolute = `file:${join(data.profileDir, 'local-plugins', 'packed-file-2.0.0.tgz')}`
  manifest.dependencies['packed-file'] = absolute
  writeFileSync(join(data.profileDir, 'package.json'), JSON.stringify(manifest))
  const lock = readFileSync(join(data.profileDir, 'pnpm-lock.yaml'), 'utf8').replaceAll('file:local-plugins/packed-file-2.0.0.tgz', absolute)
  writeFileSync(join(data.profileDir, 'pnpm-lock.yaml'), lock)
  const { snapshot } = await exportSnapshot({
    profileDir: data.profileDir,
    outputDir: join(data.root, 'snapshot'),
    machine: 'other-mac',
    machineId: 'other-mac',
    desktopVersion: '0.2.1-rc.5',
    excluded: PRIVATE_PLUGINS,
    packer: async (_source, destination) => {
      writeFileSync(join(destination, 'packed-link-3.0.0.tgz'), readFileSync(data.linkedTarball))
      return { file: 'packed-link-3.0.0.tgz', commit: COMMIT }
    },
  })
  const plugin = snapshot.profiles.desktop.plugins.find(entry => entry.name === 'packed-file')
  assert.equal(plugin.spec, 'file:local-plugins/packed-file-2.0.0.tgz')
  assert.equal(plugin.source, 'packed')
  assert.ok(!snapshot.profiles.desktop.lockfile.includes(data.profileDir))
  assert.equal(parse(snapshot.profiles.desktop.lockfile).importers['.'].dependencies['packed-file'], undefined)
})

test('a file: dependency outside local-plugins is refused', async t => {
  const data = fixture(t)
  const manifest = JSON.parse(readFileSync(join(data.profileDir, 'package.json'), 'utf8'))
  manifest.dependencies['packed-file'] = `file:${join(data.root, 'packed-file-2.0.0.tgz')}`
  writeFileSync(join(data.profileDir, 'package.json'), JSON.stringify(manifest))
  await assert.rejects(exportSnapshot({
    profileDir: data.profileDir,
    outputDir: join(data.root, 'snapshot-outside'),
    machine: 'source-mac',
    machineId: 'source-mac',
    desktopVersion: '0.2.1-rc.5',
    excluded: PRIVATE_PLUGINS,
    packer: async (_source, destination) => {
      writeFileSync(join(destination, 'packed-link-3.0.0.tgz'), readFileSync(data.linkedTarball))
      return { file: 'packed-link-3.0.0.tgz', commit: COMMIT }
    },
  }), /local-plugins/)
})

test('component switches export only for rows a bundle of an exported plugin declares', async t => {
  const data = fixture(t)
  writeFileSync(join(data.profileDir, 'cordis.patch.yml'), [
    '- id: allowed-row', '  name: allowed-npm', '  disabled: true',
    '- id: official-row', '  disabled: true',
    '- id: official-named', '  name: \'@deepseek-ai/dsh-experimental-session-search\'', '  disabled: false',
    '- id: config-only', '  name: allowed-npm', '  config:', '    level: 2',
    '- id: unrelated-row', '  name: someone-else', '  disabled: true',
    '- id: undeclared-row', '  disabled: true',
    '- id: base-row', '  disabled: true',
    '- id: private-b-host', '  disabled: true',
    '- insert:', '    - id: inserted-row', '      name: allowed-npm', '      disabled: true',
    '',
  ].join('\n'))
  const { snapshot } = await exportSnapshot({
    profileDir: data.profileDir,
    outputDir: join(data.root, 'snapshot-rows'),
    machine: 'source-mac',
    machineId: 'Source-Mac',
    desktopVersion: '0.2.1-rc.5',
    excluded: PRIVATE_PLUGINS,
    catalog: catalogFor(data.profileDir),
    packer: async (_source, destination) => {
      writeFileSync(join(destination, 'packed-link-3.0.0.tgz'), readFileSync(data.linkedTarball))
      return { file: 'packed-link-3.0.0.tgz', commit: COMMIT }
    },
  })
  assert.deepEqual(snapshot.profiles.desktop.rows.map(row => [row.id, row.owner]), [['allowed-row', 'allowed-npm'], ['official-row', OFFICIAL], ['official-named', OFFICIAL]])
  assert.equal(snapshot.machineId, 'Source-Mac')
  const withoutOfficial = await exportSnapshot({
    profileDir: data.profileDir,
    outputDir: join(data.root, 'snapshot-rows-2'),
    machine: 'source-mac',
    machineId: 'Source-Mac',
    desktopVersion: '0.2.1-rc.5',
    excluded: [...PRIVATE_PLUGINS, OFFICIAL],
    catalog: catalogFor(data.profileDir),
    packer: async (_source, destination) => {
      writeFileSync(join(destination, 'packed-link-3.0.0.tgz'), readFileSync(data.linkedTarball))
      return { file: 'packed-link-3.0.0.tgz', commit: COMMIT }
    },
  })
  assert.deepEqual(withoutOfficial.snapshot.profiles.desktop.rows.map(row => row.id), ['allowed-row'])
  assert.deepEqual(withoutOfficial.snapshot.profiles.desktop.official, [])
  assert.deepEqual(withoutOfficial.snapshot.excluded, [OFFICIAL, 'fixture-private-a', 'fixture-private-b'].sort())
})

test('machine directory names drop .local and unsafe characters', () => {
  assert.equal(machineDirectory('Alices-MacBook-Air.local'), 'Alices-MacBook-Air')
  assert.equal(machineDirectory('示例 Mac'), '---Mac')
  assert.throws(() => machineDirectory('..'), /Git 目录/)
})
