import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('applier survives killing the original parent process group and is adopted by launchd', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-detached-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const child = join(root, 'child.mjs')
  const parent = join(root, 'parent.mjs')
  const log = join(root, 'apply.log')
  writeFileSync(child, 'setInterval(() => {}, 1000)\n')
  const module = new URL('../lib/core/detached.js', import.meta.url).pathname
  writeFileSync(parent, `import { launchDetached } from '${module}'\nconst pid = await launchDetached({ command: process.execPath, args: [${JSON.stringify(child)}], logPath: ${JSON.stringify(log)} })\nconsole.log(pid)\nsetInterval(() => {}, 1000)\n`)
  const original = spawn(process.execPath, [parent], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  original.stdout.on('data', chunk => { output += chunk })
  let pid
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (/^\d+\n/.test(output)) {
        pid = Number(output.trim())
        break
      }
      await sleep(50)
    }
    assert.ok(Number.isInteger(pid), output)
    assert.ok(original.pid !== pid)
    process.kill(-original.pid, 'SIGKILL')
    await sleep(300)
    assert.doesNotThrow(() => process.kill(pid, 0))
    const ps = execFileSync('ps', ['-o', 'pid=,ppid=,pgid=,command=', '-p', String(pid)], { encoding: 'utf8' })
    const fields = ps.trim().split(/\s+/)
    assert.equal(Number(fields[1]), 1, ps)
    assert.notEqual(Number(fields[2]), original.pid, ps)
  } finally {
    if (pid !== undefined) {
      try { process.kill(pid, 'SIGTERM') } catch {}
    }
    if (original.exitCode === null) {
      try { process.kill(-original.pid, 'SIGKILL') } catch {}
    }
    await sleep(100)
  }
})
