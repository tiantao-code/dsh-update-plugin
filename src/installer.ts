import { spawn } from 'node:child_process'
import { constants as fsConstants, existsSync } from 'node:fs'
import { access, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import semver from 'semver'
import type { InstallationInfo, InstallationMode } from './types.js'

const DSH_PACKAGE = '@deepseek-ai/dsh'

export interface DetectOptions {
  /** From ctx.profileContext, when the Host was started from a profile. */
  profileHome?: string
}

/**
 * Locate the running installation from the process that actually runs it.
 * The plugin itself lives in a profile's node_modules, so resolving from
 * import.meta.url would find the profile copy, not the global installation.
 */
export async function detectInstallation(options: DetectOptions = {}): Promise<InstallationInfo> {
  const candidates: string[] = []
  if (process.env.DSH_INSTALLATION_ROOT) candidates.push(process.env.DSH_INSTALLATION_ROOT)
  if (process.env.DSH_BIN) candidates.push(process.env.DSH_BIN)

  const argvEntry = process.argv[1]
  if (argvEntry) {
    try {
      const resolved = await realpath(argvEntry)
      if (basename(resolved) === 'bin.js' && basename(dirname(resolved)) === 'lib') {
        candidates.push(dirname(dirname(resolved)))
      }
    } catch {
      // argv[1] may be a virtual path; other candidates can still succeed.
    }
  }

  if (options.profileHome) candidates.push(join(options.profileHome, 'installation'))

  for (const candidate of candidates) {
    const root = await findDshRoot(candidate)
    if (root) return describeInstallation(root)
  }

  return {
    mode: 'unknown',
    packageRoot: '',
    prefix: '',
    writable: false,
    reason: '无法从当前进程定位 @deepseek-ai/dsh 的安装目录。',
  }
}

async function findDshRoot(candidate: string): Promise<string | undefined> {
  let current: string
  try {
    current = await realpath(candidate)
  } catch {
    return undefined
  }
  // Accept a package root, lib/, or the bin.js inside it.
  if (basename(current) === 'bin.js') current = dirname(current)
  for (let depth = 0; depth < 4; depth += 1) {
    const manifest = await readPackageManifest(current)
    if (manifest?.name === DSH_PACKAGE) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

async function describeInstallation(root: string): Promise<InstallationInfo> {
  const manifest = await readPackageManifest(root)
  const scopeDir = dirname(root)
  const nodeModules = dirname(scopeDir)
  const hasNodeModules = basename(nodeModules) === 'node_modules'
  const prefix = hasNodeModules ? dirname(dirname(nodeModules)) : ''
  const binPath = prefix ? join(prefix, 'bin', 'dsh') : undefined
  let binTarget: string | undefined
  if (binPath) {
    try {
      binTarget = await realpath(binPath)
    } catch {
      binTarget = undefined
    }
  }

  const mode = detectMode(root, prefix)
  const writable =
    mode === 'npm-global' &&
    (await isWritable(root)) &&
    (await isWritable(scopeDir)) &&
    (await isWritable(prefix))

  return {
    mode,
    packageRoot: root,
    prefix,
    ...(binPath ? { binPath } : {}),
    ...(binTarget ? { binTarget } : {}),
    writable,
    ...(mode === 'npm-global'
      ? {}
      : { reason: explanation(mode, manifest?.version) }),
  }
}

function detectMode(root: string, prefix: string): InstallationMode {
  if (!prefix) return 'unknown'
  if (root.includes('.app/Contents/') || root.includes('/Applications/')) return 'desktop'
  if (root.includes('/Cellar/') || prefix.includes('/Cellar/')) return 'homebrew'
  if (root.includes('/.pnpm/') || /(^|\/)pnpm(\/|$)/.test(prefix)) return 'pnpm-global'
  if (
    existsAt(join(root, 'pnpm-workspace.yaml')) ||
    existsAt(join(root, '.git')) ||
    existsAt(join(root, 'packages', 'cli'))
  ) {
    return 'source'
  }
  if (root.includes('/node_modules/@deepseek-ai/dsh')) return 'npm-global'
  return 'unknown'
}

function explanation(mode: InstallationMode, version: string | undefined): string {
  const suffix = version ? `（当前 ${version}）` : ''
  switch (mode) {
    case 'homebrew':
      return `当前 DSH 由 Homebrew 管理${suffix}，请使用 brew upgrade。`
    case 'pnpm-global':
      return `当前 DSH 由 pnpm 全局安装${suffix}，首版只支持 npm 全局安装。`
    case 'desktop':
      return `当前是 DSH Desktop${suffix}，请通过桌面端更新。`
    case 'source':
      return '当前是源码 checkout，请手动执行 git pull && pnpm install && pnpm build。'
    default:
      return `无法识别当前 DSH 安装方式${suffix}，不会自动修改安装目录。`
  }
}

export interface NpmInstallOptions {
  prefix: string
  stageRoot: string
  /** Isolated npm cache for this update, removed with the stage on cancel. */
  cacheDir: string
  version: string
  registry: string
  allowBuildScripts: boolean
  signal?: AbortSignal
  onLog: (line: string) => void | Promise<void>
}

export async function installToStage(options: NpmInstallOptions): Promise<void> {
  const args = [
    'install',
    '-g',
    '--prefix',
    options.stageRoot,
    `${DSH_PACKAGE}@${options.version}`,
    '--no-audit',
    '--no-fund',
    '--cache',
    options.cacheDir,
    '--registry',
    options.registry,
  ]
  if (!options.allowBuildScripts) args.push('--ignore-scripts')

  await options.onLog(`执行 npm ${args.join(' ')}`)
  await runCommand('npm', args, {
    cwd: options.prefix,
    signal: options.signal,
    timeoutMs: 15 * 60 * 1000,
    onLine: options.onLog,
  })
}

export interface VerifyStageOptions {
  stageRoot: string
  version: string
  onLog: (line: string) => void | Promise<void>
}

export async function verifyStage(options: VerifyStageOptions): Promise<string> {
  const packageRoot = stagePackageRoot(options.stageRoot)
  const manifest = await readPackageManifest(packageRoot)
  if (!manifest) throw new Error('staged 安装缺少 @deepseek-ai/dsh/package.json')
  if (manifest.version !== options.version) {
    throw new Error(`staged 版本不匹配：期望 ${options.version}，实际 ${manifest.version}`)
  }
  const bin = join(packageRoot, 'lib', 'bin.js')
  await access(bin, fsConstants.R_OK)
  await options.onLog(`校验 staged 版本：${manifest.version}`)

  const output = await runCommand(process.execPath, [bin, '--version'], {
    cwd: packageRoot,
    timeoutMs: 30_000,
  })
  const printed = output.trim()
  if (!printed.includes(options.version)) {
    throw new Error(`staged 可执行文件版本校验失败：${printed || '(无输出)'}`)
  }
  await options.onLog(`staged 可执行文件自检通过：${printed}`)
  return packageRoot
}

export class SwitchError extends Error {
  constructor(
    message: string,
    readonly backupPath: string,
    readonly rolledBack: boolean,
  ) {
    super(message)
    this.name = 'SwitchError'
  }
}

export interface SwitchOptions {
  packageRoot: string
  stageRoot: string
  currentVersion: string
  targetVersion: string
  onLog: (line: string) => void | Promise<void>
}

/** Two renames on one filesystem; the second failing restores the first. */
export async function switchInstallation(options: SwitchOptions): Promise<string> {
  const stagePackage = stagePackageRoot(options.stageRoot)
  const [rootStat, stageStat] = await Promise.all([stat(options.packageRoot), stat(stagePackage)])
  if (rootStat.dev !== stageStat.dev) {
    throw new Error('staged 目录与安装目录不在同一文件系统，无法原子切换。')
  }

  const backup = join(
    dirname(options.packageRoot),
    `.dsh-backup-${options.currentVersion}-${Date.now()}`,
  )
  await options.onLog(`备份当前版本到 ${backup}`)
  await rename(options.packageRoot, backup)
  try {
    await rename(stagePackage, options.packageRoot)
  } catch (error) {
    await options.onLog('切换失败，正在恢复备份')
    let restored = true
    await rename(backup, options.packageRoot).catch(restoreError => {
      restored = false
      options.onLog(
        `恢复备份失败：${messageOf(restoreError)}；备份仍保留在 ${backup}`,
      ).catch(() => undefined)
    })
    throw new SwitchError(
      `切换失败：${messageOf(error)}${restored ? '（已恢复原版本）' : '（请手动恢复备份）'}`,
      backup,
      restored,
    )
  }
  return backup
}

export async function rollbackInstallation(
  packageRoot: string,
  backupPath: string,
  onLog: (line: string) => void | Promise<void>,
): Promise<void> {
  await onLog(`从备份恢复：${backupPath}`)
  const failed = join(dirname(packageRoot), `.dsh-failed-${Date.now()}`)
  try {
    await rename(packageRoot, failed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await rename(backupPath, packageRoot)
}

export async function removeStage(stageRoot: string): Promise<void> {
  await rm(stageRoot, { recursive: true, force: true })
}

export async function readInstalledVersion(packageRoot: string): Promise<string | undefined> {
  if (!packageRoot) return undefined
  const manifest = await readPackageManifest(packageRoot)
  return typeof manifest?.version === 'string' ? manifest.version : undefined
}

export function stagePackageRoot(stageRoot: string): string {
  return join(stageRoot, 'lib', 'node_modules', DSH_PACKAGE)
}

export function stageRootFor(prefix: string, updateId: string): string {
  return join(prefix, 'lib', 'node_modules', `.dsh-stage-${updateId}`)
}

/** The command a user can paste after the page disconnects. */
export function buildRestartCommand(argv = process.argv, cwd = process.cwd()): string {
  const args = argv.slice(2)
  const parts = ['dsh', ...args].map(shellQuote)
  const prefix: string[] = []
  if (cwd) prefix.push(`cd ${shellQuote(cwd)}`)
  if (process.env.DSH_HOME) prefix.push(`DSH_HOME=${shellQuote(process.env.DSH_HOME)}`)
  return [...prefix, parts.join(' ')].join(' && ')
}

export function parseVersion(value: string | undefined): string | undefined {
  const candidate = value?.trim().split(/\s+/).at(-1)
  return candidate && semver.valid(candidate) ? candidate : undefined
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string
    signal?: AbortSignal
    timeoutMs: number
    onLine?: (line: string) => void | Promise<void>
  },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        npm_config_yes: 'true',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: string[] = []
    let settled = false
    let buffer = ''

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
      fail(new Error(`${command} 超时（${Math.round(options.timeoutMs / 1000)} 秒）`))
    }, options.timeoutMs)
    timer.unref()

    const onAbort = () => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
      fail(new Error('操作已取消'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const pipe = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      chunks.push(text)
      buffer += text
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        void options.onLine?.(line)
        if (chunks.length > 2_000) chunks.splice(0, 1_000)
      }
    }
    child.stdout?.on('data', pipe)
    child.stderr?.on('data', pipe)
    child.on('error', error => fail(error))
    child.on('close', code => {
      if (buffer.trim()) void options.onLine?.(buffer)
      if (settled) return
      settled = true
      cleanup()
      if (code === 0) resolve(chunks.join(''))
      else reject(new Error(`${command} 退出码 ${code}`))
    })

    function fail(error: Error): void {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    function cleanup(): void {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  })
}

async function readPackageManifest(directory: string): Promise<{ name?: string; version?: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
      name?: string
      version?: string
    }
    return parsed
  } catch {
    return undefined
  }
}

async function isWritable(path: string): Promise<boolean> {
  if (!path) return false
  try {
    await access(path, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

function existsAt(path: string): boolean {
  return existsSync(path)
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
