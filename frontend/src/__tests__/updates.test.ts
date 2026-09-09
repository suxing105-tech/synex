import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { startUpdates, updateAction, updateStatus, updateError, isUpdateBusy, downloadPercent } from "../lib/updates";

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
    await vi.advanceTimersByTimeAsync(14999);
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
  it("uses indeterminate progress when length is unknown", () => {
    expect(downloadPercent(200, null)).toBeNull(); expect(downloadPercent(200, 0)).toBeNull();
    expect(downloadPercent(50, 200)).toBe(25); expect(downloadPercent(201, 200)).toBe(100);
    expect(isUpdateBusy("installing")).toBe(true); expect(isUpdateBusy("ready")).toBe(false);
  });
});
