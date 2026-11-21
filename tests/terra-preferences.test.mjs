import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaultPreferences, readPreferencesFile, updatePreferencesFile } from '../lib/core/preferences.js'

test('TS-002 overlapping preference patches preserve both fields', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'sweep-preferences-'))
  const path = join(dir, 'preferences.json')
  await fs.writeFile(path, JSON.stringify(defaultPreferences()))
  const originalRead = fs.readFile
  let entered, release, reads = 0, first, second
  const reading = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  fs.readFile = async (...args) => {
    const ordinal = args[0] === path ? ++reads : 0
    const value = await originalRead(...args)
    if (ordinal === 1) { entered(); await gate }
    return value
  }
  syncBuiltinESMExports()
  try {
    first = updatePreferencesFile(path, { exportExcluded: ['private-plugin'] })
    await reading
    second = updatePreferencesFile(path, { machineName: 'Review machine' })
    assert.equal(reads, 1, 'the second patch must not read a stale snapshot')
    release()
    await Promise.all([first, second])
    const saved = await readPreferencesFile(path)
    assert.equal(saved.machineName, 'Review machine')
    assert.deepEqual(saved.exportExcluded, ['private-plugin'])
  } finally {
    release()
    await Promise.allSettled([first, second])
    fs.readFile = originalRead
    syncBuiltinESMExports()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('TS-002 a rejected patch does not block later updates', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'sweep-preferences-failure-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'preferences.json')
  await assert.rejects(updatePreferencesFile(path, { machineName: 3 }), /本机名称无效/)
  await updatePreferencesFile(path, { machineName: 'Saved' })
  assert.equal((await readPreferencesFile(path)).machineName, 'Saved')
})
