# DSH 更新插件设计方案（v2）

> 决策版本：单包插件、仅检查 `rc` 与 `alpha`、允许降级、手动重启、第三方发布。
> 当前安装快照：`@deepseek-ai/dsh` **0.2.1-rc.5**，Node **v26.5.0**。
> registry 快照：`next=0.2.2-rc.3`、`alpha=0.2.2-alpha.3`、`latest=0.2.2-rc.1`。
> 原则：版本与通道从 registry 动态读取，不在代码里写死；所有危险操作可解释、可回滚、可恢复。

---

## 1. 结论与决策

### 1.1 不是三个插件，是一个包

上一版拆成 Host / Client / Bundle 三个包，是按 DSH 官方“每个 UI 面独立发布”的惯例设计的，对本功能属于过度拆分。**最终只生成一个 npm 包**，在同一个 `package.json` 里同时声明三种角色：

| 角色 | 声明 | 产物 |
| --- | --- | --- |
| Bundle | `dsh.bundle.patch` | `cordis.patch.yml`，向 profile 插入一行 |
| Host 插件 | `exports["."]` | `lib/index.js`，导出更新服务 |
| Client 插件 | `dsh.client` + `exports["./client"]` | `lib/client.js`，Web 面板 |

依据是 DSH 自身允许一个包声明多个角色：

- `dsh-package-manifest/lib/types/types.d.ts:27`：**“a package may declare several roles”**，`DshManifest` 同时有 `bundle`、`profile`、`client` 字段。
- `dsh-client-modules/lib/index.js:105-106`：客户端模块系统扫描 **host Loader 的 entries**，找声明了 `dsh.client` 的包；`:732-738` 读取该包的 `dsh.client` 并要求导出 `./client`。

也就是说，只要 bundle patch 插入**这个包自己**一行，这一行既加载 Host 半边，又会被客户端模块系统识别出 Client 半边。不需要第二个 UI 包，也不需要第三个 bundle 包。

### 1.2 已确认的产品决策

| 决策 | 结果 |
| --- | --- |
| 测试通道 | 只认 `alpha`。RC 通道取 `-rc.N`，测试通道取 `-alpha.N`。 |
| 降级 | 允许。默认展示在“更多版本”里，选择时给 Session 格式警告和确认。 |
| 重启 | 手动。插件只完成安装与切换，然后给出当前启动命令，由用户重启。 |
| 发布 | 第三方。使用自己的 npm scope，不占用 `@deepseek-ai`。 |
| 包数量 | 一个包。只有未来 UI 需要独立发布节奏时才拆出 Client 包。 |

### 1.3 一句话流程

检查 RC/Alpha 最新版 → 选择版本 → 兼容性预检 → 选择要暂停的 Session → 后台 staged 安装 → 暂停并等待静默 → 原子切换 → 提示手动重启 → 重启后验证并出结果。

---

## 2. 目标与非目标

### 2.1 目标

- 展示当前版本、最新 RC、最新 Alpha，以及可展开的全部版本。
- 用户选择目标版本，包括降级/重装。
- 更新前预检 Node、已装插件、安装方式、Session 格式。
- 若存在运行中的 Session，让用户确认是否中断，并逐项勾选要优雅暂停的 Session。
- 先下载安装、后暂停切换，把中断窗口压到几秒。
- 安装失败不影响当前安装；切换失败自动回滚。
- 手动重启后能验证新版本，并恢复上次更新状态。
- 过程可审计，失败有明确的下一步。

### 2.2 非目标

- 不更新 Node.js。
- 不更新其它插件；插件更新仍走 `plugin-manager`。
- 不支持 Windows 的原子替换（首版）。
- 不做自动重启、不接管 supervisor。
- 不管理其它 profile 或其它 DSH 进程中的 Session，只警告。
- 不自动恢复或重放未完成的回合。
- 不做静默自动更新。

---

## 3. 单包设计

### 3.1 包结构

```text
dsh-update/
  package.json
  cordis.patch.yml
  tsdown.config.ts
  src/
    index.ts              # Host：默认导出 UpdateService
    registry.ts           # registry 拉取与通道选择
    compatibility.ts      # Node / 插件 / 安装形态预检
    pause.ts              # activity / stop / 轮询
    installer.ts          # 探测、staged 安装、切换、回滚
    store.ts              # state / lock / ledger / logs
    types.ts
    client/
      index.tsx           # Client：apply / slots / locale
      UpdatePanel.tsx
      VersionStep.tsx
      CompatibilityStep.tsx
      SessionStep.tsx
      ProgressStep.tsx
      store.ts
      locales.ts
  locale/
    en.json
    zh.json
  lib/                    # 构建产物
    index.js
    client.js
    types/
```

### 3.2 包清单

```json
{
  "name": "@your-scope/dsh-update",
  "version": "0.1.0",
  "type": "module",
  "description": "Check and install DSH RC/Alpha updates from the Web UI.",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./typert": { "types": "./lib/typert.host.d.ts", "default": "./lib/typert.host.js" },
    "./remote": { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./locale/*.json": "./locale/*.json",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/**/*.js",
    "lib/types/**/*.d.ts",
    "lib/typert.*",
    "cordis.patch.yml",
    "locale/*.json",
    "package.json"
  ],
  "engines": {
    "node": ">=24.9.0",
    "dsh": ">=0.2.1-0 <0.3.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5"
  },
  "dependencies": {
    "@deepseek-ai/dsh-atomic-write": "0.2.1-rc.5",
    "@deepseek-ai/dsh-typert-protocol": "0.2.1-rc.5",
    "@deepseek-ai/schemastery": "~3.18.5",
    "semver": "^7.7.0"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ]
    }
  }
}
```

要点：

- `dsh.bundle.patch` 与 `dsh.client` 可以共存；`engines.dsh` 必须写宽范围，不能写 `^0.2.1-rc.5`，否则会挡住 `0.2.2-rc.*`（预发布 comparator 的 core 是 `0.2.1`）。
- `@deepseek-ai/dsh-atomic-write` 只用于状态文件；如果不想依赖内部包，可以用 `fs.rename` + 临时文件自己实现，但优先复用。
- `@deepseek-ai/schemastery` 是 DSH 插件配置的现成 schema 库；也可用 `zod`，但会多一个依赖。
- Client 侧不要打包 React 等共享依赖；用 `dsh.client.external` 或 DSH 的 baseline externals，避免双份 React。

### 3.3 patch 自插入

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-update
      name: '@your-scope/dsh-update'
```

这一行是 Host 入口。客户端模块系统会在同一个 Loader entry 上读到该包的 `dsh.client`，并加载 `./client`。因此：

- 不需要 `ui-dsh-update` 第二行。
- 不需要一个只做组合的空 bundle 包。
- 也不需要把 Host 和 Client 拆成两个 npm 包。

M0 必须实际验证一次“自引用 patch + 同包双面”能同时加载 Host 与 Client；如果 DSH 某版本对 self-row 有额外限制，退化方案是拆成 2 个包（Host+Bundle 一个，Client 一个），而不是回到 3 个。

### 3.4 什么情况下才拆包

只有以下情况才值得把 Client 拆出去：

- UI 需要独立于 Host 的发布节奏，且两者版本经常不兼容。
- Client 需要一套 Host 不需要的重型依赖，单包体积明显过大。
- 需要让用户只安装 UI、不安装 Host（本功能不成立）。

否则单包更简单：一个版本号、一次发布、一次安装、一个插件条目。

---

## 4. 总体架构

```text
┌────────────────────────────── Web Client ──────────────────────────────┐
│ 侧边栏「更新」面板 / 更新向导                                          │
│ ctx.remote.dshUpdate.check / plan / pause / start / status             │
│ ctx.remote.$on('dsh-update/status' | 'dsh-update/log')                 │
└────────────────────────────────┬──────────────────────────────────────┘
                                 │ Typert Remote
┌────────────────────────────────▼──────────────────────────────────────┐
│ Host: @your-scope/dsh-update（ctx.dshUpdate）                         │
│                                                                        │
│  VersionService       registry 拉取、RC/Alpha 选择、缓存               │
│  CompatibilityGuard   Node / 插件 / manifest / Session 格式            │
│  PauseCoordinator     activity 发现 → stop → 轮询静默 → 账本           │
│  Installer            安装探测、staged 安装、原子切换、回滚            │
│  UpdateStore          state.json、lock、logs、审计                     │
└───────┬──────────────────┬──────────────────┬─────────────────────────┘
        │                  │                  │
        ▼                  ▼                  ▼
  npm registry      ~/.dsh/updates      全局安装前缀 / 新 dsh 进程
```

职责边界：

- Host 是唯一能读 registry、写安装目录、读进程状态的层。
- Client 只发 RPC、展示状态，绝不直接 fetch registry 或执行安装命令。
- Bundle patch 只负责让 Host 半边被加载；Client 半边由 `dsh.client` 自动发现。

---

## 5. 版本检查

### 5.1 数据源

只查 npm registry，不依赖 GitHub API（当前环境 GitHub API 已触发 rate limit）：

```text
GET <registry>/@deepseek-ai%2Fdsh
Accept: application/json
If-None-Match: <cached etag>
```

- 默认 `https://registry.npmjs.org`。
- 可选 fallback `https://registry.npmmirror.com`，仅在首选不可达时使用。
- 只接受 package 名精确匹配 `@deepseek-ai/dsh` 的响应。
- 不允许用户输入任意 tarball URL 作为核心更新源。

### 5.2 两个通道

当前 registry 的 dist-tags 是：

| tag | 版本 | 用途 |
| --- | --- | --- |
| `next` | `0.2.2-rc.3` | 最新 RC |
| `alpha` | `0.2.2-alpha.3` | 最新 Alpha |
| `latest` | `0.2.2-rc.1` | **不是稳定版**，只是当前 latest 指向的 rc |

通道规则：

| 通道 | 规则 | 当前应选中 | UI 名称 |
| --- | --- | --- | --- |
| `rc` | `prerelease[0] === 'rc'`，取最高 SemVer | `0.2.2-rc.3` | RC 预览版 |
| `alpha` | `prerelease[0] === 'alpha'`，取最高 SemVer | `0.2.2-alpha.3` | Alpha 测试版 |

```ts
function channelOf(version: string): 'rc' | 'alpha' | undefined {
  const pre = semver.prerelease(version)?.[0]
  if (pre === 'rc') return 'rc'
  if (pre === 'alpha') return 'alpha'
  return undefined
}

function pickLatest(versions: string[], channel: 'rc' | 'alpha') {
  return versions
    .filter((v) => channelOf(v) === channel)
    .sort(semver.rcompare)[0]
}
```

注意：

- **不能按发布时间排序**。rc 与 alpha 交错发布，时间序会选错。
- **不能把 `latest` 当稳定版**。当前 `latest` 是 rc.1，且低于 `next` 的 rc.3；UI 只把它作为 tag 角标展示。
- 版本列表不要写死 `0.2.2`；所有值从 registry 元数据生成。
- `next` / `alpha` / `latest` 只是展示用的 tag，不参与选择逻辑。

### 5.3 候选过滤

```ts
interface VersionCandidate {
  version: string
  channel: 'rc' | 'alpha'
  tags: string[]
  publishedAt: string
  deprecated?: string
  nodeRange?: string
  nodeCompatible: boolean
  relation: 'newer' | 'same' | 'older'
  selectable: boolean
  disabledReason?: string
}
```

规则：

1. `semver.valid(version)` 必须为真。
2. `engines.node` 存在时，用 `semver.satisfies(process.versions.node, range, { includePrerelease: true })`；不满足则禁用并显示“需要 Node x.y.z”。
3. `deprecated` 默认不选，展开可见并显示原因。
4. 低于当前版本的候选允许选择（决策：允许降级），但放在“更多版本”里，标“降级”，选择时二次确认。
5. 等于当前版本的候选显示“重装”。
6. 高于当前版本的候选按 SemVer 排在前面。

### 5.4 缓存、超时与离线

- 缓存：`~/.dsh/updates/registry-cache.json`，TTL 5 分钟；手动检查强制刷新。
- 使用 `ETag` / `If-None-Match`；304 复用缓存。
- 超时 10s；失败时：
  - 有缓存 → 展示缓存并标“离线/可能过期”。
  - 无缓存 → 错误页 + 重试 + registry 设置。
- fallback registry 不与主 registry 的版本列表混合排序，避免供应链混淆。

### 5.5 版本表

| 字段 | 说明 |
| --- | --- |
| 版本 | `0.2.2-rc.3` |
| 通道 | RC / Alpha |
| 发布时间 | 本地时区 + 相对时间 |
| tag | `next`、`latest`、`alpha` 角标 |
| 兼容性 | Node / 插件 / 未知 |
| 操作 | 选择、详情 |

默认只展示 RC 与 Alpha 各自的最新版本；“查看全部版本”展开完整列表，包含降级/重装。

---

## 6. 兼容性预检

`plan(target)` 在暂停/安装前执行，返回阻塞项、警告项和可执行动作。

### 6.1 Node 运行时

- 读目标版本的 `engines.node`。
- 与 `process.versions.node` 比较。
- 不满足 → **阻塞**；文案说明“本插件不能升级 Node，请先升级 Node”。
- 重启后仍是同一个 Node 可执行文件，不要假设更新 DSH 会带 Node。

### 6.2 已安装插件

读取：

- profile 的 `package.json`（`dsh.profile.bundles`、dependencies）。
- profile `node_modules` 中每个 bundle 的 `package.json`。
- installation 自带的 bundle。
- 每个包的 `engines.dsh`、`peerDependencies['@deepseek-ai/dsh']`、`dsh.manifestVersion`。

判断：

```ts
const range = pkg.engines?.dsh ?? pkg.peerDependencies?.['@deepseek-ai/dsh']
const ok = !range || semver.satisfies(target, range, { includePrerelease: true })
```

**预发布陷阱（必须写进实现和测试）**：

- `^0.2.1-rc.5` 的 comparator core 是 `0.2.1`，默认规则下不匹配 `0.2.2-rc.3`。
- 插件作者应使用 `>=0.2.1-0 <0.3.0` 这类宽范围；预检必须 `includePrerelease: true`。
- 结果要显示原始 range，不能只显示 ok/not-ok，否则用户无法判断是插件声明问题还是 DSH 不兼容。

豁免语义：

- 不自动继承旧的 compatibility exemption。
- 不自动写新豁免。
- 不兼容插件默认动作是“更新前禁用该 bundle”，不是“强制继续”。
- 若用户坚持继续，逐个勾选风险确认；更新后展示插件加载失败清单。

`manifestVersion`：

- 当前读者不会因 `manifestVersion` 不匹配就拒绝加载；但目标 DSH 若提升支持版本，旧插件可能出现元数据读取问题。
- 作为 **warning**，不作为硬阻塞。

### 6.3 安装形态

- 探测安装方式、前缀、是否可写、磁盘空间。
- 不可写 → **阻塞**，给精确命令和复制按钮。
- 源码 checkout / Desktop / 未知包管理器 → **阻塞**，说明正确更新方式。
- 另一个更新正在进行 → **阻塞**。
- 磁盘空间小于“预计安装体积 × 2” → **阻塞**。

### 6.4 降级与 Session 格式

决策允许降级，但必须警告：

- 升级可能触发 Session 格式迁移（`formatStatus === 'migration-required'`）。
- **降级不保证旧版本能读新格式**。
- 降级时显示强警告，要求勾选“我已备份/接受不可读风险”。
- 不自动复制 Session 日志（体积大且可能含敏感内容）；只提示备份路径。
- 重装同版本不触发格式风险，但仍会重启 Host。

### 6.5 结果模型

```ts
interface CompatibilityReport {
  target: string
  node: { current: string; required?: string; ok: boolean }
  plugins: Array<{
    name: string
    version?: string
    range?: string
    status: 'ok' | 'incompatible' | 'unknown' | 'manifest-warning'
    detail?: string
  }>
  blocking: Array<{ code: string; message: string; action?: string }>
  warnings: Array<{ code: string; message: string }>
  canProceed: boolean
}
```

UI 把 `blocking` 放最上面，每项带可执行动作（升级 Node、禁用插件、打开插件页、复制命令）；`warnings` 折叠。

### 6.6 推荐动作：先禁用不兼容插件

对每个 `incompatible` 的 bundle 提供“更新前禁用”：

- 通过 `pluginManager` 的 bundle enable/disable 能力写入 profile patch。
- 记录到更新计划；更新成功后提示“这些插件因不兼容被禁用，可在插件页重新启用”。
- 不删除、不卸载插件包，避免丢失用户配置。

---

## 7. 会话中断与暂停

### 7.1 术语

| 术语 | 含义 |
| --- | --- |
| 优雅暂停 | 停止该 Session 的 turn/job/subagent/schedule，等待静默，已落盘内容保留 |
| 中断 | 进程直接退出，未完成回合被硬切断 |
| 未暂停 | 用户没有选择优雅暂停，重启时会被中断 |

“暂停”不是 DSH 的持久 Session 状态；它是更新插件在本次更新期间执行的协调动作。更新完成后 Session 恢复为普通会话，用户可继续对话。

### 7.2 发现活动

使用 workspace 的统一 seam，而不是自己拼四个服务：

```ts
const active = await ctx.waterfall(
  'workspace/session-activity',
  { sessionId },
  () => Promise.resolve([]),
)
```

返回示例：

```ts
[
  { kind: 'turn' },
  { kind: 'job', items: [{ id: 'job-1', label: 'pnpm build' }] },
  { kind: 'subagent', items: [{ id: 'sess-child', label: 'review' }] },
  { kind: 'schedule', items: [{ id: 'daily-check' }] },
]
```

对 `sessionController.list()` 中 `running` 的 Session 逐个查询；同时把 `running=false` 但 activity 非空的 Session 也纳入（例如后台 job 还在跑）。

### 7.3 停止

```ts
await ctx.parallel('workspace/session-stop', { sessionId })
```

这条路径与 DSH“归档 Session 前的停止流程”使用同一组 provider，覆盖：

- Agent turn 取消；
- 该 Session 拥有的后台 job kill；
- 运行中的子代理/后代停止；
- 活跃的定时提醒取消。

**它不会等待工作结束**，所以必须继续轮询 activity。

语义注意：`workspace/session-stop` 当前文档的上下文是 archive admission；更新插件借用它，是因为它正好聚合四类 provider，而不是因为它叫“暂停”。落地时必须在代码注释和评审里写清这一点。不要调用 `archiveSession()`（会把 Session 从列表隐藏），也不要把“归档”写进用户文案。若上游认为该事件不应被复用，备选方案是直接调用四类 provider，或向上游提议新增中性的 `session/suspend` 事件。

### 7.4 静默判定

```ts
async function pauseSession(
  ctx: Context,
  sessionId: string,
  timeoutMs: number,
): Promise<PauseResult> {
  await ctx.parallel('workspace/session-stop', { sessionId })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const active = await ctx.waterfall(
      'workspace/session-activity',
      { sessionId },
      () => Promise.resolve([]),
    )
    if (active.length === 0) return { sessionId, status: 'paused' }
    await sleep(250)
  }

  return {
    sessionId,
    status: 'timeout',
    active: await ctx.waterfall(
      'workspace/session-activity',
      { sessionId },
      () => Promise.resolve([]),
    ),
  }
}
```

建议超时 15s，并行暂停多个 Session，每个 Session 状态独立记录。

超时处理：

- 不静默继续；弹窗列出仍在运行的 turn / job / subagent / schedule。
- 选项：继续等待、跳过该 Session、取消更新。
- “跳过”等同于“未暂停”，切换时会硬中断，必须二次确认。

### 7.5 用户选择 UI

“会话处理”步骤：

- 列出所有有活动的 Session：标题、cwd、最后活动时间、活动家族标签。
- 默认全选；“全部暂停”“全不选”快捷键。
- 当前正在查看的 Session 标记“当前会话”，仍可勾选；文案说明勾选后页面会短暂无响应，重启后可继续。
- 未勾选的运行中 Session 显示红色风险标记。
- 选项：
  - `暂停选中会话（推荐）`
  - `不暂停，直接更新（不推荐）` — 需要勾选风险确认。
- 底部汇总：“将暂停 3 个会话；2 个运行中会话未暂停，重启时会被中断。”

### 7.6 边界情况

**当前会话 / 调用来源**

- 只允许从 Web 面板发起更新，不允许 Agent 工具在回合内直接触发更新。
- Agent 工具调用本身处于一个 turn 中，暂停该 Session 会取消工具调用，形成自指。
- 如果未来提供 Agent 工具，只提供“检查版本 / 打开发布面板”，不提供“立即更新”。

**新会话在准备期间启动**

- 下载/安装可能持续数分钟，用户可能新开 Session。
- 切换前重新扫描一次 activity；发现不在已暂停集合中的新活动 → 停止切换，回到会话选择步骤。
- 不自动暂停新会话，避免在用户不知情时取消别人的工作。

**其它 profile / 其它 DSH 进程**

- `sessionController` 只能看到当前 Host 的 Session。
- 全局更新会影响同一个安装下的所有 profile。
- `~/.dsh/updates/install.lock` 防止同插件并发更新。
- best-effort 扫描 `ps` 中的 `dsh` 进程 / 端口，发现其它实例时警告并要求确认。
- 文案明确：“本插件只能暂停当前 Web 服务中的会话；其它终端/TUI/其它端口的 DSH 需要你手动停止。”
- 不承诺跨进程自动暂停。

**终端 PTY**

- 终端进程不会随 Session 暂停而保留；Host 退出时 PTY 会终止。
- 如果存在活跃 terminal，单独提示“终端会话会被关闭，命令输出可能丢失”。
- 不把 terminal 当作可恢复 Session 的一部分。

**定时提醒**

- `workspace/session-stop` 会取消活跃提醒，但周期性 schedule 可能在维护窗口内再次触发。
- 暂停后、切换前再次扫描 activity；若 schedule 重新唤醒，重新暂停或中止。
- 维护窗口应尽量短（staged 安装完成后才暂停）。

**队列与未完成回合**

- `sessionController.cancel()` 的语义是取消当前 turn 但保留 pending inbox；排队消息不会因暂停丢失。
- 已落盘消息保留；当前回合未落盘的增量可能丢失。
- UI 不使用“绝不丢数据”这种承诺，使用“已保存的消息保留，未完成的回合可能丢失”。

### 7.7 暂停账本

写 `~/.dsh/updates/pause-ledger.json`：

```json
{
  "updateId": "upd_...",
  "createdAt": "2026-11-17T...",
  "sessions": [
    {
      "sessionId": "sess_...",
      "title": "...",
      "status": "paused",
      "activities": ["turn", "job"]
    }
  ]
}
```

用途：

- 重启后展示“更新前暂停了哪些会话”。
- 提供“打开会话”入口，不自动注入消息、不自动恢复回合。
- 崩溃恢复时判断哪些 Session 可能处于半停止状态。

账本只是插件元数据，不写入 Session 日志，避免污染模型上下文。

---

## 8. 安装与切换

### 8.1 安装形态探测

| 形态 | 判定 | 首版策略 |
| --- | --- | --- |
| npm 全局 | `realpath(argv[1])` 位于 `npm prefix -g` 下 | 支持 |
| pnpm 全局 | 位于 pnpm global dir / store 符号链接 | 只读提示 |
| Homebrew 托管 | `brew list --formula` 命中 / 路径属于 brew | 只读提示 |
| Desktop 内置 | Desktop profile / 安装器自有目录 | 只读提示，交给 Desktop |
| 源码 checkout | 包根含 `pnpm-workspace.yaml` / `.git` | 只读提示：`git pull && pnpm install && pnpm build` |
| 未知 | 以上都不匹配 | 只读提示 + 当前路径 |

```ts
interface InstallationInfo {
  mode: 'npm-global' | 'pnpm-global' | 'homebrew' | 'desktop' | 'source' | 'unknown'
  packageRoot: string       // 当前 @deepseek-ai/dsh
  prefix: string            // 全局前缀
  binPath: string           // /opt/homebrew/bin/dsh
  binTarget: string         // 解析后的 bin.js
  writable: boolean
  reason?: string
}
```

### 8.2 staged 安装

核心原则：**安装失败不能影响当前可用安装**。

1. 在目标前缀的同一文件系统创建 staging 目录：
   `<prefix>/lib/node_modules/.dsh-stage-<updateId>/`
2. 用 npm 安装到 staging：

   ```bash
   npm install -g --prefix <stage> @deepseek-ai/dsh@<version> \
     --ignore-scripts --no-audit --no-fund \
     --cache <prefix>/.dsh-cache/<updateId> \
     --registry <registry>
   ```

   - `--prefix` 让 npm 生成 `<stage>/lib/node_modules/@deepseek-ai/dsh` 与 `<stage>/bin/dsh`。
   - 使用独立 cache，绕过用户 npm cache 可能存在的权限问题。
   - `--ignore-scripts` 默认开启；若安装日志显示依赖需要 build script，列出包名并让用户选择“允许并重试”，不静默执行。
3. 校验：
   - `staging/.../dsh/package.json` 的 `version` 精确等于目标版本。
   - `staging/.../dsh/lib/bin.js` 存在。
   - 运行 `node staging/.../dsh/lib/bin.js --version`，输出匹配。
   - 可选：针对临时 profile 跑 `--dump-config`。
   - 可选：核对 npm 元数据中的 `dist.integrity`（npm 安装时已校验，再核对一次）。

为什么先安装再暂停：下载与依赖安装是主要耗时，放在会话仍可运行时完成，把暂停窗口压到切换的几秒。

### 8.3 原子切换

切换前再做一次 preflight：

- 当前包根仍然是探测时的路径。
- 目标 staging 仍完整。
- 没有新的未暂停活动。
- 磁盘空间足够完成两次 rename。

切换：

```text
backup = <prefix>/lib/node_modules/@deepseek-ai/.dsh-backup-<currentVersion>-<timestamp>
rename(<prefix>/lib/node_modules/@deepseek-ai/dsh, backup)
rename(<stage>/lib/node_modules/@deepseek-ai/dsh, <prefix>/lib/node_modules/@deepseek-ai/dsh)
```

- staging 与目标必须在同一文件系统，`rename` 才是原子的；不要把 staging 放到 `/tmp` 或另一个卷。
- `bin/dsh` 符号链接通常仍指向 `../lib/node_modules/@deepseek-ai/dsh/lib/bin.js`，路径不变，无需重写；如果探测到绝对链接或 `.cmd` shim，单独处理并记录。
- 切换窗口内不处理新的更新请求。

**切换时机与混用窗口**

手动重启意味着“切换”和“旧进程退出”之间一定有一个窗口。方案选择是：**暂停完成后立即切换，然后停在 `installed` 等待用户重启**。原因是当前没有可靠的“退出时执行切换”钩子，拖到重启时缺少执行点。

这个窗口有一个真实风险：旧 Host 已经加载的模块还在内存里，但磁盘上的包目录已经换成新版本；如果旧 Host 在窗口内懒加载某个尚未加载的模块，可能读到新代码，形成新旧混用。

首版的处理：

- 切换后插件自身停止后台检查、拒绝再次更新，UI 固定显示“已安装，请立即重启”。
- 不承诺“零混用”；文档和 UI 都要求用户尽快重启。
- 切换前不打开新的面板/新会话不做强制限制（无法可靠拦截所有插件），但会在确认页提示“更新完成后请立即重启”。
- 若未来要求零窗口，采用版本化安装目录 + `current` 符号链接，在进程退出时切链接；或提供一个独立的 apply helper，在用户重启命令里完成切换。这些都不作为首版。

`bin/dsh` 仍然指向 `dsh/lib/bin.js`，所以用户重新执行原命令就会加载新目录。切换后插件只写状态、发提示，不主动 `process.exit()`；退出由用户的重启动作触发。

### 8.4 回滚

- 保留上一版本备份，直到用户重启并确认新版本可用。
- 切换后、重启前发现异常（例如 `--version` 失败）→ 立即把 backup rename 回来。
- 重启失败后由用户或下一次 Host 启动时的恢复逻辑回滚：
  1. 停止失败的新进程（如果还活着）。
  2. 将损坏的新目录移到 `.dsh-failed-<version>-<ts>`。
  3. 把 backup rename 回 `dsh`。
  4. 用旧版本重新启动，写失败报告。
- 磁盘占用：默认只保留 1 份备份；可在设置中调整或手动清理。
- 数据不回滚：Session 格式可能已前向迁移，旧版本不一定能读；报告里明确说明。

### 8.5 降级/重装

- 降级走同一条 staged 安装 + 切换路径，只是目标版本低于当前版本。
- UI 标“降级”，给 Session 格式警告和确认；不默认禁止。
- 重装同版本也走同一路径，用于修复损坏的安装；不触发格式警告。
- 降级后如果旧版本无法读取新格式 Session，插件不自动修复；提示备份和升级回退路径。

### 8.6 其它包管理器

- **pnpm 全局**：目录通常是符号链接到 store，直接 rename 会破坏链接语义。首版不写，给 `pnpm add -g @deepseek-ai/dsh@<version>` 命令。
- **Homebrew**：不要绕过 brew 写 Cellar；给 `brew upgrade` 或卸载重装指引。
- **Desktop**：更新归 Desktop shell 所有；插件只显示版本和“请使用桌面端更新”。
- **源码 checkout**：不碰工作区；给 git/pnpm 命令。

### 8.7 权限与安全

- 不做 `sudo`，不弹系统提权。
- 不可写时展示精确命令，带复制按钮；说明“需要写权限的是全局安装前缀，不是当前项目”。
- 不把 registry token 写进日志；URL 中的 userinfo 要脱敏。
- 只允许从配置的 registry 安装；不允许用户输入任意 tarball URL 作为核心更新源。
- 目标版本必须来自本次检查结果的候选列表；安装前重新拉取元数据确认该版本仍存在且未被撤回。
- 默认不执行依赖的 install/postinstall 脚本；需要时逐项批准。

---

## 9. 手动重启与验证

### 9.1 为什么手动

当前 DSH 没有公开的 restart API。`internal/update` 是 Cordis fiber 更新事件，不是进程重启器；`process-shutdown` 只提供优雅退出，不提供重新拉起。自动重启需要 detached relauncher + 信号 + 端口等待 + 健康检查 + 回滚，复杂度和 supervisor 冲突风险都高。

决策：**首版只做手动重启**。插件完成安装与切换后，给出当前启动命令，由用户执行。

### 9.2 完成后提示

```text
DSH 0.2.2-rc.3 已安装。
请重启当前 DSH 进程以完成更新：

  dsh web --port 3080

当前页面会断开；重启后浏览器需要 Reload。
[复制命令] [查看日志]
```

命令不要写死：Host 启动时记录自己的 `argv`、`cwd`、关键环境变量，展示实际命令。例如用户从 `dsh web` 启动，就显示 `dsh web`；带 `--port 8080` 就显示 `--port 8080`。

### 9.3 状态与恢复

`state.json` 阶段：

| 阶段 | 启动时恢复 |
| --- | --- |
| `checking` / `planning` | 标记为已取消，清理临时文件 |
| `staged` | staging 可能完整；提示“继续安装”或清理 |
| `pausing` | 重新扫描 activity；提示哪些 Session 已暂停 |
| `switching` | 检查当前包版本/备份：目标版本在 → 标记 `installed`；旧版本在 → 标记失败；目录缺失 → 恢复备份 |
| `installed` | 等待用户重启；下次启动时验证版本 |
| `done` / `failed` | 展示结果，允许清理备份 |

重启后验证：

1. 当前运行的 `@deepseek-ai/dsh` 版本等于目标版本。
2. `pluginManager.listBundles()` 可返回，且没有大面积 load error。
3. 更新插件自身能加载（否则说明 Client/Host 兼容性有问题）。
4. 若版本仍等于旧版本 → 用户还没重启，保持 `installed` 并提示。
5. 若版本既不是旧版本也不是目标版本 → 报“安装状态异常”，给恢复入口。

### 9.4 页面 Reload

Host 重启后：

- 旧页面连接断开，DSH 客户端重连时发现 release identity 变化。
- 现有 “Service version changed” 对话框提示 Reload；用户点 Reload 后加载新 client bundle。
- 更新插件在重启前发 `dsh-update/status = installed`，页面显示“已安装，等待重启”。
- 不尝试在旧页面里热替换新版本模块；DSH 的 release identity 机制已经明确禁止。

### 9.5 崩溃恢复

- 所有状态写入使用原子写（`@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic` / `withFileLock`）。
- 切换中崩溃：启动时比较当前目录、backup、staging 的版本，决定完成或回滚。
- 暂停中崩溃：Session 可能已停止但未写账本；启动时扫描 activity 并提示。
- 重启前崩溃：保持 `installed`，用户下次启动时验证。

---

## 10. 交互设计

### 10.1 入口

- 主入口：Web 侧边栏“更新”，有新版本时显示 badge。
- 次入口：Settings → General 的版本行，提供“检查更新”链接。
- 不放在 Plugins 页面：插件管理更新插件，本插件更新 DSH 核心，语义不同。

### 10.2 向导

```text
① 版本
  当前 0.2.1-rc.5
  [RC 预览版] 0.2.2-rc.3   next   3 天前  [选择]
  [Alpha 测试版] 0.2.2-alpha.3 alpha 14 天前 [选择]
  查看全部版本 ▾   （含降级/重装）

② 兼容性
  Node 26.5.0 ✓
  已装插件 12 个，2 个不兼容  [查看] [更新前禁用]
  安装方式 npm 全局 ✓
  ⚠ 升级可能迁移 Session 格式，降级不保证可读

③ 会话
  运行中的会话（3）
  ☑ 重构 runner        ~/code/a   turn, job
  ☑ 调研 DSH 插件       ~/code/b   turn
  ☐ 当前会话            ~/code/c   idle
  [全部暂停] [全不选]
  ○ 暂停选中会话（推荐）
  ○ 不暂停，直接更新（不推荐）

④ 确认
  目标 0.2.2-rc.3
  方式 npm 全局 staged 安装
  暂停 2 个会话；1 个运行中会话未暂停
  ☑ 我了解更新需要手动重启 DSH，页面需要 Reload
  [开始更新]

⑤ 执行
  ✓ 检查版本
  ✓ 兼容性预检
  ✓ 下载并安装到 staging
  ✓ 暂停会话
  → 切换安装
  ✓ 等待手动重启

⑥ 结果
  ✓ DSH 0.2.2-rc.3 已安装
  [复制重启命令] [查看日志] [刷新页面]
  或
  ✗ 更新失败，已回滚到 0.2.1-rc.5
```

### 10.3 文案要点

- “中断”和“暂停”必须区分，不能混用。
- “未暂停的会话会被硬中断”放在勾选列表上方，而不是折叠在帮助里。
- “当前页面会断开”在确认页明确写出。
- 不使用“无损”“保证不丢消息”；使用“已保存的消息保留，未完成回合可能丢失”。
- 失败时给“下一步做什么”，不只给错误码。
- 降级时明确写“旧版本可能无法读取新格式 Session”。

### 10.4 状态机

```text
idle
  → checking
  → ready
  → planning
  → ready
  → staging        // 可取消，不中断会话
  → staged
  → pausing        // 可取消；超时需用户决策
  → paused
  → switching      // 极短；不可取消
  → installed      // 等待手动重启
  → done | failed | rolled-back
```

- `staging` 之前取消：无副作用。
- `pausing` 中取消：不自动恢复回合，把账本标记 `cancelled`，提示用户。
- `switching` 之后取消：不支持，只能等待完成或回滚。

### 10.5 错误 UX

| 错误 | 展示 | 动作 |
| --- | --- | --- |
| registry 不可达 | 有缓存则展示缓存 + 过期标记；否则错误 | 重试 / 换 registry |
| Node 不满足 | 目标版本卡片禁用 | 升级 Node 指引 |
| 安装前缀不可写 | 阻塞页 | 复制命令 / 查看权限说明 |
| 插件不兼容 | 列表 | 更新前禁用 / 仍要继续（逐项确认） |
| 会话暂停超时 | 弹窗列出活动 | 继续等待 / 跳过 / 取消 |
| npm 安装失败 | 阶段错误 + 日志 | 重试 / 换 registry / 取消 |
| 切换失败 | 自动回滚结果 | 查看日志 / 重试 |
| 重启后版本不对 | 状态异常 | 查看日志 / 恢复备份 |
| 页面版本不匹配 | DSH 自带对话框 | Reload |

---

## 11. Host / Client API

### 11.1 配置

```ts
const Config = z.object({
  registry: z.string().default('https://registry.npmjs.org'),
  fallbackRegistries: z.array(z.string()).default(['https://registry.npmmirror.com']),
  checkIntervalMinutes: z.number().default(360),
  pauseTimeoutMs: z.number().default(15000),
  allowIncompatiblePlugins: z.boolean().default(false),
  allowDowngrade: z.boolean().default(true),
  allowBuildScripts: z.boolean().default(false),
})
```

说明：

- `checkIntervalMinutes: 0` 关闭后台检查，只保留手动。
- `allowDowngrade` 默认 true（决策允许），UI 仍会给警告和确认。
- 没有 `restartMode`：重启固定手动。
- 没有 `channels`：通道固定 RC + Alpha，避免用户把测试版定义改乱。

### 11.2 类型

```ts
type Channel = 'rc' | 'alpha'
type Phase =
  | 'idle' | 'checking' | 'ready' | 'planning'
  | 'staging' | 'staged' | 'pausing' | 'paused'
  | 'switching' | 'installed'
  | 'done' | 'failed' | 'rolled-back'

interface CheckResult {
  current: string
  checkedAt: string
  registry: string
  cached: boolean
  latest: Partial<Record<Channel, VersionCandidate>>
  versions: VersionCandidate[]
}

interface UpdatePlan {
  target: string
  compatibility: CompatibilityReport
  sessions: SessionWork[]
  install: {
    mode: InstallationInfo['mode']
    prefix: string
    writable: boolean
    estimatedBytes?: number
  }
}

interface PauseReport {
  paused: string[]
  skipped: string[]
  timeouts: Array<{ sessionId: string; active: SessionActivity[] }>
  failures: Array<{ sessionId: string; error: string }>
}

interface UpdateStatus {
  id: string
  phase: Phase
  target: string
  previous: string
  progress?: { step: string; percent?: number; message?: string }
  error?: { code: string; message: string; detail?: string }
  startedAt: string
  finishedAt?: string
  restartCommand?: string
  logPath: string
}
```

### 11.3 Host 服务方法

```ts
class UpdateService extends TypertRemoteService {
  static inject = ['sessionController', 'jobController', 'pluginManager']
  static Config = Config

  @Remote check(req?: { force?: boolean }): Promise<CheckResult>

  @Remote plan(target: string): Promise<UpdatePlan>

  @Remote pause(req: { sessionIds: string[] }): Promise<PauseReport>

  @Remote start(req: {
    target: string
    pauseSessionIds: string[]
    acceptRisk: boolean
  }): Promise<{ id: string }>

  @Remote status(): Promise<UpdateStatus>

  @Remote cancel(id: string): Promise<void>

  @Remote logs(req: { id: string; offset?: number }): Promise<{ chunk: string; next: number }>
}
```

约定：

- `check` 只读 registry，不写安装目录。
- `plan` 只读文件系统/进程，不暂停、不安装。
- `pause` 可单独调用，便于 UI 先暂停再确认；`start` 内部会再次确认暂停集合。
- `start` 立即返回 `id`，后续通过事件/`status` 推送，不把长任务挂在一次 RPC 上。
- `cancel` 只在 `staging` / `pausing` 有效；`switching` 之后返回明确错误。
- 没有 `restart` 方法：重启由用户执行，插件只返回 `restartCommand`。

### 11.4 事件

```ts
'dsh-update/status'  // UpdateStatus
'dsh-update/log'     // { id, chunk }
```

Client：

```ts
ctx.remote.$on('dsh-update/status', (status) => controller.apply(status))
ctx.remote.$on('dsh-update/log', (chunk) => controller.appendLog(chunk))
```

连接恢复后重新调用 `status()`，避免错过事件。

### 11.5 本地文件

```text
~/.dsh/updates/
  state.json                 # 当前/最近一次更新
  lock                       # 单实例锁（pid + startedAt）
  registry-cache.json        # ETag + 元数据
  pause-ledger.json          # 暂停账本
  last-result.json           # 重启后读取的结果
  logs/
    <updateId>.log
```

---

## 12. 工程与开发流程

### 12.1 构建

单包两个入口：

```ts
// tsdown.config.ts（示意；沿用仓库现有 tsdown 版本）
export default [
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    platform: 'node',
    dts: true,
    clean: false,
  },
  {
    entry: ['src/client/index.tsx'],
    outDir: 'lib',
    platform: 'browser',
    dts: true,
    clean: false,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
  },
]
```

- 构建前单独清理 `lib`（例如 `"build": "rimraf lib && tsdown"`）；两个 config 都设 `clean: false`，否则并行构建可能互相删产物。
- Host 与 Client 分开构建目标；不要用同一份 `platform` 配置硬套。
- Client 的 `external` 要与 DSH baseline externals 对齐，避免把 React 打进 bundle。
- Host 的 `@Remote` 方法依赖 typert 描述：沿用仓库现有的 typert 生成配置，产出 `lib/typert.host.js` 与 `lib/typert.remote-client.js`。没有这两个文件，`ctx.remote.dshUpdate` 在 Client 侧没有可用的远程描述。
- `files` 必须包含 `lib/client.js`、`lib/typert.*`、`cordis.patch.yml`、`locale`；用 `npm pack` 检查。

### 12.2 Host 入口

```ts
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'

export default class UpdateService extends TypertRemoteService {
  static inject = ['sessionController', 'jobController', 'pluginManager']
  static Config = z.object({
    registry: z.string().default('https://registry.npmjs.org'),
    fallbackRegistries: z.array(z.string()).default(['https://registry.npmmirror.com']),
    allowDowngrade: z.boolean().default(true),
  })

  async start() {
    await this.recoverState()
    this.startBackgroundCheck()
  }

  async stop() {
    this.dispose()
  }

  // @Remote 方法见 11.3
}
```

要点：

- 默认导出服务类，DSH 按 Cordis Service 生命周期挂载。
- `inject` 只列 Web profile 一定存在的服务；对 `subagent` / `schedule` 不直接 inject，通过 workspace 事件间接使用。
- 所有定时器、事件监听、watcher 都放进 `ctx.effect()` 或 `start/stop`，确保卸载时清理。

### 12.3 Client 入口

```tsx
import type { Context } from '@deepseek-ai/cordis'

export const NS = 'dshUpdate'
export const PANEL_ID = 'updates'
export const inject = ['slots', 'locale', 'remote', 'remote.dshUpdate', 'layout']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-update: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('main', function* () {
    yield ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ t }),
      },
      UpdatePanel,
    )
  })

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 10,
        label: () => t('panel'),
        locale: NS,
      },
      UpdateIcon,
    ),
  )
}
```

要点：

- `dsh.client.inject` 只写信息性依赖，不是 Cordis 服务注入；真正的服务依赖靠 `ctx` 与 `ctx.remote`。
- `ctx.slots.inject()` 等待 slot 声明，适配 late declaration、locale 变化和 teardown。
- 所有文案进 `locale/en.json` / `zh.json`，不在组件里硬编码中文。
- badge 用 sidebar/overlay 贡献点；最小版本可先不做 badge。

### 12.4 本地安装

```bash
pnpm install
pnpm run build
npm pack                     # 检查包内容
dsh plugin --profile web add link:/absolute/path/to/dsh-update
```

然后在 Plugins 页面启用，或在 profile 的 `dsh.profile.bundles` 中选中。

检查合成树：

```bash
dsh --profile web --dump-config
dsh --profile web --dump-config-schema
```

启动：

```bash
dsh web
```

HMR：

- Host 改动通常需要重启，除非 profile 开了 HMR。
- Client 改动在 client HMR receiver 下可热更新；需要该包 `tsdown --watch` 与 DSH 的 dev watcher 同时工作。
- 不承诺“改完自动生效”；每次以 `--dump-config` 和实际页面为准。

### 12.5 测试

- **单元**
  - 通道选择：用真实版本序列验证 RC 选 `0.2.2-rc.3`、Alpha 选 `0.2.2-alpha.3`，并验证 `latest=0.2.2-rc.1` 不被误当稳定版或最高 RC。
  - SemVer 边界：`0.2.1-rc.5` vs `0.2.2-rc.3`、`includePrerelease` 行为。
  - 兼容性：`engines.dsh`、peer range、manifestVersion、缺失字段。
  - 状态机：每个阶段的取消/失败/恢复。
  - 降级：允许选择、警告、确认。
- **集成**
  - 临时 npm 前缀 + 假包验证 staged 安装、原子切换、回滚。
  - mock registry，验证 ETag、超时、fallback、deprecated。
  - fake sessionController/jobController/activity，验证暂停顺序、超时、并发。
- **E2E**
  - 临时 `DSH_HOME` + 临时安装前缀跑完整向导。
  - 验证侧边栏、步骤、错误文案。
  - 验证重启后旧页面触发 release 对话框，Reload 后新版本加载。
- **手工**
  - `0.2.1-rc.5` → `0.2.2-rc.3`。
  - `0.2.1-rc.5` → `0.2.2-alpha.3`。
  - 降级到 `0.2.1-rc.4`（确认警告）。
  - 无网络、registry 403/timeout。
  - 安装前缀只读。
  - 两个 Session 同时运行，暂停其中一个、另一个不暂停。
  - 暂停超时（模拟不响应 cancel 的 job）。
  - 重启后版本不对/启动失败，走恢复。

### 12.6 发布（第三方）

- 包名用自有 scope，例如 `@your-scope/dsh-update`；不要使用 `@deepseek-ai`。
- `engines.dsh` 写兼容范围；README 写清支持矩阵：Web、npm 全局、macOS/Linux。
- `files` 包含 `lib`、`cordis.patch.yml`、`locale`。
- 发布前 `npm pack` 检查 `./client`、`./cordis.patch.yml`、locale 是否齐全。
- 不要求进入官方 catalog；用户通过 `dsh plugin add` 安装。
- 版本策略：插件自身 SemVer；DSH 兼容范围单独声明，不随 DSH 版本号绑定。

---

## 13. 失败模式

| 失败点 | 影响 | 自动处理 | 用户可见结果 |
| --- | --- | --- | --- |
| registry 不可达 | 无法检查新版本 | 用缓存/fallback | 缓存标记或重试 |
| Node 不满足 | 无法运行目标版本 | 阻塞 | 升级 Node 指引 |
| 插件不兼容 | 更新后插件可能不加载 | 阻塞或更新前禁用 | 兼容性列表 |
| 安装前缀不可写 | 无法安装 | 阻塞 | 复制命令 |
| staging 下载失败 | 当前安装不受影响 | 清理 staging | 失败 + 重试 |
| staging 校验失败 | 当前安装不受影响 | 清理 staging | 失败 + 日志 |
| 暂停超时 | 切换会硬中断 | 等待用户决策 | 活动列表 + 三选项 |
| 切换 rename 失败 | 可能处于中间态 | 立即回滚 | 回滚结果 |
| 手动重启前崩溃 | 新旧版本都可能 | 启动时恢复 | 恢复报告 |
| 重启后启动失败 | 新版本不可用 | 用户手动恢复/下次启动回滚 | 失败报告 + 命令 |
| 页面未 Reload | 旧 client 继续运行 | DSH release 对话框 | Reload 提示 |
| 降级后 Session 不可读 | 数据风险 | 不自动处理 | 强警告 + 备份提示 |

---

## 14. 安全设计

- **来源固定**：只从配置的 npm registry 安装，包名固定 `@deepseek-ai/dsh`；不接受任意 tarball / Git URL 作为核心更新源。
- **版本固定**：目标必须来自本次检查的候选列表；安装前重新确认 metadata 中该版本仍存在。
- **完整性**：npm 自身校验 `dist.integrity`；安装后再核对 package.json version 与 bin 可执行。
- **最小权限**：不 sudo、不提权；不可写就停下。
- **脚本审批**：默认 `--ignore-scripts`；需要 build script 时列出包名并让用户批准。
- **日志脱敏**：registry URL 中的 userinfo、npm token、环境变量中的密钥不写日志。
- **锁与并发**：`~/.dsh/updates/lock` + plugin-manager 操作互斥；同一时间只允许一个更新。
- **审计**：记录版本、时间、暂停的 Session、结果、回滚原因；不上传遥测。
- **降级防护**：允许但强警告；明确 Session 格式风险。
- **防误触**：更新按钮不在主聊天输入区；必须经过版本选择 + 会话确认 + 最终确认三步。
- **第三方信任**：插件自身安装来源由用户决定；文档明确它拥有写全局安装目录的权限。

---

## 15. 里程碑

### M0：单包双面验证（1 天）

- 用最小包验证 `dsh.bundle.patch` 自插入 + `dsh.client` + `./client` 能同时加载 Host 与 Client。
- 验证 `--dump-config` 与 Web 页面都能看到面板。
- 验证 registry / RC / Alpha 选择。

**验收**：不写业务逻辑，单包能跑通“Host 服务 + Web 面板”。

### M1：Host 只读能力（2–3 天）

- `check` / `plan` / `status`。
- registry 缓存、RC/Alpha 选择、Node/插件兼容性。
- 单测覆盖版本与兼容性。

**验收**：面板展示当前版本、RC/Alpha 最新版、阻塞项。

### M2：Client 向导（2–3 天）

- 侧边栏入口、版本选择、兼容性页、确认页。
- locale、错误/重试、空状态。
- 不做安装，只做到“计划完成”。

**验收**：用户能在 UI 完成选择并看到准确计划。

### M3：暂停协调（2–3 天）

- activity 发现、stop、轮询静默、超时。
- 会话勾选、暂停账本、当前会话标记。
- fake provider 集成测试。

**验收**：暂停 2 个运行中会话，activity 归零；未暂停的会话被明确标记风险。

### M4：安装/切换/手动重启（3–4 天）

- 安装探测、staged npm 安装、校验、原子切换、回滚。
- 手动重启命令、状态恢复、重启后验证。
- 降级路径。

**验收**：真实从 `0.2.1-rc.5` 更新到 `0.2.2-rc.3`，失败可回滚；降级到 `0.2.1-rc.4` 有警告。

### M5：硬化与发布（2–3 天）

- 并发锁、崩溃恢复、日志脱敏、错误文案。
- E2E、README、发布到自有 scope。
- 可选：插件加载失败报告。

**验收**：只读前缀、断网、启动失败、暂停超时四类故障下都不破坏当前安装。

总计约 10–14 个工作日；单人可完成，UI 与安装器可并行。

---

## 16. 风险与待确认

| 风险/问题 | 影响 | 建议 |
| --- | --- | --- |
| 没有公开 restart API | 只能手动重启，体验略差 | 接受；未来上游提供后再做自动 |
| 全局安装被包管理器托管 | 直接替换目录可能破坏所有权 | 首版只支持 npm；其它只读提示 |
| 切换时新旧模块混用 | 运行中进程可能懒加载新代码 | 切换后不再 import；或未来用 `current` 符号链接 |
| 其它 profile/进程不可见 | 全局更新可能影响别的 DSH 实例 | 全局锁 + 进程扫描 + 明确警告 |
| 插件兼容性只能声明式判断 | 运行时仍可能崩 | 更新前禁用不兼容插件 + 启动失败回滚 |
| Session 格式前向迁移 | 降级不可读 | 允许降级但强警告；建议备份 |
| 单包双面在目标 DSH 版本有差异 | Host/Client 可能只加载一半 | M0 先验证；退化方案是拆 2 包 |
| 第三方包信任 | 用户需信任插件作者 | README 明确权限；发布源可验证 |
| Windows 语义不同 | rename/信号不同 | 首版不支持；后续单独设计 |
| “latest” 是 rc | 用户误以为稳定版 | UI 明确标注；选择逻辑不依赖 latest |

### 仍需确认

1. 包名/scope 用哪个？`@your-scope/dsh-update` 只是占位。
2. 插件安装后默认启用，还是让用户在 Plugins 页面手动启用？
3. 是否需要发布到 npm 之外的渠道（GitHub Release / 内部 registry）？
4. 首版是否要支持 Windows？如果不支持，README 明确写。

---

## 17. 参考资料

- `@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts:27`：一个包可声明多个角色（`bundle` / `profile` / `client`）。
- `@deepseek-ai/dsh-client-modules/lib/index.js:105-106`：客户端模块系统扫描 host Loader entries 中的 `dsh.client` 包；`:732-738`：读取 `dsh.client` 并要求导出 `./client`。
- `@deepseek-ai/dsh-plugin-manager` README：安装、兼容性、豁免、restart-required、pnpm 注册表回退。
- `@deepseek-ai/dsh-workspace/lib/index.js:531`：`workspace/session-activity` waterfall；`:623`：`workspace/session-stop` parallel。
- `@deepseek-ai/dsh-api-session-controller` 类型：`SessionSummary.running`、`SessionCancelRequest`。
- `@deepseek-ai/dsh-api-job-controller` / `dsh-jobs-local`：job list/kill。
- `@deepseek-ai/dsh-subagent` README：`startActivation`、`dispose()`、后代清理。
- `@deepseek-ai/dsh-client-ui-plugin-manager` 与 `dsh-client-ui-plugin-market`：Client slot、locale、remote 用法。
- `@deepseek-ai/dsh-client-ui-settings-general` README：Host release 变化时的 “Service version changed” 对话框。
- `@deepseek-ai/dsh` README：`dsh web`、`dsh --profile web --port 8080`。
