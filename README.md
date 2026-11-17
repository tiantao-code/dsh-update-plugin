# DSH Update

DSH 版本更新插件：检查新的 **RC / Alpha** 版本、预检兼容性、暂停选定会话、把新版本安装到临时目录，再原子切换并提示手动重启。

界面入口：Web 侧边栏的「更新」图标 → `main` 面板中的更新向导。

## 状态

代码按 `dsh-update-plugin-design.md` 实现，**尚未运行安装/构建/调试**。首次使用前请先完成：

```bash
pnpm install     # 或 npm install
pnpm build       # rimraf lib && tsdown && tsc
npm pack
```

本机若没有 `pnpm`，用 npm 等价命令即可。构建需要 `tsdown`、`typescript`、`@types/*` 等 devDependencies。

## 安装

包名当前是占位 scope：`@your-scope/dsh-update`。发布或本地安装前请把 `package.json`、`cordis.patch.yml`、`tsdown.config.ts`、`src/typert/spec.ts` 中的 `@your-scope/dsh-update` 替换为实际包名（**四处必须一致**：`TYPERT.package` 必须等于自身包名，否则 typert loader 会拒绝；Client bundle 的 `__ModuleLoader__.load({ id })` 也使用包名）。

本地 link 安装：

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-update-plugin
```

或用打包产物：

```bash
npm pack
dsh plugin --profile web add ./your-scope-dsh-update-0.1.0.tgz
```

安装后重启 DSH（本插件不会自动重启）：

```bash
dsh web --port 3080
```

刷新页面，侧边栏出现更新图标。

## 使用

1. **版本**：读取 npm registry 的 `@deepseek-ai/dsh` packument，只显示 `rc` / `alpha` 预发布版本。`latest` 只是 npm dist-tag 角标，不代表稳定版；最高版本按 SemVer 排序而不是发布时间。
2. **兼容性**：检查目标版本的 `engines.node`、当前安装方式是否可写、磁盘空间，以及已装 bundle 声明的 `engines.dsh` / `peerDependencies["@deepseek-ai/dsh"]`。不兼容插件可在列表里直接禁用（写入 profile patch），不会卸载。
3. **会话**：列出有活动（turn/job/subagent/schedule）的会话，默认全选。可选择暂停选中会话，或明确接受风险后不暂停。
4. **确认**：勾选“理解需要手动重启”，开始更新。
5. **执行**：staging → 暂停 → 切换前重扫 → 原子 rename 切换。安装失败不会动当前版本；切换失败自动回滚。
6. **结果**：页面会断开。复制页面上的重启命令，在终端重启 DSH，然后刷新页面。新版本启动后重新打开面板会显示完成状态。

### 暂停语义

- 通过 workspace 公共 seam `workspace/session-activity` 读取活动，通过 `workspace/session-stop` 请求停止（借用 archive admission 使用的同一组 provider；**不会 archive 任何会话**）。
- `stop` 不等待结束，插件轮询活动直到为空；默认 15 秒超时（`pauseTimeoutMs`）。
- 超时后可选择：继续等待、跳过并继续（需再次确认风险）、取消。
- 未接受“跳过会话”风险时，切换前会重扫；发现未暂停会话出现新活动就中止切换，回到会话选择。
- 终端 PTY 会随会话停止而关闭；pending inbox 会保留，但未完成回合可能丢失。

## 配置

Host 插件配置（profile patch 或 `dsh` 配置层）：

```yaml
dsh-update:
  registry: https://registry.npmjs.org
  fallbackRegistries:
    - https://registry.npmmirror.com
  checkIntervalMinutes: 360   # 0 关闭后台检查
  pauseTimeoutMs: 15000
  allowIncompatiblePlugins: false
  allowDowngrade: true
  allowBuildScripts: false
```

## 安全边界

- 只访问固定 npm 包 `@deepseek-ai/dsh`，版本号必须来自 registry 且匹配 `rc`/`alpha`；不接受任意 tarball URL。
- 不调用 `sudo`；只修改当前 npm 全局安装目录，且要求 `prefix`、`@deepseek-ai` scope 目录、包目录都可写。
- 默认 `npm install --ignore-scripts`；需要构建脚本时由 `allowBuildScripts` 显式打开。
- 同一时间只允许一个更新：`~/.dsh/updates/install.lock`（跨进程 pid 锁）。
- 日志脱敏 URL 凭据、`_authToken`、Bearer token。
- 当前只支持 **npm 全局安装**。Homebrew / pnpm 全局 / DSH Desktop / 源码 checkout 会阻塞并提示手动更新方式；Windows 不在首版范围。

## 关键实现说明

- **一个包，三种角色**：`dsh.bundle.patch` 负责把 Loader entry 插入 profile；`exports["."]` 是 Host 插件；`dsh.client` + `exports["./client"]` 是浏览器面板。
- **Host Remote**：`UpdateService extends TypertRemoteService`，namespace 为 `dshUpdate`，方法 `check / plan / pause / start / status / cancel / logs`。typert 生成物是手写的：`lib/typert.host.js` 与 `lib/typert.remote-client.js`（源码在 `src/typert/`）。
- **Client**：bundle 由 `window.__ModuleLoader__.load({ id, factory })` 包裹；`apply()` 先 `ctx.remote.$mount(TYPERT_REMOTE)`，再等待 `remote.dshUpdate` 并注册 `main` / `sidebar.panellist` slot。
- **事件降级**：DSH 的 `ctx.remote.$on` 只转发固定白名单事件，第三方包无法把自定义 `dsh-update/status` 加进去。因此 Client **每 2 秒轮询** `status()`，活跃时增量读取 `logs()`；没有使用设计稿里的自定义事件。
- **状态文件**：`~/.dsh/updates/` 下 `state.json`、`registry-cache.json`、`pause-ledger.json`、`last-result.json`、`install.lock`、`logs/<updateId>.log`。
- **重启恢复**：Host 启动时按 `state.json` 阶段恢复。`switching` 会按安装目录的实际版本判断 installed / 恢复备份 / failed；`installed` 在下次启动验证版本后转为 `done`。

## 目录

```text
src/index.ts             Host 服务、状态机、typert Remote 方法
src/registry.ts          npm packument、ETag、缓存、rc/alpha 候选
src/compatibility.ts     Node / 安装方式 / 插件范围预检
src/pause.ts             workspace activity + stop seam
src/installer.ts         安装目录探测、staged npm install、切换与回滚
src/store.ts             ~/.dsh/updates 持久化、锁、日志脱敏
src/types.ts             Host/Client 共享 wire 类型
src/typert/              手写的 typert spec / host / remote 生成物源码
src/client/              浏览器向导与 slot 注册
locale/*.json            slot 展示元数据
cordis.patch.yml         bundle 自插入 patch
```

## 已知限制

- 没有公开的 restart API，必须手动重启；页面靠 DSH 的 release identity 对话框 Reload。
- 切换后旧页面仍可能持有旧模块；在重启前不要继续操作该页面。
- 只对当前 profile / 当前进程做 best-effort 会话暂停；其它 profile 或其它 DSH 进程只提示，不承诺暂停。
- 声明式兼容性检查不能保证插件一定启动；不兼容列表是预检结果，不是运行时保证。
- 首次实现未运行测试；`pnpm typecheck` / `pnpm build` 需要在有 devDependencies 的环境执行。
