# Tauri 桌面 App — M0-f 第三轮：sidecar 生命周期抽 composable

> 日期：2026-09-09
> 分支：`codex/tauri-app`
> 前置：`59947c6`（M0-f 第二轮：splash overlay 组件化）+ `7f4e978`（materials 32）
> 状态：本轮为第三轮 composable 拆分，待最终 commit + materials 落地。

## 一、动机

M0-f 第二轮（`materials/32-tauri-m0f-component.md`）把 splash 视觉层抽到
`SplashOverlay.svelte` 纯展示组件，但 sidecar 生命周期（订阅 / 超时 / cleanup）
仍然驻留在 `frontend/src/App.svelte`，与 App 业务 init 逻辑混在一起：

- App.svelte 仍持有 6 个 sidecar 相关变量：`backendReady` / `backendError` /
  `initStarted` / `sidecarReadyUnsub` / `sidecarDiedUnsub` / `backendBootTimeout`
- App.svelte 仍含 3 个 sidecar helper：`markBackendReady` / `markBackendFailed`
  + 30s setTimeout
- App.svelte 仍需 import `isTauri` / `onSidecarReady` / `onSidecarDied` 直接订阅

带来的问题：

- **复用门槛**：未来 onboarding modal / first-run wizard 想显示同样的 splash，
  不能直接 import，需要复制 60+ 行订阅代码。
- **测试边界模糊**：app-splash.test.ts 一边断言 splash 视觉存在（上一轮已拆），
  一边断言 sidecar 生命周期，混在静态扫描里。
- **架构分界不清**：App.svelte 应该只管业务 init，splash 启动门应该单独治理。

本轮继续把 sidecar 生命周期从 App.svelte 抽出到
`lib/splash-gate.svelte.ts` 的 `createSplashGate()` composable，
让 App.svelte 只持有一个 `gate` 对象。

## 二、文件结构

```
frontend/src/
├── App.svelte                      # 245 行（-110，382 → 245）
├── lib/
│   ├── splash-gate.svelte.ts       # 新增（105 行），$state rune composable
│   └── tauri.ts                    # 不变（被 gate import）
├── components/
│   └── SplashOverlay.svelte        # 不变（M0-f 第二轮产物）
└── __tests__/
    ├── app-splash.test.ts          # 重构（聚焦 App.svelte 端：声明 + 反例）
    └── splash-gate.test.ts         # 新增 10 个（composable 行为）
```

`extract_splash_gate.cjs` 是本轮的 idempotent 重构脚本（重复跑 no-op），
保留作为审计轨迹。

## 三、关键设计

### 3.1 lib/splash-gate.svelte.ts（composable）

```ts
export interface SplashGate {
  readonly ready: boolean;     // gate 持有的响应式状态
  readonly error: string | null;
  start(doInit: () => Promise<void>): Promise<boolean>;
  dispose(): void;
}

export function createSplashGate(opts: SplashGateOptions = {}): SplashGate {
  const timeoutMs = opts.timeoutMs ?? 30000;
  // 浏览器默认 ready=true；Tauri 默认 ready=false
  let ready = $state(!isTauri());
  let error = $state<string | null>(null);
  // ...readyUnsub / diedUnsub / bootTimeout 闭包持有...
  async function start(doInit: () => Promise<void>): Promise<boolean> {
    if (!isTauri()) {
      await doInit();
      return true;
    }
    readyUnsub = await onSidecarReady(() => markReady(doInit));
    diedUnsub = await onSidecarDied((p) => markFailed(p?.reason || "sidecar died"));
    bootTimeout = setTimeout(() => {
      if (!ready) markFailed(error || `后端进程启动超时（${Math.round(timeoutMs / 1000)}s）`);
    }, timeoutMs);
    return false;
  }
  function dispose() { readyUnsub?.(); diedUnsub?.(); clearBootTimeout(); }
  return { get ready() { return ready; }, get error() { return error; }, start, dispose };
}
```

设计要点：

- **.svelte.ts 文件**：让 `$state` rune 在 composable 里 work，
  App.svelte 模板用 `gate.ready` / `gate.error` 时自动响应变化。
- **不暴露 deps 注入**：gate 直接读 `./tauri` 的 `isTauri` /
  `onSidecarReady` / `onSidecarDied`，保持 API 简单（无 opts.deps）。
  未来要单测 Tauri 行为，再加 deps 注入点。
- **start() 返回 boolean**：告诉调用方是 browser 模式（true，已 await doInit）
  还是 Tauri 模式（false，doInit 等 sidecar-ready 才会触发），
  让 App.svelte 在 browser 模式继续 setup comfyui polling + window listeners。
- **timeoutMs 默认 30000**：测试可传小值加速。
- **dispose() 幂等**：unsub 调一次后置 null，再次 dispose 不抛错。

### 3.2 App.svelte（剩 245 行）

```svelte
<script lang="ts">
  import { createSplashGate } from "./lib/splash-gate.svelte";
  // 不再 import isTauri / onSidecarReady / onSidecarDied
  // 不再声明 backendReady / backendError / sidecar*Unsub / backendBootTimeout
  // 不再定义 markBackendReady / markBackendFailed

  const gate = createSplashGate();

  async function doInit() {
    if (initStarted) return;
    initStarted = true;
    try {
      await Promise.all([refreshFolders(), refreshStats(), refreshFeed()]);
      const cfg = await settingsApi.get();
      if (!cfg.watch_dirs || cfg.watch_dirs.length === 0) onboardingOpen = true;
    } catch (e) { console.error("init failed", e); }
    connectEvents();
  }

  onMount(async () => {
    const isBrowser = await gate.start(doInit);
    if (!isBrowser) return;
    // browser-only: comfyui polling + window listeners
    await refreshComfyuiStatus();
    comfyuiTimer = setInterval(refreshComfyuiStatus, 30000);
    // ...
  });

  onDestroy(() => {
    gate.dispose();
    // ...disconnectEvents / clearInterval / removeEventListener
  });
</script>

<SplashOverlay ready={gate.ready} error={gate.error} />
```

App.svelte 现在的责任边界：

| 关注点 | App.svelte | gate |
|---|---|---|
| 业务 init (refreshFolders/stats/feed/settings/connectEvents) | ✅ | ❌ |
| comfyui polling + window listeners (browser-only) | ✅ | ❌ |
| sidecar-ready / sidecar-died 订阅 | ❌ | ✅ |
| 30s 启动超时 | ❌ | ✅ |
| SplashOverlay ready/error 渲染 | ✅ (调用) | ✅ (持有状态) |
| onDestroy cleanup | ✅ (gate.dispose) | ✅ (内部 unsub) |

### 3.3 App.svelte 模板引用 bug 修复

重构时漏改了模板段，line 216 仍引用旧标识符 `backendReady` / `backendError`，
如果直接 build 会因 Svelte 编译失败：

```svelte
<!-- before -->
<SplashOverlay ready={backendReady} error={backendError} />
<!-- after -->
<SplashOverlay ready={gate.ready} error={gate.error} />
```

这是 refactor 的高频陷阱：**必须同时改 `<script>` 和 template 两段**，本轮
发现并修复。

## 四、测试

### 4.1 app-splash.test.ts 重写

| 旧 case | 现状 |
|---|---|
| 13 个 stale assertion（旧 backendReady/backendError/setTimeout 30000 内联） | 删除 |
| 8 个 gate 断言（import / 声明 gate / doInit / gate.start / gate.dispose / 模板 / 反例：不再 import tauri sidecar API） | 新增 |

总计 15 个 case，覆盖：

- `<script>` 必须把 sidecar 生命周期交给 `createSplashGate` composable
  （import / const gate / doInit 都在）
- `onMount` 必须通过 `gate.start(doInit)` 启动
- `onDestroy` 必须调用 `gate.dispose()`
- 模板用 `<SplashOverlay ready={gate.ready} error={gate.error} />`
- 反例：App.svelte 不应再 import `isTauri/onSidecarReady/onSidecarDied`
- 反例：App.svelte 不应再设 30s `setTimeout` / 声明 backendReady 等
- 反例：App.svelte 不应再定义 markBackendReady / markBackendFailed
- splash 视觉层已抽到 SplashOverlay（不再内联 + 不再含 `@keyframes splash-spin`）

### 4.2 splash-gate.test.ts 新建（10 个 case）

通过 mock `window.__TAURI__.event.listen` 实现 Tauri 行为，
通过 `delete window.__TAURI__` 走 browser 路径。

**关键 mock 细节**：tauri.ts 的 `onSidecarReady(cb)` 内部用
`t.event.listen("sidecar-ready", (e) => cb(e.payload))` 注册了一个
wrapper，会把 Tauri 事件 `{ payload: ... }` 解包后再调 userCb。
所以测试 mock 的 `listen` 收到的 cb 其实是 tauri.ts 的 wrapper，
测试触发时要传 Tauri 事件原 shape：

```ts
// 错误 mock：把 tauri.ts 的 wrapper 当 userCb 直接调
listen: vi.fn(async (event, cb) => {
  readyCb = cb;  // cb 其实是 wrapper
});
// 然后 readyCb({}) 直接调 → wrapper 收到 e={} → userCb(e.payload)=userCb(undefined)

// 正确 mock：触发时传 Tauri 事件 shape
readyTrigger!({ payload: { port: 8765 } });   // wrapper → userCb({ port: 8765 }) → markReady
diedTrigger!({ payload: { reason: "sidecar crashed" } }); // wrapper → userCb(reason) → markFailed
```

同时 mock 的 `readyUnsub` / `diedUnsub` 必须让 trigger 失效（不然 dispose
测试假阳性）：

```ts
let readyActive = true;
readyUnsub = vi.fn(() => { readyActive = false; });
readyTrigger = (e) => { if (readyActive) cb(e); };
```

覆盖：

| describe | case 数 |
|---|---|
| 浏览器模式（ready 默认 true / start 返回 true / dispose 不抛错） | 3 |
| Tauri 模式（ready 默认 false / start 返回 false） | 2 |
| Tauri 触发 sidecar-ready callback | 1 |
| Tauri 触发 sidecar-died callback | 1 |
| Tauri 30s 超时（fakeTimers 推进） | 1 |
| dispose() 后 callback 不影响 state + unsub 各调 1 次 | 1 |
| dispose() 幂等 | 1 |

### 4.3 测试运行

```
Test Files  31 passed (31)
Tests       282 passed (282)
Duration    1.68s
```

`app-splash.test.ts` 15 个 + `splash-gate.test.ts` 10 个 + 其它 257 个全过。

## 五、关键陷阱 & 修复

### 5.1 GBK vs UTF-8 编码陷阱（关键！）

PowerShell `Set-Content -Encoding UTF8` 在中文 Windows 默认环境实际写 GBK 而非 UTF-8：

```
Format-Hex 显示中文 '回' = BB D8（GBK），不是 UTF-8 E5 9B 9E
```

vitest 运行时按 UTF-8 读 GBK 文件 → 中文变 `��` → regex
`/后端进程启动超时/` 匹配失败。

**修复方案**：用 PowerShell here-string `@'...'@` + `Set-Content -Encoding UTF8`
即可正确写 UTF-8（注意不是 `Set-Content -Encoding UTF8`，而是
`Set-Content -Path ... -Value $content -Encoding UTF8 -NoNewline`，且
$content 用 `@'...'@` 字面 here-string）。

或者更稳：用 C# `[System.IO.File]::WriteAllText(path, text, (New-Object
System.Text.UTF8Encoding 0))`，0 表示 no BOM。

验证命令：

```powershell
node -e "
const fs = require('fs');
const b = fs.readFileSync('frontend/src/__tests__/splash-gate.test.ts');
let utf8 = false, gbk = false;
for (let i = 0; i < b.length - 2; i++) {
  if (b[i] === 0xE5 && b[i+1] === 0x9B && b[i+2] === 0x9E) { utf8 = true; break; }
  if (b[i] === 0xBB && b[i+1] === 0xD8) { gbk = true; break; }
}
console.log('utf8=' + utf8, 'gbk=' + gbk);
"
```

### 5.2 PowerShell `it(\"...` 解析陷阱

PowerShell 在解析命令行时把 JS 代码里的 `it(\"some test name\", () => {...})`
当成命令调用 `it`，触发 `Unexpected token '('`。即便用 single-quoted JS string
或 heredoc 嵌套也会触发。

**解决**：直接用 PowerShell here-string `@'...'@` 整个文件作为变量，再用
`Set-Content -Value $content -Encoding UTF8 -NoNewline` 写入，PS 不会解析
`@'...'@` 内部的内容，只当作字面字符串。

### 5.3 Tauri 事件 wrapper 陷阱

`onSidecarReady(cb)` 内部用 `t.event.listen("sidecar-ready", e => cb(e.payload))`
注册了一个 wrapper，测试 mock `listen` 收到的 cb 是 wrapper 而不是 userCb。
直接 `readyCb({})` 调不到 userCb 的正确 payload，必须传 Tauri 事件 shape
`{ payload: ... }` 让 wrapper 解包。

### 5.4 dispose 后失效陷阱

mock 的 `readyUnsub` 必须让 trigger 失效，否则 dispose 测试假阳性
（dispose 后 trigger 还能调 wrapper → wrapper 仍能调 userCb → state 变化）。
用 `readyActive` / `diedActive` 布尔位控制 trigger 内部是否真的调 cb。

### 5.5 App.svelte 模板引用陷阱

refactor 后必须同时改 `<script>` 和 template 两段。本轮发现 line 216 模板
段漏改 `backendReady`/`backendError` → `gate.ready`/`gate.error`，
build 时会因未声明变量编译失败。

## 六、build 验证

```
dist/index.html                   0.48 kB │ gzip:  0.33 kB
dist/assets/index-DtefEBd4.css   30.43 kB │ gzip:  6.75 kB
dist/assets/index-DaJpLFhN.js   138.30 kB │ gzip: 50.05 kB
✓ built in 1.38s
```

`dist/assets/index-*.js` 含 `splash-overlay` / `splash-spinner` / `splash-err`
/ `splash-hint` / `sidecar-ready` / `sidecar-died` / `3e4` (30000) /
8 处 `setTimeout`。

## 七、提交计划

```
refactor(frontend): sidecar 生命周期抽到 createSplashGate composable (M0-f 3rd round)

- 新建 lib/splash-gate.svelte.ts (105 行)：$state rune + 默认 isTauri/
  onSidecarReady/onSidecarDied 注入 + 30s 启动超时 + dispose 释放订阅
- App.svelte 重构 (382→245 行，-110)：gate 持有 splash 状态，App.svelte
  只剩 doInit 业务 init + gate.start/dispose + <SplashOverlay gate.ready/gate.error/>
- 修复 App.svelte 模板引用 bug：line 216 仍用 backendReady/backendError
  未切到 gate.ready/gate.error（Svelte 编译会失败）
- app-splash.test.ts 重写：13 个 stale assertion 删除，8 个 gate 断言新增
- splash-gate.test.ts 新建：10 case 覆盖浏览器/Tauri/事件/超时/dispose
- 修复 GBK 编码陷阱：PowerShell Set-Content 在中文 Windows 默认写 GBK，
  改用 PowerShell here-string @'...'@ + Set-Content -Encoding UTF8 -NoNewline
- 修复 mock 设计：原 mock 把 tauri.ts 的 wrapper 当 user callback，
  改为正确模拟 Tauri 事件 shape { payload: ... }
```

## 八、未来工作（M0-f 之后）

- [ ] P0 M0-g：sidecar 真实启动 + 后端通信（目前是空 sidecar）
- [ ] splash 进度条（markReady 前显示「启动后端 30%」之类，由 Rust 端 sidecar 事件驱动）
- [ ] splash-gate 暴露 `progress` rune（侧边栏 / 设置页可显示）
- [ ] splash-gate 在断连时显示重试按钮（onSidecarDied 时不只 set error，
      还暴露 retry() 让用户手动重启 sidecar）
- [ ] 把「App.svelte 端不再 import tauri sidecar API」放到 lint 规则里
      （svelte-check / 自定义 eslint rule）