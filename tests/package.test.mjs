import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const manifest = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('package exposes an installable DSH host and web client bundle', () => {
  const pkg = manifest()
  assert.equal(pkg.name, '@miint-sunny/dsh-plugin-sync')
  assert.equal(pkg.license, 'MIT')
  assert.notEqual(pkg.private, true)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-plugin-manager'])
  assert.equal(typeof pkg.peerDependencies['@deepseek-ai/cordis'], 'string')
  assert.equal(typeof pkg.engines.dsh, 'string')
  assert.ok(pkg.files.includes('lib'))
  assert.ok(!pkg.files.includes('src'))
  assert.ok(!pkg.files.includes('scripts'))
  assert.ok(pkg.files.includes('scripts/detached-apply.sh'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
})

test('build creates host and wrapped browser entries and the bundle patch mounts the host', () => {
  for (const file of ['lib/index.js', 'lib/client.js', 'lib/types/index.d.ts']) {
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} is missing`)
  }
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load/)
  assert.match(client, /plugins\.bundle\.config/)
  assert.match(client, /SyncPage/)
  assert.ok(!client.includes('require("./locale.js")'))
  assert.ok(!client.includes('require("./model.js")'))
  assert.ok(client.includes('react/jsx-runtime'))
  assert.ok(!client.includes('React.createElement'))
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: dsh-plugin-sync/)
  assert.match(patch, /name: '@miint-sunny\/dsh-plugin-sync'/)
})
