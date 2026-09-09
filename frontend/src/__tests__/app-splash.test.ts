import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// 回归测试：Tauri M0-f 黑屏修复（App.svelte 端 + SplashOverlay 组件拆分）。
//
// 根因：dist/assets/index-*.js 含 splash overlay（splash-overlay / splash-spinner
// / splash-err / splash-hint / @keyframes splash-spin），但 frontend/src/App.svelte
// 源码没有这些代码。下次 cargo tauri build 会重新打包，导致 prod 一直 #app 空
// div 黑屏。详见 materials/29-tauri-m0-delivery.md §7.1 + 30。
//
// 本测试覆盖：
// - App.svelte 端：sidecar 生命周期（backendReady / backendError / doInit / mark*
//   / onMount 订阅 / 30s 超时 / onDestroy cleanup），并验证 splash 视觉已抽出
//   到独立组件（不再内联模板 / 不再含 splash CSS），由 <SplashOverlay ready=... error=.../>
//   替代。
// - SplashOverlay.svelte 端：组件 Props 接口 + 模板 + CSS（见 splash-overlay.test.ts）。

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
  describe("<script> 必须含后端就绪状态与启动流程", () => {
    it("import isTauri / onSidecarReady / onSidecarDied from ./lib/tauri", () => {
      expect(
        /import\s*\{\s*isTauri\s*,\s*onSidecarReady\s*,\s*onSidecarDied\s*\}\s*from\s*"\.\/lib\/tauri"/.test(scriptSrc),
        "App.svelte 必须 import { isTauri, onSidecarReady, onSidecarDied } from \"./lib/tauri\""
      ).toBe(true);
    });

    it("声明 backendReady = $state(!isTauri())", () => {
      expect(
        /let\s+backendReady\s*=\s*\$state\(\s*!\s*isTauri\(\)\s*\)/.test(scriptSrc),
        "App.svelte 必须有 `let backendReady = $state(!isTauri())` 控制 splash 显示"
      ).toBe(true);
    });

    it("声明 backendError = $state(null)", () => {
      expect(
        /let\s+backendError[^=]*=\s*\$state\(\s*null\s*\)/.test(scriptSrc),
        "App.svelte 必须有 `let backendError = $state(null)` 记录后端错误"
      ).toBe(true);
    });

    it("声明 doInit()：原 onMount 内 init 逻辑抽出来", () => {
      expect(
        /\b(?:async\s+)?function\s+doInit\s*\(/.test(scriptSrc),
        "App.svelte 必须有 `function doInit()` 封装原 onMount init 流程"
      ).toBe(true);
    });

    it("声明 markBackendReady()：切 ready + 清 error + 调 doInit", () => {
      expect(
        /\bfunction\s+markBackendReady\s*\(/.test(scriptSrc),
        "App.svelte 必须有 `function markBackendReady()`"
      ).toBe(true);
    });

    it("声明 markBackendFailed(reason)：切错误卡", () => {
      expect(
        /\bfunction\s+markBackendFailed\s*\(\s*reason\s*:/.test(scriptSrc),
        "App.svelte 必须有 `function markBackendFailed(reason: string)`"
      ).toBe(true);
    });
  });

  describe("onMount 必须订阅 sidecar 事件 + 30s 超时", () => {
    it("onMount 内调用 onSidecarReady(...) 订阅 ready", () => {
      expect(
        /\bonSidecarReady\s*\(/.test(scriptSrc),
        "App.svelte onMount 必须调用 onSidecarReady(...) 等待后端就绪"
      ).toBe(true);
    });

    it("onMount 内调用 onSidecarDied(...) 订阅 died", () => {
      expect(
        /\bonSidecarDied\s*\(/.test(scriptSrc),
        "App.svelte onMount 必须调用 onSidecarDied(...) 监听后端崩溃"
      ).toBe(true);
    });

    it("onMount 内 setTimeout(..., 30000) 设置 30s 启动超时", () => {
      expect(
        /\bsetTimeout\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?\}\s*,\s*30000\s*\)/.test(scriptSrc),
        "App.svelte onMount 必须 setTimeout(..., 30000) 30s 启动超时（防卡死）"
      ).toBe(true);
    });

    it("onMount 包含 `if (isTauri())` 分支", () => {
      expect(
        /\bif\s*\(\s*isTauri\s*\(\s*\)\s*\)\s*\{/.test(scriptSrc),
        "App.svelte onMount 必须 if (isTauri()) 区分 Tauri / 浏览器路径"
      ).toBe(true);
    });
  });

  describe("onDestroy 必须释放 sidecar 监听", () => {
    it("onDestroy 调用 sidecarReadyUnsub()", () => {
      expect(
        /\bif\s*\(\s*sidecarReadyUnsub\s*\)\s+sidecarReadyUnsub\s*\(/.test(scriptSrc),
        "App.svelte onDestroy 必须调用 sidecarReadyUnsub() 防泄漏"
      ).toBe(true);
    });

    it("onDestroy clearTimeout(backendBootTimeout)", () => {
      expect(
        /\bif\s*\(\s*backendBootTimeout\s*\)\s+clearTimeout\s*\(\s*backendBootTimeout\s*\)/.test(scriptSrc),
        "App.svelte onDestroy 必须 clearTimeout(backendBootTimeout) 防泄漏"
      ).toBe(true);
    });
  });

  describe("splash 视觉层已抽到 SplashOverlay 组件（不再内联）", () => {
    it("App.svelte import SplashOverlay from ./components/SplashOverlay.svelte", () => {
      expect(
        /import\s+SplashOverlay\s+from\s+"\.\/components\/SplashOverlay\.svelte"/.test(scriptSrc),
        "App.svelte 必须 import SplashOverlay from ./components/SplashOverlay.svelte"
      ).toBe(true);
    });

    it("App.svelte 模板用 <SplashOverlay ready={backendReady} error={backendError} />", () => {
      expect(
        /<SplashOverlay\s+ready=\{backendReady\}\s+error=\{backendError\}\s*\/>/.test(templateSrc),
        "App.svelte 模板必须调 <SplashOverlay ready={backendReady} error={backendError} />"
      ).toBe(true);
    });

    it("App.svelte 不再内联 splash overlay 模板（防止重复渲染）", () => {
      // 反例：模板不应再含 class="splash-overlay" 内联 div，否则会双重渲染
      expect(
        /class="splash-overlay"/.test(templateSrc),
        "App.svelte 模板不应再内联 splash-overlay div（已抽到 SplashOverlay 组件）"
      ).toBe(false);
    });

    it("App.svelte 不再含 splash CSS（防止样式散落两处）", () => {
      // 反例：<style> 内不应再含 splash-* 规则
      expect(
        /@keyframes\s+splash-spin/.test(raw),
        "App.svelte 不应再含 @keyframes splash-spin（已抽到 SplashOverlay 组件）"
      ).toBe(false);
    });
  });
});