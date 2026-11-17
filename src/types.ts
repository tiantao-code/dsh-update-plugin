/** Update channels the plugin is willing to install. `latest` is deliberately absent. */
export type UpdateChannel = 'rc' | 'alpha'

/** Version relation to the version currently installed. */
export type VersionRelation = 'newer' | 'same' | 'older'

/** A version advertised by the registry, annotated for the wizard. */
export interface VersionCandidate {
  version: string
  channel: UpdateChannel
  /** dist-tags that point at this exact version (next/alpha/latest/...). */
  tags: string[]
  publishedAt?: string
  deprecated?: string
  nodeRange?: string
  nodeCompatible: boolean
  relation: VersionRelation
  selectable: boolean
  /** Human readable reason the radio button is disabled. */
  disabledReason?: string
  /** From dist.unpackedSize, used for the free-space preflight. */
  unpackedSize?: number
  integrity?: string
}

export interface CheckResult {
  current: string
  checkedAt: string
  registry: string
  cached: boolean
  /** True when the registry could not be reached and the cache was used. */
  offline?: boolean
  /** Registry error message when no cache was available. */
  error?: string
  /** Highest accepted rc / alpha version. */
  latest: { rc?: string; alpha?: string }
  versions: VersionCandidate[]
}

export type PluginCompatibilityStatus = 'ok' | 'incompatible' | 'unknown' | 'manifest-warning'

export interface PluginCompatibility {
  name: string
  version?: string
  /** Original declared range, shown verbatim. */
  range?: string
  status: PluginCompatibilityStatus
  detail?: string
  /** Where the bundle was found: profile or installation. */
  source?: 'profile' | 'installation' | 'built-in'
}

export interface BlockingIssue {
  code: string
  message: string
  action?: string
}

export interface CompatibilityWarning {
  code: string
  message: string
}

export interface CompatibilityReport {
  target: string
  node: { current: string; required?: string; ok: boolean }
  plugins: PluginCompatibility[]
  blocking: BlockingIssue[]
  warnings: CompatibilityWarning[]
  canProceed: boolean
}

/** One session that may hold work, as shown in the session step. */
export interface SessionWork {
  sessionId: string
  /** `SessionSummary` has no title; this is a cwd-based label. */
  title: string
  cwd?: string
  running: boolean
  lastActivityAt: number
  activities: Array<{ kind: string; count?: number; labels?: string[] }>
  /** True when the session cannot be paused and will be interrupted. */
  risk?: boolean
}

export interface UpdatePlan {
  target: string
  compatibility: CompatibilityReport
  sessions: SessionWork[]
  install: {
    mode: InstallationInfo['mode']
    prefix: string
    writable: boolean
    estimatedBytes?: number
  }
  /** True when the target is not currently selectable (deprecated / disabled channel). */
  blocked?: boolean
}

export type InstallationMode =
  | 'npm-global'
  | 'pnpm-global'
  | 'homebrew'
  | 'desktop'
  | 'source'
  | 'unknown'

export interface InstallationInfo {
  mode: InstallationMode
  packageRoot: string
  prefix: string
  binPath?: string
  binTarget?: string
  writable: boolean
  reason?: string
}

export interface PauseReport {
  paused: string[]
  skipped: string[]
  timeouts: string[]
  failures: Array<{ sessionId: string; message: string }>
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'ready'
  | 'planning'
  | 'staging'
  | 'staged'
  | 'pausing'
  | 'paused'
  | 'switching'
  | 'installed'
  | 'done'
  | 'failed'
  | 'rolled-back'

export interface UpdateError {
  code: string
  message: string
  /** Optional concrete action the UI can offer. */
  action?: string
}

export interface UpdateProgress {
  step: 'preflight' | 'staging' | 'pausing' | 'switching' | 'verifying'
  message: string
  percent?: number
}

export interface UpdateStatus {
  id: string
  phase: UpdatePhase
  target: string
  previous: string
  progress?: UpdateProgress
  error?: UpdateError
  startedAt?: string
  finishedAt?: string
  restartCommand?: string
  logPath?: string
  backupPath?: string
  stagePath?: string
  pauseReport?: PauseReport
  check?: CheckResult
}

export interface StartResult {
  id: string
}

export interface LogsResult {
  offset: number
  nextOffset: number
  content: string
  eof: boolean
}

export interface PauseRequest {
  sessionIds: string[]
}

export interface StartRequest {
  target: string
  /** Sessions selected on the session step. Empty means "update without pausing". */
  pauseSessionIds: string[]
  /**
   * The user accepted the consequences: interrupted sessions, downgrade,
   * incompatible plugins, or a pause timeout.
   */
  acceptRisk: boolean
}

export interface CheckRequest {
  force?: boolean
}

export interface LogsRequest {
  id: string
  offset?: number
}

export interface UpdateConfig {
  registry: string
  fallbackRegistries: string[]
  checkIntervalMinutes: number
  pauseTimeoutMs: number
  allowIncompatiblePlugins: boolean
  allowDowngrade: boolean
  allowBuildScripts: boolean
}

export interface PersistedState extends UpdateStatus {
  version: 1
  stageRoot?: string
  acceptRisk?: boolean
  pauseSessionIds?: string[]
  startedAt?: string
}
