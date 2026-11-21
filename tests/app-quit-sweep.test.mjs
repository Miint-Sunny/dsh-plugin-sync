import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyStagedPlan } from '../lib/core/apply.js'

test('S-004 literal custom App paths keep waiting for a live dummy process', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sweep-app-quit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const appPath = join(root, 'Custom (local) [stable]+{1}^$|?.app')
  const executable = join(appPath, 'Contents/MacOS/DeepSeek Harness')
  const dummy = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)", '--', executable], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  t.after(async () => { const ended = once(dummy, 'exit'); dummy.kill('SIGTERM'); await ended })
  await once(dummy, 'message')
  const bin = join(root, 'bin'), dshHome = join(root, 'home'), stagedDir = join(root, 'staged')
  const profile = join(dshHome, 'profiles/desktop')
  await Promise.all([mkdir(bin), mkdir(stagedDir), mkdir(profile, { recursive: true })])
  const manifest = JSON.stringify({ dependencies: {} })
  await writeFile(join(profile, 'package.json'), manifest)
  await writeFile(join(profile, 'lock'), 'fixture: the quit check must run first')
  await writeFile(join(stagedDir, 'plan.json'), JSON.stringify({ id: 'literal-app-path', untouched: [], manifest: { dependencies: {} } }))
  for (const command of ['osascript', 'open']) {
    await writeFile(join(bin, command), '#!/bin/sh\nexit 0\n')
    await chmod(join(bin, command), 0o755)
  }
  // Use the system pgrep regex engine, but return success only for our own dummy
  // child PID. No real application is quit, opened, or signalled.
  const probe = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const result = spawnSync('/usr/bin/pgrep', ['-P', ${JSON.stringify(String(process.pid))}, '-f', process.argv[3]], { encoding: 'utf8' });
process.exit(result.stdout.trim().split(/\\s+/).includes(${JSON.stringify(String(dummy.pid))}) ? 0 : 1);
`
  await writeFile(join(bin, 'pgrep'), probe)
  await chmod(join(bin, 'pgrep'), 0o755)
  const previousPath = process.env.PATH
  let result
  try {
    process.env.PATH = `${bin}:${previousPath}`
    result = await applyStagedPlan({ stagedDir, dshHome, noApp: false, appPath, dshPath: join(root, 'never-run'), timeoutMs: 200 })
  } finally { process.env.PATH = previousPath }
  assert.equal(result.success, false)
  assert.match(result.error, /等待桌面端退出超时/)
  assert.equal(result.backupDir, undefined, 'must not start profile backup or mutation while the process is live')
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), manifest)
})
