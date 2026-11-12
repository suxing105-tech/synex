<script lang="ts">
  /**
   * 遮罩编辑器：盖住整个再次创作弹窗的一层编辑面，画完交回一份「白＝要改的地方」的遮罩。
   *
   * 四条设计定了就不动摇：
   * 1. 画布只看 alpha（涂没涂到），涂出来的红色只是给人看的第二层。提交那份黑白图在导出时按 alpha 现推，
   *    所以「换个颜色」「调叠色不透明度」永远不会悄悄改变送给 ComfyUI 的东西。
   * 2. 撤销不存像素快照：一张 2048² 的 RGBA 快照就是 16MB，存 40 步等于一次编辑器吃 600MB 内存。
   *    这里存笔迹、要重画时整条重放一遍，画布操作是原生路径，几十笔也就几毫秒。
   * 3. 手势与图库放大层对齐：左键画、Shift+左键框选、滚轮缩放、Ctrl+滚轮改笔刷、
   *    双击 100%⇄适应、空格临时抓手。左键归画笔，所以平移只能靠空格（或中键），
   *    不能像看图那样直接拖；Shift 那一下给的是「圈一整块」，边界是硬的，
   *    像「把这台机器整个移除」这种用画笔涂永远涂不整齐。
   * 4. 框选在松手之前一个字都不进遮罩：预览画在第三张画布上，松手才落进遮罩层与显示层。
   *    拖回去重画（比如从右下角往左上拖）不会留下已经涂上的痕迹。
   *
   * 规则（画布尺寸、补间、多少像素算没画、导出格式）全在 lib/mask.ts，那儿有测试；这层只管画。
   */
  import { onMount, tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { modalFocus } from "../lib/modal-focus";
  import {
    MASK_BRUSH_DEFAULT, MASK_BRUSH_MAX, MASK_BRUSH_MIN, MASK_INK_DEFAULT, MASK_INK_MAX, MASK_INK_MIN,
    MASK_INK_RGB, MASK_REDO_LIMIT, countMaskPixels, isMaskEmpty, maskBrushRadius, maskCanvasScale,
    maskCanvasSize, maskPixelsInSource, maskRectIsReal, maskRectSelect, strokePoints, stripDataUrl,
    type MaskEdit, type MaskPoint, type MaskRect,
  } from "../lib/mask";

  interface Props {
    /** 参考图的显示地址（调用方给已经拼好的 backendUrl） */
    src: string;
    /** 「图片1」：画的是哪一格要说出来 */
    label: string;
    /** 只读回显：现在这次是局部重绘还是移除（在这儿改提示词会画完还得退出去，所以只读） */
    modeText: string;
    /** 只读回显：提示词摘要 */
    promptSummary: string;
    /** 工作流自己写的那句「留空会怎样」 */
    hint?: string;
    /** 上一次画的（透明底 PNG 的 data URL）：进来接着改，不是从头再来 */
    seed?: string;
    /** 画在哪一份参考图上，换图之后遮罩就不认了 */
    imageId: number;
    /** 参考图的真实宽：底图地址可能被后端降过档，笔刷粗细与像素计数要按源图说话，别按画布 */
    sourceWidth?: number;
    onCancel: () => void;
    /** 交回 null = 这格其实没画（用户全擦了），调用方据此把标记一起撤掉 */
    onDone: (edit: MaskEdit | null) => void;
  }

  let {
    src, label, modeText, promptSummary, hint = "", seed = "", imageId, sourceWidth = 0, onCancel, onDone,
  }: Props = $props();

  type Tool = "paint" | "erase";
  /** 一笔要么是画笔涂的一条线，要么是 Shift 框出来的一块：有 rect 就按块算，pts 留空 */
  interface Stroke { op: Tool; r: number; pts: MaskPoint[]; rect?: MaskRect }

  let rootEl = $state<HTMLDivElement | null>(null);
  let viewport = $state<HTMLDivElement | null>(null);
  let stageEl = $state<HTMLDivElement | null>(null);
  let maskCanvas = $state<HTMLCanvasElement | null>(null);
  let inkCanvas = $state<HTMLCanvasElement | null>(null);
  /** 框选的预览层：遮罩本体一点都没动，看得见的那圈只是预览 */
  let liveCanvas = $state<HTMLCanvasElement | null>(null);

  /** 画布像素尺寸＝参考图尺寸（长边超上限先降），一笔的坐标就按它算 */
  let size = $state({ width: 1, height: 1 });
  /** 适应窗口时这一格在屏幕上多大 */
  let box = $state({ width: 1, height: 1 });
  /** 1 = 适应窗口 */
  let zoom = $state(1);
  /** 适应窗口对应多少倍真实像素：换算「100%」这个数字用 */
  let fit = 1;
  let pan = $state({ x: 0, y: 0 });
  let ready = $state(false);
  let tool = $state<Tool>("paint");
  let brush = $state(MASK_BRUSH_DEFAULT);
  let ink = $state(MASK_INK_DEFAULT);
  let strokes = $state<Stroke[]>([]);
  /** 重做栈要和撤销栈一样是状态：底栏那颗「重做」的 disabled 读它，
   *  写成普通 let 的话编译器只算一次，撤销完重做还是灰的、永远点不着。 */
  let undone = $state<Stroke[]>([]);
  let painted = $state(0);
  let handing = $state(false);
  let drawing = false;
  /** Shift+左键按住的两个对角（画布坐标），松手前只是个草稿 */
  let rectDrag: { from: MaskPoint; to: MaskPoint } | null = null;
  let panning = false;
  let lastClient: MaskPoint | null = null;
  let live: Stroke | null = null;
  let seedImg: HTMLImageElement | null = null;
  /** 笔刷圈：停在视口坐标上，直径跟着缩放走，让人看得见这一笔有多粗 */
  let cursor = $state<MaskPoint | null>(null);

  const stageStyle = $derived(
    `width:${box.width.toFixed(1)}px; height:${box.height.toFixed(1)}px; `
    + `transform: translate(${pan.x.toFixed(1)}px, ${pan.y.toFixed(1)}px) scale(${zoom.toFixed(4)});`,
  );
  const percent = $derived(Math.round(zoom * fit * 100));
  /** 底图降过档时画布比源图小：笔刷与计数都要换算回源图口径，不然同一支笔在两张图上不一样粗 */
  const unitScale = $derived(maskCanvasScale(size.width, sourceWidth));
  /** 「已涂多少像素」也按源图报：画布线性缩 k 倍，面积差 k 平方 */
  const paintedSource = $derived(maskPixelsInSource(painted, size.width, sourceWidth));
  const cursorStyle = $derived(cursor
    ? `left:${cursor.x.toFixed(1)}px; top:${cursor.y.toFixed(1)}px; `
      // 笔刷圈要和落下去那一笔一样粗：brush 是直径（下笔取 brush/2 作半径），换算到屏幕
      // 上就是「直径 × 画布缩放 × 这一格多大 × 用户放的倍率」。以前多乘了个 2，
      // 圈看着比实际涂到的宽一倍，用户只能凭感觉把笔刷调小。
      + `width:${Math.max(6, brush * unitScale * fit * zoom).toFixed(1)}px; `
      + `height:${Math.max(6, brush * unitScale * fit * zoom).toFixed(1)}px;`
    : "");
  const emptyMask = $derived(isMaskEmpty(painted));

  function ctx(el: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
    return el ? el.getContext("2d") : null;
  }

  /** 适应窗口：按视口算这一格多大。缩放与平移是叠在它上面的 transform，所以窗口变了只需重量这一格。 */
  function measure() {
    const el = viewport;
    if (!el) return;
    const vw = el.clientWidth || 1;
    const vh = el.clientHeight || 1;
    fit = Math.min(vw / size.width, vh / size.height);
    box = { width: Math.max(1, size.width * fit), height: Math.max(1, size.height * fit) };
  }

  function dab(c: CanvasRenderingContext2D, color: string, alpha: number, op: Tool, r: number, pts: MaskPoint[]) {
    c.save();
    // 擦除一律按满不透明擦：橡皮管的是「涂没涂到」，不该留下半透明的边
    c.globalAlpha = op === "erase" ? 1 : alpha;
    c.globalCompositeOperation = op === "erase" ? "destination-out" : "source-over";
    c.fillStyle = color;
    for (const p of pts) {
      c.beginPath();
      c.arc(p.x, p.y, r, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  /** 框出来的那块同样落进两层，一次成形、硬边：圈整件东西时硬边比软边准 */
  function block(c: CanvasRenderingContext2D, color: string, alpha: number, op: Tool, rect: MaskRect) {
    c.save();
    c.globalAlpha = op === "erase" ? 1 : alpha;
    c.globalCompositeOperation = op === "erase" ? "destination-out" : "source-over";
    c.fillStyle = color;
    c.fillRect(rect.x, rect.y, rect.width, rect.height);
    c.restore();
  }

  /** 松手那一刻的预览：清掉预览层，把这块真的画进遮罩层与显示层 */
  function commitRect(rect: MaskRect, op: Tool) {
    const m = ctx(maskCanvas);
    const k = ctx(inkCanvas);
    if (m && k) {
      block(m, "rgb(255, 255, 255)", 1, op, rect);
      block(k, `rgb(${MASK_INK_RGB})`, ink, op, rect);
    }
    if (m) recount(m);
  }

  /** 拖动中的预览只画在第三张画布上：橡皮那块用白虚线圈，涂的那块用红的压一层 */
  function drawPreview(rect: MaskRect | null, erasing: boolean) {
    const c = ctx(liveCanvas);
    if (!c) return;
    c.clearRect(0, 0, size.width, size.height);
    if (!rect) return;
    // 画布会被 fit×zoom 缩到屏幕上，线宽先除回去，屏上看永远是 2px 那一圈
    const lw = 2 / Math.max(0.02, fit * zoom);
    c.save();
    if (!erasing) {
      c.globalAlpha = Math.min(0.9, ink + 0.2);
      c.fillStyle = `rgb(${MASK_INK_RGB})`;
      c.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    c.globalAlpha = 1;
    c.lineWidth = lw;
    c.strokeStyle = erasing ? "rgb(255, 255, 255)" : `rgb(${MASK_INK_RGB})`;
    if (erasing) c.setLineDash([lw * 6, lw * 4]);
    c.strokeRect(rect.x, rect.y, rect.width, rect.height);
    c.restore();
  }

  /** 当前这一框在画布上的位置（往回拖、拖出画面都归一成正放矩形） */
  function selection(): MaskRect | null {
    return rectDrag ? maskRectSelect(rectDrag.from, rectDrag.to, size.width, size.height) : null;
  }

  /** 一笔同时落进两层：遮罩层涂白（只有 alpha 算数），给人看的那层涂红并按叠色不透明度压暗 */
  function apply(m: CanvasRenderingContext2D, k: CanvasRenderingContext2D, s: Stroke, from = 0) {
    if (s.rect) {
      block(m, "rgb(255, 255, 255)", 1, s.op, s.rect);
      block(k, `rgb(${MASK_INK_RGB})`, ink, s.op, s.rect);
      return;
    }
    const pts = from > 0 ? s.pts.slice(from) : s.pts;
    dab(m, "rgb(255, 255, 255)", 1, s.op, s.r, pts);
    dab(k, `rgb(${MASK_INK_RGB})`, ink, s.op, s.r, pts);
  }

  /** 上一次的遮罩落到两层上：遮罩层直接画，显示层要先把它染成红色再按不透明度压 */
  function drawSeed(m: CanvasRenderingContext2D, k: CanvasRenderingContext2D) {
    if (!seedImg) return;
    m.drawImage(seedImg, 0, 0, size.width, size.height);
    const scratch = document.createElement("canvas");
    scratch.width = size.width;
    scratch.height = size.height;
    const s = scratch.getContext("2d");
    if (!s) return;
    s.drawImage(seedImg, 0, 0, size.width, size.height);
    s.globalCompositeOperation = "source-in";
    s.fillStyle = `rgb(${MASK_INK_RGB})`;
    s.fillRect(0, 0, scratch.width, scratch.height);
    k.save();
    k.globalAlpha = ink;
    k.drawImage(scratch, 0, 0);
    k.restore();
  }

  /** 整条重放：撤销、重做、清空、改叠色都走这一条，不存像素快照 */
  function redraw() {
    const m = ctx(maskCanvas);
    const k = ctx(inkCanvas);
    if (!m || !k) return;
    m.clearRect(0, 0, size.width, size.height);
    k.clearRect(0, 0, size.width, size.height);
    drawSeed(m, k);
    for (const s of strokes) apply(m, k, s);
    recount(m);
  }

  function recount(m: CanvasRenderingContext2D) {
    try {
      painted = countMaskPixels(m.getImageData(0, 0, size.width, size.height).data);
    } catch {
      // 画布取不到像素（极少数硬件/权限情况下会这样）：宁可按「画了」算，也别把用户刚画的东西说成没画
      painted = Math.max(painted, 1);
    }
  }

  function toCanvas(e: PointerEvent): MaskPoint | null {
    const el = stageEl;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: ((e.clientX - r.left) / r.width) * size.width,
      y: ((e.clientY - r.top) / r.height) * size.height,
    };
  }

  function trackCursor(e: PointerEvent) {
    const el = viewport;
    if (!el) return;
    const r = el.getBoundingClientRect();
    cursor = { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onDown(e: PointerEvent) {
    if (!ready) return;
    trackCursor(e);
    // 中键与空格态都算抓手：画到一半想挪画面，不该被迫先松手
    if (handing || e.button === 1) {
      panning = true;
      lastClient = { x: e.clientX, y: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      e.preventDefault();
      return;
    }
    // Shift+左键＝圈一整块。「把这台机器整个移除」这类需求用画笔涂，边界永远不整齐，
    // 而松手之前它一个字都没进遮罩，所以拖过头直接松开就行，不需要撤销。
    if (e.button === 0 && e.shiftKey) {
      const from = toCanvas(e);
      if (!from) return;
      rectDrag = { from, to: from };
      cursor = null; // 拖动中笔刷圈没有意义，藏掉
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const p = toCanvas(e);
    if (!p) return;
    drawing = true;
    live = { op: tool, r: maskBrushRadius(brush, size.width, sourceWidth), pts: [p] };
    undone = [];
    const m = ctx(maskCanvas);
    const k = ctx(inkCanvas);
    if (m && k) apply(m, k, live);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onMove(e: PointerEvent) {
    if (rectDrag) {
      const p = toCanvas(e);
      if (!p) return;
      rectDrag = { from: rectDrag.from, to: p };
      drawPreview(selection(), tool === "erase");
      return;
    }
    trackCursor(e);
    if (panning && lastClient) {
      pan = { x: pan.x + (e.clientX - lastClient.x), y: pan.y + (e.clientY - lastClient.y) };
      lastClient = { x: e.clientX, y: e.clientY };
      return;
    }
    if (!drawing || !live) return;
    const p = toCanvas(e);
    if (!p) return;
    const from = live.pts.length;
    // 两个事件位置之间补点：拖得快时浏览器只给三五个位置，直接落圆就是虚线
    const prev = live.pts[from - 1];
    live.pts.push(...strokePoints(prev, p, live.r));
    const m = ctx(maskCanvas);
    const k = ctx(inkCanvas);
    if (m && k) apply(m, k, live, from);
  }

  function onUp(e: PointerEvent) {
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (rectDrag) {
      const rect = selection();
      rectDrag = null;
      drawPreview(null, tool === "erase");
      // 手抖拖出一两个像素不算一次操作：不进笔迹栈，也就不占一步撤销
      if (!maskRectIsReal(rect) || !rect) return;
      const stroke: Stroke = { op: tool, r: 0, pts: [], rect };
      strokes = [...strokes, stroke];
      undone = [];
      commitRect(rect, tool);
      return;
    }
    panning = false;
    lastClient = null;
    if (!drawing || !live) return;
    drawing = false;
    strokes = [...strokes, live];
    live = null;
    const m = ctx(maskCanvas);
    if (m) recount(m);
    if (undone.length) undone = [];
  }

  function undo() {
    if (!strokes.length) return;
    const last = strokes[strokes.length - 1];
    strokes = strokes.slice(0, -1);
    undone = [...undone, last].slice(-MASK_REDO_LIMIT);
    redraw();
  }

  function redo() {
    if (!undone.length) return;
    const back = undone[undone.length - 1];
    undone = undone.slice(0, -1);
    strokes = [...strokes, back];
    redraw();
  }

  function clearAll() {
    if (!strokes.length && !seedImg) return;
    rectDrag = null;
    strokes = [];
    undone = [];
    seedImg = null;
    drawPreview(null, false);
    redraw();
  }

  /** Ctrl+滚轮改笔刷：画遮罩时手一直在画布上，让人去点滑杆等于打断他 */
  function onWheel(e: WheelEvent) {
    if (e.ctrlKey) {
      setBrush(brush + (e.deltaY < 0 ? 4 : -4));
      return;
    }
    const k = Math.exp(-e.deltaY * 0.0016);
    zoom = Math.min(12, Math.max(0.2, zoom * k));
  }

  function setBrush(next: number) {
    brush = Math.min(MASK_BRUSH_MAX, Math.max(MASK_BRUSH_MIN, Math.round(next)));
  }

  function setInk(next: number) {
    ink = Math.min(MASK_INK_MAX, Math.max(MASK_INK_MIN, next));
    redraw();
  }

  function zoomBy(delta: number) {
    zoom = Math.min(12, Math.max(0.2, zoom + delta));
  }

  function fitView() {
    zoom = 1;
    pan = { x: 0, y: 0 };
  }

  /** 双击：100%（一个画布像素＝一个屏幕像素）⇄ 适应窗口来回切 */
  function toggleRealSize() {
    const real = 1 / (fit || 1);
    if (zoom >= real * 0.995) fitView();
    else zoom = real;
  }

  function onKeyDown(e: KeyboardEvent) {
    const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
      return;
    }
    if (typing) return;
    // 空格＝临时抓手：画遮罩最常做的两件事是涂和挪，这两个键位与图库放大层一致
    if (e.code === "Space") {
      e.preventDefault();
      handing = true;
      return;
    }
    if (e.key.toLowerCase() === "b") tool = "paint";
    else if (e.key.toLowerCase() === "e") tool = "erase";
    else if (e.key === "+" || e.key === "=") zoomBy(0.25);
    else if (e.key === "-") zoomBy(-0.25);
    else if (e.key === "0") fitView();
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.code === "Space") handing = false;
  }

  function finish() {
    const m = maskCanvas;
    const k = inkCanvas;
    if (!m || !k) {
      onDone(null);
      return;
    }
    if (isMaskEmpty(painted)) {
      onDone(null);
      return;
    }
    // 三步推出黑白：铺黑 → 把涂过的地方擦成透明 → 从底下垫白。
    // 为什么绕这一圈：编辑器只看 alpha（颜色随便换都不该改变提交的东西），
    // 后端要的是「白＝要改」的灰度图。逐像素循环在 4096 像素上要卡手，这三步是原生路径。
    const out = document.createElement("canvas");
    out.width = m.width;
    out.height = m.height;
    const c = out.getContext("2d");
    if (!c) {
      onDone(null);
      return;
    }
    c.fillStyle = "rgb(0, 0, 0)";
    c.fillRect(0, 0, out.width, out.height);
    c.globalCompositeOperation = "destination-out";
    c.drawImage(m, 0, 0);
    c.globalCompositeOperation = "destination-over";
    c.fillStyle = "rgb(255, 255, 255)";
    c.fillRect(0, 0, out.width, out.height);
    onDone({
      coverage: m.toDataURL("image/png"),
      png: stripDataUrl(out.toDataURL("image/png")),
      tint: k.toDataURL("image/png"),
      pixels: paintedSource,
      imageId,
    });
  }

  onMount(() => {
    rootEl?.focus();
    const img = new Image();
    img.onload = async () => {
      size = maskCanvasSize(img.naturalWidth || 1, img.naturalHeight || 1);
      ready = true;
      await tick();
      measure();
      if (seed) {
        const old = new Image();
        old.onload = async () => {
          seedImg = old;
          await tick();
          redraw();
        };
        old.src = seed;
      } else {
        redraw();
      }
    };
    img.src = src;
    if (typeof ResizeObserver === "function" && viewport) {
      const ro = new ResizeObserver(() => measure());
      ro.observe(viewport);
      return () => ro.disconnect();
    }
  });
</script>

<div class="me" role="dialog" aria-label={`编辑${label}的遮罩`} tabindex="-1"
  bind:this={rootEl} use:modalFocus onkeydown={onKeyDown} onkeyup={onKeyUp}>
  <header class="me-top">
    <div class="me-line">
      <span class="me-what"><Icon name="mask" size={14} />{label} · 遮罩</span>
      <span class="me-mode">{modeText}</span>
      <span class="me-prompt" title={promptSummary}>{promptSummary}</span>
      <span class="me-count" class:is-none={emptyMask}>{emptyMask ? "还没涂" : `已涂 ${paintedSource.toLocaleString("zh-CN")} 处像素`}</span>
    </div>
    <p class="me-hint">{hint || "左键涂、Shift+左键拖一个框圈住一整块；E 换橡皮，没涂的地方一个字都不动。"}</p>
  </header>

  <div class="me-view" class:is-hand={handing} class:is-erase={tool === "erase"}
    bind:this={viewport}
    onwheel={onWheel}
    onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointercancel={onUp}
    onpointerleave={() => (cursor = null)}
    ondblclick={toggleRealSize}>
    {#if ready}
      <div class="me-stage" bind:this={stageEl} style={stageStyle}>
        <img class="me-ref" {src} alt="" draggable="false" />
        <canvas class="me-ink" bind:this={inkCanvas} width={size.width} height={size.height}></canvas>
        <!-- 框选拖动中的预览：遮罩本体在松手之前一个字都没动 -->
        <canvas class="me-live" bind:this={liveCanvas} width={size.width} height={size.height} aria-hidden="true"></canvas>
        <!-- 真正的遮罩只在这张看不见的画布上：显示那层是它的红色副本 -->
        <canvas class="me-mask" bind:this={maskCanvas} width={size.width} height={size.height} aria-hidden="true"></canvas>
      </div>
      {#if cursor && !handing}
        <span class="me-dab" style={cursorStyle} aria-hidden="true"></span>
      {/if}
    {:else}
      <p class="me-load">正在读这张参考图…</p>
    {/if}
  </div>

  <footer class="me-bar">
    <div class="me-group" role="group" aria-label="工具">
      <button class="me-btn" class:is-on={tool === "paint"} aria-pressed={tool === "paint"}
        title="画笔（B）：涂上的地方＝要改的地方" onclick={() => (tool = "paint")}>画笔</button>
      <button class="me-btn" class:is-on={tool === "erase"} aria-pressed={tool === "erase"}
        title="橡皮（E）：擦掉涂错的地方" onclick={() => (tool = "erase")}>橡皮</button>
      <button class="me-btn" disabled={!strokes.length} title="撤销（Ctrl+Z）" onclick={undo}>撤销</button>
      <button class="me-btn" disabled={!undone.length} title="重做（Ctrl+Y）" onclick={redo}>重做</button>
      <button class="me-btn" disabled={!strokes.length && !seed} title="全部清掉，从空白重画" onclick={clearAll}>清空</button>
    </div>

    <label class="me-slider">
      <span>粗细</span>
      <input type="range" min={MASK_BRUSH_MIN} max={MASK_BRUSH_MAX} step={1} bind:value={brush}
        aria-label="笔刷粗细（源图像素）" title="画笔直径，按原图像素算；Ctrl+滚轮也能改" />
      <b>{brush}</b>
    </label>

    <label class="me-slider">
      <span>叠色</span>
      <input type="range" min={MASK_INK_MIN} max={MASK_INK_MAX} step={0.05} bind:value={ink}
        aria-label="红色叠层不透明度" oninput={() => setInk(ink)} title="只是让你看得清，不影响送给 ComfyUI 的遮罩" />
      <b>{Math.round(ink * 100)}%</b>
    </label>

    <div class="me-group" role="group" aria-label="缩放">
      <button class="me-btn" title="缩小（-）" onclick={() => zoomBy(-0.25)}>－</button>
      <span class="me-zoom">{percent}%</span>
      <button class="me-btn" title="放大（+）" onclick={() => zoomBy(0.25)}>＋</button>
      <button class="me-btn" title="回到适应窗口（0）" onclick={fitView}>适应</button>
      <button class="me-btn" title="100%：一个像素就是一个像素" onclick={toggleRealSize}>100%</button>
    </div>

    <div class="me-group me-actions">
      <button class="me-btn" onclick={onCancel}>取消</button>
      <button class="me-btn me-btn-go" onclick={finish}>完成</button>
    </div>
  </footer>
</div>

<style>
  /* 盖住整层弹窗（2026-11-12 定稿）：它是 .cm-panel 的兄弟、.cm-backdrop 的孩子，
     inset:0 连 backdrop 那 20px 内边距一起盖住——画遮罩要的是整块地方，不该在底下留一条缝。
     z-index 取 7（2026-11-12 真机走查后从 2 提上来）：.cm-panel 只有 position:relative、没有 z-index，
     不成 layer，所以它那条 sticky 底栏（.cm-dock 3）、工作流弹层（.cm-pop-scrim 4、.cm-pop 5）和那颗
     生成钮（.cm-actions 6）都是跟编辑层直接比大小的——留在 2 的时候底栏连那颗红色「生成」还露在画布
     上面，看着像在画遮罩，手一抖就是一次真跑图。7 压过弹窗里的全部，只把悬停放大那张 .cm-ref-zoom(9)
     让在外面：画遮罩时鼠标不碰参考图那一排，它本来也不会出现。 */
  .me {
    position: absolute; inset: 0; z-index: 7; display: flex; flex-direction: column; gap: 8px;
    padding: 12px 14px; background: var(--ink-0); color: var(--text-1);
    font-size: var(--fs-sm); outline: none;
  }
  .me-top { display: flex; flex-direction: column; gap: 4px; flex: none; }
  .me-line { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
  .me-what { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-base); font-weight: 650; }
  .me-mode {
    padding: 2px 8px; border-radius: var(--r-pill); background: var(--ink-3);
    color: var(--text-1); font-size: var(--fs-xs);
  }
  .me-prompt {
    min-width: 0; max-width: 46ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--text-2); font-size: var(--fs-xs);
  }
  .me-count { margin-left: auto; color: var(--text-2); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
  .me-count.is-none { color: var(--warn); }
  .me-hint { margin: 0; color: var(--text-2); font-size: var(--fs-xs); }

  .me-view {
    position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    background: var(--ink-1); border: 1px solid var(--line); border-radius: var(--r-2);
    cursor: crosshair; touch-action: none;
  }
  .me-view.is-hand { cursor: grab; }
  .me-view.is-erase { cursor: cell; }
  .me-stage {
    position: relative; flex: none; transform-origin: center center;
    will-change: transform; user-select: none;
  }
  .me-ref, .me-ink, .me-live, .me-mask {
    position: absolute; inset: 0; width: 100%; height: 100%; display: block;
  }
  .me-ref { position: relative; pointer-events: none; }
  .me-ink { pointer-events: none; }
  .me-live { pointer-events: none; }
  /* 看不见的那张才是遮罩本体：显示用的是它的红色副本 */
  .me-mask { visibility: hidden; }
  .me-dab {
    position: absolute; transform: translate(-50%, -50%); border-radius: var(--r-pill);
    border: 1px solid rgb(255 255 255 / 70%); pointer-events: none;
  }
  .me-load { color: var(--text-2); }

  .me-bar {
    flex: none; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 6px 0 0; border-top: 1px solid var(--line-soft);
  }
  .me-group { display: inline-flex; align-items: center; gap: 4px; }
  .me-btn {
    height: var(--ctl-sm); min-width: 24px; padding: 0 10px; border-radius: var(--r-1);
    background: var(--ink-3); color: var(--text-1); font-size: var(--fs-sm);
    border: 1px solid transparent; cursor: pointer;
  }
  .me-btn:hover:not(:disabled) { background: var(--ink-4); }
  .me-btn:disabled { color: var(--text-3); cursor: default; }
  .me-btn.is-on { background: var(--accent); color: var(--accent-ink); }
  .me-btn-go { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
  .me-btn-go:hover { background: var(--accent-strong); }
  .me-zoom { min-width: 44px; text-align: center; color: var(--text-1); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
  .me-slider { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); font-size: var(--fs-xs); }
  .me-slider input { width: 96px; height: 24px; accent-color: var(--accent); }
  .me-slider b { min-width: 34px; color: var(--text-1); font-weight: 500; font-variant-numeric: tabular-nums; }
  .me-actions { margin-left: auto; }
</style>