import type { Catalog, LocalizedText, PluginGroup } from './catalog.js'
import { packageIdentity } from './package-names.js'
import type { Change, ChangeSet, UnchangedReason } from './plan.js'
import type { PluginSource, SyncSnapshot } from './types.js'

/** How the import list identifies a plugin: this machine's metadata first, the snapshot's otherwise. */
export interface PluginEntry {
  name: string
  group: PluginGroup
  title?: LocalizedText
  description?: LocalizedText
  /** `data:` URL; only plugins installed here have one. */
  icon?: string
  experimental: boolean
  localVersion?: string
  snapshotVersion?: string
  snapshotSource?: PluginSource
  /** Source commit of a plugin packed from a `link:` repository. */
  commit?: string
}

/** A plugin with the changes an import offers for it; the page selects them together. */
export interface PluginChanges extends PluginEntry {
  changes: Change[]
  /** Whether every change is on by default; a downgrade or a compatibility exemption is not. */
  defaultOn: boolean
  /** Dependencies whose install scripts applying these changes would newly allow. */
  newBuildPermissions: string[]
}

/** A plugin the import leaves alone, with the reason. */
export interface PluginUnchanged extends PluginEntry {
  reason: UnchangedReason
}

function order(left: PluginEntry, right: PluginEntry): number {
  if (left.group !== right.group) return left.group === 'third-party' ? -1 : 1
  return left.name.localeCompare(right.name)
}

/**
 * Groups an import's changes by plugin and attaches what identifies each plugin.
 * @param set - the changes {@link buildChanges} found.
 * @param snapshot - the snapshot being imported.
 * @param catalog - this machine's plugins.
 * @param versions - installed versions here by package name.
 * @param permissions - the dependencies a plugin's changes would newly allow to run install scripts.
 * @returns changed plugins and unchanged plugins, third-party first, then by name.
 */
export function previewEntries(set: ChangeSet, snapshot: SyncSnapshot, catalog: Catalog, versions: Record<string, string>, permissions: (name: string) => string[]): { plugins: PluginChanges[]; unchanged: PluginUnchanged[] } {
  const desktop = snapshot.profiles.desktop
  const entry = (name: string): PluginEntry => {
    const local = catalog.plugins.find(plugin => packageIdentity(plugin.name) === packageIdentity(name))
    const plugin = desktop.plugins.find(item => item.name === name)
    const official = desktop.official.find(item => item.name === name)
    const title = local?.title ?? plugin?.title ?? official?.title
    const description = local?.description ?? plugin?.description ?? official?.description
    const localVersion = versions[name] ?? (local === undefined ? undefined : versions[local.name] ?? local.version)
    return {
      name,
      group: local?.group ?? (plugin?.official === true || official !== undefined ? 'official' : 'third-party'),
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(local?.icon !== undefined ? { icon: local.icon } : {}),
      experimental: name.startsWith('@deepseek-ai/dsh-experimental-'),
      ...(localVersion !== undefined ? { localVersion } : {}),
      ...(plugin !== undefined ? { snapshotVersion: plugin.version, snapshotSource: plugin.source } : {}),
      ...(plugin?.commit !== undefined ? { commit: plugin.commit } : {}),
    }
  }
  const byOwner = new Map<string, Change[]>()
  for (const change of set.changes) byOwner.set(change.owner, [...byOwner.get(change.owner) ?? [], change])
  const plugins = [...byOwner].map(([name, changes]) => ({
    ...entry(name),
    changes,
    defaultOn: changes.every(change => change.defaultOn),
    newBuildPermissions: changes.some(change => ['install', 'rename', 'upgrade', 'downgrade'].includes(change.kind)) ? permissions(name) : [],
  })).sort(order)
  const unchanged = set.unchanged.map(item => ({ ...entry(item.name), reason: item.reason })).sort(order)
  return { plugins, unchanged }
}
