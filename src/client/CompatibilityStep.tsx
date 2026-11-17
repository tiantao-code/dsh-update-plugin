import { Badge, Button, Card, KV, formatBytes, useStore, useT } from './ui.js'
import { store } from './singleton.js'

export function CompatibilityStep() {
  const state = useStore()
  const t = useT()
  const plan = state.plan
  if (!plan) return null
  const report = plan.compatibility
  const riskRequired = report.warnings.some(warning => warning.code === 'risk-required')

  return (
    <>
      <Card>
        <div className="dshu-grid">
          <KV label={t('targetVersion')}>{plan.target}</KV>
          <KV label={t('node')}>
            {report.node.current}{' '}
            {report.node.ok ? <Badge tone="ok">{t('nodeOk')}</Badge> : <Badge tone="bad">{t('nodeBad')}</Badge>}
          </KV>
          <KV label={t('installMode')}>{plan.install.mode}</KV>
          <KV label={t('installPath')}>{plan.install.prefix || '—'}</KV>
          <KV label={t('writable')}>
            {plan.install.writable ? <Badge tone="ok">✓</Badge> : <Badge tone="bad">{t('notWritable')}</Badge>}
          </KV>
          <KV label={t('estimatedSize')}>{formatBytes(plan.install.estimatedBytes)}</KV>
        </div>
        {report.node.required ? (
          <p className="dshu-note">
            {t('node')}: {report.node.required}
          </p>
        ) : null}
      </Card>

      {report.blocking.length > 0 ? (
        <Card>
          <div className="dshu-v" style={{ marginBottom: 8 }}>{t('blocking')}</div>
          <div className="dshu-list">
            {report.blocking.map(issue => (
              <div className="dshu-alert" key={issue.code}>
                {issue.message}
                {issue.action ? <div className="dshu-note">{issue.action}</div> : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {report.warnings.length > 0 ? (
        <Card>
          <div className="dshu-v" style={{ marginBottom: 8 }}>{t('warnings')}</div>
          <div className="dshu-list">
            {report.warnings.map((warning, index) => (
              <div className="dshu-warnbox" key={`${warning.code}-${index}`}>{warning.message}</div>
            ))}
          </div>
          {riskRequired ? (
            <label className="dshu-radio" style={{ marginTop: 12 }}>
              <input
                type="checkbox"
                checked={state.acceptRisk}
                onChange={event => store.setAcceptRisk(event.target.checked)}
              />
              <span>{t('acceptRisk')}</span>
            </label>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <div className="dshu-v" style={{ marginBottom: 8 }}>{t('plugins')} ({report.plugins.length})</div>
        {report.plugins.length === 0 ? (
          <div className="dshu-empty">{t('allClear')}</div>
        ) : (
          <div className="dshu-list">
            {report.plugins.map(plugin => (
              <div className="dshu-item" key={plugin.name}>
                <div className="dshu-item-main">
                  <div className="dshu-item-title">
                    <span>{plugin.name}</span>
                    <PluginBadge status={plugin.status} />
                    {plugin.version ? <span className="dshu-note">{plugin.version}</span> : null}
                  </div>
                  <div className="dshu-item-meta">
                    {plugin.range ? `${t('pluginRange')}: ${plugin.range}` : null}
                    {plugin.detail ? <div>{plugin.detail}</div> : null}
                  </div>
                </div>
                {plugin.status === 'incompatible' ? (
                  <Button
                    disabled={state.busy !== null}
                    onClick={() => void store.disableBundle(plugin.name)}
                    title={t('disableBeforeUpdate')}
                  >
                    {state.busy === `disable:${plugin.name}` ? t('disabling') : t('disable')}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {report.plugins.some(plugin => plugin.status === 'incompatible') ? (
          <p className="dshu-note" style={{ marginTop: 10 }}>{t('enableHint')}</p>
        ) : null}
      </Card>

      <div className="dshu-actions">
        <Button onClick={() => store.back()}>{t('back')}</Button>
        <Button
          kind="primary"
          disabled={!report.canProceed || (riskRequired && !state.acceptRisk) || state.busy !== null}
          onClick={() => store.go('sessions')}
        >
          {report.canProceed ? t('canProceed') : t('cannotProceed')}
        </Button>
      </div>
    </>
  )
}

function PluginBadge(props: { status: string }) {
  const t = useT()
  if (props.status === 'ok') return <Badge tone="ok">{t('pluginOk')}</Badge>
  if (props.status === 'incompatible') return <Badge tone="bad">{t('pluginIncompatible')}</Badge>
  if (props.status === 'manifest-warning') return <Badge tone="warn">{t('pluginManifestWarning')}</Badge>
  return <Badge tone="warn">{t('pluginUnknown')}</Badge>
}
