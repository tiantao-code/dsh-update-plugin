import semver from 'semver'
import type { CheckResult, UpdateChannel, VersionCandidate } from './types.js'
import type { RegistryCache, RegistryPackument, RegistryVersion, UpdateStore } from './store.js'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
export const FALLBACK_REGISTRY = 'https://registry.npmmirror.com'
export const CACHE_TTL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000
const PACKAGE_NAME = '@deepseek-ai/dsh'

export interface CheckOptions {
  store: UpdateStore
  current: string
  registry: string
  fallbackRegistries: string[]
  allowDowngrade: boolean
  force: boolean
  signal?: AbortSignal
}

/**
 * Version discovery is intentionally narrow: one exact npm package, JSON
 * packument, no arbitrary tarball URLs. Only rc/alpha prereleases are
 * accepted; `latest` is a tag badge, never a "stable" signal.
 */
export async function checkVersions(options: CheckOptions): Promise<CheckResult> {
  const registries = uniqueRegistries([options.registry, ...options.fallbackRegistries])
  const cache = await options.store.readCache()
  const now = Date.now()

  if (
    !options.force &&
    cache &&
    cache.registry === registries[0] &&
    now - cache.fetchedAt < CACHE_TTL_MS
  ) {
    return resultFromPackument(cache.packument, {
      current: options.current,
      registry: cache.registry,
      cached: true,
      allowDowngrade: options.allowDowngrade,
    })
  }

  let lastError: string | undefined
  let usedCache: RegistryCache | undefined
  for (let index = 0; index < registries.length; index += 1) {
    const registry = registries[index]!
    const cachedForRegistry = cache?.registry === registry ? cache : undefined
    try {
      const response = await requestPackument(
        registry,
        cachedForRegistry?.etag,
        options.signal,
      )
      if (response.notModified && cachedForRegistry) {
        return resultFromPackument(cachedForRegistry.packument, {
          current: options.current,
          registry,
          cached: true,
          allowDowngrade: options.allowDowngrade,
        })
      }
      if (!response.packument) {
        lastError = `registry ${registry} 返回了无法识别的响应`
        continue
      }
      await options.store.writeCache({
        registry,
        etag: response.etag,
        fetchedAt: Date.now(),
        packument: response.packument,
      })
      return resultFromPackument(response.packument, {
        current: options.current,
        registry,
        cached: false,
        allowDowngrade: options.allowDowngrade,
      })
    } catch (error) {
      lastError = describeError(error)
      usedCache ??= cache
      // A configured fallback is only consulted when the preferred registry is
      // unreachable, and its versions are never merged with the primary ones.
      continue
    }
  }

  if (usedCache) {
    return {
      ...resultFromPackument(usedCache.packument, {
        current: options.current,
        registry: usedCache.registry,
        cached: true,
        allowDowngrade: options.allowDowngrade,
      }),
      offline: true,
      error: lastError,
    }
  }

  return {
    current: options.current,
    checkedAt: new Date().toISOString(),
    registry: registries[0] ?? DEFAULT_REGISTRY,
    cached: false,
    error: lastError ?? '无法连接 npm registry',
    latest: {},
    versions: [],
  }
}

export function channelOf(version: string): UpdateChannel | undefined {
  const prerelease = semver.prerelease(version)
  const channel = prerelease?.[0]
  return channel === 'rc' || channel === 'alpha' ? channel : undefined
}

/** Highest version per accepted channel, using SemVer ordering rather than publish time. */
export function latestByChannel(versions: VersionCandidate[]): CheckResult['latest'] {
  const latest: CheckResult['latest'] = {}
  for (const candidate of versions) {
    const current = latest[candidate.channel]
    if (!current || semver.compare(candidate.version, current) > 0) {
      latest[candidate.channel] = candidate.version
    }
  }
  return latest
}

export function candidatesFromPackument(
  packument: RegistryPackument,
  current: string,
  allowDowngrade: boolean,
): VersionCandidate[] {
  const versions = packument.versions ?? {}
  const distTags = packument['dist-tags'] ?? {}
  const result: VersionCandidate[] = []

  for (const [version, manifest] of Object.entries(versions)) {
    if (!semver.valid(version)) continue
    const channel = channelOf(version)
    if (!channel) continue
    result.push(candidateFor(version, manifest, distTags, packument, current, allowDowngrade))
  }

  return result.sort((a, b) => semver.rcompare(a.version, b.version))
}

function candidateFor(
  version: string,
  manifest: RegistryVersion,
  distTags: Record<string, string>,
  packument: RegistryPackument,
  current: string,
  allowDowngrade: boolean,
): VersionCandidate {
  const relation = semver.compare(version, current)
  const relationKind: VersionCandidate['relation'] =
    relation > 0 ? 'newer' : relation === 0 ? 'same' : 'older'
  const nodeRange = manifest.engines?.node
  const nodeCompatible =
    !nodeRange || semver.satisfies(process.versions.node, nodeRange, { includePrerelease: true })
  const deprecated =
    typeof manifest.deprecated === 'string'
      ? manifest.deprecated
      : manifest.deprecated === true
        ? '该版本已被标记为 deprecated'
        : undefined
  const downgradeBlocked = relationKind === 'older' && !allowDowngrade

  let disabledReason: string | undefined
  if (!nodeCompatible) {
    disabledReason = `需要 Node ${nodeRange ?? ''}（当前 ${process.versions.node}）`
  } else if (deprecated) {
    disabledReason = `已废弃：${deprecated}`
  } else if (downgradeBlocked) {
    disabledReason = '当前配置不允许降级'
  }

  return {
    version,
    channel: channelOf(version)!,
    tags: Object.entries(distTags)
      .filter(([, tagged]) => tagged === version)
      .map(([tag]) => tag)
      .sort(),
    publishedAt: packument.time?.[version],
    ...(deprecated ? { deprecated } : {}),
    ...(nodeRange ? { nodeRange } : {}),
    nodeCompatible,
    relation: relationKind,
    selectable: disabledReason === undefined,
    ...(disabledReason ? { disabledReason } : {}),
    ...(manifest.dist?.unpackedSize ? { unpackedSize: manifest.dist.unpackedSize } : {}),
    ...(manifest.dist?.integrity ? { integrity: manifest.dist.integrity } : {}),
  }
}

function resultFromPackument(
  packument: RegistryPackument,
  options: {
    current: string
    registry: string
    cached: boolean
    allowDowngrade: boolean
  },
): CheckResult {
  const versions = candidatesFromPackument(
    packument,
    options.current,
    options.allowDowngrade,
  )
  return {
    current: options.current,
    checkedAt: new Date().toISOString(),
    registry: options.registry,
    cached: options.cached,
    latest: latestByChannel(versions),
    versions,
  }
}

interface PackumentResponse {
  notModified: boolean
  etag?: string
  packument?: RegistryPackument
}

async function requestPackument(
  registry: string,
  etag: string | undefined,
  outerSignal: AbortSignal | undefined,
): Promise<PackumentResponse> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'dsh-update-plugin/0.1.0',
  }
  if (etag) headers['if-none-match'] = etag

  const path = encodeURIComponent(PACKAGE_NAME).replace('%40', '@')
  const response = await fetch(`${registry}/${path}`, {
    headers,
    signal,
    redirect: 'follow',
  })
  if (response.status === 304) {
    return { notModified: true, etag }
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} (${registry})`)
  }
  const packument = (await response.json()) as RegistryPackument
  assertPackument(packument)
  return {
    notModified: false,
    etag: response.headers.get('etag') ?? undefined,
    packument,
  }
}

function assertPackument(packument: RegistryPackument): void {
  if (!packument || typeof packument !== 'object') throw new Error('registry 响应不是对象')
  if (packument.name !== PACKAGE_NAME) {
    throw new Error(`registry 返回了意外的包名：${String(packument.name)}`)
  }
  if (!packument.versions || typeof packument.versions !== 'object') {
    throw new Error('registry 响应缺少 versions')
  }
}

function uniqueRegistries(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = normalizeRegistry(value)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result
}

export function normalizeRegistry(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`无效的 registry 地址：${value}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`registry 只支持 http(s)：${value}`)
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '连接 npm registry 超时（10 秒）'
    return error.message
  }
  return String(error)
}
