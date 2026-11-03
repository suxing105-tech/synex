import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createSplashGate,
  SPLASH_INDEX_TIMEOUT_MS,
  SPLASH_MIN_PRESENTATION_MS,
} from "../lib/splash-gate.svelte";

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
      // 后端起来了，但首屏数据还没落地：仍在 index 段，不提前收场
      expect(gate.phase).toBe("index");
      expect(gate.ready).toBe(false);
      readyTrigger?.({ payload: {} });
      expect(init).toHaveBeenCalledTimes(1);
      gate.markIndexReady();
      vi.advanceTimersByTime(31000);
      expect(gate.ready).toBe(true);
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
      expect(gate.error).toBe(null);
      expect(doInit).toHaveBeenCalledTimes(1);
      // 收场是双条件：这里只满足「后端就绪」，所以还不该收
      expect(gate.ready).toBe(false);
      gate.markIndexReady();
      expect(gate.ready).toBe(false); // 最短呈现未到
      vi.advanceTimersByTime(900);
      expect(gate.ready).toBe(true);
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

  describe("收场双条件与计时（画廊成形轮新增）", () => {

    it("后端就绪但首屏数据未回：停在 index 段不收场", async () => {
      // 上限写死在这里，不靠默认值——默认值是会被调的（这轮就从 6000 调到了 4000）
      const gate = createSplashGate({ indexTimeoutMs: 9000 });
      await gate.start(vi.fn().mockResolvedValue(undefined));
      readyTrigger!({ payload: { port: 8765 } });
      vi.advanceTimersByTime(5000);
      expect(gate.phase).toBe("index");
      expect(gate.ready).toBe(false);
      expect(gate.error).toBe(null);
      gate.dispose();
    });

    it("首屏数据先回来也不提前收场，最短呈现到点才 ready", async () => {
      const gate = createSplashGate({ minPresentationMs: 900 });
      await gate.start(vi.fn().mockResolvedValue(undefined));
      readyTrigger!({ payload: {} });
      gate.markIndexReady();
      vi.advanceTimersByTime(899);
      expect(gate.ready).toBe(false);
      vi.advanceTimersByTime(1);
      expect(gate.ready).toBe(true);
      expect(gate.phase).toBe("ready");
      gate.dispose();
    });

    it("首屏数据永不落地：到上限放行，不报错", async () => {
      const gate = createSplashGate({ indexTimeoutMs: 6000, minPresentationMs: 900 });
      await gate.start(vi.fn().mockResolvedValue(undefined));
      readyTrigger!({ payload: {} });
      vi.advanceTimersByTime(5999);
      expect(gate.ready).toBe(false);
      vi.advanceTimersByTime(1);
      expect(gate.ready).toBe(true);
      expect(gate.error).toBe(null);
      gate.dispose();
    });

    it("markIndexReady 幂等，dispose 后调用不抛错", async () => {
      const gate = createSplashGate();
      await gate.start(vi.fn().mockResolvedValue(undefined));
      readyTrigger!({ payload: {} });
      gate.markIndexReady();
      expect(() => gate.markIndexReady()).not.toThrow();
      gate.dispose();
      expect(() => gate.markIndexReady()).not.toThrow();
    });

    it("就绪后再收到 sidecar-died：错误优先，phase 转 error", async () => {
      const gate = createSplashGate();
      await gate.start(vi.fn().mockResolvedValue(undefined));
      readyTrigger!({ payload: {} });
      gate.markIndexReady();
      vi.advanceTimersByTime(1000);
      expect(gate.ready).toBe(true);
      diedTrigger!({ payload: { reason: "后台已退出" } });
      expect(gate.ready).toBe(false);
      expect(gate.phase).toBe("error");
      expect(gate.error).toBe("后台已退出");
      gate.dispose();
    });
  });
  });

  describe("preview 回放（浏览器 + ?splash=preview）", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      delete (globalThis as any).__TAURI__;
    });

    afterEach(() => {
      vi.useRealTimers();
      if (originalTauri !== undefined) {
        (globalThis as any).__TAURI__ = originalTauri;
      } else {
        delete (globalThis as any).__TAURI__;
      }
    });

    it("不带 preview 的浏览器路径不显示启动页（行为不变）", async () => {
      const gate = createSplashGate();
      const doInit = vi.fn().mockResolvedValue(undefined);
      await gate.start(doInit);
      expect(gate.phase).toBe("ready");
      expect(doInit).toHaveBeenCalledTimes(1);
    });

    it("preview 演完整编排：boot → index → doInit 延后 → 数据落地才 ready", async () => {
      const gate = createSplashGate({ preview: true, minPresentationMs: 900, previewRevealMs: 2000 });
      const doInit = vi.fn().mockResolvedValue(undefined);
      expect(gate.phase).toBe("boot");
      await gate.start(doInit);
      expect(gate.phase).toBe("boot");
      // previewBackendMs = min(900, 2000*0.3) = 600：模拟真机 READY 在编排中途到达
      vi.advanceTimersByTime(600);
      expect(gate.phase).toBe("index");
      expect(doInit).not.toHaveBeenCalled();
      // 到 reveal 点才真去拿数据，动画才有机会演完
      vi.advanceTimersByTime(1400);
      expect(doInit).toHaveBeenCalledTimes(1);
      expect(gate.ready).toBe(false);
      gate.markIndexReady();
      expect(gate.ready).toBe(true);
      gate.dispose();
    });
  });

  describe("默认计时（本轮把「慢」本身当 bug）", () => {
    it("最短呈现 480ms、数据上限 4000ms：都不许再回到 900 / 6000", () => {
      // 遮罩上的每一毫秒都是人造延迟：真机 700ms 就绪，就不该被动画按着看满一秒。
      expect(SPLASH_MIN_PRESENTATION_MS).toBe(480);
      expect(SPLASH_INDEX_TIMEOUT_MS).toBe(4000);
      expect(SPLASH_MIN_PRESENTATION_MS).toBeLessThanOrEqual(600);
      expect(SPLASH_INDEX_TIMEOUT_MS).toBeLessThanOrEqual(4500);
    });

    it("preview 默认 1500ms 放行：dev 回放演的就是真机的节奏", async () => {
      vi.useFakeTimers();
      delete (globalThis as any).__TAURI__; // preview 只在非 Tauri 路径上回放
      const gate = createSplashGate({ preview: true });
      const doInit = vi.fn().mockResolvedValue(undefined);
      await gate.start(doInit);
      // previewBackendMs = min(480, 1500*0.3) = 450：READY 先到，文案切「正在整理图库」
      vi.advanceTimersByTime(450);
      expect(gate.phase).toBe("index");
      expect(doInit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1050);
      expect(doInit).toHaveBeenCalledTimes(1);
      gate.markIndexReady();
      // 480ms 下限早过了，这一刻就该收场，不再多压一秒
      expect(gate.ready).toBe(true);
      gate.dispose();
      vi.useRealTimers();
    });
  });
});
