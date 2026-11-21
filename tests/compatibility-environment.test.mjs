import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const compatibility = fileURLToPath(new URL('./compatibility.test.mjs', import.meta.url))
function scratch(t) { const root = mkdtempSync(join(tmpdir(), 'sync-compat-env-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root }

test('chore138 compatibility test reports a skip when the selected App is absent', t => {
  const root = scratch(t)
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', compatibility], {
    cwd: root, env: { ...process.env, NODE_TEST_CONTEXT: undefined, DSH_APP: join(root, 'missing.app'), NODE_OPTIONS: undefined }, encoding: 'utf8', timeout: 20000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# SKIP/)
  assert.match(result.stdout, /# fail 0/)
})

test('chore138 compatibility Electron ignores inherited Node-only options',
  { skip: !existsSync(process.env.DSH_APP ?? '/Applications/DeepSeek Harness.app') && 'requires DSH_APP' }, t => {
    const root = scratch(t), preload = join(root, 'parent-options.mjs')
    // Set after standalone Node has started. Only an unisolated Electron child sees it.
    writeFileSync(preload, `
      import childProcess from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      const run = childProcess.execFileSync
      process.env.NODE_OPTIONS = '--trace-warnings'
      childProcess.execFileSync = (file, args, options) => {
        if (options.env.NODE_OPTIONS !== undefined) throw new Error('Node-only options leaked to Electron')
        return run(file, args, options)
      }
      syncBuiltinESMExports()
    `)
    const result = spawnSync(process.execPath, ['--import', preload, '--test-reporter=tap', compatibility], {
      cwd: root, env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: undefined }, encoding: 'utf8', timeout: 20000,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /# pass 1/)
    assert.doesNotMatch(result.stdout, /# SKIP/)
  })
