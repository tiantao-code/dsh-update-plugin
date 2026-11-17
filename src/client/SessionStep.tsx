import { Badge, Button, Card, useStore, useT } from './ui.js'
import { store } from './singleton.js'
import { sessionLabel } from './store.js'

export function SessionStep() {
  const state = useStore()
  const t = useT()
  const plan = state.plan
  if (!plan) return null
  const sessions = plan.sessions
  const selected = state.selectedSessions
  const skipped = sessions.filter(session => !selected.has(session.sessionId))
  const riskRequired = skipped.length > 0

  return (
    <>
      <Card>
        <div className="dshu-v">{t('sessions')}</div>
        <p className="dshu-note">{t('sessionsHint')}</p>
        {sessions.length === 0 ? (
          <div className="dshu-empty">{t('noSessions')}</div>
        ) : (
          <>
            <div className="dshu-row" style={{ margin: '10px 0' }}>
              <span className="dshu-note">{sessions.length} · {selected.size} {t('selected')}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button kind="link" onClick={() => store.setAllSessions(true)}>{t('selectAll')}</Button>
                <Button kind="link" onClick={() => store.setAllSessions(false)}>{t('selectNone')}</Button>
              </div>
            </div>
            <div className="dshu-list">
              {sessions.map(session => (
                <label
                  className="dshu-item"
                  data-selected={selected.has(session.sessionId)}
                  key={session.sessionId}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(session.sessionId)}
                    onChange={() => store.toggleSession(session.sessionId)}
                    style={{ marginTop: 3 }}
                  />
                  <div className="dshu-item-main">
                    <div className="dshu-item-title">
                      <span>{sessionLabel(session)}</span>
                      {session.running ? <Badge tone="warn">{t('sessionRunning')}</Badge> : <Badge>{t('sessionIdle')}</Badge>}
                      {session.risk ? <Badge tone="bad">{t('sessionRisk')}</Badge> : null}
                    </div>
                    <div className="dshu-item-meta">
                      {session.cwd ? <div>{session.cwd}</div> : null}
                      <div>
                        {t('sessionActivity')}:{' '}
                        {session.activities.length === 0
                          ? '—'
                          : session.activities
                              .map(activity => `${activity.kind}${activity.count ? `×${activity.count}` : ''}`)
                              .join(', ')}
                      </div>
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </>
        )}
        {riskRequired ? (
          <div style={{ marginTop: 14 }}>
            <div className="dshu-warnbox">
              <div>{t('updateWithoutPauseHint')}</div>
              <label className="dshu-radio" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={state.acceptRisk}
                  onChange={event => store.setAcceptRisk(event.target.checked)}
                />
                <span>{t('acceptRisk')}</span>
              </label>
            </div>
          </div>
        ) : null}
        {sessions.length > 0 ? (
          <p className="dshu-note" style={{ marginTop: 10 }}>{t('updateWithoutPauseHint')}</p>
        ) : null}
      </Card>

      <div className="dshu-actions">
        <Button onClick={() => store.back()}>{t('back')}</Button>
        {sessions.length > 0 ? (
          <span className="dshu-note">{t('pauseAfterDownload')}</span>
        ) : null}
        <Button
          kind="primary"
          disabled={(riskRequired && !state.acceptRisk) || state.busy !== null}
          onClick={() => store.go('confirm')}
        >
          {t('next')}
        </Button>
      </div>
    </>
  )
}
