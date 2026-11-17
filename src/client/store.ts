import { NS, zh, type LocaleKey } from './locales.js'
import type {
  CheckResult,
  CompatibilityReport,
  LogsResult,
  PauseReport,
  SessionWork,
  StartResult,
  UpdatePlan,
  UpdateStatus,
} from '../types.js'

export type WizardStep = 'version' | 'compat' | 'sessions' | 'confirm' | 'run' | 'result'

type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error?: { code?: string; message?: string } }

interface RemoteApi {
  check(request: { force?: boolean }): Promise<RemoteResult<CheckResult>>
  plan(target: string): Promise<RemoteResult<UpdatePlan>>
  pause(request: { sessionIds: string[] }): Promise<RemoteResult<PauseReport>>
  start(request: {
    target: string
    pauseSessionIds: string[]
    acceptRisk: boolean
  }): Promise<RemoteResult<StartResult>>
  status(): Promise<RemoteResult<UpdateStatus>>
  cancel(id: string): Promise<RemoteResult<UpdateStatus>>
  logs(request: { id: string; offset?: number }): Promise<RemoteResult<LogsResult>>
}

export interface ClientSnapshot {
  ready: boolean
  step: WizardStep
  status: UpdateStatus | null
  check: CheckResult | null
  plan: UpdatePlan | null
  target: string
  selectedSessions: ReadonlySet<string>
  acceptRisk: boolean
  showAll: boolean
  busy: string | null
  error: string | null
  log: string
  copied: boolean
  pauseReport: PauseReport | null
}

const ACTIVE = new Set(['checking', 'planning', 'staging', 'staged', 'pausing', 'paused', 'switching'])
const TERMINAL = new Set(['installed', 'done', 'failed', 'rolled-back'])

const initial: ClientSnapshot = {
  ready: false,
  step: 'version',
  status: null,
  check: null,
  plan: null,
  target: '',
  selectedSessions: new Set(),
  acceptRisk: false,
  showAll: false,
  busy: null,
  error: null,
  log: '',
  copied: false,
  pauseReport: null,
}

/**
 * Panel state and transport. The Host exposes plain Remote methods; DSH does not
 * forward third-party Cordis events to the browser, so this controller polls
 * `status()` and appends `logs()` while an update is active.
 */
export class UpdateStore {
  private snapshot: ClientSnapshot = initial
  private listeners = new Set<() => void>()
  private remote: RemoteApi | null = null
  private ctx: any
  private timer: ReturnType<typeof setInterval> | null = null
  private logOffset = 0
  private refreshing = false
  private disposed = false
  private translate: ((key: LocaleKey) => string) | null = null
  private localeDispose: (() => void) | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ClientSnapshot => this.snapshot

  t = (key: LocaleKey): string => this.translate?.(key) ?? zh[key]

  connect(ctx: any, remote: RemoteApi): void {
    this.disposed = false
    this.ctx = ctx
    this.remote = remote
    this.translate = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : null
    if (typeof ctx.locale?.subscribe === 'function') {
      this.localeDispose = ctx.locale.subscribe(() => this.patch({}))
    }
    this.timer ??= setInterval(() => void this.tick(), 2_000)
    void this.init()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.listeners.clear()
    this.localeDispose?.()
    this.localeDispose = null
  }

  private patch(patch: Partial<ClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  private async init(): Promise<void> {
    try {
      await this.refresh()
      if (!this.snapshot.check && !this.snapshot.status?.check) {
        await this.check(false)
      }
    } catch (error) {
      this.patch({ error: messageOf(error) })
    } finally {
      this.patch({ ready: true })
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.refreshing) return
    await this.refresh().catch(() => undefined)
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
      const status = await this.call('status')
      const previous = this.snapshot.status
      const newRun = Boolean(previous && previous.id !== status.id)
      const transition = !previous || newRun || previous.phase !== status.phase
      const active = ACTIVE.has(status.phase) || status.phase === 'installed'
      if (newRun) this.logOffset = 0
      let step = this.snapshot.step
      if (transition) {
        if (TERMINAL.has(status.phase)) step = 'result'
        else if (['staging', 'staged', 'pausing', 'paused', 'switching'].includes(status.phase)) step = 'run'
      }
      this.patch({
        status,
        check: this.snapshot.check ?? status.check ?? null,
        step,
        target: status.target || this.snapshot.target,
        pauseReport: status.pauseReport ?? this.snapshot.pauseReport,
        error: status.error?.message ?? this.snapshot.error,
        ...(newRun ? { log: '' } : {}),
      })
      if (active && status.id) await this.loadLogs(status)
    } finally {
      this.refreshing = false
    }
  }

  private async loadLogs(status: UpdateStatus): Promise<void> {
    if (!status.id) return
    try {
      const chunk = await this.call('logs', { id: status.id, offset: this.logOffset })
      if (chunk.content) {
        this.logOffset = chunk.nextOffset
        this.patch({ log: trimLog(this.snapshot.log + chunk.content) })
      }
    } catch {
      // Logs are diagnostic only; do not surface a transient read failure.
    }
  }

  async check(force: boolean): Promise<void> {
    this.patch({ busy: 'checking', error: null })
    try {
      const result = await this.call('check', { force })
      const selected = defaultTarget(result, this.snapshot.target)
      this.patch({
        check: result,
        target: selected,
        step: 'version',
        error: result.error ?? null,
      })
    } catch (error) {
      this.patch({ error: messageOf(error) })
    } finally {
      this.patch({ busy: null })
    }
  }

  async plan(target = this.snapshot.target): Promise<void> {
    if (!target) return
    this.patch({ busy: 'planning', target, error: null })
    try {
      const plan = await this.call('plan', target)
      this.patch({
        plan,
        step: 'compat',
        selectedSessions: new Set(plan.sessions.map(session => session.sessionId)),
        acceptRisk: false,
        error: null,
      })
    } catch (error) {
      this.patch({ error: messageOf(error) })
    } finally {
      this.patch({ busy: null })
    }
  }

  setTarget(target: string): void {
    this.patch({ target, acceptRisk: false })
  }

  setShowAll(showAll: boolean): void {
    this.patch({ showAll })
  }

  toggleSession(sessionId: string): void {
    const next = new Set(this.snapshot.selectedSessions)
    if (next.has(sessionId)) next.delete(sessionId)
    else next.add(sessionId)
    this.patch({ selectedSessions: next, acceptRisk: false })
  }

  setAllSessions(selected: boolean): void {
    const plan = this.snapshot.plan
    this.patch({
      selectedSessions: new Set(selected ? (plan?.sessions ?? []).map(s => s.sessionId) : []),
      acceptRisk: false,
    })
  }

  setAcceptRisk(acceptRisk: boolean): void {
    this.patch({ acceptRisk })
  }

  go(step: WizardStep): void {
    this.patch({ step, copied: false })
  }

  back(): void {
    const order: WizardStep[] = ['version', 'compat', 'sessions', 'confirm']
    const index = order.indexOf(this.snapshot.step)
    if (index > 0) this.patch({ step: order[index - 1]! })
  }

  async pauseNow(): Promise<void> {
    const ids = [...this.snapshot.selectedSessions]
    if (ids.length === 0) {
      this.patch({ step: 'confirm' })
      return
    }
    this.patch({ busy: 'pausing', error: null })
    try {
      const report = await this.call('pause', { sessionIds: ids })
      this.patch({ pauseReport: report, plan: await this.replan() })
    } catch (error) {
      this.patch({ error: messageOf(error) })
    } finally {
      this.patch({ busy: null })
    }
  }

  async start(acceptRisk = this.snapshot.acceptRisk): Promise<void> {
    const target = this.snapshot.target
    if (!target) return
    const pauseSessionIds = [...this.snapshot.selectedSessions]
    this.patch({ busy: 'starting', error: null, log: '', copied: false })
    this.logOffset = 0
    try {
      await this.call('start', { target, pauseSessionIds, acceptRisk })
      this.patch({ step: 'run', acceptRisk })
      await this.refresh()
    } catch (error) {
      this.patch({ error: messageOf(error) })
    } finally {
      this.patch({ busy: null })
    }
  }

  async resumeWithRisk(): Promise<void> {
    await this.start(true)
  }

  async cancel(): Promise<void> {
    const status = this.snapshot.status
    if (!status?.id) return
    this.patch({ busy: 'cancelling', error: null })
    try {
      const next = await this.call('cancel', status.id)
      this.patch({ status: next, step: 'version' })
    } catch (error) {
      this.patch({ error: messageOf(error) })
    } finally {
      this.patch({ busy: null })
    }
  }

  async copyCommand(): Promise<void> {
    const command = this.snapshot.status?.restartCommand
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      this.patch({ copied: true })
    } catch {
      this.patch({ error: messageOf(new Error('clipboard')) })
    }
  }

  async disableBundle(name: string): Promise<void> {
    const pluginManager = this.ctx?.remote?.pluginManager
    if (!pluginManager?.setBundleEnabled) return
    this.patch({ busy: `disable:${name}`, error: null })
    try {
      const response = await pluginManager.setBundleEnabled(name, false)
      if (!response || response.ok === false) {
        throw new Error(response?.error?.message ?? 'disable failed')
      }
      const change = response.value
      if (change && change.application === 'failed') {
        throw new Error(change.error?.message ?? 'disable failed')
      }
      this.patch({ plan: await this.replan() })
    } catch (error) {
      this.patch({ error: messageOf(error) })
    } finally {
      this.patch({ busy: null })
    }
  }

  private async replan(): Promise<UpdatePlan | null> {
    const target = this.snapshot.target || this.snapshot.plan?.target
    if (!target || !this.remote) return this.snapshot.plan
    try {
      return await this.call('plan', target)
    } catch {
      return this.snapshot.plan
    }
  }

  private async call<K extends keyof RemoteApi>(
    method: K,
    ...args: Parameters<RemoteApi[K]>
  ): Promise<Awaited<ReturnType<RemoteApi[K]>> extends RemoteResult<infer T> ? T : never> {
    if (!this.remote) throw new Error('remote not mounted')
    const result = await (this.remote[method] as (...a: unknown[]) => Promise<unknown>)(...args)
    return unwrap(result)
  }
}

function unwrap<T>(result: unknown): T {
  if (result && typeof result === 'object' && 'ok' in result) {
    const shaped = result as RemoteResult<T>
    if (shaped.ok) return shaped.value
    throw new Error(shaped.error?.message ?? shaped.error?.code ?? 'remote call failed')
  }
  return result as T
}

function defaultTarget(result: CheckResult, previous: string): string {
  const byVersion = new Map(result.versions.map(candidate => [candidate.version, candidate]))
  for (const version of [result.latest.rc, result.latest.alpha]) {
    if (!version) continue
    const candidate = byVersion.get(version)
    if (candidate?.selectable && candidate.relation !== 'older') return candidate.version
  }
  const preferred =
    result.versions.find(candidate => candidate.selectable && candidate.relation === 'newer') ??
    result.versions.find(candidate => candidate.selectable && candidate.relation === 'same')
  if (preferred) return preferred.version
  return previous || result.current
}

function trimLog(log: string): string {
  const limit = 32_000
  return log.length > limit ? log.slice(log.length - limit) : log
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function sessionLabel(session: SessionWork): string {
  return session.title || session.sessionId.slice(0, 8)
}

export function blockingOf(report: CompatibilityReport | undefined): string[] {
  return (report?.blocking ?? []).map(issue => issue.message)
}
