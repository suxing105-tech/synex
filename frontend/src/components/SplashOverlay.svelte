<script lang="ts">
  // 启动引导页（展示层）：阶段与异常由 App 的 splash gate 决定，这里只管演什么。
  //
  // 三段编排：
  //   boot  —— 字标被一道斜向光扫点亮，地标那枚「缩略图滑块」自己装配起来，文案「正在唤醒本地引擎」
  //   index —— 文案切到「正在整理图库」；此时主界面已经铺好骨架（见 appBooting）
  //   ready —— 不再硬切：留 340ms 淡出 + 轻微回缩，骨架→真卡的替换发生在淡出之下
  //
  // 为什么字标能玩光影：/logo.png 是纯 #f24e4e + 透明通道的字标（531×531，背景
  // alpha=0），直接当 CSS mask 用，光带只会在字形里走，不需要另画一份矢量。
  //
  // 动画只用 transform / opacity / clip-path，全屏合成层控制在两个以内；不碰 filter: blur()，
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
      <span class="splash-rule" aria-hidden="true">
        <i class="rule-track"></i>
        <i class="rule-fill"></i>
        <i class="rule-thumb"></i>
      </span>
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
    /* 这一层不能有淡入：index.html 的预挂载壳用的是同一份底色，mount() 之后同帧交接。
       整层从 opacity:0 起播的那 260ms 里，底色本身也是半透明的，等于把底下的真实界面
       透出来闪一下——底色对齐救不了它，因为糊在一起的是整层。 */
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

  /* 地标：把主界面右上角那枚「缩略图滑块」原样搬来当品牌符号——同 4px 细轨、同 14px
     圆头、同 2px #18181b 内环、同静止色 #323237，不另拍一套几何（拍两套就一定对不上，
     那是「精致」最先输掉的地方）。
     滑块头停在 18% 不动：这条规矩是「不报假百分比」，所以启动期间没有任何滑动；
     它只在首屏数据真落地的那一刻滑到右端收场，那是真事件，不是假进度。 */
  .splash-rule {
    position: relative; /* 三层都是 absolute，父级不定位在 stage 上就会各飘各的 */
    display: block;
    width: 168px;
    height: 14px; /* 按控制件的满高占位，14px 圆头不会被后面的文案顶到 */
    margin-top: 34px;
  }
  .rule-track,
  .rule-fill {
    position: absolute;
    left: 0;
    top: 5px; /* (14 - 4) / 2：细轨在 14px 的控制框里垂直居中 */
    width: 100%;
    height: 4px;
    border-radius: 2px;
  }
  .rule-track {
    background: #323237;
    animation: splash-rule-in 240ms ease-out 80ms both;
  }
  .rule-fill {
    background: #f24e4e;
    /* 展开用 clip-path 不用 scaleX：scaleX 会把 2px 圆角横向拉成钝头，看着像融化的糖 */
    clip-path: inset(0 100% 0 0);
    animation: splash-rule-fill 320ms cubic-bezier(.22, .61, .36, 1) 200ms both;
  }
  .rule-thumb {
    position: absolute;
    left: 23px; /* 停在 18%：中心 30px，减去 7px 半径 */
    top: 0;
    width: 14px;
    height: 14px;
    box-sizing: border-box;
    border: 2px solid #18181b;
    border-radius: 50%;
    background: #f24e4e;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .5), 0 0 0 1px rgba(242, 78, 78, .4);
    transform: scale(0);
    animation: splash-thumb-in 260ms cubic-bezier(.34, 1.4, .64, 1) 400ms both;
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
  .has-error .rule-track,
  .has-error .rule-fill,
  .has-error .rule-thumb { animation: none; }
  .has-error .splash-mark { background: #5a5a5f; }
  /* 动画停了得把终态补回来：三层都是「动画负责从隐藏走到可见」，
     只下 animation:none 会退回 clip-path:100% 与 scale(0)，地标整条消失。
     红也一并收掉——错误态什么都没在往前推。 */
  .has-error .rule-fill {
    background: #5a5a5f;
    clip-path: inset(0 calc(100% - 30px) 0 0);
  }
  .has-error .rule-thumb {
    background: #5a5a5f;
    transform: scale(1);
    box-shadow: 0 1px 3px rgba(0, 0, 0, .5);
  }

  @keyframes splash-fade-out { from { opacity: 1; transform: scale(1.014); } to { opacity: 0; transform: scale(1); } }
  @keyframes splash-mark-in { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: scale(1); } }
  @keyframes splash-sweep { from { transform: translateX(-180%); } to { transform: translateX(340%); } }
  @keyframes splash-rule-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes splash-rule-fill { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 calc(100% - 30px) 0 0); } }
  @keyframes splash-thumb-in { from { opacity: 0; transform: scale(.5); } to { opacity: 1; transform: scale(1); } }
  @keyframes splash-caption-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes splash-glow { from { opacity: .7; transform: scale(1); } to { opacity: 1; transform: scale(1.05); } }

  /* 就绪那一闪：字标里再走一道光，表示数据到了，紧接着整层淡出。
     必须连 transform 一起动——光带在 mask 子树里，停在 box 外就是隐形动画（第一版就踩了）。 */
  .is-leaving .splash-mark::after {
    animation: splash-ready-flash 280ms cubic-bezier(.22, .61, .36, 1) both;
  }
  @keyframes splash-ready-flash {
    0% { opacity: .95; transform: translateX(-180%); }
    100% { opacity: 0; transform: translateX(340%); }
  }
  /* 启动期不动，就绪这一拍才走：滑块头从中途滑到最右、红轨铺满，读作「收齐了」。
     时长跟 splash-fade-out 同为 340ms 里的一段，收场只有一个动作，不产生第二种节奏。 */
  .is-leaving .rule-thumb {
    animation: splash-thumb-run 300ms cubic-bezier(.4, 0, .2, 1) both;
  }
  .is-leaving .rule-fill {
    animation: splash-rule-done 300ms cubic-bezier(.4, 0, .2, 1) both;
  }
  @keyframes splash-thumb-run {
    from { transform: translateX(0) scale(1); }
    to { transform: translateX(131px) scale(1); }
  }
  @keyframes splash-rule-done {
    from { clip-path: inset(0 calc(100% - 30px) 0 0); }
    to { clip-path: inset(0 0 0 0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .splash-glow,
    .splash-mark,
    .splash-mark::after,
    .splash-rule,
    .splash-caption,
    .is-leaving { animation: none; }
    .splash-mark { opacity: 1; transform: none; }
    .splash-mark::after { display: none; }
    .rule-track,
    .rule-fill,
    .rule-thumb { animation: none; }
    .rule-track { opacity: 1; }
    .rule-fill { clip-path: inset(0 calc(100% - 30px) 0 0); }
    .rule-thumb { opacity: 1; transform: scale(1); }
    .splash-caption { opacity: 1; transform: none; }
    .is-leaving { transition: opacity 120ms linear; opacity: 0; }
  }
</style>
