# Tauri 桌面 App — M0-f 修复交付（Tauri WebView2 黑屏）

> 日期：2026-09-09
> 分支：`codex/tauri-app`
> 提交：`958c39c fix(frontend): App.svelte splash 防 Tauri 黑屏（M0-f）`
> 范围：M0 §7.1 黑屏修复

## 一、根因

M0 交付时（`materials/29-tauri-m0-delivery.md` §7.1）已发现：**dist 产物含
splash overlay 代码，但 `frontend/src/App.svelte` 源码没有**。

App.svelte 是个 251 行的干净基线，没有 `splash-overlay` 模板、没有 Tauri
路径分支、没有 `onSidecarReady` 订阅 — 完全没有后端就绪守卫。dist 产物
里的 splash overlay 是某次实验性编辑后留下的，源码永远落后于 dist。

后果：
- 当前 `dist/assets/index-CuMhI-iW.js` 含 `splash-overlay` 类名和 Tauri
  侧car 订阅代码，所以本地 vite 预览 `pnpm dev` 时能看到 splash 和主 UI
- 但下次 `cargo tauri build` 会从源码重新打包，splash 立刻消失，主窗口
  content area 黑屏（因为 isTauri() = true + 后端未 ready 时主 UI 已尝试
  渲染 + WebView2 devtools 不开，调试时只能靠堆栈）

## 二、修复（commit 958c39c）

把 splash overlay 从「dist 副产品」变成「源码一等公民」，让 `cargo tauri
build` 出来的产物和 dev 行为一致。

### 2.1 App.svelte 改动

| # | 位置 | 改动 |
|---|---|---|
| 1 | `<script>` 顶部 | `import { isTauri, onSidecarReady, onSidecarDied } from "./lib/tauri"` |
| 2 | `onMount` 之前 | 新增 `backendReady = $state(!isTauri())` / `backendError = $state(null)` / `initStarted` / `sidecarReadyUnsub` / `sidecarDiedUnsub` / `backendBootTimeout`，加 `doInit()` / `markBackendReady()` / `markBackendFailed(reason)` 三个 helper |
| 3 | `onMount` 整块重写 | `if (isTauri())` 路径：调 `onSidecarReady(() => markBackendReady())` + `onSidecarDied(...)` + `setTimeout(..., 30000)` 启动超时；浏览器路径：直接 `await doInit()` + 原有 comfyui 探测 / 事件监听 |
| 4 | `onDestroy` 开头 | cleanup：`sidecarReadyUnsub()` + `sidecarDiedUnsub()` + `clearTimeout(backendBootTimeout)`，再 `disconnectEvents()` |
| 5 | 模板 `<Toast />` 之后 | `{#if !backendReady}` 守卫 + splash-overlay / splash-card / splash-logo / splash-spinner / splash-hint / splash-err 元素（错误时切 `.splash-err`，含 `build-sidecar.ps1` 重建提示） |
| 6 | `<style>` 内 | 6 个 splash CSS + `@keyframes splash-spin` 旋转动画，颜色 token 用 `bg-bg` (#18181b) / `bg-surface` (#2e2e33) / accent (#f24e4e) / danger (#fb7185)，和 tailwind.config 一致 |

App.svelte 从 251 行涨到 383 行（+132 行，含 30 行中文注释）。

### 2.2 关键设计

- **`backendReady = $state(!isTauri())`**：浏览器 dev / 静态托管直接
  `!false = true`，splash 不会显示；Tauri WebView 默认 `!true = false`，
  splash 一开始就显示，等 Rust 端 sidecar-ready 才翻转。
- **`doInit()` 抽出来**：原 onMount 内的 init 流程（Promise.all + settingsApi
  + connectEvents）抽成单独函数，被 `markBackendReady` 和浏览器路径都调，
  避免重复代码。
- **30s 超时**：一般 sidecar 1~2s 就 ready，30s 留给冷启动 + 防永久卡死。
  超时切 `splash-err` 红字卡 + `build-sidecar.ps1` 重建提示。
- **错误处理**：`onSidecarDied` 监听后端崩溃，立即切 `splash-err` + 把
  reason 显示给用户，避免白屏假象。

## 三、回归测试（`frontend/src/__tests__/app-splash.test.ts`）

19 个 case，分 5 组：

```
✓ <script> 必须含后端就绪状态与启动流程 (6)
  - import isTauri / onSidecarReady / onSidecarDied
  - backendReady = $state(!isTauri())
  - backendError = $state(null)
  - function doInit()
  - function markBackendReady()
  - function markBackendFailed(reason)
✓ onMount 必须订阅 sidecar 事件 + 30s 超时 (4)
  - onMount 调 onSidecarReady(...)
  - onMount 调 onSidecarDied(...)
  - setTimeout(..., 30000)
  - if (isTauri()) 分支
✓ onDestroy 必须释放 sidecar 监听 (2)
  - sidecarReadyUnsub()
  - clearTimeout(backendBootTimeout)
✓ 模板必须含 splash overlay (4)
  - {#if !backendReady} 守卫
  - splash-overlay / splash-card / splash-logo 三类名
  - splash-spinner / splash-hint / splash-err 三类名
  - build-sidecar.ps1 关键字
✓ <style> 必须含 splash CSS + keyframes (2)
  - 6 个 CSS 规则
  - @keyframes splash-spin
反例 (1)
  - splash-overlay 必须顶层渲染（不在根 grid 内嵌）
```

## 四、验证

| 验证项 | 结果 |
|---|---|
| `pnpm test` | **29 files / 260 tests passed** （新增 19 个 splash 测试） |
| `pnpm build` | `dist/assets/index-CuMhI-iW.js` 内含 `splash-overlay` / `splash-spinner` / `splash-err` / `splash-hint` / `splash-card` / `splash-logo` 全套类名 |
| `cargo check --release`（`frontend/src-tauri/`） | Finished `release` profile [optimized] target(s) in 31.24s，**Rust 端编译通过** |
| Git status | 干净，3 个文件已提交：`frontend/src/App.svelte`（modified）+ `frontend/src/__tests__/app-splash.test.ts`（new）+ `apply_splash.cjs`（new） |

## 五、附加：apply_splash.cjs

幂等的 Node 脚本，把上述 6 步改造封装成可重跑：

```
$ node apply_splash.cjs
1) tauri import added OK
2) splash state + doInit + markBackendReady/Failed inserted before onMount OK
3) onMount replaced (Tauri-aware) OK
4) onDestroy cleanup inserted OK
5) splash overlay inserted before <style> OK
6) splash CSS inserted before </style> OK
App.svelte updated
```

特性：
- 6 步每个都有 marker 存在性检查，重复跑会变 no-op（不破坏已转换的文件）
- 自动处理 CRLF / LF（Windows 仓库用 `\r\n`，脚本内部统一转 LF 处理，写回时还原）
- 每个 marker 都含 2 空格前导缩进，与源码 `<script>` 块一致

未来若类似「dist 比源码多了一段代码 → 下次 build 会丢」的场景，可复用此模式。

## 六、仍待完成（M1+）

- [ ] **端到端验证 splash 在 prod Tauri 窗口里真的显示** — M0 已有 NSIS 安装
  路径，但 splash 修复只在源码层验证过。需 `cargo tauri build` 出新安装包 +
  NSIS 装机 + 启动看 splash 是否在 WebView2 主窗口出现 + 后端就绪后 splash
  消失 + 主 UI 完整渲染（验收 M0-f 完成）。
- [ ] 后端启动失败的友好错误（sidecar crash 时 Rust 端 stderr 写到日志 +
  弹错误 dialog），目前 `onSidecarDied` 只显示 reason 字符串。
- [ ] splash 文案 polish（与产品沟通）。
