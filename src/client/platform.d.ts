declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react'
  export const Button: ComponentType<{
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>>
  export const Checkbox: ComponentType<{
    checked: boolean
    onChange: (checked: boolean) => void
    label: ReactNode
    disabled?: boolean
    title?: string | undefined
    className?: string | undefined
  }>
  export const SegmentedTabs: ComponentType<{
    items: { value: string; label: ReactNode; id: string; panelId: string }[]
    value: string
    onChange: (value: string) => void
    label: string
    className?: string | undefined
  }>
  export const SegmentedControl: ComponentType<{
    id: string
    value: string
    options: { value: string; label: ReactNode; disabled?: boolean; title?: string | undefined }[]
    onChange: (value: string) => void
    label: string
    disabled?: boolean
    className?: string | undefined
  }>
  export const SettingsForm: ComponentType<{
    labels: { unavailable: string; readOnly: string; saveFailed: string; saving: string; save: string }
    state: { available: boolean; writable: boolean; dirty: boolean; invalid: boolean; saving: boolean; failed: boolean }
    onSave: () => void
    onDiscard: () => void
    children?: ReactNode
  }>
  export const SettingsValueField: ComponentType<{
    id: string
    label: string
    hint?: string | undefined
    text: string
    placeholder?: string | undefined
    invalid?: boolean
    invalidLabel?: string
    disabled?: boolean
    overridden?: boolean
    overriddenLabel?: string
    resetLabel?: string
    onReset?: () => void
    onEdit: (text: string) => void
  }>
  export const PathLabel: ComponentType<{ path: string; className?: string | undefined }>
  export const Tag: ComponentType<{
    tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
    className?: string | undefined
    children?: ReactNode
  }>
  export const StateDot: ComponentType<{ state: 'done' | 'warning' | 'ongoing' | 'error' | 'idle'; size?: number | undefined; className?: string | undefined }>
  export const RiskConfirmation: ComponentType<{
    open: boolean
    title: string
    description: string
    acknowledgeLabel: string
    cancelLabel: string
    closeLabel: string
    confirmLabel: string
    acknowledged: boolean
    disabled?: boolean
    onAcknowledgedChange: (acknowledged: boolean) => void
    onCancel: () => void
    onConfirm: () => void
  }>
  export const PluginArtworkDefault: ComponentType<{ size?: number }>
  export const IconChevronRightOutlineRegular: ComponentType<{ size?: number }>
  export const IconChevronDownOutlineRegular: ComponentType<{ size?: number }>
  export const IconDownloadOutlineRegular: ComponentType<{ size?: number }>
}
