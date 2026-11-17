import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { CheckResult, PauseReport, PersistedState, UpdateStatus } from './types.js'

/** All files the plugin owns live under `<dshHome>/updates`. */
export class UpdateStore {
  readonly dir: string
  readonly statePath: string
  readonly cachePath: string
  readonly ledgerPath: string
  readonly lastResultPath: string
  readonly lockPath: string
  readonly logDir: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(dshHome: string) {
    this.dir = join(dshHome, 'updates')
    this.statePath = join(this.dir, 'state.json')
    this.cachePath = join(this.dir, 'registry-cache.json')
    this.ledgerPath = join(this.dir, 'pause-ledger.json')
    this.lastResultPath = join(this.dir, 'last-result.json')
    this.lockPath = join(this.dir, 'install.lock')
    this.logDir = join(this.dir, 'logs')
  }

  async ensure(): Promise<void> {
    await mkdir(this.logDir, { recursive: true, mode: 0o700 })
  }

  logPathFor(id: string): string {
    return join(this.logDir, `${id}.log`)
  }

  async readState(): Promise<PersistedState | undefined> {
    return readJson<PersistedState>(this.statePath)
  }

  /** Serialize state writes so two background transitions cannot interleave. */
  writeState(state: PersistedState): Promise<void> {
    const payload = `${JSON.stringify(state, undefined, 2)}\n`
    const run = async () => {
      await this.ensure()
      await writeFileAtomic(this.statePath, payload, { mode: 0o600, dirMode: 0o700 })
    }
    this.writeChain = this.writeChain.then(run, run)
    return this.writeChain
  }

  async clearState(): Promise<void> {
    await this.ensure()
    await unlink(this.statePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }

  async readCache(): Promise<RegistryCache | undefined> {
    return readJson<RegistryCache>(this.cachePath)
  }

  async writeCache(cache: RegistryCache): Promise<void> {
    await this.ensure()
    await writeFileAtomic(this.cachePath, JSON.stringify(cache), {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  async writeLedger(ledger: PauseLedger): Promise<void> {
    await this.ensure()
    await writeFileAtomic(this.ledgerPath, JSON.stringify(ledger, undefined, 2), {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  async writeLastResult(status: UpdateStatus): Promise<void> {
    await this.ensure()
    await writeFileAtomic(this.lastResultPath, JSON.stringify(status, undefined, 2), {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  async appendLog(logPath: string, message: string): Promise<void> {
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 })
    const line = `[${new Date().toISOString()}] ${redact(message)}\n`
    await appendText(logPath, line)
  }

  async readLog(
    logPath: string,
    offset = 0,
  ): Promise<{ content: string; nextOffset: number; eof: boolean }> {
    try {
      const buffer = await readFile(logPath)
      const start = Math.max(0, Math.min(offset, buffer.length))
      return {
        content: buffer.subarray(start).toString('utf8'),
        nextOffset: buffer.length,
        eof: true,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: '', nextOffset: 0, eof: true }
      }
      throw error
    }
  }

  /**
   * Cross-process guard for staging/switching. A live owner blocks a second
   * update; a stale pid (or an old malformed record) is taken over.
   */
  async acquireInstallLock(): Promise<InstallLock> {
    await this.ensure()
    const token = randomUUID()
    const payload = JSON.stringify({
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600)
        await handle.writeFile(payload, 'utf8')
        await handle.close()
        return { token, path: this.lockPath }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await readJson<{ token?: string; pid?: number; createdAt?: string }>(
          this.lockPath,
        ).catch(() => undefined)
        if (existing?.pid && isProcessAlive(existing.pid)) {
          throw new InstallBusyError(existing.pid)
        }
        // An owner that died mid-install leaves the lock behind; age protects
        // against a just-created lock whose JSON has not been flushed yet.
        if (!existing?.pid) {
          const info = await stat(this.lockPath).catch(() => undefined)
          if (info && Date.now() - info.mtimeMs < 30_000) throw new InstallBusyError(undefined)
        }
        await unlink(this.lockPath).catch(() => undefined)
      }
    }
    throw new InstallBusyError(undefined)
  }

  async releaseInstallLock(token: string): Promise<void> {
    const existing = await readJson<{ token?: string }>(this.lockPath).catch(() => undefined)
    if (existing?.token === token) await unlink(this.lockPath).catch(() => undefined)
  }
}

export interface InstallLock {
  token: string
  path: string
}

export class InstallBusyError extends Error {
  constructor(readonly ownerPid?: number) {
    super(
      ownerPid
        ? `另一个 DSH 更新进程正在运行（pid ${ownerPid}）`
        : '另一个 DSH 更新进程正在运行',
    )
    this.name = 'InstallBusyError'
  }
}

export interface RegistryCache {
  registry: string
  etag?: string
  fetchedAt: number
  packument: RegistryPackument
}

export interface RegistryPackument {
  name: string
  'dist-tags'?: Record<string, string>
  versions?: Record<string, RegistryVersion>
  time?: Record<string, string>
}

export interface RegistryVersion {
  version?: string
  deprecated?: string
  engines?: { node?: string; dsh?: string }
  dist?: { tarball?: string; integrity?: string; shasum?: string; unpackedSize?: number }
  [key: string]: unknown
}

export interface PauseLedger {
  updateId: string
  createdAt: string
  sessions: Array<{
    sessionId: string
    title: string
    status: 'paused' | 'timeout' | 'skipped' | 'failed'
    activities: string[]
  }>
}

export function statusToState(
  status: UpdateStatus,
  extra: Partial<PersistedState> = {},
): PersistedState {
  return {
    version: 1,
    ...status,
    ...extra,
  }
}

export function stateToStatus(state: PersistedState): UpdateStatus {
  const { version: _version, stageRoot: _stageRoot, acceptRisk: _acceptRisk, ...status } = state
  void _version
  void _stageRoot
  void _acceptRisk
  return status
}

export function mergeCheck(status: UpdateStatus, check: CheckResult): UpdateStatus {
  return { ...status, check }
}

export function emptyReport(): PauseReport {
  return { paused: [], skipped: [], timeouts: [], failures: [] }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function appendText(path: string, text: string): Promise<void> {
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
  } finally {
    await handle.close()
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Keep tokens and URL credentials out of logs. */
export function redact(message: string): string {
  return message
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***@')
    .replace(/(_authToken\s*[=:]\s*)\S+/gi, '$1***')
    .replace(/(authorization:\s*bearer\s+)\S+/gi, '$1***')
}

export function newUpdateId(): string {
  return `upd_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

/** Best-effort disk check; a missing/unsupported statfs is not a blocker. */
export async function hasFreeSpace(path: string, bytes: number): Promise<boolean | undefined> {
  try {
    const { statfs } = await import('node:fs/promises')
    const info = await statfs(path)
    return info.bavail * info.bsize >= bytes
  } catch {
    return undefined
  }
}

export function exists(path: string): boolean {
  return existsSync(path)
}
