import type { LocalizedText } from './catalog.js'

export type PluginSource = 'npm' | 'github' | 'tarball-url' | 'packed'

/** A profile dependency in a snapshot. */
export interface SnapshotPlugin {
  name: string
  version: string
  spec: string
  source: PluginSource
  integrity?: string
  file?: string
  commit?: string
  bundle: boolean
  selected: boolean
  /** Whether the exporting machine's plugin manager marks it official. */
  official?: boolean
  title?: LocalizedText
  description?: LocalizedText
}

/** An official bundle the installation ships, with its selection on the exporting machine. */
export interface SnapshotOfficial {
  name: string
  enabled: boolean
  title?: LocalizedText
  description?: LocalizedText
}

/** A component switch: a top-level `{ id, disabled }` entry of the profile patch. */
export interface SnapshotRow {
  id: string
  name?: string
  disabled: boolean
  /** The plugin whose bundle declares the row. */
  owner: string
  title?: LocalizedText
}

export interface DesktopProfileSnapshot {
  plugins: SnapshotPlugin[]
  official: SnapshotOfficial[]
  bundles: string[]
  rows: SnapshotRow[]
  exemptions: Record<string, string[]>
  workspace: {
    patchedDependencies: Record<string, string>
    allowBuilds: unknown
    overrides: unknown
  }
  patches: Record<string, string>
  lockfile: string
}

export interface SyncSnapshot {
  format: 'dsh-plugin-sync/snapshot-2'
  createdAt: string
  /** Display name of the exporting machine. */
  machine: string
  /** Directory name of the exporting machine in a Git repository. */
  machineId: string
  exporter: { name: string; version: string }
  dsh: { desktopVersion: string }
  profiles: { desktop: DesktopProfileSnapshot }
  /** Plugins the exporting machine has but left out of this snapshot. */
  excluded: string[]
}

export interface PackedResult {
  file: string
  integrity?: string
  commit?: string
}

export type Packer = (sourceDir: string, destinationDir: string) => Promise<PackedResult>
