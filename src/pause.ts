import { basename } from 'node:path'
import type { PauseReport, SessionWork } from './types.js'

interface SessionSummaryLike {
  sessionId: string
  running?: boolean
  blank?: boolean
  updatedAt?: number
  cwd?: string
}

interface ActivityLike {
  kind: string
  items?: ReadonlyArray<{ id: string; label?: string }>
}

export interface PauseOptions {
  sessionIds: string[]
  timeoutMs: number
  onLog?: (message: string) => void | Promise<void>
  signal?: AbortSignal
}

export interface PauseOutcome {
  report: PauseReport
  sessions: SessionWork[]
}

/**
 * Sessions are discovered through the public workspace seam. The plugin never
 * reaches into session internals and never calls archiveSession().
 */
export async function listSessionWork(ctx: any): Promise<SessionWork[]> {
  const signal = AbortSignal.timeout(5_000)
  const listed = await ctx.sessionController.list({}, signal)
  const sessions: SessionSummaryLike[] = Array.isArray(listed?.items) ? listed.items : []
  const work: SessionWork[] = []

  for (const session of sessions) {
    const sessionId = String(session.sessionId)
    let activities: ActivityLike[] = []
    try {
      activities = await readActivities(ctx, sessionId)
    } catch {
      activities = []
    }
    if (!session.running && activities.length === 0) continue
    work.push({
      sessionId,
      title: sessionTitle(session),
      ...(session.cwd ? { cwd: session.cwd } : {}),
      running: Boolean(session.running),
      lastActivityAt: Number(session.updatedAt ?? 0),
      activities: activities.map(activity => ({
        kind: activity.kind,
        ...(activity.items ? { count: activity.items.length } : {}),
        ...(activity.items
          ? { labels: activity.items.map(item => item.label ?? item.id).slice(0, 8) }
          : {}),
      })),
    })
  }

  return work.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
}

export async function pauseSessions(
  ctx: any,
  options: PauseOptions,
): Promise<PauseOutcome> {
  const report: PauseReport = { paused: [], skipped: [], timeouts: [], failures: [] }
  const allWork = await listSessionWork(ctx)
  const selected = new Set(options.sessionIds)
  const work = allWork.filter(session => selected.has(session.sessionId))

  for (const sessionId of options.sessionIds) {
    // The session may have finished between selection and this call. Nothing is
    // running, so treat it as already paused instead of reporting a timeout.
    if (!allWork.some(session => session.sessionId === sessionId)) {
      report.paused.push(sessionId)
    }
  }

  await Promise.all(
    work.map(async session => {
      options.signal?.throwIfAborted()
      try {
        await options.onLog?.(`暂停会话 ${session.sessionId}`)
        // Borrowing the same engine archive uses: providers of turn/job/
        // subagent/schedule react to this seam. We do not archive anything.
        await ctx.parallel('workspace/session-stop', { sessionId: session.sessionId })
      } catch (error) {
        report.failures.push({ sessionId: session.sessionId, message: messageOf(error) })
      }
    }),
  )

  const deadline = Date.now() + Math.max(1_000, options.timeoutMs)
  let pending = work.filter(
    session => !report.failures.some(failure => failure.sessionId === session.sessionId),
  )

  while (pending.length > 0 && Date.now() < deadline) {
    options.signal?.throwIfAborted()
    const still: SessionWork[] = []
    for (const session of pending) {
      let activities: ActivityLike[]
      try {
        activities = await readActivities(ctx, session.sessionId)
      } catch (error) {
        report.failures.push({
          sessionId: session.sessionId,
          message: `无法读取活动状态：${messageOf(error)}`,
        })
        continue
      }
      if (activities.length === 0) {
        report.paused.push(session.sessionId)
        await options.onLog?.(`会话 ${session.sessionId} 已暂停`)
      } else {
        still.push(session)
      }
    }
    pending = still
    if (pending.length > 0) {
      await sleep(250, options.signal)
    }
  }

  for (const session of pending) {
    report.timeouts.push(session.sessionId)
    await options.onLog?.(`会话 ${session.sessionId} 在超时内仍有活动`)
  }

  return { report, sessions: work }
}

export async function readActivities(ctx: any, sessionId: string): Promise<ActivityLike[]> {
  const result = await ctx.waterfall(
    'workspace/session-activity',
    { sessionId },
    () => Promise.resolve([]),
  )
  return Array.isArray(result) ? (result as ActivityLike[]) : []
}

/** True when an unpaused session still has work immediately before switching. */
export async function findUnpausedActivity(
  ctx: any,
  paused: ReadonlySet<string>,
): Promise<string[]> {
  const work = await listSessionWork(ctx)
  return work
    .filter(
      session =>
        session.activities.length > 0 ||
        (session.running && !paused.has(session.sessionId)),
    )
    .map(session => session.sessionId)
}

export function sessionTitle(session: SessionSummaryLike): string {
  if (session.cwd) {
    const name = basename(session.cwd)
    if (name && name !== '/') return name
  }
  return `会话 ${String(session.sessionId).slice(0, 8)}`
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
