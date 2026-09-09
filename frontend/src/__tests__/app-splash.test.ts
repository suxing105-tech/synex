import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// 回归测试：Tauri M0-f 黑屏修复。
//
// 根因：dist/assets/index-*.js 含 splash overlay（splash-overlay / splash-spinner
// / splash-err / splash-hint / @keyframes splash-spin），但 frontend/src/App.svelte
// 源码没有这些代码。下次 cargo tauri build 会重新打包，导致 prod 一直 #app 空
// div 黑屏。详见 materials/29-tauri-m0-delivery.md §7.1 + 30。
//
// 本测试用静态扫描锁住以下关键标识符必须在 App.svelte 里存在，防止后续 PR
// 不小心把这些代码删掉 / 漏合并。

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
      // 匹配 onSidecarReady( 的调用（不论参数）
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

  describe("模板必须含 splash overlay", () => {
    it("模板 `{#if !backendReady}` 守卫", () => {
      expect(
        /\{\s*#if\s+!\s*backendReady\s*\}/.test(templateSrc),
        "App.svelte 模板必须有 {#if !backendReady} 守卫，后端未就绪时显示 splash"
      ).toBe(true);
    });

    it("模板含 splash-overlay / splash-card / splash-logo", () => {
      expect(/class="splash-overlay"/.test(templateSrc)).toBe(true);
      expect(/class="splash-card"/.test(templateSrc)).toBe(true);
      expect(/class="splash-logo"/.test(templateSrc)).toBe(true);
    });

    it("模板含 splash-spinner / splash-hint / splash-err", () => {
      expect(/class="splash-spinner"/.test(templateSrc)).toBe(true);
      expect(/class="splash-hint"/.test(templateSrc)).toBe(true);
      expect(/class="splash-err"/.test(templateSrc)).toBe(true);
    });

    it("splash-err 提示包含 build-sidecar.ps1 关键字", () => {
      // 用户提示：反复失败时建议运行 build-sidecar.ps1 重建
      expect(/build-sidecar\.ps1/.test(templateSrc)).toBe(true);
    });
  });

  describe("<style> 必须含 splash CSS + keyframes", () => {
    const styleSrc = extractBlock(raw, "<style>", "</style>");

    it(".splash-overlay / .splash-card / .splash-logo / .splash-spinner / .splash-hint / .splash-err CSS", () => {
      for (const cls of [
        ".splash-overlay",
        ".splash-card",
        ".splash-logo",
        ".splash-spinner",
        ".splash-hint",
        ".splash-err",
      ]) {
        expect(
          styleSrc.includes(cls),
          "App.svelte <style> 缺 " + cls + " CSS"
        ).toBe(true);
      }
    });

    it("@keyframes splash-spin 旋转动画", () => {
      expect(
        /@keyframes\s+splash-spin\b/.test(styleSrc),
        "App.svelte <style> 必须有 @keyframes splash-spin 旋转动画"
      ).toBe(true);
    });
  });

  describe("反例：splash 不要混进模板根节点（应独立 {#if}）", () => {
    it("splash-overlay 不应该被 bind / 直接挂在 <div class=\"h-screen\"> 根上", () => {
      // splash-overlay 必须出现在顶层 {#if !backendReady} 守卫中，单独渲染
      // 不应嵌入在主 grid 容器内（避免覆盖 z-index 计算错误）
      const splashIdx = raw.indexOf('class="splash-overlay"');
      const rootIdx = raw.indexOf('class="h-screen w-screen');
      expect(splashIdx).toBeGreaterThan(-1);
      expect(rootIdx).toBeGreaterThan(-1);
      // splash-overlay 必须出现在 root 之后（顶层 append 而非嵌入）
      expect(splashIdx > rootIdx, "splash-overlay 应追加在根 <div> 之后顶层渲染").toBe(true);
    });
  });
});
