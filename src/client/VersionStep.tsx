import type { VersionCandidate } from '../types.js'
import { Badge, Button, Card, ErrorLine, KV, formatTime, formatBytes, useStore, useT } from './ui.js'
import { store } from './singleton.js'

export function VersionStep() {
  const state = useStore()
  const t = useT()
  const check = state.check

  if (!check) {
    return (
      <Card>
        <div className="dshu-row">
          <div>
            <div className="dshu-v">{t('check')}</div>
            <p className="dshu-note">{t('subtitle')}</p>
          </div>
          <Button kind="primary" onClick={() => store.check(true)} disabled={state.busy !== null}>
            {state.busy === 'checking' ? t('checking') : t('check')}
          </Button>
        </div>
        <ErrorLine message={state.error} />
      </Card>
    )
  }

  const visible = state.showAll
    ? check.versions
    : check.versions.filter(candidate => candidate.relation !== 'older' || candidate.version === state.target)

  return (
    <>
      <Card>
        <div className="dshu-grid">
          <KV label={t('currentVersion')}>{check.current}</KV>
          <KV label={t('latestRc')}>
            {check.latest.rc ?? '—'}{' '}
            {check.latest.rc && check.versions.find(v => v.version === check.latest.rc)?.tags.includes('latest') ? (
              <Badge tone="warn">latest</Badge>
            ) : null}
          </KV>
          <KV label={t('latestAlpha')}>{check.latest.alpha ?? '—'}</KV>
          <KV label={t('registry')}>{check.registry}</KV>
        </div>
        <p className="dshu-note">
          {t('reportedBy')} {formatTime(check.checkedAt)}
          {check.cached ? ` · ${t('cached')}` : ''}
        </p>
        {check.offline ? <div className="dshu-warnbox">{t('offline')}</div> : null}
        {check.error ? <div className="dshu-warnbox">{check.error}</div> : null}
        <ErrorLine message={state.error} />
      </Card>

      <Card>
        <div className="dshu-row" style={{ marginBottom: 10 }}>
          <div className="dshu-v">{t('versions')}</div>
          <Button kind="link" onClick={() => store.check(true)} disabled={state.busy !== null}>
            {state.busy === 'checking' ? t('checking') : t('refresh')}
          </Button>
        </div>
        {visible.length === 0 ? (
          <div className="dshu-empty">{t('noVersions')}</div>
        ) : (
          <table className="dshu-table">
            <thead>
              <tr>
                <th style={{ width: 36 }} />
                <th>{t('versionColumn')}</th>
                <th>{t('channelColumn')}</th>
                <th>{t('tagsColumn')}</th>
                <th>{t('publishedColumn')}</th>
                <th>{t('estimatedSize')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(candidate => (
                <tr key={candidate.version} data-disabled={!candidate.selectable}>
                  <td>
                    <input
                      type="radio"
                      name="dshu-version"
                      checked={state.target === candidate.version}
                      disabled={!candidate.selectable || state.busy !== null}
                      onChange={() => store.setTarget(candidate.version)}
                      aria-label={candidate.version}
                    />
                  </td>
                  <td>
                    <div>{candidate.version}</div>
                    <Relation candidate={candidate} />
                    {candidate.deprecated ? <div className="dshu-note">{t('deprecated')}: {candidate.deprecated}</div> : null}
                    {candidate.disabledReason ? <div className="dshu-note">{candidate.disabledReason}</div> : null}
                  </td>
                  <td>{candidate.channel.toUpperCase()}</td>
                  <td>{candidate.tags.length ? candidate.tags.join(', ') : '—'}</td>
                  <td>{formatTime(candidate.publishedAt)}</td>
                  <td>{formatBytes(candidate.unpackedSize)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {check.versions.some(candidate => candidate.relation === 'older') ? (
          <div style={{ marginTop: 10 }}>
            <Button kind="link" onClick={() => store.setShowAll(!state.showAll)}>
              {state.showAll ? t('hideAll') : t('showAll')}
            </Button>
          </div>
        ) : null}
      </Card>

      <div className="dshu-actions">
        <Button
          kind="primary"
          disabled={!state.target || state.busy !== null}
          onClick={() => store.plan()}
        >
          {state.busy === 'planning' ? t('busy') : t('next')}
        </Button>
      </div>
    </>
  )
}

function Relation(props: { candidate: VersionCandidate }) {
  const t = useT()
  if (props.candidate.relation === 'newer') return <Badge tone="ok">{t('newer')}</Badge>
  if (props.candidate.relation === 'same') return <Badge tone="warn">{t('reinstall')}</Badge>
  return <Badge>{t('older')}</Badge>
}
