import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Checkbox,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconDownloadOutlineRegular,
  PathLabel,
  PluginArtworkDefault,
  RiskConfirmation,
  SegmentedControl,
  SegmentedTabs,
  SettingsForm,
  SettingsValueField,
  StateDot,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { en, NS, zh } from './locale.js'
import {
  changeLine,
  componentLine,
  countsByKind,
  defaultSelection,
  descriptionOf,
  fallbackResolver,
  fileBase64,
  formatSize,
  formatTime,
  interpolating,
  kindsOf,
  repositoryInputValid,
  selectedChangeIds,
  summaryText,
  titleOf,
  type LocalizedText,
  type PluginChangesLike,
  type PluginLike,
  type ResolveText,
  type Translate,
} from './model.js'

type Tab = 'import' | 'export' | 'settings'
type Location = 'zip' | 'git'

interface Preferences {
  format: 'dsh-plugin-sync/preferences-2'
  machineName?: string
  repository: string
  exportTarget: Location
  exportExcluded: string[]
}

interface LocalPlugin extends PluginLike {
  enabled: boolean
  installed: boolean
  version?: string
  source?: 'link' | 'file' | 'github' | 'tarball' | 'npm'
  commit?: string
  dirty?: boolean
  exported: boolean
  exempted: boolean
  error?: string
}

interface Machine {
  id: string
  name: string
  createdAt: string
  commit: string
  self: boolean
}

interface RepositoryState {
  configured: boolean
  kind?: 'url' | 'path'
  fetchedAt?: string
  machines?: Machine[] | null
  error?: string
}

interface LastApply {
  success: boolean
  finishedAt?: string
  source?: { machine: string; createdAt: string }
  summary?: Record<string, number>
  steps?: { name: string; status: string }[]
  backupDir?: string
  logPath?: string
  error?: string
  rollbackError?: string
  appendedRows?: string[]
  warnings?: string[]
  acknowledged?: boolean
}

interface ExportRecord {
  exportedAt: string
  target: Location
  pluginCount: number
  filename?: string
  size?: number
  downloadId?: string
  downloadable?: boolean
  commit?: string
  pushed?: boolean
  pushError?: string
  unpushed?: number
}

interface SyncState {
  desktopVersion: string
  temporaryHome: boolean
  machineId: string
  machineName: string
  defaultMachineName: string
  preferences: Preferences
  plugins: LocalPlugin[]
  lastApply: LastApply | null
  lastExport: ExportRecord | null
  applying: boolean
  repository: RepositoryState
  paths: { data: string; backups: string }
  keep: number
}

interface UnchangedPlugin extends PluginLike {
  reason: 'same' | 'local-only' | 'not-exported'
  localVersion?: string
}

interface Preview {
  previewId: string
  source: { machine: string; machineId: string; createdAt: string; desktopVersion: string; exporterVersion: string }
  plugins: PluginChangesLike[]
  unchanged: UnchangedPlugin[]
  warnings: string[]
}

interface ClientContextLike {
  locale: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
    resolveText?: (text: LocalizedText) => string
  }
  slots: {
    inject(name: string, install: () => unknown): void
    register(entry: { name: string; key: string; locale: string }, component: (props: { t: Translate; view: string }) => ReactNode): () => void
  }
  effect(setup: () => (() => void), label?: string): unknown
}

const styles = `
.dps-page{display:flex;flex-direction:column;gap:20px;min-width:0;max-width:100%;color:var(--dsw-alias-label-primary)}
.dps-tabs{width:336px;max-width:100%}
.dps-segment{align-self:flex-start;width:fit-content;min-width:200px}
.dps-panel{display:flex;flex-direction:column;gap:24px;min-width:0}
.dps-panel[hidden]{display:none}
.dps-section{display:flex;flex-direction:column;gap:10px;min-width:0}
.dps-section-head{display:flex;align-items:center;gap:12px;min-width:0;min-height:32px}
.dps-section-title{margin:0;font-size:14px;font-weight:500;line-height:22px}
.dps-count{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400}
.dps-spacer{flex:1}
.dps-group-label{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dps-rows{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.dps-row{display:flex;align-items:flex-start;gap:12px;min-width:0;padding:10px 2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dps-row:last-child{border-bottom:0}
.dps-row[data-off=true] .dps-row-title,.dps-row[data-off=true] .dps-row-text,.dps-row[data-off=true] .dps-icon{opacity:.45}
.dps-check{display:flex;flex:1;align-items:flex-start;gap:10px;min-width:0;cursor:pointer}
.dps-check input{margin-top:12px;flex:none;accent-color:var(--dsw-alias-state-business-primary)}
.dps-check>span{display:flex;flex:1;gap:12px;min-width:0}
.dps-icon{display:flex;flex:none;align-items:center;justify-content:center;width:40px;height:40px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-secondary)}
.dps-icon img{width:30px;height:30px;object-fit:contain}
.dps-row-main{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.dps-row-title{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;font-size:13.5px;font-weight:500;line-height:20px;overflow-wrap:anywhere}
.dps-row-text{display:block;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dps-row-description{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dps-row-side{display:flex;flex:none;align-items:center;gap:8px;padding-top:6px}
.dps-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px}
.dps-hint,.dps-warning,.dps-error{margin:0;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dps-hint{color:var(--dsw-alias-label-tertiary)}
.dps-warning{color:var(--dsw-alias-state-warn-primary)}
.dps-error{color:var(--dsw-alias-state-error-primary)}
.dps-status{display:flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;overflow-wrap:anywhere}
.dps-toggle{display:inline-flex;align-items:center;gap:6px;width:fit-content;padding:4px 2px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
.dps-toggle:hover{color:var(--dsw-alias-label-primary)}
.dps-details{display:flex;flex-direction:column;gap:2px;margin:4px 0 0;padding:0;list-style:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dps-banner{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2)}
.dps-banner-line{display:flex;align-items:center;gap:10px;min-width:0}
.dps-banner-title{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:20px;overflow-wrap:anywhere}
.dps-facts{margin:0}
.dps-facts>div{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:44px;padding:8px 2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dps-facts dt{flex:none;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dps-facts dd{min-width:0;margin:0;font-size:13px;line-height:20px;text-align:end;overflow-wrap:anywhere}
.dps-form-sections{display:flex;flex-direction:column;gap:28px}
@media(max-width:520px){.dps-facts>div{flex-direction:column;align-items:flex-start}.dps-facts dd{text-align:start}.dps-section-head{flex-wrap:wrap}}
`

async function api(path: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const response = await fetch(path, init === undefined
    ? { headers: { accept: 'application/json' }, cache: 'no-store' }
    : { method: init.method ?? 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(init.body ?? {}) })
  let value: any
  try {
    value = await response.json()
  } catch {
    // A response without a JSON body only has its status to report.
    value = undefined
  }
  if (!response.ok) throw new Error(value?.error?.message ?? `HTTP ${response.status}`)
  return value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContextLike): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-sync: dictionaries')
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-plugin-sync'
    tag.textContent = styles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-plugin-sync: styles')
  const fallback = fallbackResolver(document.documentElement.lang || navigator.language || 'en')
  const resolve: ResolveText = text => typeof ctx.locale.resolveText === 'function' ? ctx.locale.resolveText(text) : fallback(text)
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@miint-sunny/dsh-plugin-sync',
    locale: NS,
  }, ({ t, view }) => view === 'summary' ? t('summary') : <SyncPage t={t} resolve={resolve} />))
}

/** The plugin artwork, or the generic plugin icon when the plugin ships none. */
function PluginIcon({ src }: { src?: string | undefined }): ReactNode {
  const [failed, setFailed] = useState(false)
  return <span className="dps-icon" aria-hidden="true">
    {src !== undefined && !failed ? <img src={src} alt="" width={30} height={30} onError={() => { setFailed(true) }} /> : <PluginArtworkDefault size={30} />}
  </span>
}

/** One plugin: icon, title, tags, description and further lines; with `checked`, the whole row is the checkbox label. */
function PluginRow(props: {
  plugin: PluginLike
  resolve: ResolveText
  tags?: ReactNode
  lines?: ReactNode
  side?: ReactNode
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  off?: boolean
}): ReactNode {
  const { plugin, resolve } = props
  const title = titleOf(plugin, resolve)
  const description = descriptionOf(plugin, resolve)
  const content = <>
    <PluginIcon src={plugin.icon} />
    <span className="dps-row-main">
      <span className="dps-row-title">{title}{props.tags}</span>
      {title !== plugin.name && <span className="dps-row-text dps-mono">{plugin.name}</span>}
      {description !== undefined && <span className="dps-row-text dps-row-description" title={description}>{description}</span>}
      {props.lines}
    </span>
  </>
  return <li className="dps-row" data-off={props.off === true}>
    {props.onCheckedChange === undefined
      ? <span className="dps-check" style={{ cursor: 'default' }}><span>{content}</span></span>
      : <Checkbox className="dps-check" checked={props.checked === true} onChange={props.onCheckedChange} label={content} />}
    {props.side !== undefined && <span className="dps-row-side">{props.side}</span>}
  </li>
}

function PluginGroups<T extends PluginLike>({ plugins, t, render }: { plugins: T[]; t: Translate; render: (plugin: T) => ReactNode }): ReactNode {
  return <>
    {(['third-party', 'official'] as const).map(group => {
      const items = plugins.filter(plugin => plugin.group === group)
      if (items.length === 0) return null
      return <div key={group}>
        <p className="dps-group-label">{t(`group.${group}`)}</p>
        <ul className="dps-rows">{items.map(render)}</ul>
      </div>
    })}
  </>
}

/** The plugin's page: import, export and settings, laid out like the official plugin pages. */
export function SyncPage({ t: translate, resolve }: { t: Translate; resolve: ResolveText }): ReactNode {
  const t = interpolating(translate)
  const id = useId()
  const [tab, setTab] = useState<Tab>('import')
  const [state, setState] = useState<SyncState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const refresh = async (): Promise<void> => {
    try {
      setState(await api('/dsh-plugin-sync/state'))
      setLoadError(null)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }
  useEffect(() => { void refresh() }, [])
  if (state === null) return <p className={loadError === null ? 'dps-hint' : 'dps-error'}>{loadError === null ? t('loading') : t('error.load', { message: loadError })}</p>
  const tabs: Tab[] = ['import', 'export', 'settings']
  return <div className="dps-page">
    <ResultBanner state={state} t={t} refresh={refresh} />
    {loadError !== null && <p className="dps-error">{t('error.load', { message: loadError })}</p>}
    <SegmentedTabs
      className="dps-tabs"
      label={t('tabs.label')}
      value={tab}
      onChange={value => { setTab(value as Tab) }}
      items={tabs.map(value => ({ value, label: t(`tab.${value}`), id: `${id}-${value}`, panelId: `${id}-${value}-panel` }))}
    />
    {tabs.map(value => <div key={value} className="dps-panel" role="tabpanel" id={`${id}-${value}-panel`} aria-labelledby={`${id}-${value}`} hidden={tab !== value}>
      {value === 'import' && <ImportTab state={state} t={t} resolve={resolve} refresh={refresh} openSettings={() => { setTab('settings') }} />}
      {value === 'export' && <ExportTab state={state} t={t} resolve={resolve} refresh={refresh} openSettings={() => { setTab('settings') }} />}
      {value === 'settings' && <SettingsTab state={state} t={t} refresh={refresh} />}
    </div>)}
  </div>
}

/** The result of the last import, shown above the tabs until dismissed, or a leftover apply lock. */
function ResultBanner({ state, t, refresh }: { state: SyncState; t: Translate; refresh: () => Promise<void> }): ReactNode {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (state.applying) {
    return <section className="dps-banner">
      <div className="dps-banner-line">
        <StateDot state="warning" />
        <span className="dps-banner-title">{t('banner.locked')}</span>
        <Button size="sm" variant="outline" onClick={() => { setConfirm(true) }}>{t('banner.clearLock')}</Button>
      </div>
      {error !== null && <p className="dps-error">{error}</p>}
      <RiskConfirmation
        open={confirm}
        title={t('lock.title')}
        description={t('lock.description')}
        acknowledgeLabel={t('lock.acknowledge')}
        cancelLabel={t('confirm.cancel')}
        closeLabel={t('confirm.close')}
        confirmLabel={t('lock.confirm')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setConfirm(false); setAcknowledged(false) }}
        onConfirm={() => {
          setConfirm(false)
          setAcknowledged(false)
          void api('/dsh-plugin-sync/apply-lock/clear', { body: { confirm: true } }).then(result => {
            setError(result?.cleared === false ? t('lock.gone') : null)
            return refresh()
          }, error => { setError(messageOf(error)) })
        }}
      />
    </section>
  }
  const last = state.lastApply
  if (last === null || last.acknowledged === true) return null
  const time = formatTime(last.finishedAt)
  const warnings = last.warnings ?? []
  const title = !last.success
    ? t(last.rollbackError === undefined ? 'banner.failure' : 'banner.rollbackFailed', { time })
    : warnings.length > 0
      ? t('banner.warnings', { time, count: warnings.length, machine: last.source?.machine ?? '' })
      : t('banner.success', { time, machine: last.source?.machine ?? '' })
  return <section className="dps-banner">
    <div className="dps-banner-line">
      <StateDot state={!last.success ? 'error' : warnings.length > 0 ? 'warning' : 'done'} />
      <span className="dps-banner-title">{title}</span>
      <Button size="sm" variant="ghost" onClick={() => { setOpen(value => !value) }}>{open ? t('banner.hide') : t('banner.details')}</Button>
      <Button size="sm" variant="ghost" onClick={() => { void api('/dsh-plugin-sync/last-apply/acknowledge', { body: {} }).then(refresh, error => { setError(messageOf(error)) }) }}>{t('banner.dismiss')}</Button>
    </div>
    <p className="dps-hint">{last.success ? summaryText(last.summary, t) : last.error}</p>
    {error !== null && <p className="dps-error">{error}</p>}
    {open && <ul className="dps-details">
      {(last.steps ?? []).map((step, index) => <li key={`${step.name}-${index}`}>{t(`step.${step.status === 'passed' ? 'passed' : 'failed'}`, { name: step.name })}</li>)}
      {warnings.map(warning => <li className="dps-warning" key={warning}>{warning}</li>)}
      {last.rollbackError !== undefined && <li className="dps-error">{last.rollbackError}</li>}
      {(last.appendedRows ?? []).length > 0 && <li>{t('banner.appended', { ids: last.appendedRows!.join('、') })}</li>}
      {last.backupDir !== undefined && <li>{t('banner.backup')} <span className="dps-mono">{last.backupDir}</span></li>}
      {last.logPath !== undefined && <li>{t('banner.log')} <span className="dps-mono">{last.logPath}</span></li>}
    </ul>}
  </section>
}

/** The line that explains the disabled Git option and opens Settings. */
function GitHelp({ t, openSettings }: { t: Translate; openSettings: () => void }): ReactNode {
  return <p className="dps-hint">{t('location.gitHelp')} <button type="button" className="dps-toggle" onClick={openSettings}>{t('location.openSettings')}</button></p>
}

function ImportTab({ state, t, resolve, refresh, openSettings }: { state: SyncState; t: Translate; resolve: ResolveText; refresh: () => Promise<void>; openSettings: () => void }): ReactNode {
  const id = useId()
  const configured = state.repository.configured
  const [location, setLocation] = useState<Location>(configured ? 'git' : 'zip')
  const [file, setFile] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [machines, setMachines] = useState<Machine[] | null>(state.repository.machines ?? null)
  const [fetchedAt, setFetchedAt] = useState<string | undefined>(state.repository.fetchedAt)
  const [machine, setMachine] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showUnchanged, setShowUnchanged] = useState(false)
  const [busy, setBusy] = useState<'fetch' | 'compare' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const compare = async (source: unknown): Promise<void> => {
    setBusy('compare')
    setError(null)
    setNotice(null)
    setPreview(null)
    try {
      const value = await api('/dsh-plugin-sync/preview', { body: { source } }) as Preview
      setPreview(value)
      setSelected(defaultSelection(value.plugins))
      setExpanded(new Set())
      setShowUnchanged(false)
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }
  const others = (machines ?? []).filter(entry => !entry.self)
  useEffect(() => {
    setMachines(state.repository.machines ?? null)
    setFetchedAt(state.repository.fetchedAt)
  }, [state.repository])
  const repositoryKey = `${state.preferences.repository}\n${String(state.repository.configured)}`
  const firstKey = useRef(repositoryKey)
  useEffect(() => {
    if (firstKey.current === repositoryKey) return
    firstKey.current = repositoryKey
    setLocation(state.repository.configured ? 'git' : 'zip')
    setMachine(null)
    setPreview(null)
    setError(null)
  }, [repositoryKey])
  useEffect(() => {
    if (location !== 'git' || machine !== null || busy !== null || others.length === 0) return
    setMachine(others[0]!.id)
    void compare({ kind: 'git', machine: others[0]!.id })
  }, [location, machines])

  const fetchRepository = async (): Promise<void> => {
    setBusy('fetch')
    setError(null)
    try {
      const value = await api('/dsh-plugin-sync/git-machines', { body: { fetch: true } })
      setMachines(value.machines)
      setFetchedAt(value.fetchedAt)
      setBusy(null)
      const next = (value.machines as Machine[]).filter(entry => !entry.self)
      const chosen = next.find(entry => entry.id === machine) ?? next[0]
      if (chosen !== undefined) {
        setMachine(chosen.id)
        await compare({ kind: 'git', machine: chosen.id })
      }
    } catch (error) {
      setError(messageOf(error))
      setBusy(null)
    }
  }
  const chooseFile = async (next: File | null): Promise<void> => {
    setFile(next)
    if (next !== null) await compare({ kind: 'zip', base64: await fileBase64(next) })
  }
  const switchLocation = (next: Location): void => {
    setLocation(next)
    setPreview(null)
    setError(null)
    setNotice(null)
    if (next === 'git' && machine !== null) void compare({ kind: 'git', machine })
    if (next === 'zip' && file !== null) void chooseFile(file)
  }

  const plugins = preview?.plugins ?? []
  const counts = countsByKind(plugins, selected)
  const changeCount = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const chosen = plugins.filter(plugin => selected.has(plugin.name))
  const names = (kind: string) => chosen.filter(plugin => kindsOf(plugin).includes(kind)).map(plugin => titleOf(plugin, resolve))
  const permissions = [...new Set(chosen.flatMap(plugin => plugin.newBuildPermissions))]
  const applyNow = async (): Promise<void> => {
    if (preview === null) return
    setBusy('apply')
    setError(null)
    try {
      const value = await api('/dsh-plugin-sync/apply', {
        body: { previewId: preview.previewId, selected: selectedChangeIds(plugins, selected), acceptRisk: (counts.exemption ?? 0) > 0, noApp: state.temporaryHome },
      })
      setPreview(null)
      setNotice(state.temporaryHome ? t('import.rehearsal', { pid: value.pid }) : t('import.started'))
      await refresh()
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }
  const confirmDescription = [
    state.temporaryHome ? t('confirm.rehearsal') : t('confirm.description'),
    t('confirm.counts', { summary: summaryText(counts, t) }),
    ...(names('downgrade').length > 0 ? [t('confirm.downgrade', { names: names('downgrade').join('、') })] : []),
    ...(names('exemption').length > 0 ? [t('confirm.exemption', { names: names('exemption').join('、') })] : []),
    ...(permissions.length > 0 ? [t('confirm.permissions', { names: permissions.join('、') })] : []),
  ].join(' ')

  const sameVersion = preview !== null && preview.source.desktopVersion === state.desktopVersion
  return <>
    <section className="dps-section">
      <div className="dps-section-head">
        <h3 className="dps-section-title">{t('import.source')}</h3>
      </div>
      <SegmentedControl
        className="dps-segment"
        id={`${id}-location`}
        label={t('import.source')}
        value={location}
        onChange={value => { switchLocation(value as Location) }}
        options={[
          { value: 'zip', label: t('location.zip') },
          { value: 'git', label: t('location.git'), disabled: !configured },
        ]}
      />
      {!configured && <GitHelp t={t} openSettings={openSettings} />}
      {location === 'zip' && <div className="dps-status">
        <input ref={fileInput} type="file" accept=".zip,application/zip" hidden onChange={event => { void chooseFile(event.currentTarget.files?.[0] ?? null); event.currentTarget.value = '' }} />
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => fileInput.current?.click()}>{t('import.chooseFile')}</Button>
        <span className="dps-mono">{file?.name ?? t('import.noFile')}</span>
      </div>}
      {location === 'git' && <>
        <div className="dps-status">
          <span className="dps-spacer">{state.repository.error !== undefined ? <span className="dps-error">{state.repository.error}</span> : fetchedAt !== undefined ? t('import.fetchedAt', { time: formatTime(fetchedAt) }) : state.repository.kind === 'path' ? t('import.localRepository') : t('import.neverFetched')}</span>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void fetchRepository() }}>{busy === 'fetch' ? t('import.fetching') : state.repository.kind === 'path' ? t('import.refresh') : t('import.fetch')}</Button>
        </div>
        {machines !== null && <ul className="dps-rows">
          {machines.length === 0 || others.length === 0 ? <li className="dps-row"><span className="dps-hint">{t('import.noMachines')}</span></li> : null}
          {machines.map(entry => <li key={entry.id} className="dps-row" data-off={entry.self}>
            <label className="dps-check" style={entry.self ? { cursor: 'default' } : undefined}>
              <input type="radio" name={`${id}-machine`} checked={machine === entry.id} disabled={entry.self || busy !== null} onChange={() => { setMachine(entry.id); void compare({ kind: 'git', machine: entry.id }) }} />
              <span className="dps-row-main">
                <span className="dps-row-title">{entry.name}{entry.self && <Tag tone="neutral">{t('import.thisMac')}</Tag>}</span>
                <span className="dps-row-text">{t('import.machineMeta', { time: formatTime(entry.createdAt), commit: entry.commit.slice(0, 7) })}</span>
              </span>
            </label>
          </li>)}
        </ul>}
      </>}
    </section>

    {busy === 'compare' && <p className="dps-hint">{t('import.comparing')}</p>}
    {error !== null && <p className="dps-error">{error}</p>}
    {notice !== null && <div className="dps-status"><StateDot state="ongoing" /><span>{notice}</span></div>}

    {preview !== null && <>
      <section className="dps-section">
        <div className="dps-section-head"><h3 className="dps-section-title">{t('import.snapshot')}</h3></div>
        <div className="dps-status">
          <span>{t('import.snapshotLine', { machine: preview.source.machine, time: formatTime(preview.source.createdAt), version: preview.source.desktopVersion })}</span>
          <StateDot state={sameVersion ? 'done' : 'warning'} />
          <span>{sameVersion ? t('import.sameVersion') : t('import.newerHere')}</span>
        </div>
        {preview.warnings.map(warning => <p key={warning} className="dps-warning">{warning}</p>)}
      </section>

      <section className="dps-section">
        <div className="dps-section-head">
          <h3 className="dps-section-title">{t('import.changes')}</h3>
          {plugins.length > 0 && <span className="dps-count">{t('common.selected', { selected: selected.size, total: plugins.length })}</span>}
          <span className="dps-spacer" />
          {plugins.length > 0 && <Button variant="primary" size="sm" disabled={changeCount === 0 || busy !== null || state.applying} title={state.applying ? t('import.lockedHint') : undefined} onClick={() => { setAcknowledged(false); setConfirmOpen(true) }}>
            {changeCount === 0 ? t('import.applyNone') : t('import.apply', { count: changeCount })}
          </Button>}
        </div>
        {plugins.length === 0 && <p className="dps-hint">{t('import.noChanges')}</p>}
        <PluginGroups plugins={plugins} t={t} render={plugin => {
          const components = plugin.changes.filter(change => change.kind === 'row')
          const listed = plugin.changes.filter(change => change.kind !== 'row')
          const open = expanded.has(plugin.name)
          return <PluginRow
            key={plugin.name}
            plugin={plugin}
            resolve={resolve}
            checked={selected.has(plugin.name)}
            off={!selected.has(plugin.name)}
            onCheckedChange={checked => { setSelected(current => { const next = new Set(current); if (checked) next.add(plugin.name); else next.delete(plugin.name); return next }) }}
            tags={<>
              {plugin.experimental && <Tag tone="info">{t('plugin.experimental')}</Tag>}
              {kindsOf(plugin).map(kind => <Tag key={kind} tone={kind === 'downgrade' ? 'warning' : kind === 'exemption' || kind === 'remove' ? 'danger' : 'neutral'}>{t(`kind.${kind}`)}</Tag>)}
            </>}
            lines={<>
              {listed.map(change => <span key={change.id} className="dps-row-text">{changeLine(change, plugin, t)}</span>)}
              {components.length > 0 && <span className="dps-row-text">
                {t('change.components', { count: components.length })}
                <button type="button" className="dps-toggle" onClick={event => { event.preventDefault(); setExpanded(current => { const next = new Set(current); if (open) next.delete(plugin.name); else next.add(plugin.name); return next }) }}>
                  {open ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}{open ? t('common.collapse') : t('common.expand')}
                </button>
              </span>}
              {open && components.map(change => <span key={change.id} className="dps-row-text">{componentLine(change, t, resolve)}</span>)}
              {plugin.newBuildPermissions.length > 0 && <span className="dps-row-text dps-warning">{t('change.permissions', { names: plugin.newBuildPermissions.join('、') })}</span>}
            </>}
          />
        }} />
        {preview.unchanged.length > 0 && <>
          <button type="button" className="dps-toggle" onClick={() => { setShowUnchanged(value => !value) }}>
            {showUnchanged ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
            {t('import.unchanged', { count: preview.unchanged.length })}
          </button>
          {showUnchanged && <PluginGroups plugins={preview.unchanged} t={t} render={plugin => <PluginRow
            key={plugin.name}
            plugin={plugin}
            resolve={resolve}
            off
            lines={<span className="dps-row-text">{t(`reason.${plugin.reason}`, { version: plugin.localVersion ?? '' })}</span>}
          />} />}
        </>}
      </section>
    </>}

    <RiskConfirmation
      open={confirmOpen}
      title={t('confirm.title', { count: changeCount })}
      description={confirmDescription}
      acknowledgeLabel={t('confirm.acknowledge')}
      cancelLabel={t('confirm.cancel')}
      closeLabel={t('confirm.close')}
      confirmLabel={state.temporaryHome ? t('confirm.confirmRehearsal') : t('confirm.confirm')}
      acknowledged={acknowledged}
      disabled={busy !== null}
      onAcknowledgedChange={setAcknowledged}
      onCancel={() => { setConfirmOpen(false) }}
      onConfirm={() => { setConfirmOpen(false); void applyNow() }}
    />
  </>
}

function ExportTab({ state, t, resolve, refresh, openSettings }: { state: SyncState; t: Translate; resolve: ResolveText; refresh: () => Promise<void>; openSettings: () => void }): ReactNode {
  const id = useId()
  const configured = state.repository.configured
  const [target, setTarget] = useState<Location>(state.preferences.exportTarget === 'git' && configured ? 'git' : 'zip')
  const [excluded, setExcluded] = useState<Set<string>>(new Set(state.preferences.exportExcluded))
  const [busy, setBusy] = useState<'export' | 'push' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [record, setRecord] = useState<ExportRecord | null>(state.lastExport)
  const [fresh, setFresh] = useState(false)
  useEffect(() => { if (!configured) setTarget('zip') }, [configured])

  const save = async (patch: Record<string, unknown>, undo: () => void): Promise<void> => {
    try {
      await api('/dsh-plugin-sync/preferences', { method: 'PATCH', body: patch })
      setError(null)
    } catch (error) {
      undo()
      setError(t('export.saveFailed', { message: messageOf(error) }))
    }
  }
  const toggle = (name: string, exported: boolean): void => {
    const before = new Set(excluded)
    const next = new Set(excluded)
    if (exported) next.delete(name)
    else next.add(name)
    setExcluded(next)
    void save({ exportExcluded: [...next].sort() }, () => { setExcluded(before) })
  }
  const exportNow = async (): Promise<void> => {
    setBusy('export')
    setError(null)
    try {
      setRecord(await api('/dsh-plugin-sync/export', { body: { target } }))
      setFresh(true)
      await refresh()
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }
  const pushNow = async (): Promise<void> => {
    setBusy('push')
    setError(null)
    try {
      const value = await api('/dsh-plugin-sync/push', { body: {} })
      setRecord(current => {
        if (current === null) return current
        const { pushError: _resolved, ...rest } = current
        return { ...rest, pushed: true, unpushed: value.unpushed }
      })
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }
  const count = state.plugins.filter(plugin => !excluded.has(plugin.name)).length
  const dirty = state.plugins.filter(plugin => plugin.dirty === true && !excluded.has(plugin.name))
  const downloadable = record?.downloadId !== undefined && (fresh || record.downloadable === true)
  return <>
    <section className="dps-section">
      <div className="dps-section-head">
        <h3 className="dps-section-title">{t('export.location')}</h3>
      </div>
      <div className="dps-section-head">
        <SegmentedControl
          className="dps-segment"
          id={`${id}-target`}
          label={t('export.location')}
          value={target}
          onChange={value => {
            const next = value as Location
            const before = target
            setTarget(next)
            void save({ exportTarget: next }, () => { setTarget(before) })
          }}
          options={[
            { value: 'zip', label: t('location.zip') },
            { value: 'git', label: t('location.git'), disabled: !configured },
          ]}
        />
        <span className="dps-spacer" />
        <Button variant="primary" size="sm" disabled={count === 0 || busy !== null} onClick={() => { void exportNow() }}>
          {busy === 'export' ? t('export.running') : count === 0 ? t('export.none') : t('export.action', { count })}
        </Button>
      </div>
      <p className="dps-hint">{target === 'zip' ? t('export.zipHint') : state.repository.kind === 'path' ? t('export.gitPathHint', { id: state.machineId }) : t('export.gitHint', { id: state.machineId })}</p>
      {!configured && <GitHelp t={t} openSettings={openSettings} />}
      {dirty.length > 0 && <p className="dps-warning">{t('export.dirty', { names: dirty.map(plugin => plugin.name).join('、') })}</p>}
      {error !== null && <p className="dps-error">{error}</p>}
      {record !== null && <div className="dps-section" style={{ gap: 6 }}>
        <div className="dps-status">
          <StateDot state={record.target === 'git' && record.pushed === false ? 'warning' : 'done'} />
          <span className="dps-spacer">
            {t(fresh ? 'export.done' : 'export.last', { time: formatTime(record.exportedAt), location: t(`location.${record.target}`), count: record.pluginCount })}
            {record.filename !== undefined && <> · <span className="dps-mono">{record.filename}</span>{record.size !== undefined && ` · ${formatSize(record.size)}`}</>}
            {record.commit !== undefined && <> · {t('export.commit', { commit: record.commit.slice(0, 7) })}</>}
          </span>
          {downloadable && <a className="dps-toggle" href={`/dsh-plugin-sync/download?id=${encodeURIComponent(record.downloadId!)}`} download={record.filename}><IconDownloadOutlineRegular size={12} />{t('export.download')}</a>}
          {record.target === 'git' && record.pushed === false && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void pushNow() }}>{busy === 'push' ? t('export.pushing') : t('export.retryPush')}</Button>}
        </div>
        {record.target === 'zip' && !downloadable && record.downloadId !== undefined && <p className="dps-hint">{t('export.expired')}</p>}
        {record.target === 'git' && record.pushed === true && <p className="dps-hint">{t('export.pushed')}</p>}
        {record.target === 'git' && record.pushed === false && <p className="dps-warning">{t('export.pushFailed', { error: record.pushError ?? '' })}</p>}
        {record.target === 'git' && record.pushed === undefined && <p className="dps-hint">{t('export.localCommit')}</p>}
        {(record.unpushed ?? 0) > 0 && <p className="dps-hint">{t('export.unpushed', { count: record.unpushed! })}</p>}
      </div>}
    </section>

    <section className="dps-section">
      <div className="dps-section-head">
        <h3 className="dps-section-title">{t('export.plugins')}</h3>
        <span className="dps-count">{t('common.selected', { selected: count, total: state.plugins.length })}</span>
      </div>
      <p className="dps-hint">{t('export.pluginsHint')}</p>
      <PluginGroups plugins={state.plugins} t={t} render={plugin => {
        const exported = !excluded.has(plugin.name)
        const meta = plugin.group === 'official' && !plugin.installed
          ? t(plugin.enabled ? 'plugin.enabled' : 'plugin.disabled')
          : [plugin.version, plugin.source !== undefined ? t(`source.${plugin.source}`) : undefined, plugin.commit].filter(Boolean).join(' · ')
        return <PluginRow
          key={plugin.name}
          plugin={plugin}
          resolve={resolve}
          checked={exported}
          off={!exported}
          onCheckedChange={checked => { toggle(plugin.name, checked) }}
          tags={<>
            {plugin.experimental && <Tag tone="info">{t('plugin.experimental')}</Tag>}
            {plugin.exempted && <Tag tone="warning">{t('kind.exemption')}</Tag>}
            {plugin.dirty === true && <Tag tone="warning">{t('plugin.dirty')}</Tag>}
            {plugin.error !== undefined && <Tag tone="danger">{t('plugin.error')}</Tag>}
          </>}
          lines={<span className="dps-row-text">{meta}{!exported && ` · ${t('export.notExported')}`}</span>}
        />
      }} />
    </section>
  </>
}

function SettingsTab({ state, t, refresh }: { state: SyncState; t: Translate; refresh: () => Promise<void> }): ReactNode {
  const saved = { name: state.preferences.machineName ?? '', repository: state.preferences.repository }
  const [name, setName] = useState(saved.name)
  const [repository, setRepository] = useState(saved.repository)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [test, setTest] = useState<{ status: 'running' | 'ok' | 'failed'; text: string } | null>(null)
  const invalid = !repositoryInputValid(repository) || name.length > 100
  const dirty = name.trim() !== saved.name || repository.trim() !== saved.repository
  const saveNow = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      await api('/dsh-plugin-sync/preferences', { method: 'PATCH', body: { machineName: name.trim(), repository: repository.trim() } })
      await refresh()
    } catch (error) {
      setSaveError(messageOf(error))
    } finally {
      setSaving(false)
    }
  }
  const testNow = async (): Promise<void> => {
    if (repository.trim() === '') {
      setTest({ status: 'failed', text: t('settings.testEmpty') })
      return
    }
    setTest({ status: 'running', text: t('settings.testing') })
    try {
      const value = await api('/dsh-plugin-sync/git-test', { body: { repository: repository.trim() } })
      setTest({ status: 'ok', text: value.branch === undefined ? t('settings.testOkEmpty') : t('settings.testOk', { branch: value.branch }) })
    } catch (error) {
      setTest({ status: 'failed', text: t('settings.testFailed', { message: messageOf(error) }) })
    }
  }
  return <>
    <SettingsForm
      labels={{ unavailable: t('form.unavailable'), readOnly: t('form.readOnly'), saveFailed: t('form.saveFailed', { message: saveError ?? '' }), saving: t('form.saving'), save: t('form.save') }}
      state={{ available: true, writable: true, dirty, invalid, saving, failed: saveError !== null }}
      onSave={() => { void saveNow() }}
      onDiscard={() => { setName(saved.name); setRepository(saved.repository) }}
    >
      <div className="dps-form-sections">
      <section className="dps-section">
        <div className="dps-section-head"><h3 className="dps-section-title">{t('settings.thisMac')}</h3></div>
        <SettingsValueField id="dps-machine-name" label={t('settings.name')} hint={t('settings.nameHint')} text={name} placeholder={state.defaultMachineName} invalid={name.length > 100} invalidLabel={t('settings.nameInvalid')} onEdit={setName} />
        <dl className="dps-facts">
          <div><dt>{t('settings.machineId')}</dt><dd className="dps-mono">{state.machineId}</dd></div>
        </dl>
        <p className="dps-hint">{t('settings.machineIdHint')}</p>
      </section>
      <section className="dps-section">
        <div className="dps-section-head"><h3 className="dps-section-title">{t('settings.git')}</h3></div>
        <SettingsValueField id="dps-repository" label={t('settings.repository')} hint={t('settings.repositoryHint')} text={repository} placeholder="git@github.com:owner/repo.git" invalid={!repositoryInputValid(repository)} invalidLabel={t('settings.repositoryInvalid')} onEdit={value => { setRepository(value); setTest(null) }} />
        <div className="dps-status">
          <Button size="sm" variant="outline" disabled={test?.status === 'running' || !repositoryInputValid(repository)} onClick={() => { void testNow() }}>{t('settings.test')}</Button>
          {test !== null && <><StateDot state={test.status === 'running' ? 'ongoing' : test.status === 'ok' ? 'done' : 'error'} /><span>{test.text}</span></>}
        </div>
      </section>
      </div>
    </SettingsForm>
    <section className="dps-section">
      <div className="dps-section-head"><h3 className="dps-section-title">{t('settings.data')}</h3></div>
      <dl className="dps-facts">
        <div><dt>{t('settings.dataDir')}</dt><dd><PathLabel path={state.paths.data} /></dd></div>
        <div><dt>{t('settings.backupDir')}</dt><dd><PathLabel path={state.paths.backups} /></dd></div>
        <div><dt>{t('settings.exports')}</dt><dd>{t('settings.exportsValue', { count: state.keep })}</dd></div>
      </dl>
    </section>
  </>
}
