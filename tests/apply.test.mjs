import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { parse, stringify } from 'yaml'
import { exportSnapshot } from '../lib/core/export.js'
import { buildChanges, createApplyPlan } from '../lib/core/plan.js'
import { applyStagedPlan as applyPlan, assertNoAppAllowed, stageApplyPlan, updateRows } from '../lib/core/apply.js'

const APP = process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app'
const applyStagedPlan = options => applyPlan({ appPath: APP, ...options })
const DSH = join(APP, 'Contents/Resources/runtime/cli/bin/dsh')
const DESKTOP_VERSION = JSON.parse(readFileSync(join(APP, 'Contents/Resources/runtime/primary-runtime/runtime.json'), 'utf8')).desktopVersion
const SECRET = 'fixture-apply-token-123'

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function freshProfile(root, withRows = false) {
  const dshHome = join(root, 'home')
  const profile = join(dshHome, 'profiles', 'desktop')
  write(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2))
  write(join(profile, 'cordis.yml'), '[]\n')
  write(join(profile, 'cordis.patch.yml'), withRows
    ? `- id: fixture-a-row\n  name: fixture-a\n  disabled: false\n  config:\n    token: ${SECRET}\n`
    : '[]\n')
  // Keep the packages under this fixture: the account's global pnpm store would also record the profile in its projects/.
  write(join(profile, 'pnpm-workspace.yaml'), `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nstoreDir: ${join(root, 'store')}\ncacheDir: ${join(root, 'cache')}\n`)
  return { dshHome, profile }
}

function dsh(dshHome, args) {
  execFileSync(DSH, args, {
    cwd: join(dshHome, 'profiles', 'desktop'),
    env: { ...process.env, DSH_HOME: dshHome, npm_config_update_notifier: 'false', DEEPSEEK_API_KEY: undefined, DEEPSEC_SCOPE_SIGNING_KEY: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function makePlugin(root, name) {
  const source = join(root, `${name}-source`, 'package')
  write(join(source, 'package.json'), JSON.stringify({
    name, version: '1.0.0', main: 'index.js', type: 'module',
    engines: { dsh: '>=0.2.1-rc.5 <0.3.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  write(join(source, 'index.js'), 'export {}\n')
  write(join(source, 'cordis.patch.yml'), `- insert:\n    - id: ${name}-row\n      name: ${name}\n`)
  const destination = join(root, `${name}-1.0.0.tgz`)
  execFileSync('tar', ['-czf', destination, '-C', dirname(source), 'package'])
  return destination
}

let suitePromise, suiteRoot
after(() => { if (suiteRoot) rmSync(suiteRoot, { recursive: true, force: true }) })
function suite() {
  suitePromise ??= (async () => {
    const root = suiteRoot = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-apply-'))
    const a = freshProfile(join(root, 'A'))
    for (const name of ['fixture-a', 'fixture-b']) {
      const tarball = makePlugin(root, name)
      write(join(a.profile, 'local-plugins', `${name}-1.0.0.tgz`), readFileSync(tarball))
    }
    dsh(a.dshHome, ['plugin', '--profile', 'desktop', 'add', 'file:local-plugins/fixture-a-1.0.0.tgz', 'file:local-plugins/fixture-b-1.0.0.tgz', '--save-exact'])
    write(join(a.profile, 'patches', 'fixture-a.patch'), `diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1,2 @@\n export {}\n+// dsh-launcher patch\n`)
    const workspace = parse(readFileSync(join(a.profile, 'pnpm-workspace.yaml'), 'utf8'))
    workspace.patchedDependencies = { 'fixture-a@1.0.0': 'patches/fixture-a.patch' }
    write(join(a.profile, 'pnpm-workspace.yaml'), stringify(workspace))
    dsh(a.dshHome, ['plugin', '--profile', 'desktop', 'install', '--no-frozen-lockfile'])
    write(join(a.profile, 'cordis.patch.yml'), `- id: fixture-a-row\n  name: fixture-a\n  disabled: true\n  config:\n    token: ${SECRET}\n- id: fixture-b-row\n  name: fixture-b\n  disabled: false\n`)
    const snapshotDir = join(root, 'snapshot')
    const { snapshot } = await exportSnapshot({ profileDir: a.profile, outputDir: snapshotDir, machine: 'A', machineId: 'mac-a', desktopVersion: DESKTOP_VERSION })
    return { root, a, snapshotDir, snapshot }
  })()
  return suitePromise
}

function localOf(dshHome) {
  const profile = join(dshHome, 'profiles', 'desktop')
  const read = file => existsSync(join(profile, file)) ? readFileSync(join(profile, file), 'utf8') : undefined
  const manifest = JSON.parse(read('package.json'))
  const versions = {}
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const installed = join(profile, 'node_modules', name, 'package.json')
    if (existsSync(installed)) versions[name] = JSON.parse(readFileSync(installed, 'utf8')).version
  }
  const patch = parse(read('cordis.patch.yml') ?? '[]') ?? []
  const rows = Object.fromEntries(patch.filter(entry => typeof entry?.id === 'string' && typeof entry.disabled === 'boolean').map(entry => [entry.id, entry.disabled]))
  return { manifest, workspace: parse(read('pnpm-workspace.yaml')), lockfile: read('pnpm-lock.yaml'), versions, rows }
}

async function planFor(data, dshHome, names, snapshot = data.snapshot) {
  const local = localOf(dshHome)
  const set = buildChanges({ snapshot, local, currentDesktopVersion: DESKTOP_VERSION })
  const selected = set.changes.filter(change => names.includes(change.name) || names.includes(change.owner)).map(change => change.id)
  return createApplyPlan({ snapshot, local, currentDesktopVersion: DESKTOP_VERSION, selected })
}

test('full apply installs packages and patches, changes only row disabled fields, and writes a result', async () => {
  const data = await suite()
  const b = freshProfile(join(data.root, 'B'), true)
  const plan = await planFor(data, b.dshHome, ['fixture-a', 'fixture-b'])
  const stagedDir = join(data.root, 'staged-full')
  await stageApplyPlan({ plan, sourceDir: data.snapshotDir, stagedDir })
  write(join(stagedDir, 'source-snapshot.json'), JSON.stringify(data.snapshot))
  const result = await applyStagedPlan({ stagedDir, dshHome: b.dshHome, noApp: true, trashDir: join(data.root, 'trash') })
  assert.equal(result.success, true, result.error)
  assert.ok(!existsSync(stagedDir))
  assert.ok(existsSync(join(data.root, 'trash', 'staged-full', 'plan.json')))
  for (const name of ['fixture-a', 'fixture-b']) {
    assert.equal(JSON.parse(readFileSync(join(b.profile, 'node_modules', name, 'package.json'), 'utf8')).version, '1.0.0')
  }
  assert.match(readFileSync(join(b.profile, 'node_modules', 'fixture-a', 'index.js'), 'utf8'), /dsh-launcher patch/)
  const rows = parse(readFileSync(join(b.profile, 'cordis.patch.yml'), 'utf8'))
  assert.equal(rows.find(row => row.id === 'fixture-a-row').disabled, true)
  assert.equal(rows.find(row => row.id === 'fixture-a-row').config.token, SECRET)
  assert.equal(rows.find(row => row.id === 'fixture-b-row').disabled, false)
  assert.deepEqual(result.appendedRows, ['fixture-b-row'])
  assert.equal(JSON.parse(readFileSync(join(b.dshHome, 'plugin-sync', 'last-apply.json'), 'utf8')).success, true)
  assert.equal(JSON.parse(readFileSync(join(b.dshHome, 'plugin-sync', 'last-snapshot.json'), 'utf8')).machine, 'A')
})

test('a fresh partial apply installs only checked snapshot plugins', async () => {
  const data = await suite()
  const partial = freshProfile(join(data.root, 'B-partial'))
  const plan = await planFor(data, partial.dshHome, ['fixture-a'])
  const stagedDir = join(data.root, 'staged-partial')
  await stageApplyPlan({ plan, sourceDir: data.snapshotDir, stagedDir })
  const result = await applyStagedPlan({ stagedDir, dshHome: partial.dshHome, noApp: true })
  assert.equal(result.success, true, result.error)
  assert.ok(existsSync(join(partial.profile, 'node_modules', 'fixture-a', 'package.json')))
  assert.ok(!existsSync(join(partial.profile, 'node_modules', 'fixture-b', 'package.json')))
  assert.equal(JSON.parse(readFileSync(join(partial.profile, 'package.json'), 'utf8')).dependencies['fixture-b'], undefined)
})

test('a partial apply still installs when CI=true makes pnpm default to a frozen lockfile', async () => {
  const data = await suite()
  const partial = freshProfile(join(data.root, 'B-partial-ci'))
  const plan = await planFor(data, partial.dshHome, ['fixture-a'])
  assert.equal(plan.frozen, false)
  const stagedDir = join(data.root, 'staged-partial-ci')
  await stageApplyPlan({ plan, sourceDir: data.snapshotDir, stagedDir })
  // GitHub Actions sets CI=true for every job; the DSH install runs pnpm with the inherited environment.
  const previous = process.env.CI
  process.env.CI = 'true'
  let result
  try {
    result = await applyStagedPlan({ stagedDir, dshHome: partial.dshHome, noApp: true })
  } finally {
    if (previous === undefined) delete process.env.CI
    else process.env.CI = previous
  }
  assert.equal(result.success, true, result.error)
  assert.ok(existsSync(join(partial.profile, 'node_modules', 'fixture-a', 'package.json')))
  assert.ok(!existsSync(join(partial.profile, 'node_modules', 'fixture-b', 'package.json')))
})

test('an installation failure restores every profile file and the previous installed plugin', async () => {
  const data = await suite()
  const b = freshProfile(join(data.root, 'B-rollback'), true)
  const goodPlan = await planFor(data, b.dshHome, ['fixture-a', 'fixture-b'])
  await stageApplyPlan({ plan: goodPlan, sourceDir: data.snapshotDir, stagedDir: join(data.root, 'staged-before-rollback') })
  const good = await applyStagedPlan({ stagedDir: join(data.root, 'staged-before-rollback'), dshHome: b.dshHome, noApp: true })
  assert.equal(good.success, true, good.error)
  const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']
  const before = Object.fromEntries(files.map(file => [file, readFileSync(join(b.profile, file), 'utf8')]))
  const stagedDir = join(data.root, 'staged-bad')
  await stageApplyPlan({ plan: goodPlan, sourceDir: data.snapshotDir, stagedDir })
  const lockPath = join(stagedDir, 'files', 'pnpm-lock.yaml')
  const lock = parse(readFileSync(lockPath, 'utf8'))
  const first = Object.values(lock.packages)[0]
  first.resolution.integrity = 'sha512-AAAA'
  write(lockPath, stringify(lock))
  const result = await applyStagedPlan({ stagedDir, dshHome: b.dshHome, noApp: true })
  assert.equal(result.success, false)
  assert.ok(existsSync(result.backupDir))
  assert.equal(dirname(result.backupDir), join(b.dshHome, 'backups', 'plugin-sync'))
  for (const file of files) assert.equal(readFileSync(join(b.profile, file), 'utf8'), before[file], file)
  assert.match(readFileSync(join(b.profile, 'node_modules', 'fixture-a', 'index.js'), 'utf8'), /dsh-launcher patch/)
  assert.equal(JSON.parse(readFileSync(join(b.dshHome, 'plugin-sync', 'last-apply.json'), 'utf8')).success, false)
})

test('no-app is allowed only outside the real DSH home', () => {
  assert.throws(() => assertNoAppAllowed('/Users/example/.dsh', '/Users/example/.dsh'), /临时 DSH_HOME/)
  assert.doesNotThrow(() => assertNoAppAllowed('/tmp/example-home', '/Users/example/.dsh'))
})

test('apply rejects a staged plan that was modified to touch a plugin outside the chosen changes', async () => {
  const data = await suite()
  const b = freshProfile(join(data.root, 'B-untouched'))
  const plan = await planFor(data, b.dshHome, ['fixture-a'])
  assert.deepEqual(plan.untouched, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const before = readFileSync(join(b.profile, 'package.json'), 'utf8')
  const tamper = [
    value => { value.plugins.push({ name: '@deepseek-ai/dsh-web-app' }) },
    value => { value.rows.push({ id: 'web-app-row', disabled: true, owner: '@deepseek-ai/dsh-web-app' }) },
    value => { value.manifest.dsh.profile.bundles = value.manifest.dsh.profile.bundles.filter(name => name !== '@deepseek-ai/dsh-web-app') },
  ]
  for (const [index, change] of tamper.entries()) {
    const stagedDir = join(data.root, `staged-untouched-${index}`)
    await stageApplyPlan({ plan, sourceDir: data.snapshotDir, stagedDir })
    const stagedPlan = JSON.parse(readFileSync(join(stagedDir, 'plan.json'), 'utf8'))
    change(stagedPlan)
    write(join(stagedDir, 'plan.json'), JSON.stringify(stagedPlan))
    const result = await applyStagedPlan({ stagedDir, dshHome: b.dshHome, noApp: true })
    assert.equal(result.success, false)
    assert.match(result.error, /未选中/)
    assert.equal(readFileSync(join(b.profile, 'package.json'), 'utf8'), before)
  }
})

test('plugins the source left out and plugins installed only here stay untouched through compare, stage and no-app apply', async () => {
  const data = await suite()
  const protectedPlugins = []
  for (const name of ['fixture-private-b', 'fixture-private-a']) {
    const checkout = join(data.root, `${name}-checkout`)
    write(join(checkout, 'package.json'), JSON.stringify({ name, version: '0.1.0', main: 'index.js', type: 'module', engines: { dsh: '>=0.2.1-rc.5 <0.3.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    write(join(checkout, 'index.js'), 'export {}\n')
    write(join(checkout, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n`)
    protectedPlugins.push({ name, checkout })
    dsh(data.a.dshHome, ['plugin', '--profile', 'desktop', 'add', `link:${checkout}`, '--save-exact'])
  }
  const snapshotDir = join(data.root, 'snapshot-protected')
  const { snapshot } = await exportSnapshot({ profileDir: data.a.profile, outputDir: snapshotDir, machine: 'A', machineId: 'mac-a', desktopVersion: DESKTOP_VERSION, excluded: ['fixture-private-b', 'fixture-private-a'] })
  assert.deepEqual(snapshot.excluded, ['fixture-private-a', 'fixture-private-b'])
  const b = freshProfile(join(data.root, 'B-protected'))
  for (const { name, checkout } of protectedPlugins) dsh(b.dshHome, ['plugin', '--profile', 'desktop', 'add', `link:${checkout}`, '--save-exact'])
  const before = JSON.parse(readFileSync(join(b.profile, 'package.json'), 'utf8'))
  const protectedOnly = value => Object.fromEntries(Object.entries(value).filter(([name]) => name.includes('fixture-private-')))
  const set = buildChanges({ snapshot, local: localOf(b.dshHome), currentDesktopVersion: DESKTOP_VERSION })
  assert.ok(!set.changes.some(change => change.name.includes('fixture-private-') || change.owner?.includes('fixture-private-')))
  assert.deepEqual(set.unchanged.filter(entry => entry.name.includes('fixture-private-')).map(entry => entry.reason), ['not-exported', 'not-exported'])
  await assert.rejects(createApplyPlan({ snapshot, local: localOf(b.dshHome), currentDesktopVersion: DESKTOP_VERSION, selected: ['plugin:fixture-private-b'] }), /不存在的变更/)
  const plan = await planFor(data, b.dshHome, ['fixture-a', 'fixture-b'], snapshot)
  assert.deepEqual(protectedOnly(plan.manifest.dependencies), protectedOnly(before.dependencies))
  assert.deepEqual(protectedOnly(plan.manifest.dsh.profile.bundles), protectedOnly(before.dsh.profile.bundles))
  const stagedDir = join(data.root, 'staged-protected')
  await stageApplyPlan({ plan, sourceDir: snapshotDir, stagedDir })
  const result = await applyStagedPlan({ stagedDir, dshHome: b.dshHome, noApp: true })
  assert.equal(result.success, true, result.error)
  const after = JSON.parse(readFileSync(join(b.profile, 'package.json'), 'utf8'))
  assert.deepEqual(protectedOnly(after.dependencies), protectedOnly(before.dependencies))
  assert.deepEqual(protectedOnly(after.dsh.profile.bundles), protectedOnly(before.dsh.profile.bundles))
  for (const { name } of protectedPlugins) assert.ok(existsSync(join(b.profile, 'node_modules', name, 'package.json')))
})

test('rollback restores the original node_modules without another install command', async () => {
  const data = await suite()
  const b = freshProfile(join(data.root, 'B-offline-rollback'))
  const goodPlan = await planFor(data, b.dshHome, ['fixture-a', 'fixture-b'])
  await stageApplyPlan({ plan: goodPlan, sourceDir: data.snapshotDir, stagedDir: join(data.root, 'staged-offline-good') })
  const good = await applyStagedPlan({ stagedDir: join(data.root, 'staged-offline-good'), dshHome: b.dshHome, noApp: true })
  assert.equal(good.success, true, good.error)
  const marker = join(b.profile, 'node_modules', 'fixture-a', 'original-marker.txt')
  write(marker, 'original node_modules\n')
  const stagedDir = join(data.root, 'staged-offline-bad')
  await stageApplyPlan({ plan: goodPlan, sourceDir: data.snapshotDir, stagedDir })
  const lockPath = join(stagedDir, 'files', 'pnpm-lock.yaml')
  const lock = parse(readFileSync(lockPath, 'utf8'))
  Object.values(lock.packages)[0].resolution.integrity = 'sha512-AAAA'
  write(lockPath, stringify(lock))
  const log = join(data.root, 'fake-dsh.log')
  const fakeDsh = join(data.root, 'fake-dsh.sh')
  write(fakeDsh, `#!/bin/sh\nprintf '%s\\n' "$*" >>${log}\nexit 1\n`)
  execFileSync('chmod', ['755', fakeDsh])
  const result = await applyStagedPlan({ stagedDir, dshHome: b.dshHome, noApp: true, dshPath: fakeDsh, trashDir: join(data.root, 'trash') })
  assert.equal(result.success, false)
  assert.equal(readFileSync(marker, 'utf8'), 'original node_modules\n')
  const calls = readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(calls.length, 1)
  assert.equal(result.rollbackError, undefined)
})

test('cleanup failure after the snapshot commit keeps the new install and records a warning', async () => {
  const data = await suite()
  const b = freshProfile(join(data.root, 'B-post-commit-cleanup'))
  const plan = await planFor(data, b.dshHome, ['fixture-a', 'fixture-b'])
  const parent = join(data.root, 'read-only-staging')
  const stagedDir = join(parent, 'staged-cleanup-fails')
  await stageApplyPlan({ plan, sourceDir: data.snapshotDir, stagedDir })
  write(join(stagedDir, 'source-snapshot.json'), JSON.stringify(data.snapshot))
  chmodSync(parent, 0o555)
  let result
  try {
    result = await applyStagedPlan({ stagedDir, dshHome: b.dshHome, noApp: true, trashDir: join(data.root, 'trash') })
  } finally {
    chmodSync(parent, 0o755)
  }
  assert.equal(result.success, true, result.error)
  assert.match(result.warnings.join('\n'), /清理已应用的暂存文件/)
  assert.equal(JSON.parse(readFileSync(join(b.profile, 'node_modules', 'fixture-a', 'package.json'), 'utf8')).version, '1.0.0')
  assert.equal(JSON.parse(readFileSync(join(b.dshHome, 'plugin-sync', 'last-snapshot.json'), 'utf8')).machine, 'A')
})

test('open failure after a successful apply only records a warning and never rolls back', async () => {
  const data = await suite()
  const b = freshProfile(join(data.root, 'B-post-commit-open'))
  const plan = await planFor(data, b.dshHome, ['fixture-a', 'fixture-b'])
  const stagedDir = join(data.root, 'staged-open-fails')
  await stageApplyPlan({ plan, sourceDir: data.snapshotDir, stagedDir })
  const bin = join(data.root, 'fake-app-commands')
  const calls = join(data.root, 'fake-app-calls.log')
  for (const [command, code] of [['osascript', 0], ['pgrep', 1], ['open', 1]]) {
    const path = join(bin, command)
    write(path, `#!/bin/sh\nprintf '%s\\n' '${command}' >>${calls}\nexit ${code}\n`)
    chmodSync(path, 0o755)
  }
  const previousPath = process.env.PATH
  let result
  try {
    process.env.PATH = `${bin}:${previousPath}`
    result = await applyStagedPlan({ stagedDir, dshHome: b.dshHome, noApp: false, trashDir: join(data.root, 'trash') })
  } finally {
    process.env.PATH = previousPath
  }
  assert.equal(result.success, true, result.error)
  assert.match(result.warnings.join('\n'), /重新打开/)
  assert.equal(JSON.parse(readFileSync(join(b.profile, 'node_modules', 'fixture-a', 'package.json'), 'utf8')).version, '1.0.0')
  assert.match(JSON.parse(readFileSync(join(b.dshHome, 'plugin-sync', 'last-apply.json'), 'utf8')).warnings.join('\n'), /重新打开/)
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['osascript', 'pgrep', 'open'])
})

test('S-004 reopening sees the persisted result and released lock at the configured App path', async () => {
  const data = await suite()
  const b = freshProfile(join(data.root, 'S-004-reopen'))
  const plan = await planFor(data, b.dshHome, ['fixture-a'])
  const stagedDir = join(data.root, 'S-004-reopen-stage')
  await stageApplyPlan({ plan, sourceDir: data.snapshotDir, stagedDir })
  const bin = join(data.root, 'S-004-reopen-bin')
  const observed = join(data.root, 'S-004-observed.json')
  for (const [command, code] of [['osascript', 0], ['pgrep', 1]]) {
    write(join(bin, command), `#!/bin/sh\nexit ${code}\n`)
    chmodSync(join(bin, command), 0o755)
  }
  const resultPath = join(b.dshHome, 'plugin-sync/last-apply.json')
  const lockPath = join(b.dshHome, 'plugin-sync/apply.lock')
  write(join(bin, 'open'), `#!/usr/bin/env node\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ args: process.argv.slice(2), locked: fs.existsSync(${JSON.stringify(lockPath)}), result: fs.existsSync(${JSON.stringify(resultPath)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(resultPath)}, 'utf8')) : null }));\n`)
  chmodSync(join(bin, 'open'), 0o755)
  const previousPath = process.env.PATH
  const appPath = join(data.root, 'Custom App.app')
  let result
  try {
    process.env.PATH = `${bin}:${previousPath}`
    result = await applyStagedPlan({ stagedDir, dshHome: b.dshHome, noApp: false, appPath, dshPath: DSH, trashDir: join(data.root, 'trash') })
  } finally { process.env.PATH = previousPath }
  assert.equal(result.success, true, result.error)
  const atOpen = JSON.parse(readFileSync(observed, 'utf8'))
  assert.equal(atOpen.result?.success, true)
  assert.equal(atOpen.locked, false)
  assert.deepEqual(atOpen.args, ['-a', appPath])
})

test('S-004 a failed reopen does not replace an apply failure with an exception', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sweep-open-failure-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  write(join(bin, 'open'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(bin, 'open'), 0o755)
  const previousPath = process.env.PATH
  let result
  try {
    process.env.PATH = `${bin}:${previousPath}`
    result = await applyStagedPlan({ stagedDir: join(root, 'missing-plan'), dshHome: join(root, 'fixture-home'), noApp: false, trashDir: join(root, 'trash') })
  } finally { process.env.PATH = previousPath }
  assert.equal(result.success, false)
  assert.match(result.error, /plan.json/)
  assert.match(result.warnings.join('\n'), /重新打开/)
})

test('S-004 the default background launcher forwards the configured App and dsh paths', async () => {
  const data = await suite()
  const b = freshProfile(join(data.root, 'S-004-launch'))
  const plan = await planFor(data, b.dshHome, ['fixture-a'])
  const stagedDir = join(data.root, 'S-004-launch-stage')
  await stageApplyPlan({ plan, sourceDir: data.snapshotDir, stagedDir })
  const called = join(data.root, 'S-004-custom-dsh-called')
  const dshPath = join(data.root, 'S-004-fake-dsh')
  write(dshPath, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(called)}, 'called'); process.exitCode = 1;\n`)
  chmodSync(dshPath, 0o755)
  const bin = join(data.root, 'S-004-launch-bin')
  const opened = join(data.root, 'S-004-launch-opened')
  const appPath = join(data.root, 'Custom App.app')
  for (const [command, code] of [['osascript', 0], ['pgrep', 1], ['open', 0]]) {
    const recorded = join(data.root, `S-004-launch-${command}.json`)
    write(join(bin, command), `#!/usr/bin/env node\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2))); ${command === 'open' ? `fs.writeFileSync(${JSON.stringify(opened)}, 'done');` : ''} process.exitCode = ${code};\n`)
    chmodSync(join(bin, command), 0o755)
  }
  const isolatedHome = join(data.root, 'S-004-isolated-home')
  mkdirSync(isolatedHome)
  const launcher = `
    const { PluginSyncService } = await import(${JSON.stringify(new URL('../lib/host.js', import.meta.url).href)});
    const service = new PluginSyncService({ provide() {}, inject() {} }, { dshHome: ${JSON.stringify(b.dshHome)} });
    await service.applyLauncher(${JSON.stringify({ stagedDir, dshHome: b.dshHome, noApp: false, dshPath, appPath })});
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', launcher], {
    env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, PATH: `${bin}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  const resultPath = join(b.dshHome, 'plugin-sync/last-apply.json')
  const deadline = Date.now() + 5000
  while (!existsSync(opened) && Date.now() < deadline) await delay(20)
  assert.ok(existsSync(opened), 'background importer must reach the fake App reopen')
  assert.ok(existsSync(resultPath), 'background importer must finish')
  assert.equal(existsSync(called), true)
  assert.equal(JSON.parse(readFileSync(resultPath, 'utf8')).success, false)
  assert.deepEqual(JSON.parse(readFileSync(join(data.root, 'S-004-launch-osascript.json'), 'utf8')), ['-e', `quit app "${appPath}"`])
  assert.deepEqual(JSON.parse(readFileSync(join(data.root, 'S-004-launch-open.json'), 'utf8')), ['-a', appPath])
})

test('S-A02 failure before installation preserves the original node_modules', async () => {
  const data = await suite()
  const b = freshProfile(join(data.root, 'S-A02-before-install'))
  const original = join(b.profile, 'node_modules', 'original-plugin', 'marker')
  write(original, 'original installed content')
  const plan = await planFor(data, b.dshHome, ['fixture-a'])
  plan.exemptions = { 'fixture-a@1.0.0': [DESKTOP_VERSION] }
  const stagedDir = join(data.root, 'S-A02-stage')
  await stageApplyPlan({ plan, sourceDir: data.snapshotDir, stagedDir })
  const dshPath = join(data.root, 'S-A02-failing-exemption')
  write(dshPath, '#!/bin/sh\nexit 7\n')
  chmodSync(dshPath, 0o755)
  const result = await applyStagedPlan({ stagedDir, dshHome: b.dshHome, noApp: true, dshPath })
  assert.equal(result.success, false)
  assert.equal(existsSync(original), true)
  assert.equal(readFileSync(original, 'utf8'), 'original installed content')
})

test('rows keep every other byte and append overrides for rows without an entry', async () => {
  const data = await suite()
  const b = freshProfile(join(data.root, 'B-rows-byte-exact'))
  const original = `# keep this comment\n- id: fixture-a-row\n  name: fixture-a\n  disabled: false\n  config:\n    token: "quoted value"\n- insert:\n    - id: fixture-b-row\n      name: fixture-b\n      disabled: false\n# BEGIN macos-shared-mcp\n- insert:\n    - id: shared-mcp-github\n      disabled: false\n# END macos-shared-mcp\n`
  write(join(b.profile, 'cordis.patch.yml'), original)
  const plan = await planFor(data, b.dshHome, ['fixture-a', 'fixture-b'])
  plan.rows.push({ id: 'missing-row', name: 'fixture-a', disabled: true, owner: 'fixture-a' })
  const stagedDir = join(data.root, 'staged-rows-byte-exact')
  await stageApplyPlan({ plan, sourceDir: data.snapshotDir, stagedDir })
  const result = await applyStagedPlan({ stagedDir, dshHome: b.dshHome, noApp: true })
  assert.equal(result.success, true, result.error)
  assert.deepEqual(result.appendedRows, ['fixture-b-row', 'missing-row'])
  const expected = `${original.replace('  disabled: false\n  config:', '  disabled: true\n  config:')}# dsh-plugin-sync 导入的组件开关\n- id: fixture-b-row\n  disabled: false\n- id: missing-row\n  disabled: true\n`
  const actual = readFileSync(join(b.profile, 'cordis.patch.yml'), 'utf8')
  assert.equal(actual, expected)
  const unchanged = await updateRows(join(b.profile, 'cordis.patch.yml'), plan.rows)
  assert.deepEqual(unchanged, { changed: false, appended: [] })
  assert.equal(readFileSync(join(b.profile, 'cordis.patch.yml'), 'utf8'), expected)
})

test('rows without a disabled field persist the selected enabled override', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-row-default-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'cordis.patch.yml')
  const original = '- id: existing\n  name: fixture-a\n  config:\n    label: "keep"\n'
  write(path, original)
  const outcome = await updateRows(path, [{ id: 'existing', name: 'fixture-a', disabled: false }])
  assert.deepEqual(outcome, { changed: true, appended: [] })
  assert.equal(readFileSync(path, 'utf8'), original.replace('- id: existing\n', '- id: existing\n  disabled: false\n'))
})

test('rows preserve block scalar contents and append a top-level override', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-row-parse-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'cordis.patch.yml')
  const original = '- id: real\n  name: fixture-a\n  disabled: false\n  config: |\n    - id: inside-block-scalar\n      disabled: false\n'
  write(path, original)
  assert.deepEqual(await updateRows(path, [{ id: 'inside-block-scalar', name: 'fixture-a', disabled: true }]), { changed: true, appended: ['inside-block-scalar'] })
  assert.deepEqual(parse(readFileSync(path, 'utf8')), [...parse(original), { id: 'inside-block-scalar', disabled: true }])
})
