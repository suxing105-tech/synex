<script lang="ts">
  // 启动引导页（展示层）：阶段与异常由 App 的 splash gate 决定，这里只管演什么。
  //
  // 三段编排：
  //   boot  —— 字标被一道斜向光扫点亮，地标线由中心展开，文案「正在唤醒本地引擎」
  //   index —— 文案切到「正在整理图库」；此时主界面已经铺好骨架（见 appBooting）
  //   ready —— 不再硬切：留 340ms 淡出 + 轻微回缩，骨架→真卡的替换发生在淡出之下
  //
  // 为什么字标能玩光影：/logo.png 是纯 #f24e4e + 透明通道的字标（531×531，背景
  // alpha=0），直接当 CSS mask 用，光带只会在字形里走，不需要另画一份矢量。
  //
  // 动画只用 transform / opacity，全屏合成层控制在两个以内；不碰 filter: blur()，
  // 4K 窗口上整屏模糊是白送的掉帧。
  import type { SplashPhase } from "../lib/splash-gate.svelte";

  interface Props {
    phase: SplashPhase;
    error: string | null;
  }
  let { phase, error }: Props = $props();

  /** 收场淡出时长；减少动画偏好下压到 120ms。 */
  const LEAVE_MS = 340;

  function reducedMotion(): boolean {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // phase 一变 ready 就整个卸载的话，等于还是硬切；所以先演淡出再卸载。
  let leaving = $state(false);
  // svelte-ignore state_referenced_locally —— 这里要的就是「创建那一刻」的值：
  // 浏览器 fast path 下组件一诞生就是 ready，必须一帧都不渲染。
  let gone = $state(phase === "ready");
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (phase !== "ready") return;
    leaving = true;
    leaveTimer = setTimeout(() => { gone = true; }, reducedMotion() ? 120 : LEAVE_MS);
    return () => clearTimeout(leaveTimer);
  });

  // ready 段沿用「正在整理图库」：那 340ms 里它确实就是在整理图库。
  const caption = $derived(phase === "boot" ? "正在唤醒本地引擎" : "正在整理图库");

  function retry() {
    location.reload();
  }
</script>

{#if !gone}
  <div
    class="splash-overlay"
    class:has-error={!!error}
    class:is-leaving={leaving}
    role="status"
    aria-live="polite"
    aria-busy={phase !== "ready" && !error}
  >
    <div class="splash-glow" aria-hidden="true"></div>
    <div class="splash-noise" aria-hidden="true"></div>
    <div class="splash-stage">
      <div class="splash-mark" role="img" aria-label="闪寻空间"></div>
      <span class="splash-rule" aria-hidden="true"></span>
      {#if error}
        <div class="splash-err" role="alert">启动未完成：{error}</div>
        <p class="splash-hint">请关闭应用后重新打开。如果仍无法启动，请联系支持并提供此错误信息。</p>
        <button type="button" class="splash-retry" onclick={retry}>重试</button>
      {:else}
        <p class="splash-caption">{caption}</p>
        <span class="sr-only">正在启动，请稍候</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .splash-overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: grid;
    place-items: center;
    overflow: hidden;
    /* 外圈必须等于 tauri.conf 的窗口 backgroundColor 与 app 底色 #0e0e10，
       否则首帧预挂载壳交给这里的那一刻会闪一下颜色。 */
    background: radial-gradient(ellipse at 50% 44%, #1b1416 0%, #121012 42%, #0e0e10 78%);
    color: #fafafa;
    animation: splash-fade-in 260ms ease-out both;
  }
  .is-leaving {
    pointer-events: none;
    animation: splash-fade-out 340ms cubic-bezier(.4, 0, .2, 1) both;
  }

  /* 氛围层：一层静态细噪点 + 一层慢速红色辉光。都不做位移动画。 */
  .splash-noise {
    position: absolute;
    inset: 0;
    opacity: .04;
    pointer-events: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  .splash-glow {
    position: absolute;
    left: 50%;
    top: 44%;
    width: 620px;
    height: 620px;
    margin: -310px 0 0 -310px;
    border-radius: 50%;
    pointer-events: none;
    background: radial-gradient(circle, #f24e4e26 0%, #f24e4e0d 45%, transparent 70%);
    animation: splash-glow 8s ease-in-out infinite alternate;
  }

  .splash-stage {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: min(480px, calc(100% - 48px));
    text-align: center;
  }

  /* 字标：mask 把整棵子树裁成字形，光带只在 SX 里走 */
  .splash-mark {
    position: relative;
    width: 96px;
    height: 96px;
    background: #f24e4e;
    -webkit-mask: url(/logo.png) center / contain no-repeat;
    mask: url(/logo.png) center / contain no-repeat;
    animation: splash-mark-in 420ms cubic-bezier(.22, .61, .36, 1) both;
  }
  .splash-mark::after {
    content: "";
    position: absolute;
    top: -25%;
    bottom: -25%;
    left: 0;
    width: 55%;
    background: linear-gradient(100deg, transparent, rgba(255, 255, 255, .8), transparent);
    transform: translateX(-180%);
    animation: splash-sweep 620ms cubic-bezier(.22, .61, .36, 1) 120ms both;
  }

  /* 地标线：不报假百分比，只表示「有事在往前推」；左端 18% 是唯一的红 */
  .splash-rule {
    display: block;
    width: 132px;
    height: 1px;
    margin-top: 38px;
    background: #ffffff14;
    transform: scaleX(0);
    transform-origin: 50% 50%;
    animation: splash-rule-grow 800ms cubic-bezier(.22, .61, .36, 1) 320ms both;
  }
  .splash-rule::after {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    width: 18%;
    height: 1px;
    background: #f24e4e;
    box-shadow: 0 0 6px #f24e4e59;
  }

  .splash-caption {
    margin-top: 26px;
    font-size: 11px;
    letter-spacing: .12em;
    color: #8a8e93;
    animation: splash-caption-in 320ms ease-out 520ms both;
  }

  .splash-err {
    margin-top: 40px;
    font-size: 14px;
    line-height: 1.7;
    color: #fb7185;
    overflow-wrap: anywhere;
  }
  .splash-hint { margin-top: 10px; font-size: 12px; line-height: 1.8; color: #a1a1aa; max-width: 380px; }
  .splash-retry {
    margin-top: 18px;
    padding: 6px 18px;
    border: 1px solid #3a3a41;
    border-radius: 6px;
    background: #1c1c20;
    color: #dcdce0;
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
    transition: background-color 140ms ease, border-color 140ms ease;
  }
  .splash-retry:hover { background: #26262b; border-color: #4a4a52; }

  /* 出错就什么都别动了：动画还在跑，用户读到的却是「起不来」，两者互相拆台 */
  .has-error,
  .has-error .splash-glow,
  .has-error .splash-mark,
  .has-error .splash-mark::after,
  .has-error .splash-rule { animation: none; }
  .has-error .splash-mark { background: #5a5a5f; }
  .has-error .splash-rule { transform: scaleX(1); }

  @keyframes splash-fade-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes splash-fade-out { from { opacity: 1; transform: scale(1.014); } to { opacity: 0; transform: scale(1); } }
  @keyframes splash-mark-in { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: scale(1); } }
  @keyframes splash-sweep { from { transform: translateX(-180%); } to { transform: translateX(340%); } }
  @keyframes splash-rule-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  @keyframes splash-caption-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes splash-glow { from { opacity: .7; transform: scale(1); } to { opacity: 1; transform: scale(1.05); } }

  /* 就绪那一闪只演一次：::after 复用成白色脉冲，扫过即收 */
  .is-leaving .splash-mark::after {
    transform: translateX(340%);
    animation: splash-ready-flash 240ms ease-out both;
  }
  @keyframes splash-ready-flash { 0% { opacity: 0; } 45% { opacity: .85; } 100% { opacity: 0; } }

  @media (prefers-reduced-motion: reduce) {
    .splash-overlay,
    .splash-glow,
    .splash-mark,
    .splash-mark::after,
    .splash-rule,
    .splash-caption,
    .is-leaving { animation: none; }
    .splash-mark { opacity: 1; transform: none; }
    .splash-mark::after { display: none; }
    .splash-rule { transform: scaleX(1); }
    .splash-caption { opacity: 1; transform: none; }
    .is-leaving { transition: opacity 120ms linear; opacity: 0; }
  }
</style>
