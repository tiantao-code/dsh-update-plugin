import { useState } from 'react'
import { Button, Card, KV, useStore, useT } from './ui.js'
import { store } from './singleton.js'
import { sessionLabel } from './store.js'

export function ConfirmStep() {
  const state = useStore()
  const t = useT()
  const [acknowledged, setAcknowledged] = useState(false)
  const plan = state.plan
  if (!plan) return null
  const selected = plan.sessions.filter(session => state.selectedSessions.has(session.sessionId))
  const skipped = plan.sessions.length - selected.length

  return (
    <>
      <Card>
        <div className="dshu-v">{t('confirm')}</div>
        <p className="dshu-note">{t('confirmHint')}</p>
        <div className="dshu-grid" style={{ marginTop: 12 }}>
          <KV label={t('currentVersion')}>{state.status?.previous || state.check?.current || '—'}</KV>
          <KV label={t('targetVersion')}>{plan.target}</KV>
          <KV label={t('sessions')}>
            {selected.length} {t('selected')}
            {skipped > 0 ? ` · ${skipped} ${t('skipped')}` : ''}
          </KV>
          <KV label={t('installMode')}>{plan.install.mode}</KV>
        </div>
        {selected.length > 0 ? (
          <div className="dshu-note" style={{ marginTop: 8 }}>
            {selected.map(sessionLabel).join(', ')}
          </div>
        ) : null}
      </Card>

      <Card>
        <div className="dshu-warnbox">{t('manualRestart')}</div>
        <p className="dshu-note" style={{ marginTop: 10 }}>{t('reloadHint')}</p>
        <label className="dshu-radio" style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={event => setAcknowledged(event.target.checked)}
          />
          <span>{t('acceptRisk')}</span>
        </label>
      </Card>

      <div className="dshu-actions">
        <Button onClick={() => store.back()}>{t('back')}</Button>
        <Button
          kind="primary"
          disabled={!acknowledged || state.busy !== null}
          onClick={() => void store.start(acknowledged || state.acceptRisk)}
        >
          {state.busy === 'starting' ? t('starting') : t('startUpdate')}
        </Button>
      </div>
    </>
  )
}
