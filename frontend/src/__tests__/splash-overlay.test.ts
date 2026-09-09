import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// 回归测试：SplashOverlay 组件（M0-f 抽出的视觉层组件）。
//
// SplashOverlay.svelte 是 App.svelte 的纯展示组件：
// - Props: { ready: boolean; error: string | null }
// - 当 !ready 时渲染 splash-overlay / splash-card / splash-logo +
//   spinner + hint（或 error 时 splash-err + hint）
// - 样式全部 scoped 在组件内部（含 @keyframes splash-spin）
//
// 本测试锁住这些标识符必须在组件文件里存在，否则下次 cargo tauri build 后的
// dist 会丢失 splash overlay 类名导致 prod 黑屏。
//
// App.svelte 端的 backendReady / sidecar 订阅等生命周期测试见 app-splash.test.ts。

const here = dirname(fileURLToPath(import.meta.url));
const componentPath = resolve(here, "..", "components", "SplashOverlay.svelte");
const raw = readFileSync(componentPath, "utf8");

function extractBlock(source: string, openTag: string, closeTag: string): string {
  const start = source.indexOf(openTag);
  if (start < 0) throw new Error("SplashOverlay.svelte missing " + openTag);
  const end = source.indexOf(closeTag, start);
  if (end < 0) throw new Error("SplashOverlay.svelte missing " + closeTag);
  return source.slice(start + openTag.length, end);
}

const scriptSrc = extractBlock(raw, "<script", "</script>");
const beforeScript = raw.slice(0, raw.indexOf("<script"));
const afterScript = raw.slice(raw.indexOf("</script>") + "</script>".length);
const templateSrc = beforeScript + afterScript;
const styleSrc = extractBlock(raw, "<style>", "</style>");

describe("SplashOverlay.svelte 视觉组件（M0-f 拆分）", () => {
  describe("<script> Props 接口", () => {
    it("声明 interface Props 含 ready + error", () => {
      expect(
        /interface\s+Props\s*\{[\s\S]*?\bready\s*:\s*boolean[\s\S]*?\berror\s*:\s*string\s*\|\s*null[\s\S]*?\}/.test(scriptSrc),
        "SplashOverlay.svelte 必须有 interface Props { ready: boolean; error: string | null }"
      ).toBe(true);
    });

    it("let { ready, error }: Props = $props() 解构 props", () => {
      expect(
        /let\s*\{\s*ready\s*,\s*error\s*\}\s*:\s*Props\s*=\s*\$props\s*\(/.test(scriptSrc),
        "SplashOverlay.svelte 必须 let { ready, error }: Props = $props() 解构 props"
      ).toBe(true);
    });
  });

  describe("模板结构", () => {
    it("`{#if !ready}` 守卫：ready 时不渲染 overlay", () => {
      expect(
        /\{\s*#if\s+!\s*ready\s*\}/.test(templateSrc),
        "模板必须有 {#if !ready} 守卫，ready=true 时整个 overlay 不渲染"
      ).toBe(true);
    });

    it("含 splash-overlay / splash-card / splash-logo 容器", () => {
      expect(/class="splash-overlay"/.test(templateSrc)).toBe(true);
      expect(/class="splash-card"/.test(templateSrc)).toBe(true);
      expect(/class="splash-logo"/.test(templateSrc)).toBe(true);
      // logo 文案
      expect(/<div class="splash-logo"><img src="\/logo.png" alt="" width="32" height="32" \/>苏醒图库<\/div>/.test(templateSrc)).toBe(true);
    });

    it("默认（无 error）显示 splash-spinner + splash-hint", () => {
      expect(/class="splash-spinner"/.test(templateSrc)).toBe(true);
      expect(/<div class="splash-hint">正在启动后端进程/.test(templateSrc)).toBe(true);
    });

    it("有 error 时显示 splash-err + splash-hint", () => {
      expect(
        /\{\s*#if\s+error\s*\}[\s\S]*?<div class="splash-err">后端进程异常：\{error\}<\/div>[\s\S]*?build-sidecar\.ps1/.test(templateSrc),
        "模板 error 分支必须含 splash-err + reason + build-sidecar.ps1 提示"
      ).toBe(true);
    });

    it("overlay 容器带 role + aria-live 让屏幕阅读器朗读状态变化", () => {
      expect(
        /<div class="splash-overlay"[^>]*\brole="alert"[^>]*\baria-live="polite"/.test(templateSrc),
        "splash-overlay 容器必须有 role=alert + aria-live=polite"
      ).toBe(true);
    });
  });

  describe("<style> scoped CSS", () => {
    it(".splash-overlay 容器：fixed 全屏 + flex 居中", () => {
      expect(
        /\.splash-overlay\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*justify-content:\s*center/.test(styleSrc),
        ".splash-overlay 必须 position:fixed + inset:0 + flex 居中"
      ).toBe(true);
    });

    it(".splash-card：圆角 + padding + min-width: 320px", () => {
      expect(
        /\.splash-card\s*\{[^}]*border-radius:\s*12px[^}]*min-width:\s*320px/.test(styleSrc),
        ".splash-card 必须有 border-radius + min-width: 320px"
      ).toBe(true);
    });

    it(".splash-spinner + .splash-hint + .splash-err 基础三件套", () => {
      for (const cls of [".splash-spinner", ".splash-hint", ".splash-err"]) {
        expect(
          styleSrc.includes(cls),
          "<style> 缺 " + cls
        ).toBe(true);
      }
    });

    it("@keyframes splash-spin 旋转动画", () => {
      expect(
        /@keyframes\s+splash-spin\s*\{[^}]*to\s*\{[^}]*transform:\s*rotate\s*\(\s*360deg\s*\)/.test(styleSrc),
        "<style> 必须有 @keyframes splash-spin 旋转动画（rotate(360deg)）"
      ).toBe(true);
    });

    it(".splash-spinner animation 引用 splash-spin keyframes", () => {
      expect(
        /\.splash-spinner\s*\{[^}]*animation:\s*splash-spin\s+\d/.test(styleSrc),
        ".splash-spinner 必须 animation: splash-spin Ns ... linear infinite"
      ).toBe(true);
    });
  });

  describe("组件不能依赖外部状态（纯展示）", () => {
    it("组件不能 import ./lib/tauri（生命周期在 App.svelte）", () => {
      expect(
        /from\s*"\.\/lib\/tauri"/.test(scriptSrc),
        "SplashOverlay 是展示层，不应依赖 ./lib/tauri（sidecar 生命周期归 App.svelte）"
      ).toBe(false);
    });

    it("组件不能 import onMount / onDestroy（无副作用）", () => {
      expect(
        /import\s*\{[^}]*\bonMount\b/.test(scriptSrc),
        "SplashOverlay 是纯展示组件，不应 import onMount"
      ).toBe(false);
      expect(
        /import\s*\{[^}]*\bonDestroy\b/.test(scriptSrc),
        "SplashOverlay 是纯展示组件，不应 import onDestroy"
      ).toBe(false);
    });

    it("组件不能调 isTauri()（环境判断在 App.svelte）", () => {
      expect(
        /\bisTauri\s*\(/.test(scriptSrc),
        "SplashOverlay 是纯展示组件，不应调 isTauri()（环境判断归 App.svelte）"
      ).toBe(false);
    });
  });
});
