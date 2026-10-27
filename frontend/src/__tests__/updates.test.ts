import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { startUpdates, updateAction, updateStatus, updateError, isUpdateBusy, downloadPercent, shouldAutoInstall, type UpdateStatus } from "../lib/updates";

describe("desktop updates", () => {
  beforeEach(() => { vi.useFakeTimers(); updateStatus.set(null); updateError.set(""); });
  afterEach(() => { delete (window as any).__TAURI__; vi.useRealTimers(); });
  it("does nothing in browser mode", async () => {
    const stop = startUpdates(); await updateAction("check_update");
    expect(get(updateStatus)).toBeNull(); stop();
  });
  it("subscribes before reading status and cleans up timers", async () => {
    const un = vi.fn(); const listen = vi.fn().mockResolvedValue(un);
    const invoke = vi.fn().mockResolvedValue({ phase: "idle" });
    (window as any).__TAURI__ = { event: { listen }, core: { invoke } };
    const stop = startUpdates(); await vi.advanceTimersByTimeAsync(0);
    expect(listen.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]);
    // 启动后 3 秒就自动检查一次；Rust 侧对「本次启动未检查成功」放行，不再被每日节流拦掉
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).toHaveBeenLastCalledWith("check_update", { automatic: true });
    stop(); expect(un).toHaveBeenCalledOnce();
    const count = invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120000); expect(invoke).toHaveBeenCalledTimes(count);
  });
  it("surfaces installation errors without losing the downloaded state", async () => {
    updateStatus.set({ phase: "ready" } as any);
    (window as any).__TAURI__ = { core: { invoke: vi.fn().mockRejectedValue("正在导入") } };
    await updateAction("install_update");
    expect(get(updateError)).toBe("正在导入"); expect(get(updateStatus)?.phase).toBe("ready");
  });
  it("自动更新打开且安装位置已确认时才自动装机", () => {
    const base: UpdateStatus = { current_version: "0.2.23", configured: true, installable: true, phase: "available", message: "", notes: "", version: "0.2.24", downloaded: 0, total: null, automatic: true, auto_update: true, last_check: 0 };
    expect(shouldAutoInstall(base)).toBe(true);
    expect(shouldAutoInstall({ ...base, auto_update: false })).toBe(false);
    expect(shouldAutoInstall({ ...base, installable: false })).toBe(false);
    expect(shouldAutoInstall({ ...base, phase: "latest", version: null })).toBe(false);
    expect(shouldAutoInstall({ ...base, version: null })).toBe(false);
    expect(shouldAutoInstall(null)).toBe(false);
  });
  it("检查到新版本后自动下载并安装，且同一版本只走一次", async () => {
    const found: UpdateStatus = { current_version: "0.2.23", configured: true, installable: true, phase: "available", message: "发现新版本", notes: "", version: "0.2.24", downloaded: 0, total: null, automatic: true, auto_update: true, last_check: 0 };
    const invoke = vi.fn(async (command: string) => {
      if (command === "get_update_status") return found;
      if (command === "download_update") return { ...found, phase: "ready" };
      if (command === "install_update") return { ...found, phase: "installing" };
      throw new Error(`unexpected command ${command}`);
    });
    (window as any).__TAURI__ = { event: { listen: vi.fn().mockResolvedValue(() => {}) }, core: { invoke } };
    const stop = startUpdates();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["get_update_status", "download_update", "install_update"]);
    // 状态又被广播成 available（例如事件重放）也不该重复装
    updateStatus.set(found);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(3);
    stop();
  });
  it("没打开自动更新时，发现新版本只提醒不动手", async () => {
    const found = { current_version: "0.2.23", configured: true, installable: true, phase: "available", message: "", notes: "", version: "0.2.24", downloaded: 0, total: null, automatic: true, auto_update: false, last_check: 0 };
    const invoke = vi.fn(async (command: string) => (command === "get_update_status" ? found : found));
    (window as any).__TAURI__ = { event: { listen: vi.fn().mockResolvedValue(() => {}) }, core: { invoke } };
    const stop = startUpdates();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["get_update_status"]);
    stop();
  });
  it("uses indeterminate progress when length is unknown", () => {
    expect(downloadPercent(200, null)).toBeNull(); expect(downloadPercent(200, 0)).toBeNull();
    expect(downloadPercent(50, 200)).toBe(25); expect(downloadPercent(201, 200)).toBe(100);
    expect(isUpdateBusy("installing")).toBe(true); expect(isUpdateBusy("ready")).toBe(false);
  });
});
