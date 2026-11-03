// Tauri sidecar 生命周期 + 启动页收场时序（M0-f 第三轮抽出；「画廊成形」轮加收场条件）
//
// 把 App.svelte 里 backendReady / backendError / initStarted / sidecar*Unsub
// / backendBootTimeout + doInit / markBackendReady / markBackendFailed + onMount
// 分支 + onDestroy cleanup 这一整套都收归到 createSplashGate()。
//
// 用法：
//   const gate = createSplashGate();
//   await gate.start(doInit);    // 浏览器路径：立刻调 doInit；Tauri 路径：订阅事件
//   gate.markIndexReady();       // doInit 的 finally 里调：首屏数据已落地
//   gate.dispose();              // onDestroy 调
//
//   <SplashOverlay phase={gate.phase} error={gate.error} />
//
// 设计要点：
// - 收场是双条件：sidecar 就绪 **且** 首屏数据落地，再加一条最短呈现下限。
//   只等 READY 会在 folders/feed 还没回来时就把遮罩撤掉，用户看到的是「空壳侧栏 +
//   空网格 → 内容突然弹出」，这是启动观感里最伤的一条。
// - 最短呈现 minPresentationMs（默认 900）：真机 1~2s 就 READY，编排会被切成一闪
//   而过，动画读不出意图。计时起点是 start()（遮罩真正出现），不是后端就绪。
// - 数据上限 indexTimeoutMs（默认 6000）：首屏数据卡住时宁可放行看到空壳，也不能
//   把用户锁在门外。放行只是「不再等」，不是报错。
// - 计时只允许待在这个文件里。App.svelte 里一旦出现 900 / 6000 这类字面量，就说
//   明时序又漏回业务层了（app-splash.test.ts 钉住这条）。
// - browser 路径默认 fast：启动页根本不出现，三个条件初值全 true，与本轮之前的行为
//   一致。dev 想看动画用 ?splash=preview —— preview 走同一条代码路径，只是把
//   READY 与首屏数据换成两个定时器模拟，所以回放出来的节奏就是真机的节奏。
// - .svelte.ts 文件让 $state / $derived rune 在 composable 里工作（App.svelte 模板
//   读 gate.phase 时自动响应变化）。
// - timeoutMs 默认 30000ms（30s）；测试时可以传小值加速。

import { isTauri, onSidecarReady, onSidecarDied, getSidecarStatus } from "./tauri";

/** 启动页当前该演哪一段。 */
export type SplashPhase = "boot" | "index" | "ready" | "error";

/**
 * 遮罩最短呈现时长（ms）。这个数字本身就是要付出去的等待。
 *
 * 上一版 900：真机 700ms 就全部就绪，却硬要看满 900ms 编排再 340ms 淡出——
 * 用户感觉到的「卡」几乎全在这段人造延迟里。现在编排 340ms 内装配完成，
 * 扫描头又一直在动（多短都读得出「在干活」），所以只留 480ms：
 * 够字标和地标立住，不至于为动画放慢入场。
 */
export const SPLASH_MIN_PRESENTATION_MS = 480;
/**
 * 等首屏数据的上限（ms）：超时放行，不报错、不死等。
 * 6000 → 4000：数据真慢的时候，回到界面看骨架加载，比被压在遮罩后面数秒好受。
 */
export const SPLASH_INDEX_TIMEOUT_MS = 4000;

export interface SplashGateOptions {
  /** 启动后端就绪超时时间（ms）。默认 30000。 */
  timeoutMs?: number;
  /** 等首屏数据的上限（ms）。默认 4000。 */
  indexTimeoutMs?: number;
  /** 遮罩最短呈现时长（ms）。默认 480。 */
  minPresentationMs?: number;
  /** dev 回放：强制演完整编排（浏览器模式下也显示启动页）。默认 false。 */
  preview?: boolean;
  /** preview 下模拟「READY 到达」的时刻（ms）。默认 min(最短呈现, 回放时长 30%)。 */
  previewBackendMs?: number;
  /** preview 下模拟「首屏数据落地」的时刻（ms）。默认 2000。 */
  previewRevealMs?: number;
}

export interface SplashGate {
  /** 当前是否就绪。true 时 SplashOverlay 不渲染。 */
  readonly ready: boolean;
  /** 错误原因。null 表示无错误。 */
  readonly error: string | null;
  /** 启动页应该演的段落，驱动 SplashOverlay 的文案与阶段。 */
  readonly phase: SplashPhase;
  /**
   * 启动门。浏览器非 preview 模式下立刻调 doInit 并返回 true；
   * Tauri 模式与 preview 模式订阅/计时后返回 false。
   */
  start(doInit: () => Promise<void>): Promise<boolean>;
  /** 首屏数据落地（由 doInit 的 finally 调用）。重复调用幂等。 */
  markIndexReady(): void;
  /** 释放 sidecar 订阅 + 全部计时器。onDestroy 调用。 */
  dispose(): void;
}

export function createSplashGate(opts: SplashGateOptions = {}): SplashGate {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const indexTimeoutMs = opts.indexTimeoutMs ?? SPLASH_INDEX_TIMEOUT_MS;
  const minPresentationMs = opts.minPresentationMs ?? SPLASH_MIN_PRESENTATION_MS;
  const preview = opts.preview === true;
  const previewRevealMs = opts.previewRevealMs ?? 1500;
  const previewBackendMs = opts.previewBackendMs ?? Math.min(minPresentationMs, Math.round(previewRevealMs * 0.3));

  // 浏览器且没开 preview：启动页根本不出现，三个条件直接给 true 走快速通道。
  const fast = !isTauri() && !preview;

  let backendReady = $state(fast);
  let indexReady = $state(fast);
  let floorReady = $state(fast);
  let indexForced = $state(false);
  let error = $state<string | null>(null);

  // indexForced：等首屏数据超过上限时的放行开关——放行只是「不再等」，不是报错。
  const indexSatisfied = $derived(indexReady || indexForced);
  const ready = $derived(!error && backendReady && indexSatisfied && floorReady);
  const phase = $derived<SplashPhase>(
    error ? "error" : ready ? "ready" : backendReady ? "index" : "boot",
  );

  let readyUnsub: (() => void) | null = null;
  let diedUnsub: (() => void) | null = null;
  let bootTimeout: ReturnType<typeof setTimeout> | null = null;
  let floorTimeout: ReturnType<typeof setTimeout> | null = null;
  let indexTimeout: ReturnType<typeof setTimeout> | null = null;
  let previewBackendTimeout: ReturnType<typeof setTimeout> | null = null;
  let previewInitTimeout: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let initialized = false;
  let eventVersion = 0;

  function drop(handle: "boot" | "floor" | "index" | "previewBackend" | "previewInit") {
    if (handle === "boot" && bootTimeout) { clearTimeout(bootTimeout); bootTimeout = null; }
    if (handle === "floor" && floorTimeout) { clearTimeout(floorTimeout); floorTimeout = null; }
    if (handle === "index" && indexTimeout) { clearTimeout(indexTimeout); indexTimeout = null; }
    if (handle === "previewBackend" && previewBackendTimeout) { clearTimeout(previewBackendTimeout); previewBackendTimeout = null; }
    if (handle === "previewInit" && previewInitTimeout) { clearTimeout(previewInitTimeout); previewInitTimeout = null; }
  }

  /** 最短呈现计时：从遮罩真正出现的那一刻算，不是从后端就绪算。 */
  function startFloor() {
    if (floorReady || floorTimeout) return;
    floorTimeout = setTimeout(() => {
      floorTimeout = null;
      floorReady = true;
    }, minPresentationMs);
  }

  /** 首屏数据的兜底：到点还没落地就放行，宁可看到空壳也不锁人。 */
  function armIndexWatch() {
    if (indexReady || indexForced || indexTimeout) return;
    indexTimeout = setTimeout(() => {
      indexTimeout = null;
      indexForced = true;
    }, indexTimeoutMs);
  }

  /** 只记「后端起来了」，不负责 init —— preview 演阶段切换时要单独用它。 */
  function noteBackendReady() {
    backendReady = true;
    error = null;
    drop("boot");
    armIndexWatch();
  }

  function runInitOnce(doInit: () => Promise<void>) {
    if (initialized) return;
    initialized = true;
    void doInit();
  }

  function markBackendReady(doInit: () => Promise<void>) {
    if (disposed) return;
    noteBackendReady();
    runInitOnce(doInit);
  }

  function markFailed(reason: string) {
    if (disposed) return;
    error = reason;
    drop("boot");
    drop("index");
    drop("previewBackend");
    drop("previewInit");
  }

  async function start(doInit: () => Promise<void>): Promise<boolean> {
    if (fast) {
      // 浏览器 dev / 静态托管：直接 init（vite proxy / FastAPI 已在 8765）
      await doInit();
      return true;
    }
    startFloor();
    if (!isTauri()) {
      // dev 回放：把真机的两个时间点换成定时器，其余（阶段、收场条件、兜底）全走同一条路。
      previewBackendTimeout = setTimeout(() => {
        previewBackendTimeout = null;
        if (!disposed) noteBackendReady();
      }, previewBackendMs);
      previewInitTimeout = setTimeout(() => {
        previewInitTimeout = null;
        if (!disposed) runInitOnce(doInit);
      }, previewRevealMs);
      return false;
    }
    // Tauri 路径：等 Rust 端 sidecar-ready，否则一直显示 splash。
    // 30s 超时切错误卡（一般 1~2s 就能 ready；30s 留给冷启动 / 防卡死）。
    readyUnsub = await onSidecarReady(() => { eventVersion++; markBackendReady(doInit); });
    diedUnsub = await onSidecarDied((p) => {
      eventVersion++;
      markFailed(p?.reason || "sidecar died");
    });
    bootTimeout = setTimeout(() => {
      if (!backendReady) markFailed(error || `后端进程启动超时（${Math.round(timeoutMs / 1000)}s）`);
    }, timeoutMs);
    // 先订阅再读取快照：READY 可能早于 WebView 挂载；新事件优先于旧快照。
    const version = eventVersion;
    try {
      const status = await getSidecarStatus();
      if (!disposed && version === eventVersion) {
        if (status?.ready) markBackendReady(doInit);
        else if (status?.last_error) markFailed(status.last_error);
      }
    } catch (e) {
      markFailed(`无法读取后端状态：${String(e)}`);
    }
    return false;
  }

  function markIndexReady() {
    if (disposed) return;
    drop("index");
    indexReady = true;
    indexForced = false;
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
    drop("boot");
    drop("floor");
    drop("index");
    drop("previewBackend");
    drop("previewInit");
  }

  return {
    get ready() {
      return ready;
    },
    get error() {
      return error;
    },
    get phase() {
      return phase;
    },
    start,
    markIndexReady,
    dispose,
  };
}
