<script lang="ts">
  // 启动引导页（展示层）：阶段与异常由 App 的 splash gate 决定，这里只管演什么。
  //
  // 这一轮改的是「慢」本身。上一版把滑块头停在 18% 一动不动，理由是「不报假进度」，
  // 结果是一条卡住的进度条：滑块停在 18% 读出来就是「进度 18%，然后不动了」，
  // 用户拿到的信息恰好是「这 App 卡住了」。不报进度的正确做法不是停下来，
  // 是让扫描头一直在轨上来回扫——来回的东西读不出百分比，但一定读得出「还在干活」。
  //
  // 三段编排（呈现下限 480ms + 收场 220ms，快机器上遮罩最多压 700ms）：
  //   boot  —— 字标被斜向光扫点亮（240ms），地标滑块装起来，扫描头开始来回扫
  //   index —— 文案「正在整理图库」，扫描头继续扫；主界面此时已铺好骨架（见 appBooting）
  //   ready —— 字标里补一道光，整层 220ms 淡出；骨架→真卡在同一条曲线下替换
  //
  // 为什么字标能玩光影：/logo.png 是纯 #f24e4e + 透明通道的字标（531×531，背景
  // alpha=0），直接当 CSS mask 用，光带只会在字形里走，不需要另画一份矢量。
  //
  // 动画只用 transform / opacity，全屏合成层控制在两个以内；不碰 filter: blur()，
  // 4K 窗口上整屏模糊是白送的掉帧。扫描头的光带由轨道框 overflow:hidden 裁住，
  // 所以它全程只需要 translateX，不用逐帧重画 clip-path——启动页掉帧比什么都贵。
  import type { SplashPhase } from "../lib/splash-gate.svelte";

  interface Props {
    phase: SplashPhase;
    error: string | null;
  }
  let { phase, error }: Props = $props();

  /**
   * 收场淡出时长（ms）。减少动画偏好下压到 120ms。
   * 必须与 .is-leaving 的 splash-fade-out 时长、以及 Feed 的 card-materialize
   * 时长三处同值，否则「遮罩淡出」与「骨架变真卡」错拍，中间会暗一帧。
   */
  const LEAVE_MS = 220;

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

  // ready 段沿用「正在整理图库」：那 220ms 里它确实就是在整理图库。
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
        <i class="rule-scan"><i class="rule-glow"></i></i>
        <i class="rule-runner"><i class="rule-thumb"></i></i>
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

<style>  .splash-overlay {
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
  /* 收场只有一个动作：220ms 淡出 + 一丝回缩。不再补「滑块头滑到最右」那一段——
     收场期间任何和淡出抢戏的位移，都会被读成「还没完」。 */
  .is-leaving {
    pointer-events: none;
    animation: splash-fade-out 220ms cubic-bezier(.4, 0, .2, 1) both;
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

  /* 字标：mask 把整棵子树裁成字形，光带只在 SX 里走。
     入场从 420/620ms 压到 240/420ms：编排本身也是等待的一部分，慢的入场和慢的后端
     在用户眼里是同一件事。 */
  .splash-mark {
    position: relative;
    width: 96px;
    height: 96px;
    background: #f24e4e;
    -webkit-mask: url(/logo.png) center / contain no-repeat;
    mask: url(/logo.png) center / contain no-repeat;
    animation: splash-mark-in 240ms cubic-bezier(.22, .61, .36, 1) both;
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
    animation: splash-sweep 420ms cubic-bezier(.22, .61, .36, 1) 80ms both;
  }
  /* 地标：主界面右上角那枚「缩略图滑块」原样搬来当品牌符号——同 4px 细轨、同 14px
     圆头、同 2px #18181b 内环、同静止色 #323237，不另拍一套几何（拍两套就一定对不上，
     那是「精致」最先输掉的地方）。
     和主页那枚只差一件事：这里它一直在动。主页它是「拖到第几张」，启动页它是
     「引擎正在扫库」——形状语言同一套，读出来的意思也顺。 */
  .splash-rule {
    position: relative; /* 三层都是 absolute，父级不定位在 stage 上就会各飘各的 */
    display: block;
    width: 168px;
    height: 14px; /* 按控制件的满高占位，14px 圆头不会被后面的文案顶到 */
    margin-top: 34px;
    animation: splash-rule-in 180ms ease-out 40ms both;
  }
  .rule-track {
    position: absolute;
    left: 0;
    top: 5px; /* (14 - 4) / 2：细轨在 14px 的控制框里垂直居中 */
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: #323237;
  }
  /* 扫描头的光：只有 4px 高，被轨道框裁住，所以永远只在轨上走。
     overflow:hidden 负责切两端，动画就只剩 translateX，一帧主线程重绘都不欠。 */
  .rule-scan {
    position: absolute;
    left: 0;
    top: 5px;
    width: 100%;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
  }
  .rule-glow {
    position: absolute;
    left: -21px; /* 让光带中心落在 7px，与圆头同心；两端各留 28px 渐变 */
    top: 0;
    width: 56px;
    height: 100%;
    /* 两端对称淡出：来回扫不需要区分头尾 */
    background: linear-gradient(90deg, transparent, #f24e4e 50%, transparent);
    animation: splash-scan 620ms cubic-bezier(.42, 0, .58, 1) 240ms infinite alternate both;
  }
  /* 扫描头本体：外层只管沿轨平移，圆头自己管入场缩放，两段动画各占一个 transform，不打架 */
  .rule-runner {
    position: absolute;
    left: 0;
    top: 0;
    width: 14px;
    height: 14px;
    animation: splash-scan 620ms cubic-bezier(.42, 0, .58, 1) 240ms infinite alternate both;
  }
  .rule-thumb {
    display: block;
    width: 14px;
    height: 14px;
    box-sizing: border-box;
    border: 2px solid #18181b;
    border-radius: 50%;
    background: #f24e4e;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .5), 0 0 0 1px rgba(242, 78, 78, .4);
    animation: splash-thumb-in 220ms cubic-bezier(.34, 1.4, .64, 1) 60ms both;
  }

  .splash-caption {
    margin-top: 26px;
    font-size: 11px;
    letter-spacing: .12em;
    color: #8a8e93;
    animation: splash-caption-in 180ms ease-out 140ms both;
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
  .has-error .splash-rule,
  .has-error .rule-runner,
  .has-error .rule-glow,
  .has-error .rule-thumb { animation: none; }
  .has-error .splash-mark { background: #5a5a5f; }
  /* 动画停了得把终态补回来：扫描头与圆头都是「动画负责从隐藏走到可见」，
     只下 animation:none 会退回 scale(0)，地标整条消失。
     红也一并收掉——错误态什么都没在往前推，光带直接藏了。 */
  .has-error .rule-glow { opacity: 0; }
  .has-error .rule-runner { transform: translateX(0); }
  .has-error .rule-thumb {
    background: #5a5a5f;
    opacity: 1;
    transform: scale(1);
    box-shadow: 0 1px 3px rgba(0, 0, 0, .5);
  }

  @keyframes splash-fade-out { from { opacity: 1; transform: scale(1.014); } to { opacity: 0; transform: scale(1); } }
  @keyframes splash-mark-in { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: scale(1); } }
  @keyframes splash-sweep { from { transform: translateX(-180%); } to { transform: translateX(340%); } }
  @keyframes splash-rule-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes splash-thumb-in { from { opacity: 0; transform: scale(.4); } to { opacity: 1; transform: scale(1); } }
  @keyframes splash-caption-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes splash-glow { from { opacity: .7; transform: scale(1); } to { opacity: 1; transform: scale(1.05); } }

  /* 扫描行程：来回 620ms/趟。154 = 168 - 14，正好是圆头在轨上的全部行程，
     和主页那枚滑块的可达范围一模一样——两头贴边，不会悬空。
     两头各有一次减速，读作「扫到头再折回来」，而不是「停住了」。 */
  @keyframes splash-scan {
    from { transform: translateX(0); }
    to { transform: translateX(154px); }
  }

  /* 就绪那一闪：字标里再走一道光，表示数据到了，紧接着整层淡出。
     必须连 transform 一起动——光带在 mask 子树里，停在 box 外就是隐形动画（第一版就踩了）。 */
  .is-leaving .splash-mark::after {
    animation: splash-ready-flash 200ms cubic-bezier(.22, .61, .36, 1) both;
  }
  @keyframes splash-ready-flash {
    0% { opacity: .95; transform: translateX(-180%); }
    100% { opacity: 0; transform: translateX(340%); }
  }

  @media (prefers-reduced-motion: reduce) {
    .splash-glow,
    .splash-mark,
    .splash-mark::after,
    .splash-rule,
    .splash-caption,
    .rule-runner,
    .rule-glow,
    .rule-thumb,
    .is-leaving { animation: none; }
    .splash-mark { opacity: 1; transform: none; }
    .splash-mark::after { display: none; }
    /* 不扫了就把扫描头摆在轨中：静止时它也该像一枚正常的滑块，不是一个坏掉的零件 */
    .rule-runner { transform: translateX(77px); } /* (168 - 14) / 2 */
    .rule-glow { opacity: 0; }
    .rule-thumb { opacity: 1; transform: scale(1); }
    .splash-caption { opacity: 1; transform: none; }
    .is-leaving { transition: opacity 120ms linear; opacity: 0; }
  }
</style>