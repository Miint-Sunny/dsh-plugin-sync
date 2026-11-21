import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireApplyLock, clearStaleApplyLock, readApplyLock, releaseApplyLock, writeApplyLockPid } from '../lib/core/apply-lock.js'

test('apply lock is exclusive, owner-scoped and clearable after the process is gone', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-lock-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const owner = await acquireApplyLock(home, 'staged-fixture')
  assert.equal((await readApplyLock(home)).owner, owner)
  await assert.rejects(acquireApplyLock(home, 'staged-other'), /已有应用进程/)
  await releaseApplyLock(home, owner)
  assert.equal(await readApplyLock(home), null)
  const staleOwner = await acquireApplyLock(home, 'staged-stale')
  assert.equal(await clearStaleApplyLock(home), false, 'a just-created PID-less lock belongs to a process that is starting')
  const file = join(home, 'plugin-sync/apply.lock')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), startedAt: new Date(Date.now() - 60_000).toISOString() }))
  assert.equal(await clearStaleApplyLock(home), true)
  assert.equal(await readApplyLock(home), null)
  assert.ok(staleOwner)
})

test('feat115-r2-4 malformed and empty locks remain visible and can be cleared manually after the startup window', async t => {
  for (const bytes of ['', '{"owner":', 'null']) {
    const home = mkdtempSync(join(tmpdir(), 'sync-broken-lock-'))
    t.after(() => rmSync(home, { recursive: true, force: true }))
    await acquireApplyLock(home, 'fixture')
    const file = join(home, 'plugin-sync/apply.lock')
    writeFileSync(file, bytes)
    const old = new Date(Date.now() - 60_000); utimesSync(file, old, old)
    const observed = await readApplyLock(home)
    assert.ok(observed)
    assert.equal(await clearStaleApplyLock(home, observed.owner), false, 'automatic recovery cannot identify a corrupt lock owner/PID')
    assert.equal(await clearStaleApplyLock(home), true)
    assert.equal(await readApplyLock(home), null)
  }
})


test('automatic stale recovery only removes the expected lock with an exited PID', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-stale-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const owner = await acquireApplyLock(home, 'install-or-rollback')
  assert.equal(await clearStaleApplyLock(home, owner), false, 'a PID-less lock may still be being created')
  assert.equal((await readApplyLock(home)).owner, owner)
  await writeApplyLockPid(home, owner, process.pid)
  await assert.rejects(clearStaleApplyLock(home, owner), /仍在运行/)
  assert.equal((await readApplyLock(home)).owner, owner)
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
  assert.equal(child.status, 0)
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
  await writeApplyLockPid(home, owner, child.pid)
  assert.equal(await clearStaleApplyLock(home, 'another-owner'), false, 'do not clear a replacement lock')
  assert.equal(await clearStaleApplyLock(home, owner), true)
  assert.equal(await readApplyLock(home), null)
})

test('feat115-r2-4 automatic owner/PID recovery stays compatible with a record missing optional descriptive fields', async t => {
  const home = mkdtempSync(join(tmpdir(), 'sync-legacy-lock-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  await acquireApplyLock(home, 'prepare-directory')
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }); assert.equal(child.status, 0)
  const file = join(home, 'plugin-sync/apply.lock')
  writeFileSync(file, JSON.stringify({ owner: 'known-owner', pid: child.pid, stagedId: 'interrupted' }))
  assert.equal(await clearStaleApplyLock(home, 'known-owner'), true)
  assert.equal(await readApplyLock(home), null)
})
