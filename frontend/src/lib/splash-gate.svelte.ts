// Tauri sidecar 生命周期 composable（M0-f 第三轮：sidecar 状态抽出）
//
// 把 App.svelte 里 backendReady / backendError / initStarted / sidecar*Unsub
// / backendBootTimeout + doInit / markBackendReady / markBackendFailed + onMount
// 分支 + onDestroy cleanup 这一整套都收归到 createSplashGate()。
//
// 用法：
//   const gate = createSplashGate();
//   await gate.start(doInit);    // 浏览器路径：立刻调 doInit；Tauri 路径：订阅事件
//   gate.dispose();              // onDestroy 调
//
//   <SplashOverlay ready={gate.ready} error={gate.error} />
//
// 设计要点：
// - .svelte.ts 文件让 $state rune 在 composable 里工作（App.svelte 模板用
//   gate.ready / gate.error 时自动响应变化）。
// - 不传 deps：gate 直接读 ./tauri 的 isTauri / onSidecarReady / onSidecarDied，
//   不暴露注入点（保持 API 简单）。如果未来要测试 Tauri 行为，再加 deps。
// - timeoutMs 默认 30000ms（30s）；测试时可以传小值加速。
// - browser 路径与 Tauri 路径不对称：browser 调 start 时立刻 doInit，
//   Tauri 等 sidecar-ready 才动。start() 返回 boolean 告诉调用方是哪种模式，
//   让 App.svelte 在 browser 模式下继续 setup comfyui polling + window listeners。

import { isTauri, onSidecarReady, onSidecarDied, getSidecarStatus } from "./tauri";

export interface SplashGateOptions {
  /** 启动后端就绪超时时间（ms）。默认 30000。 */
  timeoutMs?: number;
}

export interface SplashGate {
  /** 当前是否就绪。true 时 SplashOverlay 不渲染。 */
  readonly ready: boolean;
  /** 错误原因。null 表示无错误。 */
  readonly error: string | null;
  /**
   * 启动门。浏览器模式下立刻调 doInit 并返回 true；
   * Tauri 模式下订阅 sidecar-ready / sidecar-died + setTimeout 后返回 false
   * （doInit 在 sidecar-ready 事件触发时才调）。
   */
  start(doInit: () => Promise<void>): Promise<boolean>;
  /** 释放 sidecar 订阅 + 超时定时器。onDestroy 调用。 */
  dispose(): void;
}

export function createSplashGate(opts: SplashGateOptions = {}): SplashGate {
  const timeoutMs = opts.timeoutMs ?? 30000;

  // 浏览器（!isTauri()）默认 ready=true，splash 不显示；Tauri 默认 false。
  let ready = $state(!isTauri());
  let error = $state<string | null>(null);
  let readyUnsub: (() => void) | null = null;
  let diedUnsub: (() => void) | null = null;
  let bootTimeout: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let initialized = false;
  let eventVersion = 0;

  function clearBootTimeout() {
    if (bootTimeout) {
      clearTimeout(bootTimeout);
      bootTimeout = null;
    }
  }

  function markReady(doInit: () => Promise<void>) {
    if (disposed) return;
    ready = true;
    error = null;
    clearBootTimeout();
    if (!initialized) {
      initialized = true;
      void doInit();
    }
  }

  function markFailed(reason: string) {
    if (disposed) return;
    ready = false;
    error = reason;
    clearBootTimeout();
  }

  async function start(doInit: () => Promise<void>): Promise<boolean> {
    if (!isTauri()) {
      // 浏览器 dev / 静态托管：直接 init（vite proxy / FastAPI 已在 8765）
      await doInit();
      return true;
    }
    // Tauri 路径：等 Rust 端 sidecar-ready，否则一直显示 splash。
    // 30s 超时切错误卡（一般 1~2s 就能 ready；30s 留给冷启动 / 防卡死）。
    readyUnsub = await onSidecarReady(() => { eventVersion++; markReady(doInit); });
    diedUnsub = await onSidecarDied((p) => {
      eventVersion++;
      markFailed(p?.reason || "sidecar died");
    });
    bootTimeout = setTimeout(() => {
      if (!ready) markFailed(error || `后端进程启动超时（${Math.round(timeoutMs / 1000)}s）`);
    }, timeoutMs);
    // 先订阅再读取快照：READY 可能早于 WebView 挂载；新事件优先于旧快照。
    const version = eventVersion;
    try {
      const status = await getSidecarStatus();
      if (!disposed && version === eventVersion) {
        if (status?.ready) markReady(doInit);
        else if (status?.last_error) markFailed(status.last_error);
      }
    } catch (e) {
      markFailed(`无法读取后端状态：${String(e)}`);
    }
    return false;
  }

  function dispose() {
    disposed = true;
    if (readyUnsub) {
      readyUnsub();
      readyUnsub = null;
    }
    if (diedUnsub) {
      diedUnsub();
      diedUnsub = null;
    }
    clearBootTimeout();
  }

  return {
    get ready() {
      return ready;
    },
    get error() {
      return error;
    },
    start,
    dispose,
  };
}
