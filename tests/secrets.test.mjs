import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { secretScanHits } from '../lib/core/secrets.js'

const cases = [
  ['sk- hexadecimal token', `sk-${'a'.repeat(32)}`],
  ['ghp_ token', `ghp_${'b'.repeat(36)}`],
  ['github_pat_ token', 'github_pat_abc123456789'],
  ['RSA private key header', '-----BEGIN RSA PRIVATE KEY-----'],
  ['EC private key header', '-----BEGIN EC PRIVATE KEY-----'],
  ['OPENSSH private key header', '-----BEGIN OPENSSH PRIVATE KEY-----'],
  ['ENCRYPTED private key header', '-----BEGIN ENCRYPTED PRIVATE KEY-----'],
  ['unprefixed private key header', '-----BEGIN PRIVATE KEY-----'],
]

for (const [name, value] of cases) {
  test(`secret scan detects ${name} without returning the value`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-secrets-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    writeFileSync(join(root, 'content.txt'), value)
    const hits = await secretScanHits(root, new Set())
    assert.deepEqual(hits, [{ file: 'content.txt', count: 1 }])
    assert.ok(!JSON.stringify(hits).includes(value))
  })
}

test('secret scan does not match the plugin source in its own packed tgz', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-own-package-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = fileURLToPath(new URL('..', import.meta.url))
  // Pack the lib/ that `npm test` built. Running prepack here would rebuild lib/ in this checkout,
  // and the build removes lib/ first while other test files are reading it.
  execFileSync('pnpm', ['pack', '--pack-destination', root, '--config.ignore-scripts=true'], {
    cwd: project,
    env: { ...process.env, npm_config_update_notifier: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.deepEqual(await secretScanHits(root, new Set()), [])
})
