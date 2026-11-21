/** Run every test file with a temporary directory of their own and fail when the run leaves anything in it. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const files = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => join('tests', name))
// The App's pnpm (bin/pnpm.mjs) turns on Node's compile cache in $TMPDIR/node-compile-cache; it is shared, not test output.
const shared = new Set(['node-compile-cache'])
// A directory per run keeps other programs' files in the shared $TMPDIR out of the count, and child processes inherit it.
const temporary = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-tests-'))
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: temporary } })
const leaked = readdirSync(temporary).filter(name => !shared.has(name)).sort()
if (leaked.length) {
  const kinds = Object.entries(Object.groupBy(leaked, name => name.replace(/-[A-Za-z0-9]{6}$/, '-*'))).map(([kind, names]) => `${kind} (${names.length})`)
  console.error([
    `Tests left ${leaked.length} ${leaked.length === 1 ? 'entry' : 'entries'} in ${temporary}, kept for inspection:`,
    ...leaked.map(name => '  ' + name),
    `Kinds: ${kinds.join(', ')}.`,
    "Find each prefix under tests/ and, right after its mkdtempSync(join(tmpdir(), '<prefix>')), add t.after(() => rmSync(dir, { recursive: true, force: true })).",
  ].join('\n'))
  process.exitCode = 1
} else {
  rmSync(temporary, { recursive: true, force: true })
  process.exitCode = result.status ?? 1
}
