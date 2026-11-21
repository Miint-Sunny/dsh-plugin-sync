import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface ApplyLock {
  owner: string
  pid?: number
  startedAt: string
  stagedId: string
  corrupt?: true
}

const STARTUP_GRACE_MS = 10_000

function path(home: string): string {
  return join(home, 'plugin-sync', 'apply.lock')
}

export async function readApplyLock(home: string): Promise<ApplyLock | null> {
  try {
    const text = await readFile(path(home), 'utf8')
    let value: ApplyLock | undefined
    try { value = JSON.parse(text) } catch { /* Keep a broken lock visible to the state and manual recovery routes. */ }
    const file = await stat(path(home))
    if (value && typeof value.owner === 'string' && value.owner &&
        (value.pid === undefined || (Number.isSafeInteger(value.pid) && value.pid > 0))) {
      return { ...value, stagedId: typeof value.stagedId === 'string' ? value.stagedId : 'unknown',
        startedAt: typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt)) ? value.startedAt : file.mtime.toISOString() }
    }
    return { owner: 'unreadable-' + createHash('sha256').update(text).digest('hex'),
      startedAt: file.mtime.toISOString(), stagedId: 'unreadable', corrupt: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function acquireApplyLock(home: string, stagedId: string, owner: string = randomUUID()): Promise<string> {
  await mkdir(join(home, 'plugin-sync'), { recursive: true })
  const temporary = `${path(home)}.new-${randomUUID()}`
  try {
    await writeFile(temporary, JSON.stringify({ owner, startedAt: new Date().toISOString(), stagedId }), { flag: 'wx', mode: 0o600 })
    // Publish a complete file with an exclusive hard link. A crash before this
    // step leaves only an unclaimed temporary file, never a half-written lock.
    await link(temporary, path(home)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error('已有应用进程正在运行，不能同时应用')
      throw error
    })
  } finally {
    await rm(temporary, { force: true })
  }
  return owner
}

export async function verifyApplyLock(home: string, stagedId: string, owner?: string): Promise<string> {
  const existing = await readApplyLock(home)
  if (existing === null) return acquireApplyLock(home, stagedId, owner)
  if (owner === undefined || existing.owner !== owner) throw new Error('已有应用进程正在运行，不能同时应用')
  return existing.owner
}

export async function writeApplyLockPid(home: string, owner: string, pid: number): Promise<void> {
  const existing = await readApplyLock(home)
  if (existing === null || existing.owner !== owner) throw new Error('应用锁不属于这次启动')
  const temporary = `${path(home)}.tmp-${process.pid}`
  await writeFile(temporary, JSON.stringify({ ...existing, pid }), { mode: 0o600 })
  await rename(temporary, path(home))
}

export async function releaseApplyLock(home: string, owner: string): Promise<void> {
  const existing = await readApplyLock(home)
  if (existing !== null && existing.owner === owner) await rm(path(home), { force: true })
}

/** Automatic callers pass the owner they observed: never reclaim a replacement or an unidentifiable startup lock. */
export async function clearStaleApplyLock(home: string, expectedOwner?: string): Promise<boolean> {
  const existing = await readApplyLock(home)
  if (existing === null) return false
  if (expectedOwner !== undefined && (existing.owner !== expectedOwner ||
    !Number.isSafeInteger(existing.pid) || existing.pid! <= 0)) return false
  if (existing.pid === undefined && Date.now() - Date.parse(existing.startedAt) < STARTUP_GRACE_MS) return false
  if (existing.pid !== undefined) {
    try {
      process.kill(existing.pid, 0)
      throw new Error('导入进程仍在运行，不能清除应用锁')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  // Recheck ownership after the liveness query, as a manual recovery may have replaced the lock.
  await releaseApplyLock(home, existing.owner)
  return true
}
