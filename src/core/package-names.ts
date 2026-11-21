/** Published identities; serialized formats and persistent row IDs keep their original names. */
export const SYNC_PACKAGE_NAMES = ['dsh-plugin-sync', '@miint-sunny/dsh-plugin-sync'] as const

const PACKAGE_RENAMES: readonly (readonly [string, string])[] = [
  SYNC_PACKAGE_NAMES,
  ['dsh-workbench', '@miint-sunny/dsh-workbench'],
  ['dsh-media-look', '@miint-sunny/dsh-media-look'],
  ['dsh-model-settings', '@miint-sunny/dsh-model-settings'],
  ['dsh-session-title-headtail', '@miint-sunny/dsh-session-title-headtail'],
  ['dsh-nai5-prompting', '@miint-sunny/dsh-nai-desk'],
  ...['usage', 'checkpoints', 'review', 'navigation', 'pages', 'settings', 'essentials'].map(part => [
    `dsh-workbench-${part}`, `@miint-sunny/dsh-workbench-${part}`,
  ] as const),
]

const aliases = new Map(PACKAGE_RENAMES.flatMap(([oldName, newName]) => [[oldName, newName], [newName, oldName]] as const))
const identities = new Map(PACKAGE_RENAMES.flatMap(([oldName, newName]) => [[oldName, newName], [newName, newName]] as const))

/** Stable identity for comparisons; serialized names still match the actual installed package. */
export function packageIdentity(name: string): string {
  return identities.get(name) ?? name
}

/** Refuse two installed/published aliases competing for the same component and preset IDs. */
export function assertUniquePackageIdentities(names: Iterable<string>): void {
  const seen = new Map<string, string>()
  for (const name of names) {
    const identity = packageIdentity(name)
    const previous = seen.get(identity)
    if (previous !== undefined && previous !== name) throw new Error(`插件包名冲突：${previous}、${name} 属于同一插件；请只保留一个名称`)
    seen.set(identity, name)
  }
}

/** The other published identity of an owned package, if its name changed. */
export function packageAlias(name: string): string | undefined {
  return aliases.get(name)
}
