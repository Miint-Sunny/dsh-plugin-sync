import { stat } from 'node:fs/promises'

/**
 * Splits the version off a pnpm key: `name`, `@scope/name`, `name@1.0.0`, `@scope/name@1.0.0` or `name@1.0.0(peer@2.0.0)`.
 * @param key - lockfile package key, exemption key or `patchedDependencies` selector.
 * @returns the package name, which is the whole key when it has no version.
 */
export function packageNameFromKey(key: string): string {
  const at = key.startsWith('@') ? key.indexOf('@', key.indexOf('/') + 1) : key.indexOf('@')
  return at < 0 ? key : key.slice(0, at)
}

/**
 * Checks whether a file or directory exists.
 * @param path - location to check.
 * @returns false for a missing path; any other error is thrown.
 */
export async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}
