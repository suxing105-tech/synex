# Tauri 桌面 App — M0-f 第二轮：splash overlay 组件化拆分

> 日期：2026-09-09
> 分支：`codex/tauri-app`
> 提交：`59947c6 refactor(frontend): splash overlay 抽到独立组件 SplashOverlay.svelte`
> 前置：`958c39c`（M0-f 首轮）+ `4ffa6ac`（E2E 验收）

## 一、动机

M0-f 首轮（`materials/29-tauri-m0-delivery.md` §7.1 + 30）把 splash overlay
正式落进 `frontend/src/App.svelte` 源码，修复了 dist 比源码多一段代码
导致下次 `cargo tauri build` 必再次黑屏的根因。

但当时把 splash overlay 模板（12 行）和 CSS（59 行）全塞进 App.svelte 一个文件：
- App.svelte 涨到 383 行，<script> + 模板 + <style> 三段关注点混杂
- splash 视觉层没有独立测试，所有覆盖都在 app-splash.test.ts 静态扫描 App.svelte
- 未来想在 onboarding modal / first-run wizard 复用 splash 视觉没法 import

本次拆分把视觉层抽成独立组件，纯展示接口（Props: ready + error），
App.svelte 继续拥有 sidecar 生命周期（订阅 + 超时 + cleanup）。

## 二、文件结构

```
frontend/src/
├── App.svelte                    # 312 行（-71 行），生命周期 + 主 UI
├── components/
│   └── SplashOverlay.svelte      # 新增（146 行），纯展示
└── __tests__/
    ├── app-splash.test.ts        # 重构 19 → 12 个（保留生命周期 + 反例：不再内联）
    └── splash-overlay.test.ts    # 新增 13 个（组件 Props / 模板 / CSS / 反例：纯展示）
```

## 三、关键设计

### 3.1 SplashOverlay.svelte（纯展示）

```ts
interface Props {
  ready: boolean;
  error: string | null;
}
let { ready, error }: Props = $props();
```

模板：`{#if !ready}` 守卫 + splash-overlay / splash-card / splash-logo + 
spinner + hint（无 error）或 splash-err + hint（含 `build-sidecar.ps1`）。
`<style>` 全 scoped：6 个 splash 规则 + `@keyframes splash-spin`。

**反例（测试锁住）**：
- ❌ 不能 `import` `./lib/tauri`（sidecar 生命周期归 App.svelte）
- ❌ 不能 `import { onMount, onDestroy }`（无副作用）
- ❌ 不能调 `isTauri()`（环境判断归 App.svelte）

### 3.2 App.svelte（生命周期）

App.svelte 仍保留：
- `import { isTauri, onSidecarReady, onSidecarDied } from "./lib/tauri"`
- `backendReady = $state(!isTauri())` + `backendError = $state(null)`
- `doInit() / markBackendReady() / markBackendFailed()`
- onMount 内 `if (isTauri())` 分支 + `onSidecarReady(...)` + `onSidecarDied(...)` + `setTimeout(_, 30000)`
- onDestroy 内 `sidecarReadyUnsub() / sidecarDiedUnsub() / clearTimeout(backendBootTimeout)`

但模板里只一行调用：
```svelte
<SplashOverlay ready={backendReady} error={backendError} />
```

**反例（测试锁住）**：
- ❌ 模板不应再含 `class="splash-overlay"` 内联 div（防双渲染）
- ❌ `<style>` 不应再含 `@keyframes splash-spin`（防样式散落两处）

## 四、验证

| 验证项 | 结果 |
|---|---|
| `pnpm test` | **30 files / 273 tests passed**（新增 13 个 splash-overlay.test.ts） |
| `pnpm build` | dist 含 6 个 splash 类名 + sidecar-ready/died 事件 + `setTimeout(_, 3e4)` + 中文文案 |
| 模块数变化 | 147 → 149（SplashOverlay 多出来的模块） |
| App.svelte 净瘦身 | 383 → 312 行（-71 行） |
| 视觉行为 | 完全一致（dist 内 class 名 + 渲染逻辑不变） |

## 五、为什么这次拆分是真的 align 而非重写

- 修复根因不变：源码 vs dist 不再漂移（commit 958c39c 已建立）
- 端到端验收不变（commit 4ffa6ac 已建立，splashed + 30s 超时在真实 Tauri 窗口渲染）
- 本次只动结构，不动行为：
  - 不改 backendReady / backendError 任何语义
  - 不改 onMount sidecar 订阅 / setTimeout 30s 超时 / onDestroy cleanup
  - 不改 splash 视觉（颜色 token / 动画 / 文案 / aria 全保留）
- 新加反例测试防止后续 PR 把组件化退化成内联

## 六、后续（M1+）

- [ ] 把 sidecar 生命周期也抽成 `lib/splash-gate.ts` composable（更高一层的封装）
- [ ] NSIS 装机后再跑一遍 E2E（覆盖 perMachine 部署场景）
- [ ] splash 文案 polish（"正在启动后端进程…" / 错误卡）
- [ ] sidecar crash 时把 stderr 末尾几行写到错误卡下方（便于排查）