import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// 回归测试：Tauri M0-f 黑屏修复（App.svelte 端 + sidecar 生命周期 composable 拆分）。
//
// 根因：dist/assets/index-*.js 含 splash overlay（splash-overlay / splash-spinner
// / splash-err / splash-hint / @keyframes splash-spin），但 frontend/src/App.svelte
// 源码没有这些代码。下次 cargo tauri build 会重新打包，导致 prod 一直 #app 空
// div 黑屏。详见 materials/29-tauri-m0-delivery.md §7.1 + 30。
//
// 本测试覆盖：
// - App.svelte 端：M0-f 第三轮把 sidecar 生命周期（backendReady / backendError /
//   sidecar 订阅 / 30s 超时 / mark* / onDestroy cleanup）整体抽到
//   lib/splash-gate.svelte.ts 的 createSplashGate()，App.svelte 只剩：
//     - const gate = createSplashGate()
//     - onMount 内 await gate.start(doInit)
//     - onDestroy 内 gate.dispose()
//     - <SplashOverlay ready={gate.ready} error={gate.error} />
// - 反例：App.svelte 不应再 import ./lib/tauri 的 isTauri / onSidecarReady /
//   onSidecarDied（防止直接调用绕过 gate），不应再含内联 splash 模板或
//   @keyframes splash-spin。
// - gate 行为（composable 端）见 splash-gate.test.ts。
// - SplashOverlay.svelte 端：组件 Props 接口 + 模板 + CSS 见 splash-overlay.test.ts。

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "..", "App.svelte");
const raw = readFileSync(appPath, "utf8");

function extractBlock(source: string, openTag: string, closeTag: string): string {
  const start = source.indexOf(openTag);
  if (start < 0) throw new Error("App.svelte missing " + openTag);
  const end = source.indexOf(closeTag, start);
  if (end < 0) throw new Error("App.svelte missing " + closeTag);
  return source.slice(start + openTag.length, end);
}

const scriptSrc = extractBlock(raw, "<script", "</script>");
const beforeScript = raw.slice(0, raw.indexOf("<script"));
const afterScript = raw.slice(raw.indexOf("</script>") + "</script>".length);
const templateSrc = beforeScript + afterScript;

describe("App.svelte Tauri splash 防黑屏（M0-f）", () => {
  describe("<script> 必须把 sidecar 生命周期交给 createSplashGate composable", () => {
    it("import { createSplashGate } from ./lib/splash-gate.svelte", () => {
      expect(
        /import\s*\{\s*createSplashGate\s*\}\s*from\s*"\.\/lib\/splash-gate\.svelte"/.test(scriptSrc),
        "App.svelte 必须 import { createSplashGate } from \"./lib/splash-gate.svelte\""
      ).toBe(true);
    });

    it("声明 const gate = createSplashGate(...)（可带 preview 选项）", () => {
      expect(
        /\bconst\s+gate\s*=\s*createSplashGate\s*\(\s*(?:\{[^}]*\})?\s*\)/.test(scriptSrc),
        "App.svelte 必须有 `const gate = createSplashGate(...)` 持有 splash 状态"
      ).toBe(true);
    });

    it("doInit 正常路径与 finally 都要 gate.markIndexReady()", () => {
      // 首屏数据落地是收场的第二个条件；finally 那条兜住早退与异常，否则只能等 6s 上限
      const calls = scriptSrc.match(/\bgate\.markIndexReady\s*\(\s*\)/g) ?? [];
      expect(calls.length, "doInit 应至少调用两次 markIndexReady（正常路径 + finally 兜底）").toBeGreaterThanOrEqual(2);
      expect(/finally\s*\{[\s\S]{0,200}gate\.markIndexReady\s*\(\s*\)/.test(scriptSrc), "必须有 finally 里的 markIndexReady 兜底").toBe(true);
    });

    it("收场计时不外泄：App.svelte 不得出现 setTimeout 与 900/6000 字面量", () => {
      expect(/\bsetTimeout\s*\(/.test(scriptSrc), "启动计时只能在 splash-gate 里").toBe(false);
      expect(/\b(?:900|6000)\b/.test(scriptSrc), "最短呈现/数据上限的数值属于 gate，不要抄进 App").toBe(false);
    });

    it("appBooting store 由 gate.ready 驱动，骨架不各说各话", () => {
      expect(/\bappBooting\.set\(\s*!gate\.ready\s*\)/.test(scriptSrc), "App 必须把 gate.ready 镜像到 appBooting").toBe(true);
    });

    it("声明 doInit()：原 onMount 内 init 业务逻辑仍在 App.svelte", () => {
      expect(
        /\b(?:async\s+)?function\s+doInit\s*\(/.test(scriptSrc),
        "App.svelte 必须有 `function doInit()`（gate 只负责 splash 状态，业务 init 仍在 App.svelte）"
      ).toBe(true);
    });
  });

  describe("onMount 必须通过 gate 启动", () => {
    it("onMount 内 await gate.start(doInit)", () => {
      expect(
        /\bawait\s+gate\.start\s*\(\s*doInit\s*\)/.test(scriptSrc),
        "App.svelte onMount 必须 await gate.start(doInit)"
      ).toBe(true);
    });
  });

  describe("onDestroy 必须释放 gate 订阅", () => {
    it("onDestroy 调用 gate.dispose()", () => {
      expect(
        /\bgate\.dispose\s*\(\s*\)/.test(scriptSrc),
        "App.svelte onDestroy 必须调用 gate.dispose() 防泄漏"
      ).toBe(true);
    });
  });

  describe("模板用 <SplashOverlay gate.ready / gate.error>", () => {
    it("App.svelte 模板把阶段而不是布尔交给启动页", () => {
      // 启动页要知道自己该演哪一段（boot / index / error），只给 ready 就演不出编排
      expect(
        /<SplashOverlay\s+phase=\{gate\.phase\}\s+error=\{gate\.error\}\s*\/>/.test(templateSrc),
        "App.svelte 模板必须用 <SplashOverlay phase={gate.phase} error={gate.error} />"
      ).toBe(true);
      expect(
        /<SplashOverlay[^>]*ready=/.test(templateSrc),
        "不应再把 ready 布尔传给启动页：收场淡出由组件自己按 phase 演"
      ).toBe(false);
    });
  });

  describe("App.svelte 不应直接调用 sidecar 生命周期 API（绕过 gate）", () => {
    it("App.svelte 不应 import { isTauri, onSidecarReady, onSidecarDied } from ./lib/tauri", () => {
      expect(
        /import\s*\{[^}]*\bisTauri\s*,\s*onSidecarReady\s*,\s*onSidecarDied\s*[^}]*\}\s*from\s*"\.\/lib\/tauri"/.test(scriptSrc),
        "App.svelte 不应再 import isTauri/onSidecarReady/onSidecarDied（生命周期已归 gate，避免双份订阅）"
      ).toBe(false);
    });

    it("App.svelte 不应再调用 onSidecarReady(...)", () => {
      expect(
        /\bonSidecarReady\s*\(/.test(scriptSrc),
        "App.svelte 不应再直接调 onSidecarReady（已迁到 gate）"
      ).toBe(false);
    });

    it("App.svelte 不应再调用 onSidecarDied(...)", () => {
      expect(
        /\bonSidecarDied\s*\(/.test(scriptSrc),
        "App.svelte 不应再直接调 onSidecarDied（已迁到 gate）"
      ).toBe(false);
    });

    it("App.svelte 不应再设 30s 启动超时 setTimeout(..., 30000)", () => {
      expect(
        /\bsetTimeout\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?\}\s*,\s*30000\s*\)/.test(scriptSrc),
        "App.svelte 不应再 setTimeout(..., 30000)（30s 超时已迁到 gate）"
      ).toBe(false);
    });

    it("App.svelte 不应再声明 backendReady / backendError / sidecar*Unsub / backendBootTimeout", () => {
      expect(
        /\b(?:let|const)\s+backendReady\b/.test(scriptSrc),
        "App.svelte 不应再声明 backendReady（已迁到 gate）"
      ).toBe(false);
      expect(
        /\b(?:let|const)\s+backendError\b/.test(scriptSrc),
        "App.svelte 不应再声明 backendError（已迁到 gate）"
      ).toBe(false);
      expect(
        /\b(?:let|const)\s+sidecarReadyUnsub\b/.test(scriptSrc),
        "App.svelte 不应再声明 sidecarReadyUnsub（已迁到 gate）"
      ).toBe(false);
      expect(
        /\b(?:let|const)\s+sidecarDiedUnsub\b/.test(scriptSrc),
        "App.svelte 不应再声明 sidecarDiedUnsub（已迁到 gate）"
      ).toBe(false);
      expect(
        /\b(?:let|const)\s+backendBootTimeout\b/.test(scriptSrc),
        "App.svelte 不应再声明 backendBootTimeout（已迁到 gate）"
      ).toBe(false);
    });

    it("App.svelte 不应再定义 markBackendReady / markBackendFailed", () => {
      expect(
        /\bfunction\s+markBackendReady\s*\(/.test(scriptSrc),
        "App.svelte 不应再定义 markBackendReady（已迁到 gate）"
      ).toBe(false);
      expect(
        /\bfunction\s+markBackendFailed\s*\(/.test(scriptSrc),
        "App.svelte 不应再定义 markBackendFailed（已迁到 gate）"
      ).toBe(false);
    });
  });

  describe("splash 视觉层已抽到 SplashOverlay 组件（不再内联）", () => {
    it("App.svelte import SplashOverlay from ./components/SplashOverlay.svelte", () => {
      expect(
        /import\s+SplashOverlay\s+from\s+"\.\/components\/SplashOverlay\.svelte"/.test(scriptSrc),
        "App.svelte 必须 import SplashOverlay from ./components/SplashOverlay.svelte"
      ).toBe(true);
    });

    it("App.svelte 不再内联 splash overlay 模板（防止重复渲染）", () => {
      expect(
        /class="splash-overlay"/.test(templateSrc),
        "App.svelte 模板不应再内联 splash-overlay div（已抽到 SplashOverlay 组件）"
      ).toBe(false);
    });

    it("App.svelte 不再含 splash CSS（防止样式散落两处）", () => {
      expect(
        /@keyframes\s+splash-spin/.test(raw),
        "App.svelte 不应再含 @keyframes splash-spin（已抽到 SplashOverlay 组件）"
      ).toBe(false);
    });
  });
});
