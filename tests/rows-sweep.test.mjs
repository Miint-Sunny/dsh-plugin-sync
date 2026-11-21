import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { updateRows } from '../lib/core/apply.js'

async function patch(t, text) {
  const root = await mkdtemp(join(tmpdir(), 'sweep-rows-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'cordis.patch.yml')
  await writeFile(file, text)
  return file
}

test('S-003 nested definitions remain unchanged while a top-level override is appended', async t => {
  const original = '- insert:\n    - id: target\n      disabled: false\n      config:\n        title: keep\n'
  const file = await patch(t, original)
  await updateRows(file, [{ id: 'target', disabled: true }])
  const text = await readFile(file, 'utf8')
  assert.ok(text.startsWith(original))
  assert.deepEqual(parse(text), [...parse(original), { id: 'target', disabled: true }])
})

test('S-003 a same-id nested configuration cannot override the selected top-level row', async t => {
  const original = '- id: target\n  disabled: false\n  config:\n    children:\n      - id: target\n        disabled: false\n'
  const file = await patch(t, original)
  await updateRows(file, [{ id: 'target', disabled: true }])
  const rows = parse(await readFile(file, 'utf8'))
  assert.equal(rows[0].disabled, true)
  assert.deepEqual(rows[0].config, parse(original)[0].config)
})

test('S-003 selecting enabled persists false for an existing row without disabled', async t => {
  const file = await patch(t, '  - id: target\n    name: keep\n')
  const result = await updateRows(file, [{ id: 'target', disabled: false }])
  assert.equal(result.changed, true)
  assert.deepEqual(parse(await readFile(file, 'utf8')), [{ id: 'target', disabled: false, name: 'keep' }])
  assert.deepEqual(await updateRows(file, [{ id: 'target', disabled: false }]), { changed: false, appended: [] })
})

for (const id of ['first', 'second']) {
  test(`S-003 BOM-prefixed rows update ${id} without changing other bytes or nested values`, async t => {
    const original = '\uFEFF- id: first\r\n  disabled: false # first\r\n  config:\r\n    children:\r\n      - id: second\r\n        disabled: false # nested\r\n- id: second\r\n  disabled: false # second\r\n'
    const file = await patch(t, original)
    assert.deepEqual(await updateRows(file, [{ id, disabled: true }]), { changed: true, appended: [] })
    assert.deepEqual(await readFile(file), Buffer.from(original.replace(`disabled: false # ${id}`, `disabled: true # ${id}`)))
  })
}

test('S-003 BOM-prefixed nested-only rows append a top-level override without changing the original', async t => {
  const original = '\uFEFF- insert:\n    - id: target\n      disabled: false\n'
  const file = await patch(t, original)
  assert.deepEqual(await updateRows(file, [{ id: 'target', disabled: true }]), { changed: true, appended: ['target'] })
  const result = await readFile(file, 'utf8')
  assert.ok(result.startsWith(original))
  assert.deepEqual(parse(result.slice(1)), [...parse(original.slice(1)), { id: 'target', disabled: true }])
})

test('S-003 a BOM-prefixed empty sequence keeps its BOM when appending a row', async t => {
  const file = await patch(t, '\uFEFF[]\n')
  await updateRows(file, [{ id: 'target', disabled: false }])
  const result = await readFile(file, 'utf8')
  assert.ok(result.startsWith('\uFEFF'))
  assert.deepEqual(parse(result), [{ id: 'target', disabled: false }])
})
