<script lang="ts">
  /**
   * 外补画板：把 ComfyUI 里那台 48 号「外补画板（可视化）」搬到再次创作弹窗里来。
   *
   * 为什么要在弹窗里重画一层，而不是直接用节点自带的那块可视化：它的前端
   * （web/js/goohai_outpaint_visual.js）活在 LiteGraph 的画布上，只有人在 ComfyUI 里打开那张图才存在。
   * 闪寻这边是本机直接提交图、云端走 RunningHub API，两条路都没有那个页面，所以只能自己画。
   * 画的那一套算术一行都不在这儿写，全部走 lib/outpaint.ts（那儿逐条对着节点的 .py 和它的前端手算，有用例）。
   *
   * 四条定了不动的：
   * 1. **画面上摆的永远是 boardPads 那份像素**，也就是服务端真会补的那份。所以选了比例之后，
   *    拖完、填完数字，屏幕上的四边会自己跳到配平后的值。这是故意的：宁可数字跳一下，
   *    也不要屏幕上拖到 221、成图出来是 220（详见 lib/outpaint.ts 文件顶那段）。
   * 2. 拖动的**手感**照节点前端：拖一边时对侧钉住，按住 Shift 才同轴对称。位移按「按下那一刻」
   *    算总量、不累加增量，否则取整误差会一次一次攒出来。
   * 3. 拖动过程中比例冻住。让适应窗口跟着画板走的话，边框刚拖开就被缩回去，屏幕上就看不出
   *    「我到底补了多少」——那正是这块可视化存在的唯一理由。
   * 4. 键盘用户走底部那四个数字框，边框命中区对读屏是隐藏的：八个拖拽点在无障碍树里只会是
   *    八个读不出方向的空按钮，而数字框本来就在，还带方向名。
   */
  import { onDestroy } from "svelte";
  import Icon from "./Icon.svelte";
  import { modalFocus } from "../lib/modal-focus";
  import {
    OUTPAINT_COMPARE_HINT, OUTPAINT_EMPTY_REASON, OUTPAINT_FACTORY, OUTPAINT_MAX_EDGE, OUTPAINT_MAX_PAD,
    OUTPAINT_RATIOS, OUTPAINT_SIDE_KEYS, OUTPAINT_SIDE_WORDS, OUTPAINT_TINT, OUTPAINT_UNITS,
    boardPads, boardReadout, boardShown, dragBoard, isBoardEmpty, outputGeometry, sideSuffix, sideValues, slideBoard,
    type OutpaintBoardState, type OutpaintEdges, type OutpaintSides, type OutpaintSide,
    type OutpaintSize, type OutpaintUnit,
  } from "../lib/outpaint";

  interface Props {
    /** 底图地址：调用方给按源图分辨率拼好的 backendUrl */
    src: string;
    /** 「图片1」：画的是哪一格要说出来 */
    label: string;
    /** 源图真实宽高：四边的百分比是按它算的，少一位成图就差一截 */
    sourceWidth: number;
    sourceHeight: number;
    /** 弹窗那份 controls 里现在的六颗（单位值，不是像素） */
    board: OutpaintBoardState;
    onCancel: () => void;
    /** 保存画板才写回 controls：取消就得真的能取消，和画遮罩同一套交代 */
    onSave: (next: OutpaintBoardState) => void;
  }

  let { src, label, sourceWidth, sourceHeight, board, onCancel, onSave }: Props = $props();

  /** 命中区 24px 是 WCAG 2.5.8 的底线；画面上那条边界仍只是 1px 线，不撑这么大根本点不着 */
  const HIT = 24;
  const HALF = HIT / 2;
  /** 四边固定列法：底排那四个框的顺序就是画板上四条边的顺序，不许另一处自己排一遍 */
  const EDGES: OutpaintSide[] = ["left", "right", "top", "bottom"];

  let view = $state({ w: 0, h: 0 });
  /** 元数据没给尺寸时按图片自己解码出来的那份兜底，别画一块一算就错的白板 */
  let natural = $state<OutpaintSize>({ w: 0, h: 0 });
  // svelte-ignore state_referenced_locally —— 要的就是开层那一刻的值：画板是 {#if} 挂上来的，
  // 每次开都从 controls 现读一份当草稿，取消就该把这一整层丢掉，不该跟着外面继续变。
  let draft = $state<OutpaintBoardState>({ ...board, raw: { ...board.raw } });
  let peek = $state(false);

  /** 一次拖动：edges 是哪几条边在动，origin 是按下那一刻的状态，baseW/H 用来把对侧钉回原地 */
  interface Drag {
    edges: OutpaintEdges;
    origin: OutpaintBoardState;
    scale: number;
    startX: number;
    startY: number;
    baseW: number;
    baseH: number;
    slide: boolean;
  }
  /** 它是状态不是局部变量：比例冻住、对侧钉回原地这两件事都靠它触发重算，不reactive就会先闪一下再冻 */
  let drag = $state<Drag | null>(null);

  const size = $derived(sourceWidth > 0 && sourceHeight > 0
    ? { w: sourceWidth, h: sourceHeight }
    : natural);
  const ready = $derived(size.w > 0 && size.h > 0);
  const zero: OutpaintSides = { left: 0, right: 0, top: 0, bottom: 0 };
  /** 画面上摆的、算成图用的，全是这一份像素（不是 controls 里那四颗单位值） */
  const pads = $derived(ready ? boardPads(draft, size) : zero);
  /** 屏幕上那四个框显示的也是换算完的那一份：填 15 配平成 40，框里就该写 40 */
  const shown = $derived(ready ? boardShown(draft, size) : draft.raw);
  const suffix = $derived(sideSuffix(draft.unit));
  const out = $derived(ready ? outputGeometry(pads, size) : null);
  const total = $derived({ w: size.w + pads.left + pads.right, h: size.h + pads.top + pads.bottom });
  const empty = $derived(ready && isBoardEmpty(pads));

  const fitScale = $derived.by(() => {
    const availW = view.w - HIT;
    const availH = view.h - HIT;
    if (!(availW > 0) || !(availH > 0) || !(total.w > 0) || !(total.h > 0)) return 1;
    // 只往下压、不放大：一屏放得下时一个屏幕像素就是一个源图像素，不拿插值糊人
    return Math.min(1, availW / total.w, availH / total.h);
  });
  const scale = $derived(drag ? Math.min(drag.scale, fitScale) : fitScale);
  const box = $derived(peek ? { w: size.w, h: size.h } : total);

  /** 画板居中，往外拖会两头一起长。平移半个增量把对侧钉回原地，手感才是在拖一条边而不是拉整块 */
  const nudge = $derived.by(() => {
    const d = drag;
    if (!d || d.slide) return { x: 0, y: 0 };
    const growW = ((total.w - d.baseW) * scale) / 2;
    const growH = ((total.h - d.baseH) * scale) / 2;
    const has = (side: OutpaintSide) => d.edges.includes(side);
    return {
      x: has("left") && !has("right") ? -growW : has("right") && !has("left") ? growW : 0,
      y: has("top") && !has("bottom") ? -growH : has("bottom") && !has("top") ? growH : 0,
    };
  });

  const stageStyle = $derived(
    "width:" + Math.max(1, Math.round(box.w * scale)) + "px;"
    + "height:" + Math.max(1, Math.round(box.h * scale)) + "px;"
    + "transform:translate(" + Math.round(nudge.x) + "px," + Math.round(nudge.y) + "px);"
    + "background:" + (peek ? "transparent" : OUTPAINT_TINT),
  );
  const srcStyle = $derived(peek
    ? "left:0;top:0;width:100%;height:100%"
    : "left:" + Math.round(pads.left * scale) + "px;"
      + "top:" + Math.round(pads.top * scale) + "px;"
      + "width:" + Math.round(size.w * scale) + "px;"
      + "height:" + Math.round(size.h * scale) + "px");

  function move(e: PointerEvent) {
    const d = drag;
    if (!d) return;
    // 屏幕位移 ÷ 当前比例 = 源图口径的位移，算术层只认源图口径
    const dx = (e.clientX - d.startX) / scale;
    const dy = (e.clientY - d.startY) / scale;
    draft = d.slide
      ? slideBoard(d.origin, size, dx, dy)
      : dragBoard(d.origin, size, d.edges, dx, dy, e.shiftKey);
  }

  function stop() {
    drag = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  }

  function start(e: PointerEvent, edges: OutpaintEdges, slide = false) {
    if (!ready || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    drag = {
      edges,
      origin: { ...draft, raw: { ...draft.raw } },
      scale: fitScale,
      startX: e.clientX,
      startY: e.clientY,
      baseW: total.w,
      baseH: total.h,
      slide,
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  function setUnit(next: OutpaintUnit) {
    if (next === draft.unit) return;
    // 换单位保画面：先按**旧**单位把画面换算成像素，再把这份像素按新单位记一遍，画面一格都不动。
    // 顺序反过来就是这次犯的错：拿新单位去读旧单位那四颗，25% 会被当成 25 像素，边界一下就缩回去。
    draft = { ...draft, unit: next, raw: sideValues(next, boardPads(draft, size), size) };
  }

  function setSide(side: OutpaintSide, text: string) {
    const value = Math.round(Number(text));
    const next = Number.isFinite(value) ? Math.max(0, Math.min(OUTPAINT_MAX_PAD, value)) : 0;
    draft = { ...draft, raw: { ...draft.raw, [side]: next } };
  }

  function reset() {
    draft = { ...OUTPAINT_FACTORY, raw: { ...OUTPAINT_FACTORY.raw } };
  }

  // 拖到一半这层被收掉（跑图会把画板关掉）：不收尾的话 window 上那三个监听会一直挂着，
  // 而 drag 指着的早就是另一层实例了。
  onDestroy(stop);

  function readNatural(e: Event) {
    if (sourceWidth > 0 && sourceHeight > 0) return;
    const img = e.currentTarget as HTMLImageElement | null;
    if (img && img.naturalWidth > 0) natural = { w: img.naturalWidth, h: img.naturalHeight };
  }
</script>

<div class="ob" role="dialog" aria-label={"扩图画板（" + label + "）"} tabindex="-1" use:modalFocus>
  <div class="ob-top">
    <div class="ob-line">
      <span class="ob-what"><Icon name="outpaint" size={14} />扩图画板 · {label}</span>
      <span class="ob-note">灰底就是这一趟要补的画面 · 拖边框或四角 · 按住原图挪位置 · 按住 Shift 同轴对称</span>
      <span class="ob-size" title={out && out.scaled
        ? "最长边超过 " + OUTPAINT_MAX_EDGE + "，这一趟会整张等比压回来"
        : "按现在这四边，这一趟会出这么大一张图"}>
        {#if out}成图 {out.w}×{out.h}{out.scaled ? "（已压回）" : ""}{:else}成图 读不到尺寸{/if}
      </span>
      <span class="ob-group ob-actions">
        <button class="ob-btn" title="回到四边 0、自由比例（和刚装上这条工作流时一样）" onclick={reset}>回出厂</button>
        <button class="ob-btn" onclick={onCancel}>取消</button>
        <button class="ob-btn ob-btn-go" onclick={() => onSave(draft)}>保存画板</button>
      </span>
    </div>
  </div>

  <div class="ob-view" bind:clientWidth={view.w} bind:clientHeight={view.h}>
    <div class="ob-stage" style={stageStyle} class:is-peek={peek}>
      <img class="ob-src" src={src} style={srcStyle} alt={label} draggable="false"
        onload={readNatural} onpointerdown={(e) => start(e, [], true)} />
      <!-- 八个命中区写死，不 {#each}：class 走动态值会让编译器认不出下面那八条选择器（整片报
           "unused selector"），而它们本来就只有这八个位置。对读屏是隐藏的——键盘用户走底部那四个框。 -->
      <span class="ob-edge is-left" aria-hidden="true" title="向左扩：按住拖动"
        onpointerdown={(e) => start(e, ["left"])}></span>
      <span class="ob-edge is-right" aria-hidden="true" title="向右扩：按住拖动"
        onpointerdown={(e) => start(e, ["right"])}></span>
      <span class="ob-edge is-top" aria-hidden="true" title="向上扩：按住拖动"
        onpointerdown={(e) => start(e, ["top"])}></span>
      <span class="ob-edge is-bottom" aria-hidden="true" title="向下扩：按住拖动"
        onpointerdown={(e) => start(e, ["bottom"])}></span>
      <span class="ob-corner is-lt" aria-hidden="true" title="向左上扩：按住拖动，按住 Shift 同轴对称"
        onpointerdown={(e) => start(e, ["left", "top"])}></span>
      <span class="ob-corner is-rt" aria-hidden="true" title="向右上扩：按住拖动，按住 Shift 同轴对称"
        onpointerdown={(e) => start(e, ["right", "top"])}></span>
      <span class="ob-corner is-lb" aria-hidden="true" title="向左下扩：按住拖动，按住 Shift 同轴对称"
        onpointerdown={(e) => start(e, ["left", "bottom"])}></span>
      <span class="ob-corner is-rb" aria-hidden="true" title="向右下扩：按住拖动，按住 Shift 同轴对称"
        onpointerdown={(e) => start(e, ["right", "bottom"])}></span>
    </div>
    {#if !ready}
      <p class="ob-loading">正在读这张图的尺寸…（百分比是按源图算的，读到之前先别拖）</p>
    {/if}
  </div>

  <div class="ob-line">
    <span class="ob-group ob-sides" role="group" aria-label="四个方向各补多少">
      {#each EDGES as side}
        <label class="ob-side" title={OUTPAINT_SIDE_WORDS[side] + "补多少（" + OUTPAINT_MAX_PAD + suffix + " 封顶）"}>
          {OUTPAINT_SIDE_WORDS[side]}
          <input type="number" min="0" max={OUTPAINT_MAX_PAD} step="1" value={shown[side]}
            onchange={(e) => setSide(side, (e.currentTarget as HTMLInputElement).value)} />
          <b>{suffix}</b>
        </label>
      {/each}
    </span>
    <span class="ob-group" role="group" aria-label="按什么单位记">
      {#each OUTPAINT_UNITS as unit}
        <button class="ob-chip" class:is-on={draft.unit === unit} aria-pressed={draft.unit === unit}
          title={unit === "百分比" ? "按源图的边长算，换图也保持同样的比例" : "按像素算，换一张图补的就是这些像素"}
          onclick={() => setUnit(unit)}>{unit}</button>
      {/each}
    </span>
    <span class="ob-group ob-ratios" role="group" aria-label="凑成哪个比例">
      {#each OUTPAINT_RATIOS as option}
        <button class="ob-chip" class:is-on={draft.ratio === option} aria-pressed={draft.ratio === option}
          title={"把画板凑成 " + option + "（只增不减：已经拖出来的量不会缩回去）"}
          onclick={() => (draft = { ...draft, ratio: option })}>{option}</button>
      {/each}
    </span>
    <button class="ob-btn" title={OUTPAINT_COMPARE_HINT}
      onpointerdown={() => (peek = true)} onpointerup={() => (peek = false)}
      onpointerleave={() => (peek = false)} onpointercancel={() => (peek = false)}>按住看原图</button>
  </div>

  <p class="ob-foot" class:is-warn={empty} role="status">
    {#if empty}
      {OUTPAINT_EMPTY_REASON}
    {:else}
      {boardReadout(draft.unit, shown)}
      {#if out && out.scaled}· 最长边过了 {OUTPAINT_MAX_EDGE}，成图整张等比压到 {out.w}×{out.h}{/if}
    {/if}
  </p>
</div>

<style>
  /* 和画遮罩那一层同一套交代：它是 .cm-backdrop 的孩子、.cm-panel 的兄弟，inset:0 连内边距一起
     吃掉，z-index 7 压过弹窗里的全部（口径见 MaskEditor.svelte 那段注释，两处必须一起改）。 */
  .ob {
    position: absolute; inset: 0; z-index: 7; display: flex; flex-direction: column; gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-4); background: var(--ink-0); color: var(--text-1);
    font-size: var(--fs-sm); outline: none;
  }
  .ob-top { display: flex; flex-direction: column; gap: var(--sp-1); flex: none; }
  .ob-line { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; flex-wrap: wrap; }
  .ob-what { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-base); font-weight: 600; }
  .ob-note { min-width: 0; color: var(--text-2); font-size: var(--fs-xs); }
  .ob-size {
    margin-left: auto; color: var(--text-1); font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
  }
  .ob-group { display: inline-flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap; }
  .ob-actions { margin-left: var(--sp-2); }

  .ob-view {
    position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    background: var(--ink-1); border: 1px solid var(--line); border-radius: var(--r-2);
    touch-action: none;
  }
  .ob-stage { position: relative; flex: none; user-select: none; will-change: transform; }
  .ob-src { position: absolute; display: block; box-shadow: 0 0 0 1px var(--line); cursor: move; }
  .ob-stage.is-peek .ob-src { box-shadow: none; cursor: default; }
  .ob-stage.is-peek .ob-edge, .ob-stage.is-peek .ob-corner { display: none; }

  /* 命中区跨在边界两侧各 HALF，视觉仍是一条线：只有源图那圈描边在说话 */
  .ob-edge, .ob-corner { position: absolute; touch-action: none; background: transparent; }
  .ob-edge:hover, .ob-corner:hover { background: rgb(255 255 255 / 10%); }
  .ob-edge.is-left, .ob-edge.is-right { top: 0; bottom: 0; width: 24px; cursor: ew-resize; }
  .ob-edge.is-left { left: 0; transform: translateX(-12px); }
  .ob-edge.is-right { right: 0; transform: translateX(12px); }
  .ob-edge.is-top, .ob-edge.is-bottom { left: 0; right: 0; height: 24px; cursor: ns-resize; }
  .ob-edge.is-top { top: 0; transform: translateY(-12px); }
  .ob-edge.is-bottom { bottom: 0; transform: translateY(12px); }
  .ob-corner { width: 24px; height: 24px; border-radius: var(--r-0); }
  .ob-corner.is-lt { left: 0; top: 0; transform: translate(-12px, -12px); cursor: nwse-resize; }
  .ob-corner.is-rb { right: 0; bottom: 0; transform: translate(12px, 12px); cursor: nwse-resize; }
  .ob-corner.is-rt { right: 0; top: 0; transform: translate(12px, -12px); cursor: nesw-resize; }
  .ob-corner.is-lb { left: 0; bottom: 0; transform: translate(-12px, 12px); cursor: nesw-resize; }

  .ob-loading {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    margin: 0; padding: var(--sp-1) var(--sp-3); border-radius: var(--r-1);
    background: var(--ink-3); color: var(--text-2); font-size: var(--fs-xs);
  }

  .ob-sides { gap: var(--sp-2); }
  .ob-side {
    display: inline-flex; align-items: center; gap: var(--sp-1);
    color: var(--text-2); font-size: var(--fs-xs);
  }
  .ob-side input {
    width: 64px; height: var(--ctl-sm); padding: 0 var(--sp-1);
    border: 1px solid var(--line); border-radius: var(--r-1);
    background: var(--ink-2); color: var(--text-1); font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
  }
  .ob-side b { min-width: 16px; color: var(--text-3); font-weight: 500; }
  .ob-ratios { gap: var(--sp-1); }

  .ob-chip {
    height: var(--ctl-sm); padding: 0 var(--sp-2); border: 0; border-radius: var(--r-pill);
    background: var(--ink-3); color: var(--text-1); font-size: var(--fs-xs); cursor: pointer;
  }
  .ob-chip:hover { background: var(--ink-4); }
  .ob-chip.is-on { background: var(--accent); color: var(--accent-ink); }
  .ob-btn {
    height: var(--ctl-sm); padding: 0 var(--sp-2); border: 0; border-radius: var(--r-1);
    background: var(--ink-3); color: var(--text-1); font-size: var(--fs-sm); cursor: pointer;
  }
  .ob-btn:hover { background: var(--ink-4); }
  .ob-btn-go { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
  .ob-btn-go:hover { background: var(--accent-strong); }

  .ob-foot {
    margin: 0; flex: none; color: var(--text-2); font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
  }
  .ob-foot.is-warn { color: var(--warn); }
</style>