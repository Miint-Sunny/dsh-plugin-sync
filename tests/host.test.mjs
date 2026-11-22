import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { PluginSyncService, PLUGIN_SYNC_ROUTES } from '../lib/host.js'
import { validateRepositoryAddress } from '../lib/core/git-sync.js'

const APP = process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app'
const SEARCH = '@deepseek-ai/dsh-experimental-session-search'
const ALPHA_LOCK = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      alpha:\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  alpha@1.0.0:\n    resolution: {integrity: sha512-YWxwaGE=}\nsnapshots:\n  alpha@1.0.0: {}\n"
const ALPHA_BETA_LOCK = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      alpha:\n        specifier: 1.0.0\n        version: 1.0.0\n      beta:\n        specifier: 2.0.0\n        version: 2.0.0\npackages:\n  alpha@1.0.0:\n    resolution: {integrity: sha512-YWxwaGE=}\n  beta@2.0.0:\n    resolution: {integrity: sha512-YmV0YQ==}\nsnapshots:\n  alpha@1.0.0: {}\n  beta@2.0.0: {}\n"

function hostFixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-host-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dshHome = join(root, 'home')
  const profile = join(dshHome, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  const { dependencies = {}, lockfile = "lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages: {}\nsnapshots: {}\n", bundles, descriptions = {}, ...config } = options
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...Object.keys(dependencies)] } } }))
  writeFileSync(join(profile, 'pnpm-lock.yaml'), lockfile)
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  for (const [name, description] of Object.entries(descriptions)) {
    mkdirSync(join(profile, 'node_modules', name), { recursive: true })
    writeFileSync(join(profile, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', description }))
  }
  const injections = []
  const launches = []
  const service = new PluginSyncService({ provide() {}, inject(_deps, callback) { injections.push(callback) } }, {
    dshHome,
    appPath: APP,
    machineId: 'mac-a',
    machineName: 'Test Mac',
    trashDir: join(root, 'trash'),
    applyLauncher: async launch => { launches.push(launch); return { pid: 123 } },
    ...config,
  })
  const routes = new Map(), disposers = []
  const fixture = { root, dshHome, profile, service, routes, launches, authorized: false, manager: bundles === undefined ? undefined : { listBundles: async () => bundles } }
  // Unloading the plugin runs the disposers of the injected scope in reverse order, as cordis does.
  fixture.unload = async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() }
  fixture.scope = {
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get(name) {
      if (name === 'connection') return fixture.authorized ? { requestRejection: () => undefined } : undefined
      if (name === 'pluginManager') return fixture.manager
      return undefined
    },
  }
  for (const callback of injections) callback(fixture.scope)
  t.after(() => fixture.unload())
  return fixture
}

function authorize(...fixtures) {
  for (const fixture of fixtures) fixture.authorized = true
}

function request(method, body, headers = {}, remoteAddress = '127.0.0.1', url = '/') {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3090', ...headers }
  req.socket = { remoteAddress }
  return req
}

async function call(routes, path, req) {
  const response = { status: 0, headers: undefined, body: '' }
  const res = {
    writeHead(status, headers) { response.status = status; response.headers = headers },
    end(body) { response.body = Buffer.concat([Buffer.from(response.body), Buffer.isBuffer(body) ? body : Buffer.from(body ?? '')]) },
  }
  await routes.get(path)(req, res)
  const text = response.body.toString()
  return { ...response, json: response.headers?.['content-type']?.includes('json') ? JSON.parse(text) : undefined }
}

const get = (fixture, path) => call(fixture.routes, path, request('GET'))
const post = (fixture, path, body = {}) => call(fixture.routes, path, request('POST', body))
const patch = (fixture, body) => call(fixture.routes, '/dsh-plugin-sync/preferences', request('PATCH', body))

async function setPreferences(fixture, fields) {
  const response = await patch(fixture, fields)
  assert.equal(response.status, 200, response.body.toString())
  return response.json
}

test('every route rejects a missing official connection before doing work', async t => {
  const { routes, launches } = hostFixture(t)
  const methods = { '/dsh-plugin-sync/state': 'GET', '/dsh-plugin-sync/download': 'GET', '/dsh-plugin-sync/preferences': 'PATCH' }
  for (const path of PLUGIN_SYNC_ROUTES) {
    const method = methods[path] ?? 'POST'
    const response = await call(routes, path, request(method, method === 'GET' ? undefined : {}))
    assert.equal(response.status, 401, path)
    assert.equal(response.json.error.code, 'UNAUTHENTICATED')
  }
  assert.equal(launches.length, 0)
})

test('loopback, origin and official rejection checks are enforced', async t => {
  const { routes, scope } = hostFixture(t)
  scope.get = () => ({ requestRejection: () => undefined })
  let response = await call(routes, '/dsh-plugin-sync/state', request('GET', undefined, {}, '192.168.1.2'))
  assert.equal(response.status, 403)
  response = await call(routes, '/dsh-plugin-sync/state', request('GET', undefined, { origin: 'https://evil.example' }))
  assert.equal(response.status, 403)
  response = await call(routes, '/dsh-plugin-sync/state', request('POST', {}))
  assert.equal(response.status, 405)
  scope.get = () => ({ requestRejection: () => 403 })
  response = await call(routes, '/dsh-plugin-sync/state', request('GET'))
  assert.equal(response.status, 403)
})

test('state lists third-party and official plugins with their metadata, and nothing is left out by default', async t => {
  const fixture = hostFixture(t, {
    dependencies: { alpha: '1.0.0', 'fixture-private-b': 'link:/fixture-private-b' },
    lockfile: ALPHA_LOCK,
    bundles: [
      { name: 'alpha', enabled: true, installed: true, version: '1.0.0', description: 'Raw alpha', meta: { title: { en: 'Alpha', zh: '阿尔法' }, description: { en: 'Alpha plugin' }, icon: 'data:image/svg+xml;base64,PHN2Zy8+' } },
      { name: 'fixture-private-b', enabled: true, installed: true, description: 'Private plugin B' },
      { name: SEARCH, official: true, optional: true, enabled: false, installed: false, availability: 'installation', meta: { title: { en: 'Session search' } } },
      { name: '@deepseek-ai/dsh-experimental-missing', official: true, enabled: false, installed: false, availability: 'missing' },
      { name: '@deepseek-ai/dsh-base', enabled: true, installed: false, availability: 'installation' },
    ],
  })
  authorize(fixture)
  const state = await get(fixture, '/dsh-plugin-sync/state')
  assert.equal(state.status, 200, state.body.toString())
  assert.deepEqual(state.json.plugins.map(plugin => [plugin.name, plugin.group, plugin.version, plugin.source, plugin.exported]), [
    ['alpha', 'third-party', '1.0.0', 'npm', true],
    ['fixture-private-b', 'third-party', undefined, 'link', true],
    [SEARCH, 'official', undefined, undefined, true],
  ])
  const [alpha, privatePlugin, search] = state.json.plugins
  assert.deepEqual([alpha.title, alpha.description, alpha.icon], [{ en: 'Alpha', zh: '阿尔法' }, { en: 'Alpha plugin' }, 'data:image/svg+xml;base64,PHN2Zy8+'])
  assert.equal(privatePlugin.description, 'Private plugin B')
  assert.deepEqual([search.enabled, search.experimental], [false, true])
  assert.deepEqual(state.json.preferences, { format: 'dsh-plugin-sync/preferences-2', repository: '', exportTarget: 'zip', exportExcluded: [] })
  assert.deepEqual([state.json.machineId, state.json.machineName, state.json.defaultMachineName], ['mac-a', 'Test Mac', 'Test Mac'])
  assert.deepEqual(state.json.repository, { configured: false })
  assert.equal(state.json.lastApply, null)
  assert.equal(state.json.lastExport, null)
  assert.equal(state.json.applying, false)
  assert.equal(state.json.keep, 5)
  assert.equal(state.json.paths.backups, join(fixture.dshHome, 'backups', 'plugin-sync', 'backup-plugin-sync-*'))
})

test('without the plugin manager the state lists dependencies with their package descriptions', async t => {
  const fixture = hostFixture(t, { dependencies: { alpha: '1.0.0' }, lockfile: ALPHA_LOCK, descriptions: { alpha: 'Alpha from package.json' } })
  authorize(fixture)
  const state = await get(fixture, '/dsh-plugin-sync/state')
  assert.deepEqual(state.json.plugins.map(plugin => [plugin.name, plugin.group, plugin.description]), [['alpha', 'third-party', 'Alpha from package.json']])
})

test('state preserves a saved exclusion across either package name and an explicit recheck clears it', async t => {
  for (const [excluded, installed] of [['dsh-nai5-prompting', '@miint-sunny/dsh-nai-desk'], ['@miint-sunny/dsh-nai-desk', 'dsh-nai5-prompting']]) {
    const fixture = hostFixture(t, { dependencies: { [installed]: '1.0.0' } })
    authorize(fixture)
    await setPreferences(fixture, { exportExcluded: [excluded] })
    let state = await get(fixture, '/dsh-plugin-sync/state')
    assert.equal(state.json.plugins[0].exported, false)
    assert.deepEqual(state.json.preferences.exportExcluded, [installed])
    const selection = new Set(state.json.preferences.exportExcluded)
    selection.delete(installed)
    await setPreferences(fixture, { exportExcluded: [...selection] })
    state = await get(fixture, '/dsh-plugin-sync/state')
    assert.equal(state.json.plugins[0].exported, true)
    selection.add(installed)
    await setPreferences(fixture, { exportExcluded: [...selection] })
    state = await get(fixture, '/dsh-plugin-sync/state')
    assert.equal(state.json.plugins[0].exported, false)
    selection.delete(installed)
    await setPreferences(fixture, { exportExcluded: [...selection] })
    state = await get(fixture, '/dsh-plugin-sync/state')
    assert.equal(state.json.plugins[0].exported, true)
  }
})

test('preferences change only the given fields and refuse invalid values without changes', async t => {
  const fixture = hostFixture(t, { dependencies: { alpha: '1.0.0' }, lockfile: ALPHA_LOCK })
  authorize(fixture)
  const path = join(fixture.dshHome, 'plugin-sync', 'preferences.json')
  mkdirSync(join(fixture.dshHome, 'plugin-sync'), { recursive: true })
  const saved = { format: 'dsh-plugin-sync/preferences-2', machineName: '旧名字', repository: '', exportTarget: 'zip', exportExcluded: ['alpha'] }
  writeFileSync(path, JSON.stringify(saved))
  const loaded = await get(fixture, '/dsh-plugin-sync/state')
  assert.deepEqual(loaded.json.preferences, saved)
  assert.equal(loaded.json.plugins[0].exported, false)
  const excluded = await setPreferences(fixture, { exportExcluded: ['gamma', 'alpha', 'alpha'] })
  assert.deepEqual([excluded.machineName, excluded.exportExcluded], ['旧名字', ['alpha', 'gamma']])
  const renamed = await setPreferences(fixture, { machineName: '  Test Mac A ' })
  assert.deepEqual([renamed.machineName, renamed.exportExcluded], ['Test Mac A', ['alpha', 'gamma']])
  const reset = await setPreferences(fixture, { machineName: '' })
  assert.equal(reset.machineName, undefined)
  assert.equal((await get(fixture, '/dsh-plugin-sync/state')).json.machineName, 'Test Mac')
  const before = readFileSync(path, 'utf8')
  for (const bad of [{ exportExcluded: ['Not A Package'] }, { repository: 'http://example.com/repo.git' }, { repository: 'relative/path' }, { machineName: 'x'.repeat(101) }, { exportTarget: 'ftp' }, { format: 'other' }]) {
    const response = await patch(fixture, bad)
    assert.equal(response.status, 400, JSON.stringify(bad))
  }
  assert.equal(readFileSync(path, 'utf8'), before)
  assert.match(execFileSync('stat', ['-f', '%Lp', path], { encoding: 'utf8' }), /600/)
})

test('repository addresses accept https, ssh and absolute paths and refuse credentials', () => {
  assert.equal(validateRepositoryAddress('https://github.com/owner/repo.git'), 'url')
  assert.equal(validateRepositoryAddress('ssh://git@github.com/owner/repo.git'), 'url')
  assert.equal(validateRepositoryAddress('git@github.com:owner/repo.git'), 'url')
  assert.equal(validateRepositoryAddress('/Users/someone/sync'), 'path')
  assert.equal(validateRepositoryAddress('~/sync'), 'path')
  assert.throws(() => validateRepositoryAddress('http://example.com/repo.git'), /https/)
  assert.throws(() => validateRepositoryAddress('git://example.com/repo.git'), /https/)
  assert.throws(() => validateRepositoryAddress('https://user:pass' + '@' + 'example.com/repo.git'), /用户名或密码/)
  assert.throws(() => validateRepositoryAddress('https://token' + '@' + 'example.com/repo.git'), /用户名或密码/)
  assert.throws(() => validateRepositoryAddress('git:secret' + '@' + 'github.com:owner/repo.git'), /用户名或密码/)
  assert.throws(() => validateRepositoryAddress('relative/path'), /绝对路径/)
})

test('request bodies have a bounded consistent error response', async t => {
  const fixture = hostFixture(t, { bodyLimit: 16 })
  authorize(fixture)
  const response = await post(fixture, '/dsh-plugin-sync/preview', { tooLarge: 'x'.repeat(40) })
  assert.equal(response.status, 413)
  assert.deepEqual(response.json, { error: { code: 'BODY_TOO_LARGE', message: '请求体超过大小上限' } })
})

test('a zip export feeds the preview and one detached no-app apply under the lock', async t => {
  const a = hostFixture(t, { dependencies: { alpha: '1.0.0', beta: '2.0.0' }, lockfile: ALPHA_BETA_LOCK })
  const b = hostFixture(t, { machineId: 'mac-b' })
  authorize(a, b)
  await setPreferences(a, { exportExcluded: ['beta'] })
  const exported = await post(a, '/dsh-plugin-sync/export', { target: 'zip' })
  assert.equal(exported.status, 200, exported.body.toString())
  assert.deepEqual([exported.json.target, exported.json.pluginCount], ['zip', 1])
  assert.match(exported.json.filename, /^dsh-plugin-sync-mac-a-\d{4}-\d{2}-\d{2}\.zip$/)
  assert.ok(exported.json.size > 0)
  const recorded = (await get(a, '/dsh-plugin-sync/state')).json.lastExport
  assert.deepEqual([recorded.filename, recorded.downloadable], [exported.json.filename, true])
  const missing = await call(a.routes, '/dsh-plugin-sync/download', request('GET', undefined, {}, '127.0.0.1', '/dsh-plugin-sync/download?id=nope'))
  assert.equal(missing.status, 404)
  const download = await call(a.routes, '/dsh-plugin-sync/download', request('GET', undefined, {}, '127.0.0.1', `/dsh-plugin-sync/download?id=${exported.json.downloadId}`))
  assert.equal(download.status, 200)
  assert.equal(download.headers['content-type'], 'application/zip')
  const preview = await post(b, '/dsh-plugin-sync/preview', { source: { kind: 'zip', base64: download.body.toString('base64') } })
  assert.equal(preview.status, 200, preview.body.toString())
  assert.deepEqual([preview.json.source.machine, preview.json.source.machineId], ['Test Mac', 'mac-a'])
  assert.deepEqual(preview.json.plugins.map(entry => [entry.name, entry.changes.map(change => change.id), entry.defaultOn]), [['alpha', ['plugin:alpha'], true]])
  const empty = await post(b, '/dsh-plugin-sync/apply', { previewId: preview.json.previewId, selected: [] })
  assert.equal(empty.status, 400)
  const again = await post(b, '/dsh-plugin-sync/preview', { source: { kind: 'zip', base64: download.body.toString('base64') } })
  const applied = await post(b, '/dsh-plugin-sync/apply', { previewId: again.json.previewId, selected: ['plugin:alpha'], noApp: true })
  assert.equal(applied.status, 202, applied.body.toString())
  assert.equal(applied.json.pid, 123)
  assert.equal(b.launches.length, 1)
  assert.equal(b.launches[0].noApp, true)
  const plan = JSON.parse(readFileSync(join(b.launches[0].stagedDir, 'plan.json'), 'utf8'))
  assert.deepEqual(plan.plugins.map(plugin => plugin.name), ['alpha'])
  assert.deepEqual(plan.manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'alpha'])
  const duplicate = await post(b, '/dsh-plugin-sync/apply', { previewId: again.json.previewId, selected: ['plugin:alpha'], noApp: true })
  assert.equal(duplicate.status, 409)
  assert.equal(b.launches.length, 1)
  assert.equal((await get(b, '/dsh-plugin-sync/state')).json.applying, true)
  const cleared = await post(b, '/dsh-plugin-sync/apply-lock/clear', { confirm: true })
  assert.equal(cleared.status, 200, cleared.body.toString())
})

test('the import result shows until acknowledged', async t => {
  const fixture = hostFixture(t)
  authorize(fixture)
  mkdirSync(join(fixture.dshHome, 'plugin-sync'), { recursive: true })
  writeFileSync(join(fixture.dshHome, 'plugin-sync', 'last-apply.json'), JSON.stringify({ success: true, finishedAt: '2026-11-01T12:00:00.000Z', summary: { install: 1 }, steps: [], logPath: '/tmp/x.log', appendedRows: [], warnings: [] }))
  assert.equal((await get(fixture, '/dsh-plugin-sync/state')).json.lastApply.acknowledged, undefined)
  const response = await post(fixture, '/dsh-plugin-sync/last-apply/acknowledge')
  assert.deepEqual(response.json, { acknowledged: true })
  assert.equal((await get(fixture, '/dsh-plugin-sync/state')).json.lastApply.acknowledged, true)
})

test('Git export pushes in one step, the import tab reads machines without fetching, and a fetch brings the latest export', async t => {
  const a = hostFixture(t, { dependencies: { alpha: '1.0.0' }, lockfile: ALPHA_LOCK, allowFileRepositoryForTests: true })
  const b = hostFixture(t, { machineId: 'mac-b', machineName: 'Other Mac', allowFileRepositoryForTests: true })
  authorize(a, b)
  const bare = join(a.root, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', bare])
  for (const fixture of [a, b]) await setPreferences(fixture, { repository: `file://${bare}`, exportTarget: 'git' })
  const tested = await post(b, '/dsh-plugin-sync/git-test', { repository: `file://${bare}` })
  assert.deepEqual([tested.status, tested.json], [200, {}])
  const refused = await post(b, '/dsh-plugin-sync/git-test', { repository: 'http://example.com/repo.git' })
  assert.equal(refused.status, 400)
  const first = await post(a, '/dsh-plugin-sync/export')
  assert.equal(first.status, 200, first.body.toString())
  assert.deepEqual([first.json.target, first.json.pushed, first.json.unpushed], ['git', true, 0])
  assert.match((await post(b, '/dsh-plugin-sync/git-test', { repository: `file://${bare}` })).json.branch, /^(main|master)$/)
  assert.deepEqual((await get(b, '/dsh-plugin-sync/state')).json.repository, { configured: true, kind: 'url', machines: null })
  const fetched = await post(b, '/dsh-plugin-sync/git-machines', { fetch: true })
  assert.deepEqual(fetched.json.machines.map(entry => [entry.id, entry.name, entry.self]), [['mac-a', 'Test Mac', false]])
  assert.ok(fetched.json.fetchedAt)
  const offline = await post(b, '/dsh-plugin-sync/git-machines', {})
  assert.deepEqual(offline.json.machines.map(entry => entry.id), ['mac-a'])
  const firstPreview = await post(b, '/dsh-plugin-sync/preview', { source: { kind: 'git', machine: 'mac-a' } })
  assert.equal(firstPreview.status, 200, firstPreview.body.toString())
  const second = await post(a, '/dsh-plugin-sync/export')
  assert.equal(second.json.pushed, true)
  assert.notEqual(second.json.commit, first.json.commit)
  const stale = await post(b, '/dsh-plugin-sync/preview', { source: { kind: 'git', machine: 'mac-a' } })
  assert.equal(stale.json.source.createdAt, firstPreview.json.source.createdAt)
  await post(b, '/dsh-plugin-sync/git-machines', { fetch: true })
  const secondPreview = await post(b, '/dsh-plugin-sync/preview', { source: { kind: 'git', machine: 'mac-a' } })
  assert.ok(secondPreview.json.source.createdAt > firstPreview.json.source.createdAt)
  const own = await post(b, '/dsh-plugin-sync/export')
  assert.equal(own.json.pushed, true)
  const both = await post(b, '/dsh-plugin-sync/git-machines', { fetch: true })
  assert.deepEqual(both.json.machines.map(entry => [entry.id, entry.self]).sort(), [['mac-a', false], ['mac-b', true]])
  // A new comparison first releases the previous one and its copy of the Git snapshot in the system temporary directory,
  // even when the new source is refused.
  assert.equal((await post(b, '/dsh-plugin-sync/preview', { source: { kind: 'unsupported' } })).status, 400)
  assert.equal((await post(b, '/dsh-plugin-sync/apply', { previewId: secondPreview.json.previewId, selected: [] })).status, 404)
})

for (const kind of ['git', 'zip']) test(`unloading the plugin removes the ${kind} snapshot copy of a comparison that was never applied`, async t => {
  const a = hostFixture(t, { dependencies: { alpha: '1.0.0' }, lockfile: ALPHA_LOCK, allowFileRepositoryForTests: true })
  const b = hostFixture(t, { machineId: 'mac-b', allowFileRepositoryForTests: true })
  authorize(a, b)
  let source
  if (kind === 'git') {
    const bare = join(a.root, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', bare])
    for (const fixture of [a, b]) await setPreferences(fixture, { repository: `file://${bare}`, exportTarget: 'git' })
    assert.equal((await post(a, '/dsh-plugin-sync/export')).status, 200)
    assert.equal((await post(b, '/dsh-plugin-sync/git-machines', { fetch: true })).status, 200)
    source = { kind: 'git', machine: 'mac-a' }
  } else {
    const exported = await post(a, '/dsh-plugin-sync/export', { target: 'zip' })
    const download = await call(a.routes, '/dsh-plugin-sync/download', request('GET', undefined, {}, '127.0.0.1', `/dsh-plugin-sync/download?id=${exported.json.downloadId}`))
    source = { kind: 'zip', base64: download.body.toString('base64') }
  }
  // The comparison copies the snapshot into the system temporary directory; point it at a directory this test owns.
  const temporary = join(b.root, 'tmp')
  mkdirSync(temporary)
  const copies = () => readdirSync(temporary).filter(name => name.startsWith('dsh-plugin-sync-'))
  const previous = process.env.TMPDIR
  process.env.TMPDIR = temporary
  try {
    const preview = await post(b, '/dsh-plugin-sync/preview', { source })
    assert.equal(preview.status, 200, preview.body.toString())
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
  assert.equal(copies().length, 1)
  await b.unload()
  assert.deepEqual(copies(), [])
})

test('a failed push keeps the commit and a retry pushes it', async t => {
  const a = hostFixture(t, { allowFileRepositoryForTests: true })
  authorize(a)
  const bare = join(a.root, 'locked.git')
  execFileSync('git', ['init', '-q', '--bare', bare])
  await setPreferences(a, { repository: `file://${bare}`, exportTarget: 'git' })
  execFileSync('chmod', ['-R', 'a-w', bare])
  let exported
  try {
    exported = await post(a, '/dsh-plugin-sync/export')
  } finally {
    execFileSync('chmod', ['-R', 'u+w', bare])
  }
  assert.equal(exported.status, 200, exported.body.toString())
  assert.equal(exported.json.pushed, false)
  assert.ok(exported.json.pushError.length > 0)
  assert.equal(exported.json.unpushed, 1)
  assert.equal((await get(a, '/dsh-plugin-sync/state')).json.lastExport.pushed, false)
  const pushed = await post(a, '/dsh-plugin-sync/push')
  assert.equal(pushed.status, 200, pushed.body.toString())
  assert.equal(pushed.json.unpushed, 0)
  const recorded = (await get(a, '/dsh-plugin-sync/state')).json.lastExport
  assert.deepEqual([recorded.pushed, recorded.unpushed, recorded.pushError], [true, 0, undefined])
})

test('a failed commit cleans only the plugin-managed clone machine directory', async t => {
  const fixture = hostFixture(t, { allowFileRepositoryForTests: true })
  authorize(fixture)
  const bare = join(fixture.root, 'hook-remote.git')
  execFileSync('git', ['init', '-q', '--bare', bare])
  await setPreferences(fixture, { repository: `file://${bare}`, exportTarget: 'git' })
  const first = await post(fixture, '/dsh-plugin-sync/export')
  assert.equal(first.status, 200, first.body.toString())
  const clones = readdirSync(join(fixture.dshHome, 'plugin-sync', 'repositories'))
  assert.equal(clones.length, 1)
  const clone = join(fixture.dshHome, 'plugin-sync', 'repositories', clones[0])
  const hook = join(clone, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n')
  execFileSync('chmod', ['755', hook])
  const failed = await post(fixture, '/dsh-plugin-sync/export')
  assert.equal(failed.status, 400, failed.body.toString())
  assert.equal(execFileSync('git', ['-C', clone, 'status', '--porcelain'], { encoding: 'utf8' }), '')
  assert.equal(execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), first.json.commit)
})

test('exports are pruned to the newest five after each successful export', async t => {
  const fixture = hostFixture(t)
  authorize(fixture)
  for (let index = 0; index < 6; index++) {
    const response = await post(fixture, '/dsh-plugin-sync/export', { target: 'zip' })
    assert.equal(response.status, 200, response.body.toString())
  }
  assert.equal(readdirSync(join(fixture.dshHome, 'plugin-sync', 'exports')).length, 5)
  assert.ok(existsSync(join(fixture.root, 'trash')))
})

test('feat115-r2-4 state and manual clear routes handle broken locks without 500 and protect a starting import', async t => {
  const { acquireApplyLock, readApplyLock } = await import('../lib/core/apply-lock.js')
  const fixture = hostFixture(t); authorize(fixture)
  const owner = await acquireApplyLock(fixture.dshHome, 'starting')
  let reply = await post(fixture, '/dsh-plugin-sync/apply-lock/clear', { confirm: true })
  assert.equal(reply.status, 200); assert.equal(reply.json.cleared, false)
  assert.equal((await readApplyLock(fixture.dshHome)).owner, owner)
  const file = join(fixture.dshHome, 'plugin-sync/apply.lock')
  for (const broken of ['', '{"owner":']) {
    writeFileSync(file, broken); const old = new Date(Date.now() - 60_000); utimesSync(file, old, old)
    reply = await get(fixture, '/dsh-plugin-sync/state')
    assert.equal(reply.status, 200, reply.body.toString()); assert.equal(reply.json.applying, true)
    reply = await post(fixture, '/dsh-plugin-sync/apply-lock/clear', { confirm: true })
    assert.equal(reply.status, 200, reply.body.toString()); assert.equal(reply.json.cleared, true)
    assert.equal(existsSync(file), false)
  }
})
