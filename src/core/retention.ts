import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { exists } from './util.js'

export async function moveToTrash(source: string, trashDir: string): Promise<void> {
  if (!await exists(source)) return
  await mkdir(trashDir, { recursive: true })
  const name = basename(source)
  let destination = join(trashDir, name)
  if (await exists(destination)) destination = join(trashDir, `${name}-${randomUUID()}`)
  await rename(source, destination)
}

export async function pruneDirectory(root: string, trashDir: string, keep = 5): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const directories = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    const info = await stat(path)
    directories.push({ path, mtimeMs: info.mtimeMs })
  }
  directories.sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const entry of directories.slice(keep)) await moveToTrash(entry.path, trashDir)
}
