import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

interface DetachedOptions {
  command: string
  args: string[]
  logPath: string
  env?: NodeJS.ProcessEnv | undefined
}

export async function launchDetached(options: DetachedOptions): Promise<number> {
  await mkdir(dirname(options.logPath), { recursive: true })
  const script = fileURLToPath(new URL('../../scripts/detached-apply.sh', import.meta.url))
  const env = options.env ?? process.env
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [script, options.logPath, options.command, ...options.args], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    let output = ''
    let errors = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', reject)
    child.on('close', code => {
      const pid = Number(output.trim())
      if (code === 0 && Number.isSafeInteger(pid) && pid > 0) resolve(pid)
      else reject(new Error(`独立应用进程启动失败（退出码 ${code}）：${errors || output}`))
    })
  })
}
