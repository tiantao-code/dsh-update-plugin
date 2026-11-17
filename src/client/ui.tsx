import { useSyncExternalStore, type ReactNode } from 'react'
import { store } from './singleton.js'
import type { LocaleKey } from './locales.js'

export function useStore() {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function useT() {
  return store.t
}

export function Button(props: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  kind?: 'primary' | 'danger' | 'link'
  title?: string
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={props.type ?? 'button'}
      className="dshu-btn"
      data-kind={props.kind}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  )
}

export function Badge(props: { children: ReactNode; tone?: 'ok' | 'bad' | 'warn' }) {
  return (
    <span className="dshu-badge" data-tone={props.tone}>
      {props.children}
    </span>
  )
}

export function Card(props: { children: ReactNode; className?: string }) {
  return <section className={`dshu-card${props.className ? ` ${props.className}` : ''}`}>{props.children}</section>
}

export function KV(props: { label: string; children: ReactNode }) {
  return (
    <div className="dshu-kv">
      <span className="dshu-k">{props.label}</span>
      <span className="dshu-v">{props.children}</span>
    </div>
  )
}

export function ErrorLine(props: { message: string | null }) {
  if (!props.message) return null
  return <div className="dshu-error">{props.message}</div>
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function formatTime(iso: string | number | undefined): string {
  if (iso === undefined) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString()
}

export function t(key: LocaleKey): string {
  return store.t(key)
}
