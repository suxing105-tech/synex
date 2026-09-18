import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import SplashOverlay from "../components/SplashOverlay.svelte";

afterEach(cleanup);
describe("全屏 LOGO 启动画面", () => {
  it("加载时只展示 LOGO 和动效，不显示品牌文字", () => {
    const ui = render(SplashOverlay, { ready: false, error: null });
    expect(ui.getByRole("img", { name: "苏醒图库" })).toBeTruthy();
    expect(ui.queryByText("苏醒图库")).toBeNull();
    expect(ui.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(ui.container.querySelector('.splash-orbit')).toBeTruthy();
    expect(ui.container.querySelector('.splash-track')).toBeTruthy();
  });
  it("ready 后移除遮罩，不添加人为等待", async () => {
    const ui = render(SplashOverlay, { ready: false, error: null });
    await ui.rerender({ ready: true, error: null });
    expect(ui.queryByRole("status")).toBeNull();
  });
  it("启动失败停止加载动效并显示错误和恢复建议", () => {
    const ui = render(SplashOverlay, { ready: false, error: "连接失败" });
    expect(ui.getByRole("alert").textContent).toContain("连接失败");
    expect(ui.getByText(/请关闭应用后重新打开/)).toBeTruthy();
    expect(ui.container.querySelector('.splash-orbit')).toBeNull();
    expect(ui.container.querySelector('.splash-track')).toBeNull();
    expect(ui.getByRole("status").getAttribute("aria-busy")).toBe("false");
  });
  it("全屏无卡片，支持减少动画偏好，主界面品牌只保留 LOGO", () => {
    const src = readFileSync(resolve('src/components/SplashOverlay.svelte'), 'utf8');
    expect(src).toContain('position: fixed');
    expect(src).toContain('inset: 0');
    expect(src).not.toContain('splash-card');
    expect(src).toContain('prefers-reduced-motion: reduce');
    const header = readFileSync(resolve('src/components/HeaderBar.svelte'), 'utf8');
    expect(header).not.toContain('<span>苏醒图库</span>');
    expect(header).toContain('src="/logo.png"');
  });
});
