import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import DesktopTitlebar from "../components/DesktopTitlebar.svelte";
import { appBooting } from "../lib/stores";

// 启动期整窗要读成「一块还没填满的界面」，而不是「一半完工的半成品」。
// 中间栏靠 FeedSkeleton，侧栏与详情栏在这里钉；标题栏是唯一的真实渲染测试，
// 因为它一旦不透明，就会盖住铺满整窗的启动页并多出一个 logo。

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("启动期 chrome", () => {
  it("侧栏：计数未到时压成等待条，不显示假的 0；来源目录铺骨架行", () => {
    const src = read("src/components/FolderTree.svelte");
    expect(src).toContain("class:pending={$appBooting}");
    expect(src).toMatch(/\{#if \$appBooting\}\s*<div class="tree-skeleton"/);
    // 空目录提示必须等启动结束才说，否则启动瞬间会看到「还没有来源目录」
    expect(src).toContain("{#if !$appBooting && userFolders.length === 0 && !newFolderFor}");
  });

  it("详情栏：启动期铺骨架块，不提前教用户「选一张图」", () => {
    const src = read("src/components/DetailPanel.svelte");
    const boot = src.indexOf("{:else if $appBooting}");
    const hint = src.indexOf("在中间选一张图片或文本");
    expect(boot).toBeGreaterThan(-1);
    expect(src.slice(boot, hint)).toContain("detail-skeleton");
  });

  it("骨架换成真卡与启动页淡出走同一条曲线：交叉溶解才不暗场", () => {
    const CURVE = "220ms cubic-bezier(.4, 0, .2, 1)";
    const mat = read("src/components/Feed.svelte").match(/animation:\s*card-materialize\s+([^;]+);/);
    expect(mat, "找不到 card-materialize 动画").toBeTruthy();
    expect(mat![1]).toContain(CURVE);
    expect(read("src/components/SplashOverlay.svelte")).toContain(`animation: splash-fade-out ${CURVE}`);
  });

  describe("标题栏", () => {
    const appWindow = {
      isMaximized: vi.fn(async () => false),
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onResized: vi.fn(async () => () => {}),
    };

    beforeEach(() => {
      vi.clearAllMocks();
      (window as any).__TAURI__ = { window: { getCurrentWindow: () => appWindow } };
    });
    afterEach(() => {
      cleanup();
      delete (window as any).__TAURI__;
      appBooting.set(false);
    });

    it("启动期透明并隐去品牌，避免和启动页重复一个 logo", () => {
      appBooting.set(true);
      const screen = render(DesktopTitlebar);
      const bar = screen.getByRole("banner", { name: "窗口标题栏" });
      expect(bar.classList.contains("is-booting")).toBe(true);
      const src = read("src/components/DesktopTitlebar.svelte");
      expect(src).toMatch(/\.is-booting \{ background:\s*transparent/);
      // 用 opacity 隐去而不是删节点：无障碍名与既有断言都不受影响
      expect(src).toMatch(/\.is-booting \.titlebar-drag img,[\s\S]*opacity:\s*0/);
    });

    it("启动期窗口仍然可拖动、可关闭", async () => {
      appBooting.set(true);
      const screen = render(DesktopTitlebar);
      const bar = screen.getByRole("banner", { name: "窗口标题栏" });
      expect(bar.querySelector("[data-tauri-drag-region]")).toBeTruthy();
      await fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
      expect(appWindow.close).toHaveBeenCalledOnce();
    });
  });
});
