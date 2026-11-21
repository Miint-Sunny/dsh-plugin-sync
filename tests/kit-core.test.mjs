import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

test('the shared installer bundle imports outside the source tree without node_modules', t => {
  const root = mkdtempSync(join(tmpdir(), 'sync-core-bundle-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const output = join(root, 'core.mjs')
  execFileSync(process.execPath, ['scripts/build-kit-core.mjs', output])
  const source = 'const api = await import(' + JSON.stringify(pathToFileURL(output).href) + '); if (!["buildChanges", "createApplyPlan", "applyProfilePlan", "stageApplyPlan", "clearStaleApplyLock", "readApplyLock"].every(key => typeof api[key] === "function")) throw new Error("incomplete core");'
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: tmpdir(), stdio: 'pipe' }))
})
