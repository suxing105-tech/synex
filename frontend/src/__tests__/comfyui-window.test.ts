import { describe, it, expect, beforeEach, vi } from "vitest";
import { openOrReuseComfyuiTab, _resetComfyuiWindow } from "../lib/comfyui-window";

describe("comfyui-window", () => {
  beforeEach(() => {
    _resetComfyuiWindow();
    vi.restoreAllMocks();
  });

  it("首次调用：window.open 用 suxing_comfyui 窗口名，传目标 URL", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const w = openOrReuseComfyuiTab("http://127.0.0.1:8188");
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0][0]).toBe("http://127.0.0.1:8188");
    expect(openSpy.mock.calls[0][1]).toBe("suxing_comfyui");
    expect(w).toBeNull();
  });

  it("多次调用：每次都用同一窗口名（浏览器自己负责复用）", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    openOrReuseComfyuiTab("http://127.0.0.1:8188");
    openOrReuseComfyuiTab("http://127.0.0.1:8188");
    openOrReuseComfyuiTab("http://127.0.0.1:8188");
    expect(openSpy).toHaveBeenCalledTimes(3);
    // 关键：窗口名全程保持不变 → 浏览器会复用同一个标签页
    for (const call of openSpy.mock.calls) {
      expect(call[1]).toBe("suxing_comfyui");
    }
  });

  it("window.open 返回非空 → 尝试 focus()，跨源失败也不抛错", () => {
    // 模拟跨源 focus 抛错的情况（真实 ComfyUI 在不同端口）
    const fakeWin = { focus: vi.fn(() => { throw new Error("cross-origin"); }) } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(fakeWin);
    const w = openOrReuseComfyuiTab("http://127.0.0.1:8188");
    expect(w).toBe(fakeWin);
    expect(fakeWin.focus).toHaveBeenCalledTimes(1);
    // 不应抛错
    expect(() => openOrReuseComfyuiTab("http://127.0.0.1:8188")).not.toThrow();
  });

  it("桌面版（Tauri）：不再调用 window.open，改走 open_external_url 交给系统默认浏览器", () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as any).__TAURI__ = { core: { invoke } };
    try {
      const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
      const w = openOrReuseComfyuiTab("http://127.0.0.1:8188");
      expect(openSpy).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "http://127.0.0.1:8188" });
      expect(w).toBeNull();
    } finally {
      delete (window as any).__TAURI__;
    }
  });

  it("桌面版：invoke 失败只被吞掉，不抛错（详情面板后面还要写工作流临时文件）", async () => {
    (window as any).__TAURI__ = { core: { invoke: vi.fn().mockRejectedValue(new Error("boom")) } };
    try {
      expect(() => openOrReuseComfyuiTab("http://127.0.0.1:8188")).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      delete (window as any).__TAURI__;
    }
  });
});
