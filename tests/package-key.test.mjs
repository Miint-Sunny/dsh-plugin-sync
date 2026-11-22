import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stageApplyPlan, verifyApplied } from '../lib/core/apply.js'
import { validateSnapshot } from '../lib/core/plan.js'
import { packageNameFromKey } from '../lib/core/util.js'

const UNVERSIONED = ['dsh-foo', '@scope/pkg']

function snapshot(patchedDependencies, excluded) {
  return {
    format: 'dsh-plugin-sync/snapshot-2',
    createdAt: '2026-11-10T12:00:00.000Z',
    machine: 'Test Mac A',
    machineId: 'source-mac',
    exporter: { name: 'dsh-plugin-sync', version: '0.4.0' },
    dsh: { desktopVersion: '0.2.1-rc.5' },
    excluded,
    profiles: {
      desktop: {
        plugins: [],
        official: [],
        bundles: [],
        rows: [],
        exemptions: {},
        workspace: { patchedDependencies },
        patches: { 'x.patch': 'patch text' },
        lockfile: "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\nsnapshots: {}\n",
      },
    },
  }
}

test('XS-012 a snapshot patch selector without a version still belongs to the plugin it names', () => {
  for (const name of UNVERSIONED) {
    for (const key of [name, `${name}@1.0.0`]) {
      assert.throws(() => validateSnapshot(snapshot({ [key]: 'patches/x.patch' }, [name])), { message: `快照无效：补丁属于不导出的插件：${key}` })
    }
    assert.deepEqual(validateSnapshot(snapshot({ [name]: 'patches/x.patch' }, [])).profiles.desktop.workspace.patchedDependencies, { [name]: 'patches/x.patch' })
  }
})

test('XS-012 a staged plan cannot carry a patch for an untouched plugin named without a version', async t => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-sync-package-key-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of UNVERSIONED) {
    for (const key of [name, `${name}@1.0.0`]) {
      const plan = { format: 'dsh-plugin-sync/plan-1', id: 'package-key', untouched: [name], snapshotPatchedDependencies: { [key]: 'patches/x.patch' } }
      await assert.rejects(stageApplyPlan({ plan, sourceDir: root, stagedDir: join(root, 'staged') }), { message: `应用计划含未选中插件的补丁：${key}` })
    }
  }
})

test('XS-012 packageNameFromKey drops the version, including a peer suffix, and keeps an unversioned key whole', () => {
  const cases = [
    ['dsh-foo', 'dsh-foo'],
    ['@scope/pkg', '@scope/pkg'],
    ['dsh-foo@1.0.0', 'dsh-foo'],
    ['@scope/pkg@1.0.0', '@scope/pkg'],
    ['pkg@1.0.0(react@18.3.1)', 'pkg'],
    ['@scope/pkg@1.0.0(@types/react@18.3.1)', '@scope/pkg'],
  ]
  for (const [key, name] of cases) assert.equal(packageNameFromKey(key), name, key)
})

test('after applying, the patch check looks in the directory of the plugin whose selector has no version', async t => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-sync-package-key-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of UNVERSIONED) {
    const profile = join(root, name.replace('/', '-'))
    const manifest = { dependencies: { [name]: '1.0.0' } }
    mkdirSync(join(profile, 'node_modules', name, 'lib'), { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    writeFileSync(join(profile, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    const plan = {
      manifest,
      plugins: [{ name, version: '1.0.0' }],
      workspaceYaml: `patchedDependencies:\n  "${name}": patches/x.patch\n`,
      patches: { 'x.patch': '// dsh-launcher patch\n+++ b/lib/x.js\n' },
    }
    await assert.rejects(verifyApplied(profile, plan), /安装后未找到带 dsh-launcher patch 标记的补丁目标/)
    writeFileSync(join(profile, 'node_modules', name, 'lib', 'x.js'), '// dsh-launcher patch\n')
    await verifyApplied(profile, plan)
  }
})
