import type { LocaleKey } from './locales.js'
import { Badge, Button, Card, KV, formatTime, useStore, useT } from './ui.js'
import { store } from './singleton.js'

const PHASES = ['staging', 'staged', 'pausing', 'paused', 'switching', 'installed'] as const

export function ProgressStep() {
  const state = useStore()
  const t = useT()
  const status = state.status
  if (!status) return null
  const pauseTimeout = status.phase === 'staged' && status.error?.code === 'PAUSE_TIMEOUT'
  const percent = status.progress?.percent ?? phasePercent(status.phase)
  const cancellable = ['staging', 'staged', 'pausing', 'paused'].includes(status.phase)

  return (
    <>
      <Card>
        <div className="dshu-row">
          <div>
            <div className="dshu-title" style={{ fontSize: 16 }}>
              {phaseTitle(status.phase, t)}
            </div>
            <div className="dshu-note">
              {status.progress?.message ?? phaseHint(status.phase, t)}
            </div>
          </div>
          <Badge tone={status.phase === 'failed' ? 'bad' : status.phase === 'installed' || status.phase === 'done' ? 'ok' : 'warn'}>
            {status.phase}
          </Badge>
        </div>
        <div className="dshu-progress">
          <span style={{ width: `${Math.max(3, Math.min(100, percent))}%` }} />
        </div>
        <div className="dshu-grid">
          <KV label={t('currentVersion')}>{status.previous || '—'}</KV>
          <KV label={t('targetVersion')}>{status.target || '—'}</KV>
          <KV label={t('stepRun')}>{status.id || '—'}</KV>
          <KV label={t('reportedBy')}>{formatTime(status.startedAt)}</KV>
        </div>
        <div className="dshu-steps" style={{ marginBottom: 0 }}>
          {PHASES.map(phase => (
            <span
              className="dshu-step"
              key={phase}
              data-active={phase === status.phase}
              data-done={phaseIndex(phase) < phaseIndex(status.phase)}
            >
              {phase}
            </span>
          ))}
        </div>
        {status.pauseReport ? (
          <p className="dshu-note" style={{ marginTop: 10 }}>
            {t('sessions')}: {status.pauseReport.paused.length} paused · {status.pauseReport.timeouts.length} timeout ·{' '}
            {status.pauseReport.failures.length} failed
          </p>
        ) : null}
        {status.error && !pauseTimeout ? <div className="dshu-alert" style={{ marginTop: 12 }}>{status.error.message}</div> : null}
        {pauseTimeout ? (
          <div className="dshu-warnbox" style={{ marginTop: 12 }}>
            <div>{t('pauseTimeout')}</div>
            <p className="dshu-note">{t('pauseTimeoutHint')}</p>
            <div className="dshu-actions" style={{ marginTop: 8 }}>
              <Button disabled={state.busy !== null} onClick={() => void store.start()}>{t('continueWaiting')}</Button>
              <Button kind="danger" disabled={state.busy !== null} onClick={() => void store.resumeWithRisk()}>{t('skipAndContinue')}</Button>
              <Button disabled={state.busy !== null} onClick={() => void store.cancel()}>{t('cancel')}</Button>
            </div>
          </div>
        ) : null}
        {status.phase === 'installed' || status.phase === 'done' ? (
          <div style={{ marginTop: 14 }}>
            <div className="dshu-v">{status.phase === 'done' ? t('done') : t('installed')}</div>
            <p className="dshu-note">{status.phase === 'done' ? t('doneHint') : t('installedHint')}</p>
            {status.phase === 'installed' && status.restartCommand ? (
              <div style={{ marginTop: 10 }}>
                <div className="dshu-k">{t('restartCommand')}</div>
                <div className="dshu-code">{status.restartCommand}</div>
                <div style={{ marginTop: 8 }}>
                  <Button onClick={() => void store.copyCommand()}>{state.copied ? t('copied') : t('copy')}</Button>
                </div>
              </div>
            ) : null}
            <p className="dshu-note" style={{ marginTop: 10 }}>{t('reloadHint')}</p>
          </div>
        ) : null}
        {status.phase === 'failed' ? (
          <div style={{ marginTop: 12 }}>
            <div className="dshu-alert">{status.error?.message ?? t('failed')}</div>
            <div className="dshu-actions" style={{ marginTop: 8 }}>
              <Button onClick={() => store.go('version')}>{t('backToVersions')}</Button>
              <Button kind="primary" onClick={() => void store.plan(status.target)}>{t('retryUpdate')}</Button>
            </div>
          </div>
        ) : null}
        {status.phase === 'rolled-back' ? (
          <div style={{ marginTop: 12 }}>
            <div className="dshu-warnbox">{t('rolledBack')} · {t('rollbackHint')}</div>
            <div className="dshu-actions" style={{ marginTop: 8 }}>
              <Button onClick={() => store.go('version')}>{t('backToVersions')}</Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Card>
        <div className="dshu-row" style={{ marginBottom: 8 }}>
          <div className="dshu-v">{t('logs')}</div>
          {cancellable ? (
            <Button kind="danger" disabled={state.busy !== null} onClick={() => void store.cancel()}>
              {state.busy === 'cancelling' ? t('cancelling') : t('cancelUpdate')}
            </Button>
          ) : null}
        </div>
        {state.error ? <div className="dshu-error" style={{ marginBottom: 8 }}>{state.error}</div> : null}
        {state.log ? <div className="dshu-log">{state.log}</div> : <div className="dshu-empty">{t('noLogs')}</div>}
      </Card>
    </>
  )
}

function phaseIndex(phase: string): number {
  return PHASES.indexOf(phase as (typeof PHASES)[number])
}

function phasePercent(phase: string): number {
  switch (phase) {
    case 'staging': return 20
    case 'staged': return 45
    case 'pausing': return 60
    case 'paused': return 70
    case 'switching': return 85
    case 'installed': return 100
    case 'done': return 100
    default: return 0
  }
}

function phaseTitle(phase: string, t: (key: LocaleKey) => string): string {
  switch (phase) {
    case 'staging': return t('staging')
    case 'staged': return t('staging')
    case 'pausing': return t('pausing')
    case 'paused': return t('pausing')
    case 'switching': return t('switching')
    case 'installed': return t('installed')
    case 'done': return t('done')
    case 'failed': return t('failed')
    case 'rolled-back': return t('rolledBack')
    default: return phase
  }
}

function phaseHint(phase: string, t: (key: LocaleKey) => string): string {
  switch (phase) {
    case 'staging': return t('stagingHint')
    case 'switching': return t('switchingHint')
    case 'installed': return t('installedHint')
    case 'done': return t('doneHint')
    default: return ''
  }
}
