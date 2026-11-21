/** Placeholder-aware translation from the slot, e.g. `t('import.apply', { count: 3 })`. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** Display text from DSH plugin metadata: a plain string or a map from language to text. */
export type LocalizedText = string | Record<string, string>

/** Picks the current language's text, as the locale service's `resolveText` does. */
export type ResolveText = (text: LocalizedText) => string

/** A change offered by `/preview`. */
export interface ChangeLike {
  id: string
  kind: string
  name: string
  owner: string
  replaces?: string
  downgrade?: boolean
  from?: string
  to?: string
  title?: LocalizedText
  defaultOn: boolean
}

/** What identifies a plugin in the lists. */
export interface PluginLike {
  name: string
  group: 'third-party' | 'official'
  title?: LocalizedText
  description?: LocalizedText
  icon?: string
  experimental: boolean
}

/** A plugin with its changes, as `/preview` lists it. */
export interface PluginChangesLike extends PluginLike {
  changes: ChangeLike[]
  defaultOn: boolean
  localVersion?: string
  snapshotVersion?: string
  snapshotSource?: string
  commit?: string
  newBuildPermissions: string[]
}

/** Change kinds in the order their tags appear. */
export const KINDS = ['install', 'rename', 'upgrade', 'downgrade', 'remove', 'enable', 'disable', 'row', 'exemption'] as const

/**
 * Wraps the slot's translation so `{name}` placeholders are filled whether or not the host does it.
 * @param translate - the slot's `t`.
 * @returns the filling translation.
 */
export function interpolating(translate: Translate): Translate {
  return (key, params) => {
    let text = translate(key, params)
    for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
}

/**
 * Resolves metadata text without the locale service: the language's entry, then English, then any.
 * @param language - BCP 47 language of the page.
 * @returns the resolver.
 */
export function fallbackResolver(language: string): ResolveText {
  return text => {
    if (typeof text === 'string') return text
    const base = language.split('-')[0]!
    return text[language] ?? text[base] ?? text.en ?? Object.values(text)[0] ?? ''
  }
}

/**
 * @param plugin - a listed plugin.
 * @param resolve - current-language resolver.
 * @returns the title shown for the plugin: its metadata title, or the package name.
 */
export function titleOf(plugin: PluginLike, resolve: ResolveText): string {
  return plugin.title === undefined ? plugin.name : resolve(plugin.title) || plugin.name
}

/**
 * @param plugin - a listed plugin.
 * @param resolve - current-language resolver.
 * @returns the plugin's description, or `undefined` when it has none.
 */
export function descriptionOf(plugin: PluginLike, resolve: ResolveText): string | undefined {
  return plugin.description === undefined ? undefined : resolve(plugin.description) || undefined
}

/**
 * @param plugin - a plugin with changes.
 * @returns its change kinds, once each, in tag order.
 */
export function kindsOf(plugin: PluginChangesLike): string[] {
  return KINDS.filter(kind => plugin.changes.some(change => change.kind === kind || (kind === 'downgrade' && change.kind === 'rename' && change.downgrade === true)))
}

/**
 * @param plugins - the preview's plugins.
 * @returns the names selected by default.
 */
export function defaultSelection(plugins: PluginChangesLike[]): Set<string> {
  return new Set(plugins.filter(plugin => plugin.defaultOn).map(plugin => plugin.name))
}

/**
 * @param plugins - the preview's plugins.
 * @param selected - selected plugin names.
 * @returns the change ids `/apply` takes.
 */
export function selectedChangeIds(plugins: PluginChangesLike[], selected: Set<string>): string[] {
  return plugins.filter(plugin => selected.has(plugin.name)).flatMap(plugin => plugin.changes.map(change => change.id))
}

/**
 * @param plugins - the preview's plugins.
 * @param selected - selected plugin names.
 * @returns the number of selected changes by kind.
 */
export function countsByKind(plugins: PluginChangesLike[], selected: Set<string>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const plugin of plugins) {
    if (!selected.has(plugin.name)) continue
    for (const change of plugin.changes) counts[change.kind] = (counts[change.kind] ?? 0) + 1
  }
  return counts
}

/**
 * @param change - a change other than a component switch.
 * @param plugin - the plugin it belongs to.
 * @param t - translation.
 * @returns the detail line under the plugin.
 */
export function changeLine(change: ChangeLike, plugin: PluginChangesLike, t: Translate): string {
  switch (change.kind) {
    case 'rename': return t('change.rename', { from: change.replaces ?? '', fromVersion: change.from ?? '', to: change.name, toVersion: change.to ?? '' })
    case 'install':
      if (plugin.snapshotSource === 'packed' && plugin.commit !== undefined) return t('change.installRepository', { version: change.to ?? '', commit: plugin.commit.slice(0, 7) })
      return t('change.install', { version: change.to ?? '', source: t(`source.${plugin.snapshotSource ?? 'npm'}`) })
    case 'upgrade':
    case 'downgrade': return t('change.version', { from: change.from ?? '', to: change.to ?? '' })
    case 'remove': return t('change.remove')
    case 'enable': return t('change.enable')
    case 'disable': return t('change.disable')
    case 'exemption': return t('change.exemption', { version: plugin.snapshotVersion ?? '', dsh: change.to ?? '' })
    default: return ''
  }
}

/**
 * @param change - a component switch.
 * @param t - translation.
 * @param resolve - current-language resolver.
 * @returns e.g. "task-board：停用 → 启用".
 */
export function componentLine(change: ChangeLike, t: Translate, resolve: ResolveText): string {
  const name = change.title === undefined ? change.name : resolve(change.title) || change.name
  return t('change.component', { name, from: t(`component.${change.from ?? 'default'}`), to: t(`component.${change.to ?? 'default'}`) })
}

/**
 * @param summary - applied change counts by kind.
 * @param t - translation.
 * @returns e.g. "安装 1 · 组件 3", or the empty-result text.
 */
export function summaryText(summary: Record<string, number> | undefined, t: Translate): string {
  const parts = KINDS.filter(kind => (summary?.[kind] ?? 0) > 0).map(kind => t(`count.${kind}`, { count: summary![kind]! }))
  return parts.length > 0 ? parts.join(' · ') : t('result.nothing')
}

/**
 * @param iso - ISO timestamp.
 * @returns local date and time without seconds, or the input when it does not parse.
 */
export function formatTime(iso: string | undefined): string {
  if (iso === undefined) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * @param bytes - a file size.
 * @returns the size in B, KB or MB.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Mirrors the host's address rules so the form can mark a bad address before saving.
 * @param input - the remote address field.
 * @returns whether the host would accept it; empty means not configured and is accepted.
 */
export function repositoryInputValid(input: string): boolean {
  if (/[\x00-\x1f\x7f]/.test(input)) return false
  const value = input.trim()
  if (value === '') return true
  if (value.startsWith('-')) return false
  const scp = /^([^/@\s]+)@(\[[^\]\s]+\]|[^:/\s\[\]]+):\S+$/.exec(value)
  if (scp !== null) {
    return !scp[1]!.includes(':') && !scp[1]!.replace(/^\[|\]$/g, '').startsWith('-')
      && !/^(?:%5b)?(?:-|%2d)/i.test(scp[2]!.replace(/^\[|\]$/g, ''))
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    try {
      const url = new URL(value)
      if ([url.hostname, url.username].some(part => decodeURIComponent(part).replace(/^\[|\]$/g, '').startsWith('-'))) return false
      if (url.password !== '') return false
      if (url.protocol === 'https:') return url.username === ''
      return url.protocol === 'ssh:'
    } catch {
      // An address URL cannot parse is one the host refuses too.
      return false
    }
  }
  return value.startsWith('/') || value.startsWith('~/')
}

/**
 * @param file - the chosen zip.
 * @returns its bytes as base64 for the JSON upload.
 */
export async function fileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) text += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32768, bytes.length)))
  return btoa(text)
}
