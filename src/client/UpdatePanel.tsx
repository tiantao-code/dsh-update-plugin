import { CompatibilityStep } from './CompatibilityStep.js'
import { ConfirmStep } from './ConfirmStep.js'
import { ProgressStep } from './ProgressStep.js'
import { SessionStep } from './SessionStep.js'
import { VersionStep } from './VersionStep.js'
import { store } from './singleton.js'
import { Button, useStore, useT } from './ui.js'
import type { WizardStep } from './store.js'

const STEPS: Array<{ id: WizardStep; key: 'stepVersion' | 'stepCompatibility' | 'stepSessions' | 'stepConfirm' | 'stepRun' }> = [
  { id: 'version', key: 'stepVersion' },
  { id: 'compat', key: 'stepCompatibility' },
  { id: 'sessions', key: 'stepSessions' },
  { id: 'confirm', key: 'stepConfirm' },
  { id: 'run', key: 'stepRun' },
]

export function UpdatePanel() {
  const state = useStore()
  const t = useT()
  const phase = state.status?.phase
  const active = phase
    ? ['staging', 'staged', 'pausing', 'paused', 'switching', 'installed'].includes(phase)
    : false
  const step: WizardStep = active ? 'result' : state.step
  const hasUpdate = Boolean(
    state.check?.versions.some(candidate => candidate.selectable && candidate.relation === 'newer'),
  )

  return (
    <div className="dshu-root">
      <header className="dshu-head">
        <div>
          <h1 className="dshu-title">{t('title')}</h1>
          <p className="dshu-sub">{t('subtitle')}</p>
        </div>
        <Button onClick={() => void store.check(true)} disabled={state.busy !== null}>
          {state.busy === 'checking' ? t('checking') : t('check')}
        </Button>
      </header>

      {hasUpdate ? <div className="dshu-warnbox" style={{ marginBottom: 12 }}>{t('updateAvailable')}</div> : null}

      <nav className="dshu-steps" aria-label={t('title')}>
        {STEPS.map(stepInfo => {
          const done = stepOrder(stepInfo.id) < stepOrder(step)
          return (
            <span
              key={stepInfo.id}
              className="dshu-step"
              data-active={stepInfo.id === step || (step === 'result' && stepInfo.id === 'run')}
              data-done={done}
            >
              {t(stepInfo.key)}
            </span>
          )
        })}
      </nav>

      {step === 'version' ? <VersionStep /> : null}
      {step === 'compat' ? <CompatibilityStep /> : null}
      {step === 'sessions' ? <SessionStep /> : null}
      {step === 'confirm' ? <ConfirmStep /> : null}
      {step === 'run' || step === 'result' ? <ProgressStep /> : null}
    </div>
  )
}

function stepOrder(step: WizardStep): number {
  return ['version', 'compat', 'sessions', 'confirm', 'run', 'result'].indexOf(step)
}

export function UpdateIcon() {
  const state = useStore()
  const t = useT()
  const hasUpdate = Boolean(
    state.check?.versions.some(candidate => candidate.selectable && candidate.relation === 'newer'),
  )
  return (
    <span className="dshu-icon" data-has-update={hasUpdate} title={t('sideBarHint')} aria-label={t('sideBarHint')}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <path d="M12 3v11m0 0 4-4m-4 4-4-4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" strokeLinecap="round" />
      </svg>
    </span>
  )
}
