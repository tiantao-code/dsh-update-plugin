import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import semver from 'semver'
import type {
  BlockingIssue,
  CompatibilityReport,
  CompatibilityWarning,
  InstallationInfo,
  PluginCompatibility,
  UpdateConfig,
  VersionCandidate,
} from './types.js'
import { hasFreeSpace } from './store.js'

interface PackageManifest {
  name?: string
  version?: string
  dsh?: {
    manifestVersion?: number
    bundle?: { patch?: string | string[] }
    client?: { platform?: string }
  }
  engines?: { dsh?: string; node?: string }
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  workspaces?: unknown
}

export interface CompatibilityInput {
  target: string
  candidate?: VersionCandidate
  installation: InstallationInfo
  profileDir?: string
  config: UpdateConfig
}

/**
 * Declarative preflight. This cannot prove a plugin will boot; it only checks
 * the ranges plugins declare, so every finding keeps its original range text.
 */
export async function checkCompatibility(
  input: CompatibilityInput,
): Promise<CompatibilityReport> {
  const blocking: BlockingIssue[] = []
  const warnings: CompatibilityWarning[] = []

  const requiredNode = input.candidate?.nodeRange
  const nodeOk =
    !requiredNode ||
    semver.satisfies(process.versions.node, requiredNode, { includePrerelease: true })
  if (!nodeOk) {
    blocking.push({
      code: 'node-incompatible',
      message: `目标版本要求 Node ${requiredNode}，当前为 ${process.versions.node}。更新插件不会升级 Node。`,
      action: 'node',
    })
  }

  if (input.installation.mode !== 'npm-global') {
    blocking.push({
      code: 'installation-not-writable',
      message: installationReason(input.installation),
      action: input.installation.mode === 'source' ? 'source' : 'manual',
    })
  } else if (!input.installation.writable || !input.installation.packageRoot) {
    blocking.push({
      code: 'installation-not-writable',
      message: '当前 DSH 安装目录不可写，无法自动切换版本。',
      action: 'permissions',
    })
  }

  if (input.candidate?.unpackedSize) {
    const free = await hasFreeSpace(
      input.installation.prefix || input.installation.packageRoot,
      input.candidate.unpackedSize * 2,
    )
    if (free === false) {
      blocking.push({
        code: 'disk-space',
        message: `磁盘空间不足：安装约需 ${formatBytes(input.candidate.unpackedSize * 2)}。`,
        action: 'disk',
      })
    }
  }

  if (input.candidate?.relation === 'older') {
    warnings.push({
      code: 'downgrade',
      message: '目标版本低于当前版本；降级后 Session 数据格式可能不可读，请先备份。',
    })
  }

  const plugins = await collectPlugins(input)
  const incompatible = plugins.filter(plugin => plugin.status === 'incompatible')
  if (incompatible.length > 0) {
    warnings.push({
      code: 'plugins-incompatible',
      message: `${incompatible.length} 个插件声明的 DSH 版本范围不包含目标版本；建议更新前禁用它们。`,
    })
    if (!input.config.allowIncompatiblePlugins) {
      warnings.push({
        code: 'risk-required',
        message: '继续更新需要逐个确认风险，或先禁用不兼容插件。',
      })
    }
  }
  const unknown = plugins.filter(plugin => plugin.status === 'unknown')
  if (unknown.length > 0) {
    warnings.push({
      code: 'plugins-unknown',
      message: `${unknown.length} 个插件没有声明 DSH 版本范围，无法预检。`,
    })
  }
  const manifestWarnings = plugins.filter(plugin => plugin.status === 'manifest-warning')
  if (manifestWarnings.length > 0) {
    warnings.push({
      code: 'manifest-version',
      message: `${manifestWarnings.length} 个插件的 manifestVersion 不是 1；更新后可能无法加载。`,
    })
  }

  return {
    target: input.target,
    node: {
      current: process.versions.node,
      ...(requiredNode ? { required: requiredNode } : {}),
      ok: nodeOk,
    },
    plugins,
    blocking,
    warnings,
    canProceed: blocking.length === 0,
  }
}

async function collectPlugins(input: CompatibilityInput): Promise<PluginCompatibility[]> {
  const found = new Map<string, PluginCompatibility>()
  const profileManifest = await readProfileManifest(input.profileDir)

  const bundleNames = new Set<string>(profileManifest?.dsh?.profile?.bundles ?? [])
  for (const name of Object.keys(profileManifest?.dependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh')) bundleNames.add(name)
  }

  for (const name of bundleNames) {
    const directory = resolveProfileDependency(input.profileDir, name)
    if (!directory) {
      found.set(name, {
        name,
        status: 'unknown',
        detail: '无法在 profile 的 node_modules 中解析该 bundle',
        source: 'profile',
      })
      continue
    }
    const manifest = await readManifest(directory)
    if (!manifest) {
      found.set(name, {
        name,
        status: 'unknown',
        detail: 'package.json 不可读',
        source: 'profile',
      })
      continue
    }
    found.set(name, evaluate(name, manifest, input.target, 'profile'))
  }

  for (const entry of await scanInstallationBundles(input.installation.packageRoot)) {
    if (found.has(entry.name)) continue
    found.set(entry.name, evaluate(entry.name, entry.manifest, input.target, 'built-in'))
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function evaluate(
  name: string,
  manifest: PackageManifest,
  target: string,
  source: PluginCompatibility['source'],
): PluginCompatibility {
  const version = typeof manifest.version === 'string' ? manifest.version : undefined
  const range = manifest.engines?.dsh ?? manifest.peerDependencies?.['@deepseek-ai/dsh']
  const base = {
    name,
    ...(version ? { version } : {}),
    ...(range ? { range } : {}),
    source,
  }

  if (!range) {
    return {
      ...base,
      status: 'unknown',
      detail: '没有声明 engines.dsh 或 peerDependencies["@deepseek-ai/dsh"]',
    }
  }
  if (!semver.validRange(range)) {
    return { ...base, status: 'unknown', detail: `无法解析版本范围：${range}` }
  }

  const compatible = semver.satisfies(target, range, { includePrerelease: true })
  const manifestWarning =
    typeof manifest.dsh?.manifestVersion === 'number' && manifest.dsh.manifestVersion !== 1
  if (!compatible) {
    return {
      ...base,
      status: 'incompatible',
      detail: `${target} 不满足 ${range}`,
    }
  }
  if (manifestWarning) {
    return {
      ...base,
      status: 'manifest-warning',
      detail: `manifestVersion=${manifest.dsh?.manifestVersion}，当前仅支持 1`,
    }
  }
  return { ...base, status: 'ok', detail: `${target} 满足 ${range}` }
}

async function readProfileManifest(
  profileDir: string | undefined,
): Promise<PackageManifest | undefined> {
  if (!profileDir) return undefined
  return readManifest(profileDir)
}

function resolveProfileDependency(
  profileDir: string | undefined,
  name: string,
): string | undefined {
  if (!profileDir) return undefined
  try {
    const require = createRequire(join(profileDir, 'package.json'))
    try {
      return dirname(require.resolve(`${name}/package.json`))
    } catch {
      const entry = require.resolve(name)
      let directory = dirname(entry)
      for (let depth = 0; depth < 8; depth += 1) {
        if (existsSync(join(directory, 'package.json'))) return directory
        const parent = dirname(directory)
        if (parent === directory) break
        directory = parent
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

async function scanInstallationBundles(
  packageRoot: string,
): Promise<Array<{ name: string; manifest: PackageManifest }>> {
  if (!packageRoot) return []
  const result: Array<{ name: string; manifest: PackageManifest }> = []
  const nodeModules = join(packageRoot, 'node_modules')
  let scopes: string[]
  try {
    scopes = await readdir(nodeModules)
  } catch {
    return result
  }

  for (const scope of scopes) {
    if (!scope.startsWith('@')) continue
    let packages: string[]
    try {
      packages = await readdir(join(nodeModules, scope))
    } catch {
      continue
    }
    for (const packageName of packages) {
      const name = `${scope}/${packageName}`
      const manifest = await readManifest(join(nodeModules, scope, packageName))
      if (!manifest?.dsh?.bundle && !manifest?.dsh?.client) continue
      result.push({ name, manifest })
    }
  }
  return result
}

async function readManifest(directory: string): Promise<PackageManifest | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as PackageManifest
  } catch {
    return undefined
  }
}

function installationReason(installation: InstallationInfo): string {
  if (installation.reason) return installation.reason
  switch (installation.mode) {
    case 'source':
      return '当前是源码 checkout，请手动执行 git pull && pnpm install && pnpm build。'
    case 'homebrew':
      return '当前由 Homebrew 管理，请使用 brew upgrade。'
    case 'desktop':
      return '当前是 DSH Desktop 安装，请通过桌面端更新。'
    case 'pnpm-global':
      return '当前由 pnpm 全局管理，首版只支持 npm 全局安装。'
    default:
      return '无法识别当前 DSH 安装方式，无法自动切换版本。'
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
