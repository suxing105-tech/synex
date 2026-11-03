import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import SplashOverlay from "../components/SplashOverlay.svelte";

// 启动引导页（展示层）回归：三段编排 + 错误态 + 无障碍。
//
// 这一轮换掉的是「通用件」：旋转环 + 来回跑的光条跟品牌无关，进度还是假的。
// 现在是字标被斜向光扫点亮 → 地标线展开 → 按阶段换文案 → 淡出收场。
// 字标用 /logo.png 的透明通道当 CSS mask，所以不需要另画一份矢量。

afterEach(cleanup);

const src = readFileSync(resolve("src/components/SplashOverlay.svelte"), "utf8");

describe("启动引导页（画廊成形 · 品牌段）", () => {
  it("boot 段：字标 + 地标线 + 文案，旋转环和假进度条都已删除", () => {
    const ui = render(SplashOverlay, { phase: "boot", error: null });
    expect(ui.getByRole("img", { name: "闪寻空间" })).toBeTruthy();
    expect(ui.getByText("正在唤醒本地引擎")).toBeTruthy();
    expect(ui.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(ui.container.querySelector(".splash-rule")).toBeTruthy();
    expect(ui.container.querySelector(".splash-orbit")).toBeNull();
    expect(ui.container.querySelector(".splash-track")).toBeNull();
  });

  it("index 段换文案，且不出现品牌中文名（首屏品牌只保留 LOGO）", () => {
    const ui = render(SplashOverlay, { phase: "index", error: null });
    expect(ui.getByText("正在整理图库")).toBeTruthy();
    expect(ui.queryByText("苏醒图库")).toBeNull();
  });

  it("光带靠 mask 只走字形，不再贴一张会露白底的 logo 图", () => {
    expect(src).toMatch(/mask:\s*url\("?\ \/ ?logo\.png\)?|mask:\s*url\(\/logo\.png\)/);
    expect(src).not.toMatch(/class="splash-logo"/);
    // 地标线必须在字标外面：mask 裁的是整棵子树，放进去就一起被裁掉
    expect(src).toMatch(/<div class="splash-mark"[^>]*><\/div>\s*\n\s*<span class="splash-rule"/);
  });

  it("ready 先演淡出再卸载，不是硬切", async () => {
    vi.useFakeTimers();
    try {
      const ui = render(SplashOverlay, { phase: "index", error: null });
      await ui.rerender({ phase: "ready", error: null });
      const el = ui.container.querySelector(".splash-overlay");
      expect(el, "收场要先留一段淡出").toBeTruthy();
      expect(el!.classList.contains("is-leaving")).toBe(true);
      expect(el!.getAttribute("aria-busy")).toBe("false");
      await vi.advanceTimersByTimeAsync(340);
      await tick();
      expect(ui.container.querySelector(".splash-overlay")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("以 ready 创建时根本不渲染：浏览器 dev 不该闪一下启动页", () => {
    const ui = render(SplashOverlay, { phase: "ready", error: null });
    expect(ui.container.querySelector(".splash-overlay")).toBeNull();
  });

  it("启动失败：停动画、给具体原因、并留一条重试出口", () => {
    const ui = render(SplashOverlay, { phase: "error", error: "连接失败" });
    expect(ui.getByRole("alert").textContent).toContain("连接失败");
    expect(ui.getByText(/请关闭应用后重新打开/)).toBeTruthy();
    expect(ui.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(ui.getByRole("status").getAttribute("aria-busy")).toBe("false");
    expect(src).toMatch(/\.has-error,[\s\S]{0,240}animation:\s*none;/);
  });

  it("全屏无卡片、支持减少动画偏好，主界面品牌只保留 LOGO", () => {
    expect(src).toContain("position: fixed");
    expect(src).toContain("inset: 0");
    expect(src).not.toContain("splash-card");
    expect(src).toContain("prefers-reduced-motion: reduce");
    // 全屏遮罩不吃点击：淡出那 340ms 底下已经是可用界面
    expect(src).toMatch(/\.is-leaving\s*\{[\s\S]{0,80}pointer-events:\s*none/);
    const header = readFileSync(resolve("src/components/HeaderBar.svelte"), "utf8");
    expect(header).not.toContain("<span>苏醒图库</span>");
    expect(header).toContain('src="/logo.png"');
  });
});
