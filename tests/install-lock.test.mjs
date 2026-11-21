import test from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { mergeInstallLock, preserveLockText } from '../lib/core/install-lock.js'

const before = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      external:
        specifier: ^1.0.0
        version: 1.0.0(peer@2.0.0)
packages:
  external@1.0.0:
    resolution: {integrity: sha512-original}
  peer@2.0.0:
    resolution: {integrity: sha512-peer}
snapshots:
  external@1.0.0(peer@2.0.0):
    dependencies:
      peer: 2.0.0
  peer@2.0.0: {}
`
const incoming = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      kit:
        specifier: file:local-plugins/kit.tgz
        version: file:local-plugins/kit.tgz
packages:
  kit@file:local-plugins/kit.tgz:
    resolution: {integrity: sha512-kit, tarball: file:local-plugins/kit.tgz}
snapshots:
  kit@file:local-plugins/kit.tgz: {}
`

test('merging a packed install retains an untouched peer binding and exact lock entry text', () => {
  const plan = { untouched: ['external'], manifest: { dependencies: { external: '^1.0.0', kit: 'file:local-plugins/kit.tgz' } }, workspaceYaml: '{}\n' }
  const result = mergeInstallLock(before, incoming, plan)
  const lock = parse(result)
  assert.equal(lock.importers['.'].dependencies.external.version, '1.0.0(peer@2.0.0)')
  assert.deepEqual(lock.snapshots['external@1.0.0(peer@2.0.0)'], { dependencies: { peer: '2.0.0' } })
  assert.match(result, /resolution: \{integrity: sha512-original\}/)
  assert.match(result, /peer@2\.0\.0: \{\}/)
  const formatted = result.replace('{integrity: sha512-original}', '{ integrity: sha512-original }')
  assert.equal(preserveLockText(before, formatted, ['external']), result)
  assert.throws(() => mergeInstallLock(before, incoming.replace('kit@file:local-plugins/kit.tgz:', 'peer@2.0.0:'), plan), /未选插件/)
})

test('obsolete registry graphs disappear before frozen policy verification but retained graphs stay', () => {
  const old = before.replace('packages:\n', 'packages:\n  unused@1.0.0:\n    resolution: {integrity: sha512-unused}\n').replace('snapshots:\n', 'snapshots:\n  unused@1.0.0: {}\n')
  const plan = { untouched: ['external'], manifest: { dependencies: { external: '^1.0.0', kit: 'file:local-plugins/kit.tgz' } }, workspaceYaml: '{}\n' }
  const result = parse(mergeInstallLock(old, incoming, plan))
  assert.equal(result.packages['unused@1.0.0'], undefined)
  assert.equal(result.snapshots['unused@1.0.0'], undefined)
  assert.deepEqual(Object.keys(result.packages).sort(), ['external@1.0.0', 'kit@file:local-plugins/kit.tgz', 'peer@2.0.0'])
})
