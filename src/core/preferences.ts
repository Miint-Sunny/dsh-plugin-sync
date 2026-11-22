import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { validateRepositoryAddress } from './git-sync.js'

const pendingUpdates = new Map<string, Promise<void>>()

/** Per-machine settings kept in `<DSH_HOME>/plugin-sync/preferences.json`. */
export interface PluginSyncPreferences {
  format: 'dsh-plugin-sync/preferences-2'
  /** Display name of this machine; absent means the macOS computer name. */
  machineName?: string
  repository: string
  exportTarget: 'zip' | 'git'
  /** Plugins left out of exports, sorted. */
  exportExcluded: string[]
}

function validPackageName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(name) || /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name)
}

/**
 * @param value - untrusted JSON from the page or the preferences file.
 * @param allowFileForTests - accept `file://` repositories.
 * @returns the validated preferences.
 */
export function validatePreferences(value: any, allowFileForTests = false): PluginSyncPreferences {
  if (value?.format !== 'dsh-plugin-sync/preferences-2') throw new Error('偏好格式无效')
  if (value.machineName !== undefined && (typeof value.machineName !== 'string' || value.machineName.trim() === '' || value.machineName.length > 100)) throw new Error('本机名称无效')
  if (typeof value.repository !== 'string' || value.repository.length > 2000) throw new Error('远程地址无效')
  if (value.repository.trim() !== '') validateRepositoryAddress(value.repository.trim(), allowFileForTests)
  if (!['zip', 'git'].includes(value.exportTarget)) throw new Error('导出位置无效')
  if (!Array.isArray(value.exportExcluded) || !value.exportExcluded.every((name: unknown) => typeof name === 'string' && validPackageName(name))) throw new Error('不导出的插件列表无效')
  return {
    format: 'dsh-plugin-sync/preferences-2',
    ...(value.machineName !== undefined ? { machineName: value.machineName.trim() } : {}),
    repository: value.repository.trim(),
    exportTarget: value.exportTarget,
    exportExcluded: [...new Set(value.exportExcluded as string[])].sort(),
  }
}

/** @returns preferences for a machine that never saved any. */
export function defaultPreferences(): PluginSyncPreferences {
  return { format: 'dsh-plugin-sync/preferences-2', repository: '', exportTarget: 'zip', exportExcluded: [] }
}

/**
 * Reads the preferences file.
 * @param path - preferences file.
 * @param allowFileForTests - accept `file://` repositories.
 * @returns the stored preferences, or defaults when the file is missing.
 */
export async function readPreferencesFile(path: string, allowFileForTests = false): Promise<PluginSyncPreferences> {
  let value: any
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultPreferences()
    throw error
  }
  return validatePreferences(value, allowFileForTests)
}

async function writeValidated(path: string, validated: PluginSyncPreferences): Promise<PluginSyncPreferences> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `preferences.json.tmp-${process.pid}-${randomUUID()}`)
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  return validated
}

/**
 * Changes only the given fields, so the export list and the settings form never overwrite each other.
 * An empty `machineName` returns to the default name.
 * @param path - preferences file.
 * @param patch - untrusted fields from the page.
 * @param allowFileForTests - accept `file://` repositories.
 * @returns the written preferences.
 */
export async function updatePreferencesFile(path: string, patch: unknown, allowFileForTests = false): Promise<PluginSyncPreferences> {
  const key = resolve(path)
  const previous = pendingUpdates.get(key)
  let release!: () => void
  const pending = new Promise<void>(done => { release = done })
  pendingUpdates.set(key, pending)
  try {
    await previous
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('偏好修改必须是对象')
    const allowed = new Set(['machineName', 'repository', 'exportTarget', 'exportExcluded'])
    const unknown = Object.keys(patch).filter(key => !allowed.has(key))
    if (unknown.length > 0) throw new Error(`不能修改的偏好字段：${unknown.join(', ')}`)
    const { machineName, ...rest } = patch as Record<string, unknown>
    const next: Record<string, unknown> = { ...await readPreferencesFile(path, allowFileForTests), ...rest }
    if (machineName !== undefined) {
      if (typeof machineName !== 'string') throw new Error('本机名称无效')
      if (machineName.trim() === '') delete next.machineName
      else next.machineName = machineName
    }
    return await writeValidated(path, validatePreferences(next, allowFileForTests))
  } finally {
    release()
    if (pendingUpdates.get(key) === pending) pendingUpdates.delete(key)
  }
}
