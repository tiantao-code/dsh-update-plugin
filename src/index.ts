import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import semver from 'semver'
import { checkCompatibility } from './compatibility.js'
import {
  buildRestartCommand,
  detectInstallation,
  installToStage,
  readInstalledVersion,
  removeStage,
  rollbackInstallation,
  stagePackageRoot,
  stageRootFor,
  SwitchError,
  switchInstallation,
  verifyStage,
} from './installer.js'
import { findUnpausedActivity, listSessionWork, pauseSessions } from './pause.js'
import {
  DEFAULT_REGISTRY,
  FALLBACK_REGISTRY,
  channelOf,
  checkVersions,
  normalizeRegistry,
} from './registry.js'
import {
  emptyReport,
  InstallBusyError,
  newUpdateId,
  statusToState,
  UpdateStore,
  stateToStatus,
} from './store.js'
import type {
  CheckRequest,
  CheckResult,
  CompatibilityReport,
  InstallationInfo,
  LogsRequest,
  LogsResult,
  PauseReport,
  PauseRequest,
  PersistedState,
  SessionWork,
  StartRequest,
  StartResult,
  UpdateConfig,
  UpdateError,
  UpdatePlan,
  UpdateStatus,
  VersionCandidate,
} from './types.js'

const ACTIVE_PHASES = new Set(['staging', 'staged', 'pausing', 'paused', 'switching'])
const TERMINAL_PHASES = new Set(['done', 'failed', 'rolled-back'])

const Config = z.object({
  registry: z.string().default(DEFAULT_REGISTRY),
  fallbackRegistries: z.array(z.string()).default([FALLBACK_REGISTRY]),
  checkIntervalMinutes: z.number().step(1).min(0).default(360),
  pauseTimeoutMs: z.number().step(1).min(1_000).default(15_000),
  allowIncompatiblePlugins: z.boolean().default(false),
  allowDowngrade: z.boolean().default(true),
  allowBuildScripts: z.boolean().default(false),
})

interface RunState {
  id: string
  target: string
  candidate: VersionCandidate
  acceptRisk: boolean
  pauseSessionIds: string[]
  stageRoot: string
  stagePkg: string
  token?: string
  abort: AbortController
  reusedStage: boolean
  cancelled: boolean
}

class UpdateFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action?: string,
  ) {
    super(message)
    this.name = 'UpdateFailure'
  }
}

/**
 * Host half of the update plugin.
 *
 * The service is the only writer to the installation directory. The client
 * only reads status and polls it; custom host events cannot be forwarded
 * through the gateway for third-party packages, so polling is the transport.
 */
export class UpdateService extends TypertRemoteService {
  static inject = ['sessionController']

  static Config = Config

  private readonly config: UpdateConfig
  private readonly store: UpdateStore
  private readonly logger: any
  private readonly ready: Promise<void>
  private current: UpdateStatus = {
    id: '',
    phase: 'idle',
    target: '',
    previous: '',
  }
  private checkResult: CheckResult | undefined
  private planResult: UpdatePlan | undefined
  private installation: InstallationInfo | undefined
  private run: RunState | undefined
  private timer: NodeJS.Timeout | undefined
  private disposed = false
  private persistedStageRoot: string | undefined

  constructor(ctx: any, config: UpdateConfig) {
    super(ctx, 'dshUpdate')
    this.config = {
      ...config,
      registry: normalizeRegistry(config.registry),
      fallbackRegistries: config.fallbackRegistries.map(normalizeRegistry),
    }
    this.logger = ctx.logger?.('dsh-update') ?? {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }
    const home = resolveDshHome(ctx.profileContext?.home)
    this.store = new UpdateStore(home)
    this.ready = this.bootstrap().catch(error => {
      this.logger.error?.('dsh-update bootstrap failed', error)
      this.current = {
        ...this.current,
        phase: 'failed',
        error: { code: 'BOOTSTRAP_FAILED', message: messageOf(error) },
      }
    })
    ctx.effect(() => () => this.dispose(), 'dsh-update: lifecycle')
  }

  // ---------------------------------------------------------------- Remote API

  @Remote
  async check(request?: CheckRequest): Promise<CheckResult> {
    await this.ready
    if (this.run) {
      if (this.checkResult) return this.checkResult
      throw new UpdateFailure('BUSY', '更新进行中，暂时不能检查版本')
    }

    // A background or resume-time refresh must not disturb the phase that owns
    // the staged installation; only the version list is replaced. In
    // particular do not flash `checking` over an installed/staged phase.
    const heldPhase =
      ACTIVE_PHASES.has(this.current.phase) || this.current.phase === 'installed'
        ? this.current.phase
        : undefined
    if (!heldPhase) {
      this.current = { ...this.current, phase: 'checking' }
      this.emit()
    }

    const current = await this.currentVersion()
    try {
      const result = await checkVersions({
        store: this.store,
        current,
        registry: this.config.registry,
        fallbackRegistries: this.config.fallbackRegistries,
        allowDowngrade: this.config.allowDowngrade,
        force: request?.force === true,
      })
      this.checkResult = result
      this.current = {
        ...this.current,
        phase: heldPhase ?? (result.error && result.versions.length === 0 ? 'idle' : 'ready'),
        previous: current,
        check: result,
        ...(heldPhase ? {} : { error: undefined }),
      }
      await this.persist()
      return result
    } catch (error) {
      const message = messageOf(error)
      this.current = {
        ...this.current,
        phase: heldPhase ?? 'idle',
        ...(heldPhase ? {} : { error: { code: 'CHECK_FAILED', message } }),
        previous: current,
      }
      this.emit()
      await this.persist()
      throw error
    }
  }

  @Remote
  async plan(target: string): Promise<UpdatePlan> {
    await this.ready
    this.assertNotBusy()
    if (this.persistedStageRoot && ['staged', 'paused'].includes(this.current.phase)) {
      throw new UpdateFailure(
        'BUSY',
        '已有一个已下载的更新等待继续或取消，请先完成或取消该更新。',
        'cancel-staged',
      )
    }
    const candidate = await this.requireCandidate(target)
    this.current = { ...this.current, phase: 'planning', target, error: undefined }
    this.emit()

    const previous = await this.currentVersion()
    const plan = await this.buildPlan(target, candidate)
    this.planResult = plan
    this.current = { ...this.current, phase: 'ready', target, previous }
    this.emit()
    return plan
  }

  @Remote
  async pause(request: PauseRequest): Promise<PauseReport> {
    await this.ready
    if (!Array.isArray(request?.sessionIds)) {
      throw new UpdateFailure('BAD_REQUEST', 'pause 需要 sessionIds 数组')
    }
    const wasActive = ACTIVE_PHASES.has(this.current.phase) && Boolean(this.current.target)
    this.current = { ...this.current, phase: 'pausing' }
    this.emit()

    const outcome = await pauseSessions((this.ctx as any), {
      sessionIds: request.sessionIds.map(String),
      timeoutMs: this.config.pauseTimeoutMs,
      onLog: message => this.log(message),
    })
    const report = outcome.report
    await this.writeLedger(outcome.sessions, report)
    this.current = {
      ...this.current,
      phase: wasActive ? 'paused' : 'ready',
      pauseReport: report,
    }
    if (report.timeouts.length > 0 || report.failures.length > 0) {
      this.current = {
        ...this.current,
        error: {
          code: 'PAUSE_TIMEOUT',
          message: '部分会话在超时内仍有活动，可继续等待、跳过或取消更新。',
        },
      }
    }
    this.emit()
    await this.persist()
    return report
  }

  @Remote
  async start(request: StartRequest): Promise<StartResult> {
    await this.ready
    this.assertNotBusy()
    if (!request || typeof request.target !== 'string') {
      throw new UpdateFailure('BAD_REQUEST', 'start 需要 target')
    }
    if (typeof request.acceptRisk !== 'boolean') {
      throw new UpdateFailure('BAD_REQUEST', 'start 需要 acceptRisk 布尔值')
    }

    const target = request.target
    if (!semver.valid(target) || !channelOf(target)) {
      throw new UpdateFailure('BAD_TARGET', `只支持 rc/alpha 版本：${target}`)
    }

    const candidate = await this.requireCandidate(target)
    if (candidate.deprecated) {
      throw new UpdateFailure('DEPRECATED', `目标版本已废弃：${candidate.deprecated}`)
    }
    if (candidate.relation === 'older' && !this.config.allowDowngrade) {
      throw new UpdateFailure('DOWNGRADE_DISABLED', '当前配置不允许降级')
    }
    if (candidate.relation === 'older' && !request.acceptRisk) {
      throw new UpdateFailure('RISK_REQUIRED', '降级需要确认风险')
    }
    if (!candidate.nodeCompatible) {
      throw new UpdateFailure(
        'NODE_INCOMPATIBLE',
        `目标版本需要 Node ${candidate.nodeRange ?? ''}，当前为 ${process.versions.node}`,
      )
    }

    const plan = await this.buildPlan(target, candidate)
    if (!plan.compatibility.canProceed) {
      const first = plan.compatibility.blocking[0]
      throw new UpdateFailure(
        first?.code ?? 'PREFLIGHT_FAILED',
        first?.message ?? '预检未通过',
        first?.action,
      )
    }
    const incompatible = plan.compatibility.plugins.filter(
      plugin => plugin.status === 'incompatible',
    )
    if (
      incompatible.length > 0 &&
      !this.config.allowIncompatiblePlugins &&
      !request.acceptRisk
    ) {
      throw new UpdateFailure(
        'RISK_REQUIRED',
        `${incompatible.length} 个已安装插件与目标版本不兼容，请先禁用或确认风险`,
      )
    }
    const pauseIds = Array.isArray(request.pauseSessionIds)
      ? request.pauseSessionIds.map(String)
      : []
    if (
      pauseIds.length === 0 &&
      plan.sessions.length > 0 &&
      !request.acceptRisk
    ) {
      throw new UpdateFailure('RISK_REQUIRED', '不暂停会话直接更新需要确认风险')
    }

    const reuse = await this.canReuseStage(target)
    const id = reuse ? this.current.id : newUpdateId()
    const token = await this.takeLock()
    const stageRoot = reuse
      ? this.persistedStageRoot!
      : stageRootFor(this.installation!.prefix, id)
    const run: RunState = {
      id,
      target,
      candidate,
      acceptRisk: request.acceptRisk,
      pauseSessionIds: pauseIds,
      stageRoot,
      stagePkg: stagePackageRoot(stageRoot),
      token,
      abort: new AbortController(),
      reusedStage: reuse,
      cancelled: false,
    }
    this.run = run
    this.current = {
      id,
      phase: reuse ? 'staged' : 'staging',
      target,
      previous: await this.currentVersion(),
      startedAt: new Date().toISOString(),
      stagePath: stageRoot,
      logPath: this.store.logPathFor(id),
      restartCommand: buildRestartCommand(),
      pauseReport: undefined,
      error: undefined,
      check: this.checkResult,
    }
    this.persistedStageRoot = stageRoot
    this.emit()
    await this.persist()

    void this.execute(run).catch(error => this.failRun(run, error))
    return { id }
  }

  @Remote
  async status(): Promise<UpdateStatus> {
    await this.ready
    return this.copyStatus()
  }

  @Remote
  async cancel(id: string): Promise<UpdateStatus> {
    await this.ready
    if (!this.run) {
      if (
        this.current.id !== id ||
        !['staged', 'paused'].includes(this.current.phase) ||
        !this.persistedStageRoot
      ) {
        throw new UpdateFailure('NOT_RUNNING', '没有与该 id 匹配的进行中更新')
      }
      const stage = this.current.stagePath ?? this.persistedStageRoot
      await removeStage(stage).catch(() => undefined)
      this.persistedStageRoot = undefined
      this.current = {
        id: '',
        phase: 'idle',
        target: '',
        previous: await this.currentVersion(),
        check: this.checkResult,
      }
      this.emit()
      await this.persist()
      return this.copyStatus()
    }
    if (this.run.id !== id) {
      throw new UpdateFailure('NOT_RUNNING', '没有与该 id 匹配的进行中更新')
    }
    if (!['staging', 'staged', 'pausing', 'paused'].includes(this.current.phase)) {
      throw new UpdateFailure('NOT_CANCELLABLE', '当前阶段不可取消')
    }
    this.run.cancelled = true
    this.run.abort.abort(new Error('用户取消更新'))
    await this.log('用户取消更新')
    await removeStage(this.run.stageRoot).catch(() => undefined)
    if (this.current.phase !== 'switching') {
      this.current = {
        id: '',
        phase: 'idle',
        target: '',
        previous: await this.currentVersion(),
        check: this.checkResult,
      }
      this.emit()
      await this.persist()
    }
    return this.copyStatus()
  }

  @Remote
  async logs(request: LogsRequest): Promise<LogsResult> {
    await this.ready
    if (!request || typeof request.id !== 'string') {
      throw new UpdateFailure('BAD_REQUEST', 'logs 需要 id')
    }
    if (!/^upd_[a-z0-9_]+$/i.test(request.id)) {
      throw new UpdateFailure('BAD_REQUEST', '无效的更新 id')
    }
    const offset = Number.isFinite(request.offset) ? Math.max(0, Number(request.offset)) : 0
    const logPath =
      this.current.id === request.id
        ? (this.current.logPath ?? this.store.logPathFor(request.id))
        : this.store.logPathFor(request.id)
    const chunk = await this.store.readLog(logPath, offset)
    return { ...chunk, offset }
  }

  // ---------------------------------------------------------------- Lifecycle

  private async bootstrap(): Promise<void> {
    await this.store.ensure()
    this.installation = await detectInstallation({
      profileHome: (this.ctx as any).profileContext?.home,
    })
    const previous = await this.currentVersion()
    this.current = {
      id: '',
      phase: 'idle',
      target: '',
      previous,
    }

    const saved = await this.store.readState()
    if (saved) {
      this.checkResult = saved.check
      await this.recover(saved)
    }

    this.emit()
    this.scheduleBackgroundCheck()
    this.logger.info?.(
      `dsh-update ready: ${this.current.phase}, installation=${this.installation.mode}, previous=${previous}`,
    )
  }

  private async recover(saved: PersistedState): Promise<void> {
    const status = stateToStatus(saved)
    this.persistedStageRoot = saved.stageRoot
    this.installation = await detectInstallation({
      profileHome: (this.ctx as any).profileContext?.home,
    })
    // `currentVersion()` masks a missing package as 0.0.0-0; recovery must see
    // the real absence to know whether it should restore a backup.
    const installed = await readInstalledVersion(this.installation?.packageRoot ?? '')

    if (status.phase === 'switching') {
      if (installed === status.target) {
        this.current = {
          ...status,
          phase: 'installed',
          restartCommand: status.restartCommand ?? buildRestartCommand(),
        }
        return
      }
      if (!installed && status.backupPath && existsSync(status.backupPath)) {
        await rollbackInstallation(
          this.installation.packageRoot,
          status.backupPath,
          message => this.log(message),
        )
        this.current = {
          ...status,
          phase: 'rolled-back',
          error: {
            code: 'SWITCH_INTERRUPTED',
            message: '上次切换在改名前中断，已从备份恢复。',
          },
          finishedAt: new Date().toISOString(),
        }
        return
      }
      this.current = {
        ...status,
        phase: 'failed',
        error: {
          code: 'SWITCH_INTERRUPTED',
          message: `上次切换中断；当前版本 ${installed || '(无法读取)'}，期望 ${status.target}。`,
        },
        finishedAt: new Date().toISOString(),
      }
      return
    }

    if (status.phase === 'installed') {
      this.current =
        installed === status.target
          ? { ...status, phase: 'done', finishedAt: new Date().toISOString() }
          : { ...status, phase: 'installed' }
      if (this.current.phase === 'done') await this.store.writeLastResult(this.current)
      return
    }

    if (status.phase === 'staged' || status.phase === 'paused' || status.phase === 'pausing') {
      const valid = await this.stageIsValid(status.target, saved.stageRoot)
      if (valid) {
        this.current = { ...status, phase: status.phase === 'pausing' ? 'paused' : status.phase }
      } else {
        if (saved.stageRoot) await removeStage(saved.stageRoot).catch(() => undefined)
        this.current = {
          id: '',
          phase: 'idle',
          target: '',
          previous: installed ?? '0.0.0-0',
          check: status.check,
        }
      }
      return
    }

    if (status.phase === 'checking' || status.phase === 'planning') {
      this.current = {
        id: '',
        phase: 'idle',
        target: '',
        previous: installed ?? '0.0.0-0',
        check: status.check,
      }
      return
    }

    this.current = { ...status, previous: status.previous || installed || '0.0.0-0' }
    if (TERMINAL_PHASES.has(this.current.phase)) {
      await this.store.writeLastResult(this.current).catch(() => undefined)
    }
  }

  private async execute(run: RunState): Promise<void> {
    try {
      if (!run.reusedStage) {
        this.setProgress('staging', 10, '正在下载并安装到临时目录')
        await this.log(`开始 staged 安装 ${run.target}`)
        await installToStage({
          prefix: this.installation!.prefix,
          stageRoot: run.stageRoot,
          cacheDir: join(this.installation!.prefix, '.dsh-cache', run.id),
          version: run.target,
          registry: this.checkResult?.registry ?? this.config.registry,
          allowBuildScripts: this.config.allowBuildScripts,
          signal: run.abort.signal,
          onLog: line => this.log(line),
        })
        run.abort.signal.throwIfAborted()
        await verifyStage({
          stageRoot: run.stageRoot,
          version: run.target,
          onLog: line => this.log(line),
        })
        this.current = { ...this.current, phase: 'staged', progress: undefined }
        this.emit()
        await this.persist()
      }

      let paused = new Set<string>()
      if (run.pauseSessionIds.length > 0) {
        this.current = { ...this.current, phase: 'pausing', progress: undefined }
        this.emit()
        await this.persist()
        const outcome = await pauseSessions((this.ctx as any), {
          sessionIds: run.pauseSessionIds,
          timeoutMs: this.config.pauseTimeoutMs,
          signal: run.abort.signal,
          onLog: message => this.log(message),
        })
        paused = new Set(outcome.report.paused)
        await this.writeLedger(outcome.sessions, outcome.report)
        this.current = { ...this.current, phase: 'paused', pauseReport: outcome.report }
        this.emit()
        await this.persist()

        const unresolved =
          outcome.report.timeouts.length + outcome.report.failures.length + outcome.report.skipped.length
        if (unresolved > 0 && !run.acceptRisk) {
          this.current = {
            ...this.current,
            phase: 'staged',
            error: {
              code: 'PAUSE_TIMEOUT',
              message: '部分会话未能在超时内暂停。可继续等待、跳过或取消；选择跳过后重试需确认风险。',
            },
          }
          this.emit()
          await this.persist()
          await this.log('暂停未完成，已停在 staged 阶段，等待用户选择')
          return
        }
      }

      run.abort.signal.throwIfAborted()
      await this.preflight(run, paused)

      this.current = {
        ...this.current,
        phase: 'switching',
        progress: { step: 'switching', message: '正在原子切换版本' },
        error: undefined,
      }
      this.emit()
      await this.persist()
      await this.log('开始切换安装目录')

      const backup = await switchInstallation({
        packageRoot: this.installation!.packageRoot,
        stageRoot: run.stageRoot,
        currentVersion: this.current.previous,
        targetVersion: run.target,
        onLog: line => this.log(line),
      })

      this.stopBackgroundCheck()
      this.current = {
        ...this.current,
        phase: 'installed',
        progress: undefined,
        backupPath: backup,
        restartCommand: buildRestartCommand(),
        finishedAt: new Date().toISOString(),
        error: undefined,
      }
      await this.store.writeLastResult(this.current).catch(() => undefined)
      await removeStage(run.stageRoot).catch(() => undefined)
      await this.log('切换完成，等待用户手动重启 DSH')
      this.emit()
      await this.persist()
    } catch (error) {
      if (run.cancelled) {
        await this.log('更新已取消')
        return
      }
      if (error instanceof Error && error.name === 'AbortError') {
        await this.log('更新已中止')
        return
      }
      if (this.current.phase === 'switching') {
        await this.handleSwitchFailure(run, error)
        return
      }
      await this.failRun(run, error)
    } finally {
      await this.releaseLock(run)
      this.run = undefined
    }
  }

  private async preflight(run: RunState, paused: ReadonlySet<string>): Promise<void> {
    this.setProgress('preflight', 60, '切换前检查安装目录和会话活动')

    const fresh = await detectInstallation({ profileHome: (this.ctx as any).profileContext?.home })
    if (!fresh.packageRoot || fresh.packageRoot !== this.installation?.packageRoot) {
      throw new UpdateFailure('INSTALL_CHANGED', '安装目录在更新期间发生变化，已停止切换')
    }
    if (!(await this.stageIsValid(run.target, run.stageRoot))) {
      throw new UpdateFailure('STAGE_INVALID', 'staged 安装已失效，请重试')
    }
    const installed = await this.currentVersion()
    if (installed !== this.current.previous) {
      throw new UpdateFailure(
        'VERSION_CHANGED',
        `当前版本已从 ${this.current.previous} 变为 ${installed}，已停止切换`,
      )
    }

    // With `acceptRisk` the user explicitly accepted that skipped sessions
    // will be interrupted, so a fresh activity scan would only re-litigate
    // that choice. Without it, every still-active session must be in the
    // successfully paused set.
    if (run.pauseSessionIds.length > 0 && !run.acceptRisk) {
      const active = await findUnpausedActivity((this.ctx as any), paused)
      if (active.length > 0) {
        throw new UpdateFailure(
          'NEW_ACTIVITY',
          `切换前发现 ${active.length} 个未暂停的会话仍有活动，请重新选择要暂停的会话`,
        )
      }
    }
    await this.log('切换前检查通过')
  }

  private async handleSwitchFailure(run: RunState, error: unknown): Promise<void> {
    const switchError = error instanceof SwitchError ? error : undefined
    const backup = switchError?.backupPath ?? this.current.backupPath
    if (backup && !switchError?.rolledBack) {
      await rollbackInstallation(this.installation!.packageRoot, backup, line => this.log(line))
    }
    if (backup) {
      this.current = {
        ...this.current,
        phase: 'rolled-back',
        backupPath: backup,
        error: {
          code: 'SWITCH_FAILED',
          message: switchError?.rolledBack
            ? '切换失败，已自动恢复到原版本。'
            : '切换失败，已从备份恢复。',
          action: switchError?.rolledBack ? undefined : 'manual-restore',
        },
        finishedAt: new Date().toISOString(),
      }
    } else {
      this.current = {
        ...this.current,
        phase: 'failed',
        error: { code: 'SWITCH_FAILED', message: '切换失败，未找到可恢复的备份。' },
        finishedAt: new Date().toISOString(),
      }
    }
    await this.store.writeLastResult(this.current)
    this.emit()
    await this.persist()
    await removeStage(run.stageRoot).catch(() => undefined)
  }

  private async failRun(run: RunState, error: unknown): Promise<void> {
    if (run.cancelled || this.current.phase === 'idle') return
    const wasStaging = this.current.phase === 'staging'
    const failure = asFailure(error)
    this.current = {
      ...this.current,
      phase: 'failed',
      progress: undefined,
      error: { code: failure.code, message: failure.message, ...(failure.action ? { action: failure.action } : {}) },
      finishedAt: new Date().toISOString(),
    }
    await this.log(`更新失败 ${failure.code}: ${failure.message}`).catch(() => undefined)
    if (wasStaging) {
      await removeStage(run.stageRoot).catch(() => undefined)
    }
    await this.store.writeLastResult(this.current).catch(() => undefined)
    this.emit()
    await this.persist().catch(() => undefined)
    this.run = undefined
  }

  // ---------------------------------------------------------------- Helpers

  private async buildPlan(
    target: string,
    candidate: VersionCandidate,
  ): Promise<UpdatePlan> {
    this.installation = await detectInstallation({ profileHome: (this.ctx as any).profileContext?.home })
    const compatibility: CompatibilityReport = await checkCompatibility({
      target,
      candidate,
      installation: this.installation,
      profileDir: (this.ctx as any).profileContext?.dir,
      config: this.config,
    })

    let sessions: SessionWork[] = []
    try {
      sessions = await listSessionWork((this.ctx as any))
    } catch (error) {
      compatibility.warnings.push({
        code: 'sessions-unavailable',
        message: `无法读取会话列表：${messageOf(error)}`,
      })
    }

    const plan: UpdatePlan = {
      target,
      compatibility,
      sessions,
      install: {
        mode: this.installation.mode,
        prefix: this.installation.prefix,
        writable: this.installation.writable,
        ...(candidate.unpackedSize ? { estimatedBytes: candidate.unpackedSize } : {}),
      },
    }
    this.planResult = plan
    return plan
  }

  private async requireCandidate(target: string): Promise<VersionCandidate> {
    if (!semver.valid(target)) throw new UpdateFailure('BAD_TARGET', `无效的版本：${target}`)
    const channel = channelOf(target)
    if (!channel) throw new UpdateFailure('BAD_TARGET', `只支持 rc/alpha 版本：${target}`)

    let check = this.checkResult
    if (!check || !check.versions.some(candidate => candidate.version === target)) {
      check = await this.check({ force: true })
    }
    const candidate = check.versions.find(version => version.version === target)
    if (!candidate) throw new UpdateFailure('UNKNOWN_VERSION', `registry 中没有版本 ${target}`)
    return candidate
  }

  private async canReuseStage(target: string): Promise<boolean> {
    if (this.current.target !== target) return false
    if (!['staged', 'paused', 'pausing'].includes(this.current.phase)) return false
    if (!this.persistedStageRoot) return false
    return this.stageIsValid(target, this.persistedStageRoot)
  }

  private async stageIsValid(target: string, stageRoot: string | undefined): Promise<boolean> {
    if (!stageRoot) return false
    const version = await readInstalledVersion(stagePackageRoot(stageRoot))
    return version === target
  }

  private async currentVersion(): Promise<string> {
    if (!this.installation?.packageRoot) {
      this.installation = await detectInstallation({
        profileHome: (this.ctx as any).profileContext?.home,
      })
    }
    const version = await readInstalledVersion(this.installation?.packageRoot ?? '')
    return version && semver.valid(version) ? version : '0.0.0-0'
  }

  private assertNotBusy(): void {
    if (
      this.run ||
      ['staging', 'pausing', 'switching', 'installed'].includes(this.current.phase)
    ) {
      throw new UpdateFailure('BUSY', '已有更新正在进行或等待重启')
    }
  }

  private async takeLock(): Promise<string> {
    try {
      const lock = await this.store.acquireInstallLock()
      return lock.token
    } catch (error) {
      if (error instanceof InstallBusyError) {
        throw new UpdateFailure('BUSY', error.message)
      }
      throw error
    }
  }

  private async releaseLock(run: RunState): Promise<void> {
    if (!run.token) return
    await this.store.releaseInstallLock(run.token).catch(() => undefined)
    run.token = undefined
  }

  private async writeLedger(sessions: SessionWork[], report: PauseReport): Promise<void> {
    const id = this.current.id || 'preflight'
    await this.store.writeLedger({
      updateId: id,
      createdAt: new Date().toISOString(),
      sessions: sessions.map(session => ({
        sessionId: session.sessionId,
        title: session.title,
        status: report.paused.includes(session.sessionId)
          ? 'paused'
          : report.timeouts.includes(session.sessionId)
            ? 'timeout'
            : report.failures.some(failure => failure.sessionId === session.sessionId)
              ? 'failed'
              : 'skipped',
        activities: session.activities.map(activity => activity.kind),
      })),
    })
  }

  private setProgress(
    step: 'preflight' | 'staging' | 'pausing' | 'switching' | 'verifying',
    percent: number,
    message: string,
  ): void {
    this.current = { ...this.current, progress: { step, percent, message } }
    this.emit()
  }

  private copyStatus(): UpdateStatus {
    return {
      ...this.current,
      ...(this.checkResult ? { check: this.checkResult } : {}),
      ...(this.current.error ? { error: { ...this.current.error } } : {}),
      ...(this.current.pauseReport
        ? {
            pauseReport: {
              ...this.current.pauseReport,
              paused: [...this.current.pauseReport.paused],
              skipped: [...this.current.pauseReport.skipped],
              timeouts: [...this.current.pauseReport.timeouts],
              failures: this.current.pauseReport.failures.map(failure => ({ ...failure })),
            },
          }
        : {}),
    }
  }

  private async persist(): Promise<void> {
    if (this.disposed) return
    const state = statusToState(this.current, {
      stageRoot: this.persistedStageRoot,
      ...(this.run
        ? {
            acceptRisk: this.run.acceptRisk,
            pauseSessionIds: this.run.pauseSessionIds,
          }
        : {}),
    })
    await this.store.writeState(state).catch(error => {
      this.logger.warn?.('dsh-update: cannot persist state', error)
    })
  }

  private emit(): void {
    if (this.disposed) return
    (this.ctx as any).emit('dsh-update/status', this.current)
  }

  private async log(message: string): Promise<void> {
    if (this.current.logPath) {
      await this.store.appendLog(this.current.logPath, message).catch(() => undefined)
    }
    (this.ctx as any).emit('dsh-update/log', { id: this.current.id, line: message })
    this.logger.info?.(message)
  }

  private scheduleBackgroundCheck(): void {
    const minutes = this.config.checkIntervalMinutes
    if (!Number.isFinite(minutes) || minutes <= 0) return
    this.timer = setInterval(() => {
      void this.backgroundCheck()
    }, Math.min(minutes * 60_000, 2_147_483_647))
    this.timer.unref?.()
  }

  private async backgroundCheck(): Promise<void> {
    if (this.disposed || this.run) return
    if (ACTIVE_PHASES.has(this.current.phase) || this.current.phase === 'installed') return
    try {
      await this.check({ force: false })
    } catch {
      // A background refresh never changes the visible error state of an idle panel.
    }
  }

  private stopBackgroundCheck(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private dispose(): void {
    this.disposed = true
    this.stopBackgroundCheck()
    this.run?.abort.abort(new Error('DSH 正在关闭'))
    if (this.run?.token) {
      void this.store.releaseInstallLock(this.run.token).catch(() => undefined)
    }
    this.run = undefined
  }
}

function asFailure(error: unknown): UpdateError {
  if (error instanceof UpdateFailure) {
    return {
      code: error.code,
      message: error.message,
      ...(error.action ? { action: error.action } : {}),
    }
  }
  return { code: 'INTERNAL', message: messageOf(error) }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { UpdateService }
export default UpdateService
