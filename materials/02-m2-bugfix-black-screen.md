# M2 修复：黑屏（main.ts 用了 Svelte 4 的实例化方式）

## 问题

启动后端 + 前端后，`http://127.0.0.1:8765/` 浏览器一片漆黑，HTML 正常下发、CSS 正常加载、JS 正常下载，但 `#app` 始终为空。

## 定位过程

1. 直接 `curl` 后端静态资源 → HTML / CSS / JS 全部 200。
2. 用 `happy-dom` 加载构建产物，复现：
   ```
   THROW: https://svelte.dev/e/effect_orphan
       at va  (validate_effect)
       at li
       at dr  (compiled $effect)
       at new $l  (App 构造函数)
   ```
   说明 Svelte 5 拒绝执行 `$effect` / `onMount`，因为当前没有 effect root 上下文。
3. 删除 `App.svelte` 里的 `$effect` 后，错误下移到 `onMount`，进一步确认是构造函数整体没有 effect 上下文。
4. 读 Svelte 5 源码 `internal/client/render.js`：正常挂载需要走 `component_root(() => Component(anchor, props))`，由 `mount()` 提供；直接 `new App({ target })` 绕过这一步。

## 根因

`frontend\src\main.ts` 用的是 Svelte 4 时代的实例化写法：

```ts
const app = new App({ target });
```

Svelte 5 不再保留这个 API。`new App({ target })` 不会建立 `active_effect`（effect root），导致组件脚本里第一个 `$effect` / `onMount` 触发 `effect_orphan`，整个组件构造中止 → 黑屏。

## 修复

改为 Svelte 5 的 `mount()`：

```ts
import { mount } from "svelte";
const app = mount(App, { target });
```

一行改动。

## 验证

- `frontend/src/__tests__/main.test.ts`（新增 2 个用例）：守护 `import { mount } from "svelte"` + 禁止 `new App(`。
- `happy-dom` 复现脚本：注入 mock `WebSocket` 后
  - 旧版本：`THROW: effect_orphan`
  - 新版本：`OK: {"len":3894,"grid":true,"headerText":"苏醒图库"}`
- 后端 pytest：27 / 27 通过
- 前端 vitest：16 / 16 通过（旧 14 + 新增 2）

## 后续注意

- 任何 Svelte 5 组件必须通过 `mount()` 挂载，不能用 `new Component({ target })`。
- Tauri 化时也需要走 `mount`（Tauri 2 已有官方 Svelte 5 模板）。
