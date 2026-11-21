import { packageAlias } from './package-names.js'

/** Display text as DSH plugin metadata carries it: a plain string or a map from language to text. */
export type LocalizedText = string | Record<string, string>

/** The fields of a `pluginManager.listBundles()` entry this plugin reads. */
export interface BundleInfo {
  name: string
  official?: boolean
  optional?: boolean
  enabled: boolean
  installed: boolean
  availability?: string
  version?: string
  /** Raw `package.json` description. */
  description?: string
  meta?: { title?: LocalizedText; description?: LocalizedText; icon?: string; error?: string }
  /** Rows the bundle's patch inserts. */
  rows?: { rowId: string; moduleName: string; meta?: { title?: LocalizedText; description?: LocalizedText } }[]
  error?: { code?: string }
}

/** Which list a plugin appears in. */
export type PluginGroup = 'third-party' | 'official'

/** A plugin as the export and import lists show it. */
export interface CatalogPlugin {
  name: string
  group: PluginGroup
  /** Whether the profile's bundle selection has it. */
  enabled: boolean
  /** Whether the profile declares it as a dependency. */
  installed: boolean
  version?: string
  title?: LocalizedText
  description?: LocalizedText
  /** `data:` URL of the plugin icon. */
  icon?: string
  experimental: boolean
  error?: string
}

/** This machine's plugins plus the owner of every row a bundle declares. */
export interface Catalog {
  plugins: CatalogPlugin[]
  /** Row id → name of the bundle whose patch inserts the row. */
  rowOwners: Map<string, string>
  /** Row id → display title from the row's plugin metadata. */
  rowTitles: Map<string, LocalizedText>
}

function text(value: unknown): LocalizedText | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter(([, item]) => typeof item === 'string' && item !== '')
  return entries.length === 0 ? undefined : Object.fromEntries(entries) as Record<string, string>
}

/**
 * Builds the catalog from the plugin manager's bundle list and the profile manifest.
 * Profile dependencies are third-party plugins unless the manager marks them official; official
 * plugins also include the optional bundles the installation ships. Bundles that are neither,
 * such as the always-on base bundles, are left out.
 * @param bundles - `pluginManager.listBundles()` entries.
 * @param manifest - the desktop profile's `package.json`.
 * @returns the plugins sorted by group and name, with row ownership.
 */
export function catalogOf(bundles: BundleInfo[], manifest: any): Catalog {
  const dependencies = Object.keys(manifest.dependencies ?? {})
  const selected: string[] = manifest.dsh?.profile?.bundles ?? []
  const byName = new Map(bundles.map(bundle => [bundle.name, bundle]))
  const plugins: CatalogPlugin[] = []
  const names = new Set([...dependencies, ...bundles.filter(bundle => bundle.official === true && bundle.availability !== 'missing').map(bundle => bundle.name)])
  for (const name of names) {
    const bundle = byName.get(name)
    const title = text(bundle?.meta?.title)
    const description = text(bundle?.meta?.description) ?? text(bundle?.description)
    plugins.push({
      name,
      group: bundle?.official === true ? 'official' : 'third-party',
      enabled: selected.includes(name),
      installed: dependencies.includes(name),
      ...(bundle?.version !== undefined ? { version: bundle.version } : {}),
      ...(title !== undefined && title !== name ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(typeof bundle?.meta?.icon === 'string' && bundle.meta.icon.startsWith('data:image/') ? { icon: bundle.meta.icon } : {}),
      experimental: name.startsWith('@deepseek-ai/dsh-experimental-'),
      ...(bundle?.error?.code !== undefined ? { error: bundle.error.code } : {}),
    })
  }
  plugins.sort((left, right) => left.group === right.group ? left.name.localeCompare(right.name) : left.group === 'third-party' ? -1 : 1)
  const rowOwners = new Map<string, string>()
  const rowTitles = new Map<string, LocalizedText>()
  for (const bundle of bundles) {
    for (const row of bundle.rows ?? []) {
      if (typeof row.rowId !== 'string') continue
      rowOwners.set(row.rowId, bundle.name)
      const title = text(row.meta?.title)
      if (title !== undefined) rowTitles.set(row.rowId, title)
    }
  }
  return { plugins, rowOwners, rowTitles }
}

/**
 * Builds the catalog from the profile manifest alone, for a host without the plugin manager.
 * Every dependency is a third-party plugin and rows are attributed by module name only.
 * @param manifest - the desktop profile's `package.json`.
 * @param descriptions - `package.json` descriptions of the installed dependencies.
 * @returns the catalog.
 */
export function manifestCatalog(manifest: any, descriptions: Record<string, string> = {}): Catalog {
  const selected: string[] = manifest.dsh?.profile?.bundles ?? []
  return catalogOf(Object.keys(manifest.dependencies ?? {}).map(name => ({
    name,
    enabled: selected.includes(name),
    installed: true,
    ...(descriptions[name] !== undefined ? { description: descriptions[name] } : {}),
  })), manifest)
}

/**
 * @param row - a profile patch entry.
 * @param catalog - row ownership from the bundles.
 * @param candidates - plugin names a module name may belong to.
 * @returns the plugin the row belongs to, or `undefined` when no bundle declares it.
 */
export function rowOwner(row: { id: string; name?: string | undefined }, catalog: Catalog, candidates: Iterable<string>): string | undefined {
  const declared = catalog.rowOwners.get(row.id)
  if (declared !== undefined) return declared
  const moduleName = row.name
  if (moduleName === undefined) return undefined
  const names = [...candidates]
  const matches = (name: string): boolean => moduleName === name || moduleName.startsWith(`${name}/`) || moduleName.startsWith(`${name}#`)
  // A profile may temporarily contain both names during migration. Prefer its
  // exact package before considering aliases, and return the actual candidate.
  for (const name of names) {
    if (matches(name)) return name
  }
  for (const name of names) {
    const alias = packageAlias(name)
    if (alias !== undefined && matches(alias)) return name
  }
  return undefined
}
