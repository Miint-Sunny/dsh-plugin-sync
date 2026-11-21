import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pruneDirectory } from '../lib/core/retention.js'

test('retention keeps the newest five directories and moves older ones to trash', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-retention-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const root = join(temporary, 'exports')
  const trash = join(temporary, 'trash')
  mkdirSync(root)
  for (let index = 0; index < 7; index++) {
    const directory = join(root, `item-${index}`)
    mkdirSync(directory)
    writeFileSync(join(directory, 'marker.txt'), String(index))
    utimesSync(directory, index + 1, index + 1)
  }
  await pruneDirectory(root, trash, 5)
  assert.deepEqual(readdirSync(root).sort(), ['item-2', 'item-3', 'item-4', 'item-5', 'item-6'])
  assert.deepEqual(readdirSync(trash).sort(), ['item-0', 'item-1'])
})
