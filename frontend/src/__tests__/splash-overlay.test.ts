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

  it("地标就是主界面那枚缩略图滑块：几何与色值共用一份，不另拍一套", () => {
    const feed = readFileSync(resolve("src/components/Feed.svelte"), "utf8");
    const rule = src.match(/\.splash-rule \{[\s\S]*?\}/);
    expect(rule, "找不到 .splash-rule 样式块").toBeTruthy();
    expect(rule![0]).toMatch(/position:\s*relative/);
    expect(rule![0]).toMatch(/height:\s*14px/);
    // 细轨 4px / 静止色 / 圆头 14px + 2px 底色内环：四条都跟 Feed 那枚滑块同值
    expect(feed).toMatch(/\.columns-slider \{[\s\S]*?height: 4px;[\s\S]*?rgb\(50 50 55\)/);
    expect(feed).toMatch(/::-webkit-slider-thumb \{[\s\S]*?width: 14px;[\s\S]*?border: 2px solid rgb\(24 24 27\)/);
    const track = src.match(/\.rule-track \{[\s\S]*?\}/);
    expect(track![0]).toContain("#323237");
    expect(src).toMatch(/height:\s*4px;\n\s*border-radius:\s*2px;/);
    const thumb = src.match(/\.rule-thumb \{[\s\S]*?\}/);
    expect(thumb![0]).toContain("width: 14px");
    expect(thumb![0]).toContain("border: 2px solid #18181b");
  });

  it("启动期滑块头不滑动，只有就绪那一拍滑到右端：不许假进度", () => {
    const thumb = src.match(/\.rule-thumb \{[\s\S]*?\}/);
    expect(thumb![0]).not.toMatch(/animation: splash-thumb-run/);
    expect(src).toMatch(/\.is-leaving \.rule-thumb \{[\s\S]*?animation: splash-thumb-run/);
    // 展开走 clip-path：scaleX 会把 2px 圆角横向拉成钝头
    expect(src).toMatch(/\.rule-fill \{[\s\S]*?clip-path: inset\(0 100% 0 0\);/);
    expect(src).toMatch(/@keyframes splash-rule-fill \{ from \{ clip-path: inset\(0 100% 0 0\);/);
  });

  it("就绪闪光与滑块收场真的会走：mask 与 position 两个坑各钉一条", () => {
    // 光带是 mask 子树里的元素：transform 停在 box 外时，只动 opacity 等于什么都没演
    const flash = src.match(/\.is-leaving \.splash-mark::after \{[\s\S]*?\}/);
    expect(flash, "找不到就绪闪光规则").toBeTruthy();
    expect(flash![0]).not.toMatch(/transform:\s*translateX\(340%\)/);
    const kf = src.match(/@keyframes splash-ready-flash \{[\s\S]*?\n  \}/);
    expect(kf, "找不到就绪闪光 keyframes").toBeTruthy();
    expect(kf![0]).toMatch(/translateX\(-180%\)/);
    expect(kf![0]).toMatch(/translateX\(340%\)/);
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
    expect(src).toMatch(/\.has-error,[\s\S]{0,320}animation:\s*none;/);
    // 地标三层都是「动画负责从隐藏走到可见」，所以停动画必须把终态补回来，
    // 否则地标整条消失；红也要收掉——错误态什么都没在往前推
    // 选择器列表里那行 .has-error .rule-thumb { animation: none; } 也算一次命中，
    // 所以只认真正带声明的那一块：要求块里出现 background
    const errFill = src.match(/\.has-error \.rule-fill \{[^}]*background[^}]*\}/);
    expect(errFill, "找不到错误态红轨规则").toBeTruthy();
    expect(errFill![0]).toContain("clip-path: inset(0 calc(100% - 30px) 0 0)");
    expect(errFill![0]).toMatch(/background:\s*#5a5a5f/);
    const errThumb = src.match(/\.has-error \.rule-thumb \{[^}]*background[^}]*\}/);
    expect(errThumb, "找不到错误态滑块头规则").toBeTruthy();
    expect(errThumb![0]).toMatch(/transform:\s*scale\(1\)/);
    expect(errThumb![0]).not.toMatch(/242, 78, 78/);
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
