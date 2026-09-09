import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSplashGate } from "../lib/splash-gate.svelte";

// 回归测试：splash-gate.svelte.ts composable（M0-f 第三轮：sidecar 生命周期
// 抽到 createSplashGate）。
//
// 设计：gate 直接 import ./lib/tauri（无 deps 注入），所以测试通过 mock
// window.__TAURI__.event.listen 实现 Tauri 行为，通过 delete window.__TAURI__
// 走 browser 路径。
//
// 关键 mock 细节：tauri.ts 的 onSidecarReady(cb) / onSidecarDied(cb) 内部用
// t.event.listen("sidecar-ready", (e) => cb(e.payload)) 注册了一个 wrapper，
// 会把 Tauri 事件 { payload: ... } 解包后再调 userCb。所以测试 mock 的 listen
// 收到的 cb 其实是 tauri.ts 的 wrapper，测试要传 Tauri 事件原 shape 才能
// 让 userCb 拿到正确的 payload。
//
// 覆盖：
// - 浏览器模式：gate.ready 默认 true / gate.error 默认 null / start(doInit)
//   返回 true 且 doInit 被调 1 次。
// - Tauri 模式：gate.ready 默认 false / start(doInit) 返回 false 且 doInit
//   不被调 / 触发 sidecar-ready callback → ready=true + doInit 被调 / 触发
//   sidecar-died callback → ready=false + error=reason / 30s 超时 →
//   error=后端进程启动超时 / dispose() 后 callback 不再影响 state，且
//   readyUnsub + diedUnsub 各被调 1 次。

declare global {
  // eslint-disable-next-line no-var
  var __TAURI__: any;
}

const originalTauri = (globalThis as any).__TAURI__;

describe("createSplashGate composable（M0-f sidecar 生命周期）", () => {
  describe("浏览器模式（window.__TAURI__ 不存在）", () => {
    beforeEach(() => {
      delete (globalThis as any).__TAURI__;
    });
    afterEach(() => {
      if (originalTauri !== undefined) {
        (globalThis as any).__TAURI__ = originalTauri;
      } else {
        delete (globalThis as any).__TAURI__;
      }
    });

    it("gate.ready 默认 true，gate.error 默认 null", () => {
      const gate = createSplashGate();
      expect(gate.ready).toBe(true);
      expect(gate.error).toBe(null);
    });

    it("await gate.start(doInit) 返回 true + doInit 被调用 1 次", async () => {
      const gate = createSplashGate();
      const doInit = vi.fn().mockResolvedValue(undefined);
      const result = await gate.start(doInit);
      expect(result).toBe(true);
      expect(doInit).toHaveBeenCalledTimes(1);
    });

    it("browser 路径不应订阅 sidecar-ready / sidecar-died 事件", async () => {
      const gate = createSplashGate();
      const doInit = vi.fn().mockResolvedValue(undefined);
      await gate.start(doInit);
      // gate 应该已经 ready=true（start 内 await doInit 后未切回 false）
      expect(gate.ready).toBe(true);
      // dispose 不应抛错（browser 路径 readyUnsub / diedUnsub 都是 no-op）
      expect(() => gate.dispose()).not.toThrow();
    });
  });

  describe("Tauri 模式（mock window.__TAURI__）", () => {
    // 触发事件用的 trigger：包装了 listen 收到的 cb（tauri.ts 的 wrapper），
    // 测试触发时要传 Tauri 事件原 shape { payload: ... }，wrapper 才会正确
    // 调 userCb(payload)。
    let readyTrigger: ((e: { payload: unknown }) => void) | null = null;
    let diedTrigger: ((e: { payload: { reason: string } }) => void) | null = null;
    let readyUnsub: (() => void) | null = null;
    let diedUnsub: (() => void) | null = null;
    let readyActive = true;
    let diedActive = true;

    beforeEach(() => {
      vi.useFakeTimers();
      readyTrigger = null;
      diedTrigger = null;
      readyActive = true;
      diedActive = true;
      readyUnsub = vi.fn(() => {
        readyActive = false;
      });
      diedUnsub = vi.fn(() => {
        diedActive = false;
      });
      (globalThis as any).__TAURI__ = {
        core: { invoke: vi.fn().mockResolvedValue({ ready: false, last_error: null }) },
        event: {
          listen: vi.fn(async (event: string, cb: any) => {
            // cb 是 tauri.ts 注册的 wrapper：(e) => userCb(e.payload)
            // 我们再套一层 trigger，trigger 会判 dispose 状态后再调 wrapper
            if (event === "sidecar-ready") {
              readyTrigger = (e: { payload: unknown }) => {
                if (readyActive) cb(e);
              };
              return readyUnsub;
            }
            if (event === "sidecar-died") {
              diedTrigger = (e: { payload: { reason: string } }) => {
                if (diedActive) cb(e);
              };
              return diedUnsub;
            }
            return vi.fn();
          }),
        },
      };
    });

    afterEach(() => {
      vi.useRealTimers();
      if (originalTauri !== undefined) {
        (globalThis as any).__TAURI__ = originalTauri;
      } else {
        delete (globalThis as any).__TAURI__;
      }
    });

    it("gate.ready 默认 false，gate.error 默认 null", () => {
      const gate = createSplashGate();
      expect(gate.ready).toBe(false);
      expect(gate.error).toBe(null);
    });

    it("READY 早于订阅时通过状态快照进入图库且只初始化一次", async () => {
      (globalThis as any).__TAURI__.core.invoke.mockResolvedValue({ ready: true });
      const gate = createSplashGate();
      const init = vi.fn().mockResolvedValue(undefined);
      await gate.start(init);
      expect(gate.ready).toBe(true);
      readyTrigger?.({ payload: {} });
      expect(init).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(31000);
      expect(gate.error).toBeNull();
      gate.dispose();
    });

    it("启动前已失败时立即显示具体错误", async () => {
      (globalThis as any).__TAURI__.core.invoke.mockResolvedValue({ ready: false, last_error: "端口被占用" });
      const gate = createSplashGate();
      await gate.start(vi.fn());
      expect(gate.error).toBe("端口被占用");
      gate.dispose();
    });

    it("较晚返回的就绪快照不能覆盖新的退出事件", async () => {
      let resolveStatus: (value: unknown) => void = () => {};
      (globalThis as any).__TAURI__.core.invoke.mockImplementation(() => new Promise(resolve => { resolveStatus = resolve; }));
      const gate = createSplashGate();
      const start = gate.start(vi.fn());
      await vi.waitFor(() => expect((globalThis as any).__TAURI__.core.invoke).toHaveBeenCalled());
      diedTrigger?.({ payload: { reason: "已退出" } });
      resolveStatus({ ready: true });
      await start;
      expect(gate.ready).toBe(false);
      expect(gate.error).toBe("已退出");
      gate.dispose();
    });

    it("await gate.start(doInit) 返回 false + doInit 不被调", async () => {
      const gate = createSplashGate();
      const doInit = vi.fn().mockResolvedValue(undefined);
      const result = await gate.start(doInit);
      expect(result).toBe(false);
      expect(doInit).not.toHaveBeenCalled();
      // Tauri 路径必须订阅两个事件
      expect((globalThis as any).__TAURI__.event.listen).toHaveBeenCalledWith(
        "sidecar-ready",
        expect.any(Function),
      );
      expect((globalThis as any).__TAURI__.event.listen).toHaveBeenCalledWith(
        "sidecar-died",
        expect.any(Function),
      );
      gate.dispose();
    });

    it("触发 sidecar-ready callback → gate.ready=true + doInit 被调 + error=null", async () => {
      const gate = createSplashGate();
      const doInit = vi.fn().mockResolvedValue(undefined);
      await gate.start(doInit);
      expect(readyTrigger).not.toBeNull();
      // 模拟 Rust 端发 sidecar-ready，payload 是 sidecar 启动信息对象
      readyTrigger!({ payload: { port: 8765 } });
      // markReady 调 doInit 是 fire-and-forget（void doInit()），等几个 microtask
      await Promise.resolve();
      await Promise.resolve();
      expect(gate.ready).toBe(true);
      expect(gate.error).toBe(null);
      expect(doInit).toHaveBeenCalledTimes(1);
      gate.dispose();
    });

    it("触发 sidecar-died callback → gate.ready=false + error=reason", async () => {
      const gate = createSplashGate();
      const doInit = vi.fn().mockResolvedValue(undefined);
      await gate.start(doInit);
      expect(diedTrigger).not.toBeNull();
      diedTrigger!({ payload: { reason: "sidecar crashed" } });
      expect(gate.ready).toBe(false);
      expect(gate.error).toBe("sidecar crashed");
      expect(doInit).not.toHaveBeenCalled();
      gate.dispose();
    });

    it("30s 超时（fakeTimers 推进）→ gate.error=后端进程启动超时", async () => {
      const gate = createSplashGate();
      const doInit = vi.fn().mockResolvedValue(undefined);
      await gate.start(doInit);
      expect(gate.ready).toBe(false);
      expect(gate.error).toBe(null);
      // fakeTimers 推进 30s
      vi.advanceTimersByTime(30000);
      expect(gate.ready).toBe(false);
      expect(gate.error).toMatch(/后端进程启动超时/);
      gate.dispose();
    });

    it("dispose() 后再触发 callback → state 不变 + readyUnsub/diedUnsub 各调 1 次", async () => {
      const gate = createSplashGate();
      const doInit = vi.fn().mockResolvedValue(undefined);
      await gate.start(doInit);
      gate.dispose();
      // dispose 之后再触发 sidecar-ready，state 应该不变（trigger 已失效）
      readyTrigger!({ payload: { port: 8765 } });
      await Promise.resolve();
      await Promise.resolve();
      expect(gate.ready).toBe(false);
      expect(gate.error).toBe(null);
      expect(doInit).not.toHaveBeenCalled();
      // dispose 必须调用 readyUnsub + diedUnsub（释放 Tauri 监听）
      expect(readyUnsub).toHaveBeenCalledTimes(1);
      expect(diedUnsub).toHaveBeenCalledTimes(1);
    });

    it("dispose() 后再次调用不应抛错（幂等）", async () => {
      const gate = createSplashGate();
      const doInit = vi.fn().mockResolvedValue(undefined);
      await gate.start(doInit);
      gate.dispose();
      expect(() => gate.dispose()).not.toThrow();
    });
  });
});
