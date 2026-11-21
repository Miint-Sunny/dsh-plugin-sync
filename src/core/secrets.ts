import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'

const SECRET_KEY = /token|secret|password|passwd|cookie|sessdata|apikey|api_key|credential|auth/i
const SECRET_PATTERNS = [
  /sk-[a-f0-9]{32}\b/gi,
  /ghp_[A-Za-z0-9_]{36}\b/g,
  /github_pat_[A-Za-z0-9_]+\b/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
]

export function collectSecretValues(value: unknown, key = '', output = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key) && value.length >= 8) output.add(value)
    return output
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectSecretValues(entry, key, output)
    return output
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) collectSecretValues(child, childKey, output)
  }
  return output
}

async function filesBelow(directory: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await filesBelow(path))
    else if (entry.isFile()) output.push(path)
  }
  return output
}

export async function secretScanHits(snapshotDir: string, secrets: ReadonlySet<string>): Promise<{ file: string; count: number }[]> {
  const hits = new Map<string, number>()
  for (const path of await filesBelow(snapshotDir)) {
    const relativePath = relative(snapshotDir, path)
    const content = await readFile(path)
    const text = relativePath.endsWith('.tgz') ? gunzipSync(content).toString('latin1') : content.toString('latin1')
    let count = 0
    for (const secret of secrets) if (secret.length >= 8 && text.includes(secret)) count++
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0
      count += [...text.matchAll(pattern)].length
    }
    if (count > 0) hits.set(relativePath, count)
  }
  return [...hits].map(([file, count]) => ({ file, count }))
}
