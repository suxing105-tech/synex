import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyFocusStage, nextFocusStage, windowIsMaximized, FOCUS_STAGES, type FocusStage } from "../lib/window-focus";

/**
 * F 键的沉浸循环。窗口那三步走 Tauri，侧栏那一步在 App.svelte 里，
 * 所以这里既验纯函数与窗口调用，也钉住 App 的接线（顺序写错 = 按一圈侧栏回不来）。
 */
const APP_SOURCE = readFileSync(resolve(process.cwd(), "src/App.svelte"), "utf8");
const tauriWindow = (api: Record<string, unknown>) => {
  (globalThis as Record<string, unknown>).__TAURI__ = { window: { getCurrentWindow: () => api } };
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI__;
  vi.restoreAllMocks();
});

describe("F 键沉浸循环", () => {
  it("顺序是 收起侧栏 → 最大化 → 全屏 → 还原，然后从头再来", () => {
    const order: FocusStage[] = [];
    let stage: FocusStage = "normal";
    for (let i = 0; i < FOCUS_STAGES.length; i += 1) {
      stage = nextFocusStage(stage);
      order.push(stage);
    }
    expect(order).toEqual(["sidebars", "maximized", "fullscreen", "normal"]);
    expect(nextFocusStage("normal")).toBe("sidebars");
  });

  it("最大化 / 全屏 / 还原分别调用对应窗口 API", async () => {
    const calls: string[] = [];
    tauriWindow({
      maximize: vi.fn(async () => { calls.push("maximize"); }),
      unmaximize: vi.fn(async () => { calls.push("unmaximize"); }),
      setFullscreen: vi.fn(async (value: boolean) => { calls.push(`fullscreen:${value}`); }),
    });
    expect(await applyFocusStage("sidebars")).toBeNull();
    expect(calls).toEqual([]);
    expect(await applyFocusStage("maximized")).toBeNull();
    expect(await applyFocusStage("fullscreen")).toBeNull();
    expect(await applyFocusStage("normal")).toBeNull();
    // 还原要先退全屏再退最大化，否则窗口还铺满。
    expect(calls).toEqual(["maximize", "fullscreen:true", "fullscreen:false", "unmaximize"]);
  });

  it("浏览器里没有窗口时静默通过，侧栏那一步照常", async () => {
    expect(await applyFocusStage("maximized")).toBeNull();
    expect(await windowIsMaximized()).toBe(false);
  });

  it("还原一步回到进入循环前的窗口大小：原本最大化就保持最大化", async () => {
    const calls: string[] = [];
    tauriWindow({
      maximize: vi.fn(async () => { calls.push("maximize"); }),
      unmaximize: vi.fn(async () => { calls.push("unmaximize"); }),
      setFullscreen: vi.fn(async (value: boolean) => { calls.push(`fullscreen:${value}`); }),
      isMaximized: vi.fn(async () => true),
    });
    expect(await windowIsMaximized()).toBe(true);
    // 日常把窗口最大化的用户按完一圈，回来还是最大化，而不是被甩成一个小窗口。
    expect(await applyFocusStage("normal", true)).toBeNull();
    expect(calls).toEqual(["fullscreen:false", "maximize"]);
  });

  it("窗口查询失败时当成普通窗口，不因为读状态失败就整个循环失效", async () => {
    tauriWindow({ isMaximized: vi.fn(async () => { throw new Error("gone"); }) });
    expect(await windowIsMaximized()).toBe(false);
  });

  it("窗口 API 失败时给出中文提示，不抛异常", async () => {
    tauriWindow({ maximize: vi.fn(async () => { throw new Error("denied"); }) });
    expect(await applyFocusStage("maximized")).toContain("窗口操作失败");
  });

  it("App 用可改键的 focusMode 动作接线，并在还原一步补回侧栏", () => {
    expect(APP_SOURCE).toContain('action: "focusMode"');
    expect(APP_SOURCE).toContain("nextFocusStage(focusStage)");
    expect(APP_SOURCE).toContain('if (next === "sidebars")');
    expect(APP_SOURCE).toContain("sidebarsBeforeFocus");
    expect(APP_SOURCE).toContain("windowIsMaximized()");
    expect(APP_SOURCE).toContain("applyFocusStage(next, windowMaximizedBeforeFocus)");
    // 弹窗（设置、新建文本、回收站确认…）开着时先不接管 F。
    expect(APP_SOURCE).toContain("if (document.querySelector('[aria-modal=\"true\"]");
  });
});
