<script lang="ts">
  /**
   * 再次创作·上半区的局部画布（原型，浏览器加 ?cm_canvas=1 才开）。
   *
   * 它要解的痛只有一条：一批出好几份时，原来那一格靠左右两颗箭头一张张翻，
   * 挑不出「这四张里哪张 closest」。所以这一格换成一个只读视口——整批自动铺开、
   * 滚轮缩放、点哪张看哪张、多轮累积在同一个平面上，旧批变淡。
   *
   * 它刻意不是一块无限画布：卡片位置由 lib/clone-canvas.ts 按批次算出来，摆在哪里
   * 不承载信息，所以没有自由摆放、没有落盘、没有持久相机。画布只是视图层的一个视口。
   *
   * 一条安全边界，整个组件的前提：**画布内部不允许出现 position:fixed / sticky，
   * 也不允许出现靠视口坐标定位的弹层。** 祖先带 transform 会创建 containing block，
   * 弹窗里那两条 fixed（参考图悬停放大预览、弹层整屏兜底遮罩）会跟着错位——
   * container-type 那次已经栽过同一个根因。所以输入卡、三颗胶囊、@ 引用菜单全在画布外面，
   * DOM 上也不能成为画布的后代。
   */
  import { untrack } from "svelte";
  import { backendUrl } from "../lib/backend-url";
  import type { CloneBatch } from "../lib/clone";
  import {
    cameraForCard, cloneSourceUrl, layoutCloneBatches, neededPixels,
    CANVAS_INSET,
    type CanvasCard, type CanvasEscape,
  } from "../lib/clone-canvas";
  import { ViewerZoom, viewerZoomWheel, ZOOM_LIMITS } from "../lib/viewer-zoom.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    /** 最新的排最前面（封存点在 lib/clone.ts 的 applyCloneProgress）。 */
    batches: CloneBatch[];
    /** 非图片产出（视频、音频）仍然交给父组件分派：视频进播放器、音频就地播。 */
    onOpenImage?: (id: number, kind?: string) => void;
    /** 把相机的「先退回全览」交给宿主的 Esc。 */
    onCamera?: (escape: CanvasEscape) => void;
  }

  let { batches, onOpenImage, onCamera }: Props = $props();

  let viewportW = $state(0);
  let viewportH = $state(0);
  /** 现在放大的是哪一张（null = 全览）。用卡片的 key 而不是产出 id：跨批次撞 id 不是不可能。 */
  let focusKey = $state<string | null>(null);
  let seenBatches = $state(0);

  const layout = $derived(layoutCloneBatches(batches));
  const dpr = $derived(
    typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1,
  );

  // 缩放与平移的状态机不在这里重写：图片预览与视频播放器共用 lib/viewer-zoom.svelte.ts 那一层
  // （fit ⇄ 100%、滚轮、抓手拖动、clamp、双击）。宿主契约只有两个 getter，
  // 画布把「整批的包围盒」当内容尺寸交进去，视口用 bind 量到的实测值。
  const zoom = new ViewerZoom({
    content: () => ({ w: layout.width, h: layout.height }),
    viewport: () => ({ w: viewportW, h: viewportH }),
    inset: CANVAS_INSET,
    // 允许 fit 放大超过卡片的设计尺寸。卡片那 240px 是排布用的设计档，不是素材分辨率
    // （素材本来就有 577~1024+），而这一格现在拿 object-fit:contain 铺满时本来就在放大。
    // 不放开的话，只出一张时画布正中间坐着一张 240 高的小图，四周全是空的（实拍 65% 高 / 18% 宽）。
    upscaleToFit: true,
    // 拖动起手不 preventDefault：这一层里面全是卡片按钮，preventDefault 掉的
    // 是 pointerdown 的兼容鼠标事件，跟着就点不到按钮（视频那一层为同样的原因关的）。
    // 图自己带了 draggable="false"，不挡也不会长出拖拽幽灵。
    preventDefaultDrag: false,
  });

  const shown = $derived.by(() => {
    const total = layout.cards.length;
    if (!total) return null;
    const at = layout.cards.findIndex((c) => c.key === focusKey);
    return { index: (at < 0 ? 0 : at) + 1, total };
  });

  /** 新批落地：先回全览。放大着的时候来了一批新东西，停在旧的那张上是掩耳盗铃。 */
  $effect(() => {
    const n = batches.length;
    if (n === seenBatches) return;
    seenBatches = n;
    zoom.mode = "fit";
    zoom.scale = 1;
    zoom.pan = { x: 0, y: 0 };
    focusKey = null;
  });

  /**
   * 关动效的人要看到静止的画布。缩放那层的过渡在样式表里，媒体查询压得住；
   * 平移那层的 transition 是 ViewerZoom 给的 inline style，`transition: none` 压不过内联——
   * 所以这里自己认一次系统偏好（与弹窗里那句 matchMedia 同一个口径），别留半条动效。
   */
  let reduceMotion = $state(false);
  $effect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    reduceMotion = mq.matches;
    const sync = () => { reduceMotion = mq.matches; };
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  });
  const stageTransition = $derived(reduceMotion ? "none" : zoom.transition);

  /** 视口变了（折侧栏、最大化）要把跑出边界的平移拉回来。 */
  $effect(() => {
    void viewportW;
    void viewportH;
    untrack(() => zoom.clampNow());
  });

  $effect(() => {
    const escape: CanvasEscape = {
      isZoomed: () => zoom.isZooming(),
      zoomOut: () => backToAll(),
    };
    untrack(() => onCamera?.(escape));
  });

  function backToAll() {
    zoom.setFit();
    focusKey = null;
  }

  function applyFocus(card: CanvasCard) {
    if (focusKey === card.key) {
      backToAll();
      return;
    }
    const cam = cameraForCard(card, layout, { w: viewportW, h: viewportH }, ZOOM_LIMITS);
    zoom.mode = "zoom";
    zoom.scale = cam.scale;
    zoom.pan = cam.pan;
    focusKey = card.key;
  }

  /** 刚拖过画面，抬手那一下不算「点这张」。 */
  function onCardClick(card: CanvasCard) {
    if (zoom.dragMoved) return;
    applyFocus(card);
  }

  /**
   * 方向键挂在卡片那颗按钮上：卡片本身就是 Tab 的停靠点，画布外壳不需要再造一个
   * （带 tabindex 的裸 div 在 a11y 检查里就是「非交互元素给了非负 tabindex」）。
   */
  function onCardKeydown(card: CanvasCard, e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const cards = layout.cards;
    if (cards.length < 2) return;
    e.preventDefault();
    const at = cards.findIndex((c) => c.key === card.key);
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = cards[(at + step + cards.length) % cards.length];
    if (!next) return;
    applyFocus(next);
    // 焦点跟着画面上放大那一张走，否则键盘用户按两下就被留在原来那颗按钮上
    const host = (e.currentTarget as HTMLElement).closest(".cc-card")?.parentElement;
    const target = host?.querySelector<HTMLElement>(`[data-cc-key="${next.key}"]`);
    target?.focus();
  }

  /** 「刚生成的」只对新到手的这批成立，旧批说这句话就是假话。 */
  function openLabel(card: CanvasCard): string {
    const noun = card.output.kind === "image" ? "张" : "条";
    return card.latest
      ? `在图库中打开刚生成的第 ${card.output.id} ${noun}`
      : `在图库中打开第 ${card.output.id} ${noun}`;
  }

  function srcFor(card: CanvasCard): string {
    return backendUrl(cloneSourceUrl(card.output, neededPixels(card, zoom.ratio, dpr)));
  }
</script>

<div class="cc-root">
  <!-- 自管键盘与指针的一块画布，语义就是 application：
       role=group 不算交互角色，挂上去 tabindex 与 keydown 一样挨告警。
       指针处理器全部落在这一层，里面那两层退回纯视觉——带 transform 的层不接事件，
       坐标孤岛这条边界也就不需要每层各自守一次。 -->
  <div class="cc-viewport" role="application" aria-label="本次与往批产出"
    bind:clientWidth={viewportW} bind:clientHeight={viewportH}
    style:cursor={zoom.cursor}
    use:viewerZoomWheel={zoom}
    onpointerdown={zoom.onPointerDown}
    onpointermove={zoom.onPointerMove}
    onpointerup={zoom.onPointerUp}
    onpointercancel={zoom.onPointerUp}>
    <!-- 放大态下垫在画面后面的一颗真空按钮：点空白退回全览。
         它必须是真的 button——挂在这层 div 上的 onclick 会招来一条 a11y 告警，
         而 svelte-check 的基线是 0 errors + 20 warnings，不能靠新告警换交互。 -->
    {#if zoom.isZooming()}
      <button type="button" class="cc-backdrop" aria-label="退回全览" onclick={backToAll}></button>
    {/if}
    <div class="cc-stage" class:is-dragging={zoom.dragging}
      style:width={zoom.sized ? `${zoom.displayW}px` : null}
      style:height={zoom.sized ? `${zoom.displayH}px` : null}
      style:transform={zoom.isZooming() ? `translate(${zoom.pan.x}px, ${zoom.pan.y}px)` : "none"}
      style:transition={stageTransition}>
      <div class="cc-content" style:width={`${layout.width}px`} style:height={`${layout.height}px`}
        style:transform={`scale(${zoom.ratio})`}>
        {#each layout.cards as card (card.key)}
          <div class="cc-card" class:is-faded={card.faded} class:is-focused={focusKey === card.key}
            style:left={`${card.x}px`} style:top={`${card.y}px`}
            style:width={`${card.w}px`} style:height={`${card.h}px`}>
            {#if card.output.kind === "image"}
              <button type="button" class="cc-zoom" data-cc-key={card.key}
                aria-label={`放大第 ${card.order + 1} 份`}
                title="点开看这一张 · 再点退回全览" onclick={() => onCardClick(card)}
                onkeydown={(e) => onCardKeydown(card, e)}>
                <img src={srcFor(card)} alt={`第 ${card.order + 1} 份生成画面`} draggable="false" />
              </button>
              <!-- 放大与「去图库」是两件事，所以拆成两颗：整块图一点就跳走，
                   是想连着看四张的人最烦的事。 -->
              <button type="button" class="cc-open" aria-label={openLabel(card)}
                onclick={() => onOpenImage?.(card.output.id, card.output.kind)}>
                <Icon name="external-link" size={12} />在图库中打开
              </button>
            {:else}
              <!-- 视频与音频不进 100%：它们的缩放语义属于各自的播放器，画布上点它就是交给父组件分派。 -->
              <button type="button" class="cc-plain" data-cc-key={card.key} aria-label={openLabel(card)}
                onclick={() => onOpenImage?.(card.output.id, card.output.kind)}
                onkeydown={(e) => onCardKeydown(card, e)}>
                <img src={srcFor(card)} alt="" draggable="false" />
                <span class="cc-play" aria-hidden="true"><Icon name="play" size={20} /></span>
              </button>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
  {#if shown && shown.total > 1}
    <!-- 翻页那两颗箭头撤了，计数与播报留着：不看画面的人也该知道自己停在哪一份。 -->
    <p class="cc-count" aria-live="polite">第 {shown.index} / {shown.total} 份</p>
  {/if}
</div>

<style>
  .cc-root { display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 0; width: 100%; }

  /* 高度不在这里定：读弹窗 .cm-body 上那份 --cm-hero-h（自定义属性会继承下来）。这一格与
     展示图、等待台是轮流占的，各自写一个数就会在换状态时把输入卡顶一下、坠一下（1478x562 踩过）。
     窄窗口与矮窗口两档同样由弹窗那边改值，所以这里一个断点都不必写。
     兜底那个数是弹窗的基类值：万一这层落在没写变量的地方，也不至于是零高。 */
  .cc-viewport {
    position: relative; width: 100%; height: var(--cm-hero-h, min(46vh, 480px));
    display: flex; align-items: center; justify-content: center;
    overflow: hidden; border-radius: 16px; outline: none;
    /* 手势归画布：滚轮是缩放、拖动是平移，所以这块区域不再跟着面板竖向滚。 */
    touch-action: none; user-select: none;
  }
  .cc-viewport:focus-visible { box-shadow: 0 0 0 2px rgb(255 255 255 / 22%); }
  .cc-backdrop { position: absolute; inset: 0; z-index: 0; border: 0; background: transparent; cursor: grab; }
  /* 画面必须坐在真空按钮之上，否则放大态下点哪都是「退回全览」。 */
  .cc-stage { position: relative; z-index: 1; flex: none; }
  /* transform 只准出现在这两层里。它创建 containing block——往外画一个 fixed 就错位。 */
  .cc-content { position: relative; transform-origin: 0 0; transition: transform 0.28s ease; }
  .cc-stage.is-dragging .cc-content { transition: none; }
  .cc-card { position: absolute; border-radius: 14px; overflow: hidden; background: #0c0c0e; }
  /* 旧批变淡，最新那批才是这一轮的结果；聚焦哪张再补一圈环，放大态下也认得出在看谁。 */
  .cc-card.is-faded { opacity: 0.55; }
  .cc-card.is-focused { box-shadow: 0 0 0 2px rgb(255 255 255 / 26%); }
  .cc-zoom, .cc-plain {
    position: absolute; inset: 0; padding: 0; border: 0; background: transparent;
    display: block; width: 100%; height: 100%;
  }
  .cc-zoom { cursor: zoom-in; }
  .cc-zoom img, .cc-plain img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .cc-play {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    display: flex; align-items: center; justify-content: center;
    width: 44px; height: 44px; border-radius: 50%;
    color: #fafafa; background: rgb(0 0 0 / 55%); pointer-events: none;
  }
  .cc-open {
    position: absolute; right: 8px; bottom: 8px; z-index: 2;
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 8px; border: 0; border-radius: 999px;
    font-size: 11.5px; color: #fafafa; background: rgb(0 0 0 / 62%);
    opacity: 0; transition: opacity 0.16s ease;
  }
  .cc-card:hover .cc-open, .cc-open:focus-visible, .cc-card.is-focused .cc-open { opacity: 1; }
  .cc-count { margin: 0; font-size: 12px; color: #8a8a8e; }

  @media (prefers-reduced-motion: reduce) {
    /* 平移与缩放是本组件唯一的动效：要撤就整条撤，别留半条。 */
    .cc-content, .cc-stage, .cc-open { transition: none; }
  }
</style>