import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('official DSH compatibility keeps supported 0.2 releases and blocks every 0.3 prerelease boundary', t => {
  const app = process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app'
  if (!existsSync(app)) return t.skip('requires a local DSH App (set DSH_APP to a disposable copy)')
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-compat-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const expected = [
    ['0.2.0', false],
    ['0.2.1-rc.4', false],
    ['0.2.1-rc.5', true],
    ['0.2.1-rc.6', true],
    ['0.2.1', true],
    ['0.2.2-rc.1', true],
    ['0.2.2-rc.2', true],
    ['0.2.2-rc.3', true],
    ['0.2.2', true],
    ['0.2.99-rc.1', true],
    ['0.2.99', true],
    ['0.3.0-0', false],
    ['0.3.0-alpha.1', false],
    ['0.3.0-beta.1', false],
    ['0.3.0-rc.1', false],
    ['0.3.0', false],
    ['0.3.1-rc.1', false],
    ['1.0.0', false],
  ]
  // The App's evaluator uses semver with includePrerelease: true. Exercise the
  // real loader decision so a stable-only upper bound cannot admit 0.3 previews.
  const output = execFileSync(join(app, 'Contents/MacOS/DeepSeek Harness'), ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { pathToFileURL } from 'node:url'
    const { evaluatePluginCompatibility } = await import(pathToFileURL(join(
      process.env.DSH_APP, 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    )).href)
    const manifest = JSON.parse(readFileSync(process.argv[1], 'utf8'))
    const versions = JSON.parse(process.argv[2])
    process.stdout.write(JSON.stringify(versions.map(version => [
      version, evaluatePluginCompatibility(manifest, {}, version) === undefined,
    ])))
  `, fileURLToPath(new URL('../package.json', import.meta.url)), JSON.stringify(expected.map(([version]) => version))], {
    cwd: root,
    env: {
      ...process.env, DSH_APP: app, DSH_HOME: join(root, 'home'), ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: undefined, DEEPSEEK_API_KEY: undefined, DEEPSEC_SCOPE_SIGNING_KEY: undefined,
    },
    encoding: 'utf8',
    timeout: 15_000,
  })
  assert.deepEqual(JSON.parse(output), expected)
})
