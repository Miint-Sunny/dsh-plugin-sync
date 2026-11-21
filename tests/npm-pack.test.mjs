import assert from 'node:assert/strict'
import { assertNoPersonalBytes } from '../scripts/privacy.mjs'
import { execFileSync } from 'node:child_process'
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { parse } from 'yaml'

const project = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
// An October build wrote this file; the current build no longer emits it.
const STALE_BUILD_OUTPUT = 'lib/client/index.js'
let root, archive, metadata, installed, consumerRequire

function assertPrivateArchive(rawTar) {
  assertNoPersonalBytes(rawTar, 'archive contains private material')
}

test.before(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'sync-npm-pack-'))
  const source = join(root, 'source')
  mkdirSync(source)
  for (const file of ['package.json', 'pnpm-lock.yaml', 'src', 'scripts', 'locale', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.client.json']) {
    if (existsSync(join(project, file))) cpSync(join(project, file), join(source, file), { recursive: true })
  }
  cpSync(realpathSync(join(project, 'node_modules')), join(source, 'node_modules'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  const statePath = join(source, 'node_modules/.pnpm-workspace-state-v1.json')
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    // Relocate only the generated validation cache of this independent copy.
    // Keep all dependency settings and the lockfile for pnpm's normal check.
    state.projects = { [realpathSync(source)]: { name: pkg.name, version: pkg.version } }
    writeFileSync(statePath, JSON.stringify(state))
  }
  assert.ok(!existsSync(join(source, 'lib')), 'prepack must build the release from source')
  mkdirSync(join(source, 'lib/client'), { recursive: true })
  writeFileSync(join(source, STALE_BUILD_OUTPUT), 'module.exports = {}\n')
  const env = { ...process.env, NODE_OPTIONS: undefined, npm_config_update_notifier: 'false' }
  const output = execFileSync('npm', ['pack', '--json', '--offline', '--pack-destination', root], { cwd: source, env, encoding: 'utf8', timeout: 120_000 })
  ;[metadata] = JSON.parse(output)
  archive = join(root, metadata.filename)
  execFileSync('tar', ['-xzf', archive, '-C', root])
  installed = join(root, 'package')
  symlinkSync(join(project, 'node_modules'), join(installed, 'node_modules'), 'dir')
  const consumer = join(root, 'consumer')
  const packageLink = join(consumer, 'node_modules', metadata.name)
  mkdirSync(join(packageLink, '..'), { recursive: true })
  symlinkSync(installed, packageLink, 'dir')
  consumerRequire = createRequire(join(consumer, 'index.cjs'))
})

test.after(() => { if (root) rmSync(root, { recursive: true, force: true }) })

test('real npm pack publishes the scoped MIT bundle and automatically builds its runtime entries', () => {
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  assert.equal(metadata.name, '@miint-sunny/dsh-plugin-sync')
  assert.equal(pkg.name, '@miint-sunny/dsh-plugin-sync')
  assert.equal(pkg.license, 'MIT')
  assert.notEqual(pkg.private, true)
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(readFileSync(join(installed, 'LICENSE'), 'utf8').includes('MIT License'))
  for (const file of ['lib/index.js', 'lib/client.js', 'lib/types/index.d.ts', 'lib/types/client/index.d.ts', 'scripts/detached-apply.sh']) {
    assert.ok(existsSync(join(installed, file)), `packed runtime is missing ${file}`)
  }
})

test('the actual archive contains only runtime files', () => {
  for (const { path } of metadata.files) {
    assert.ok(/^(?:lib\/|locale\/|scripts\/detached-apply\.sh$|cordis\.patch\.yml$|README(?:\.en)?\.md$|LICENSE$|package\.json$)/.test(path), `unexpected packed path: ${path}`)
  }
})

test('a file an earlier build left in lib/ is not packed', () => {
  assert.ok(!metadata.files.some(({ path }) => path === STALE_BUILD_OUTPUT), `stale build output was packed: ${STALE_BUILD_OUTPUT}`)
})

test('the actual archive contains no personal home path in decompressed tar bytes', () => {
  const rawTar = gunzipSync(readFileSync(archive))
  assertPrivateArchive(rawTar)
})

test('the archive privacy scan rejects mixed-case paths and the runtime username anywhere in raw tar bytes', () => {
  for (const value of ['/uSeRs/fixture', '/HoMe/fixture', String.raw`C:\uSeRs\fixture`, userInfo().username.toUpperCase()]) {
    // Includes bytes before file contents: tar headers and PAX records must be scanned too.
    assert.throws(() => assertPrivateArchive(Buffer.concat([Buffer.alloc(512), Buffer.from(value), Buffer.alloc(512)])), /archive contains/)
  }
  assert.doesNotThrow(() => assertPrivateArchive(Buffer.from('package/lib/index.js\0export const ready = true')))
})

test('the unpacked browser module uses the scoped loader and settings slot while keeping its stable row ID', () => {
  let loaded
  const browser = {
    window: { __ModuleLoader__: { load(value) { loaded = value } } },
    document: { documentElement: { lang: 'en' }, createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
    navigator: { language: 'en' },
  }
  runInNewContext(readFileSync(join(installed, 'lib/client.js'), 'utf8'), browser)
  assert.equal(loaded.id, '@miint-sunny/dsh-plugin-sync')
  const client = loaded.factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(id))
  let slot
  client.apply({
    effect: fn => fn(), locale: { register() {} },
    slots: { inject: (_name, fn) => fn(), register: value => { slot = value } },
  })
  assert.equal(slot.key, '@miint-sunny/dsh-plugin-sync')
  assert.deepEqual(parse(readFileSync(join(installed, 'cordis.patch.yml'), 'utf8')), [{ insert: [{ id: 'dsh-plugin-sync', name: '@miint-sunny/dsh-plugin-sync' }] }])
})

test('the unpacked host and detached helper run from the release without source files', async () => {
  const entry = consumerRequire.resolve('@miint-sunny/dsh-plugin-sync')
  assert.equal(consumerRequire.resolve('@miint-sunny/dsh-plugin-sync/client'), join(installed, 'lib/client.js'))
  assert.equal(consumerRequire.resolve('@miint-sunny/dsh-plugin-sync/cordis.patch.yml'), join(installed, 'cordis.patch.yml'))
  const { PluginSyncService } = await import(pathToFileURL(entry).href)
  assert.equal(typeof PluginSyncService, 'function')
  const { launchDetached } = await import(pathToFileURL(join(installed, 'lib/core/detached.js')).href)
  const output = join(root, 'detached-result.json')
  const pid = await launchDetached({ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ok: true}))`], logPath: join(root, 'detached.log') })
  assert.ok(pid > 0)
  const deadline = Date.now() + 5000
  while (!existsSync(output) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { ok: true })
  assert.ok(!existsSync(join(installed, 'src')))
  assert.ok(!existsSync(join(installed, 'scripts/wrap-client.mjs')))
})
