<script lang="ts">
  /**
   * 遮罩编辑器：盖住整个再次创作弹窗的一层编辑面，画完交回一份「白＝要改的地方」的遮罩。
   *
   * 四条设计定了就不动摇：
   * 1. 画布只看 alpha（涂没涂到），给人看的那一层是它现染出来的副本，不是第二份事实（paintInk）。
   *    提交那份黑白图在导出时按 alpha 现推，所以「换个颜色」「调叠色不透明度」永远不会悄悄改变
   *    送给 ComfyUI 的东西；反过来，这一层的颜色必须跟工作流盖给模型看的那份一致（lib/mask.ts），
   *    不然人在屏幕上涂红、模型收到绿，照屏幕理解指令必然对不上。
   * 2. 撤销不存像素快照：一张 2048² 的 RGBA 快照就是 16MB，存 40 步等于一次编辑器吃 600MB 内存。
   *    这里存笔迹、要重画时整条重放一遍，画布操作是原生路径，几十笔也就几毫秒。
   * 3. 手势与图库放大层对齐：滚轮缩放、Ctrl+滚轮改笔刷、双击 100%⇄适应、空格临时抓手、
   *    B/E/S 换工具、Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y、+−0。左键归画笔，所以平移只能靠空格（或中键）。
   *    框选那几件的键位照孤海那台编辑器（图2）：选框是一件工具，Shift=1:1 与加选区，Alt=减选区，
   *    谁算框选、算加还是算减全在 lib/mask.ts 的 maskRectOp 里判，那儿有测试。
   * 4. 框是「拖出来先悬着」，不是松手就焊死：选框工具下拖完那一框只在预览层上，
   *    按在框里拖可以挪（图2「框内拖动移动」），在框外单击就撤掉（「外部单击取消」），
   *    开始下一框／换工具／保存遮罩时才落进遮罩层。画笔态的 Shift/Alt 框照旧松手即落——
   *    那是涂到一半顺手圈一块的快捷法，不该被挂住。两种框在松手前都不进遮罩，
   *    从右下角往回拖、拖过头直接松开都不留痕迹。
   *
   * 规则（画布尺寸、补间、多少像素算没画、导出格式）全在 lib/mask.ts，那儿有测试；这层只管画。
   */
  import { onMount, tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { modalFocus } from "../lib/modal-focus";
  import {
    MASK_BRUSH_DEFAULT, MASK_BRUSH_MAX, MASK_BRUSH_MIN, MASK_INK_DEFAULT, MASK_INK_MAX, MASK_INK_MIN,
    MASK_REDO_LIMIT, MASK_TINTS, MASK_TINT_DEFAULT, countMaskPixels, isMaskEmpty, maskBrushRadius,
    maskCanvasScale, maskCanvasSize, maskCloseTolerance, maskEnclosedPolygon, maskIsClick,
    maskMinEnclosedArea, maskPixelsInSource, maskRectContains, maskRectIsReal, maskRectMove,
    maskRectOp, maskRectSelect, maskSquareSelect, maskTintRgb, strokePoints, stripDataUrl,
    type MaskEdit, type MaskOp, type MaskPoint, type MaskRect, type MaskTool,
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

  type Tool = MaskTool;
  type Op = MaskOp;
  /** 一笔要么是画笔涂的一条线，要么是框出来的一块（有 rect 就按块算，pts 留空），
   *  要么是一次「反转」——它也得进笔迹栈，不然撤销一次就把反转吞了。 */
  interface Stroke {
    op: Op;
    r: number;
    pts: MaskPoint[];
    rect?: MaskRect;
    invert?: boolean;
    /** 这一笔涂到闭合时圈里要填的那圈点（松手那一刻判的，见 maskEnclosedPolygon）；
     *  没闭合就没有这个键。它跟着笔迹进栈，所以撤销/重做/反转重放都填得出来。 */
    fill?: MaskPoint[];
  }

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
  /** 色板：只换给人看这一层的颜色，送出去的遮罩与模型看到的染色都不跟着变 */
  let tintId = $state(MASK_TINT_DEFAULT);
  const tintRgb = $derived(maskTintRgb(tintId));
  let strokes = $state<Stroke[]>([]);
  /** 重做栈要和撤销栈一样是状态：底栏那颗「重做」的 disabled 读它，
   *  写成普通 let 的话编译器只算一次，撤销完重做还是灰的、永远点不着。 */
  let undone = $state<Stroke[]>([]);
  let painted = $state(0);
  let handing = $state(false);
  let drawing = false;
  /** 拖框中的草稿：两个对角、加还是减、是新框还是在挪已有那框（挪时 base 是原框）、Shift 是否锁了 1:1 */
  let rectDrag: {
    from: MaskPoint; to: MaskPoint; op: Op; square: boolean;
    mode: "new" | "move"; base: MaskRect | null;
  } | null = null;
  /** 选框工具拖出来、还没落进遮罩的那一框：可以接着挪，也可以在框外单击撤掉（图2 的用法） */
  let pending: { rect: MaskRect; op: Op } | null = null;
  /** 上面那一框存不存在要给界面看（撤销/清空按钮的 disabled 读它），所以必须是 $state；
   *  pending 本身只给逻辑读，写成普通 let——模板里读普通 let 是这个仓库明令禁止的（有护栏测试）。
   *  两个值同生同灭，只在 commitPending / cancelPending / 拖框那两处成对改。 */
  let hasPending = $state(false);
  /** 反转要一整层的像素反相，借一张临时画布中转（复用，别每步新建） */
  let scratch: HTMLCanvasElement | null = null;
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

  /** 框出来的那块一次成形、硬边：圈整件东西时硬边比软边准 */
  function block(c: CanvasRenderingContext2D, color: string, alpha: number, op: Tool, rect: MaskRect) {
    c.save();
    c.globalAlpha = op === "erase" ? 1 : alpha;
    c.globalCompositeOperation = op === "erase" ? "destination-out" : "source-over";
    c.fillStyle = color;
    c.fillRect(rect.x, rect.y, rect.width, rect.height);
    c.restore();
  }

  /** 把闭合那一圈填进遮罩层：只写遮罩层，给人看的那层照旧从它派生，
   *  所以填出来的必然与笔迹同色同浓度，不会又冒出第三种样子（见 paintInk 那条护栏）。
   *  canvas 默认非零绕数：圈里全算、圈外不算。橡皮闭合同样对称——圈里挖空。 */
  function fillPoly(c: CanvasRenderingContext2D, op: Op, ring: MaskPoint[]) {
    if (ring.length < 3) return;
    c.save();
    c.globalAlpha = 1;
    c.globalCompositeOperation = op === "erase" ? "destination-out" : "source-over";
    c.fillStyle = "rgb(255, 255, 255)";
    c.beginPath();
    c.moveTo(ring[0].x, ring[0].y);
    for (let i = 1; i < ring.length; i += 1) c.lineTo(ring[i].x, ring[i].y);
    c.closePath();
    c.fill();
    c.restore();
  }

  /** 把悬着的那一框落进遮罩层（选框工具拖完的框先悬着，到这里才算数） */
  function commitPending() {
    if (!pending) return;
    const { rect, op } = pending;
    pending = null;
    hasPending = false;
    strokes = [...strokes, { op, r: 0, pts: [], rect }];
    undone = [];
    commitRect(rect, op);
  }

  /** 撤掉悬着的那一框：它一个字都没进遮罩，所以撤掉不需要撤销 */
  function cancelPending() {
    if (!pending) return;
    pending = null;
    hasPending = false;
    drawPreview(null, false);
  }

  /** 松手那一刻：把这块落进遮罩层，再照着遮罩层重染一层给人看 */
  function commitRect(rect: MaskRect, op: Op) {
    const m = ctx(maskCanvas);
    if (!m) return;
    block(m, "rgb(255, 255, 255)", 1, op, rect);
    recount(m);
    paintInk();
  }

  /** 悬着/拖动中的那一框只画在第三张画布上，**只画框不填充**（图2 就是这样的）：
   *  这一框还没落进遮罩，填上一层会让人分不清哪块已经算了、哪块还在挑，
   *  而且填充会挡住要看的画面。加与减靠「深浅两层虚线换位」区分，不靠颜色：
   *  加＝暗底 + 白虚线，减＝白底 + 暗虚线，压在亮处暗处都看得见。 */
  function drawPreview(rect: MaskRect | null, erasing: boolean) {
    const c = ctx(liveCanvas);
    if (!c) return;
    c.clearRect(0, 0, size.width, size.height);
    if (!rect) return;
    // 画布会被 fit×zoom 缩到屏幕上，线宽先除回去，屏上看永远是 2px 那一圈
    const lw = 2 / Math.max(0.02, fit * zoom);
    const dark = "rgb(20, 20, 24)";
    const light = "rgb(255, 255, 255)";
    c.save();
    c.globalAlpha = 1;
    c.lineWidth = lw;
    c.setLineDash([]);
    c.strokeStyle = erasing ? light : dark;
    c.strokeRect(rect.x, rect.y, rect.width, rect.height);
    c.lineWidth = lw * 0.8;
    c.setLineDash([lw * 4, lw * 3]);
    c.strokeStyle = erasing ? dark : light;
    c.strokeRect(rect.x, rect.y, rect.width, rect.height);
    c.restore();
  }

  /** 当前这一框在画布上的位置：Shift 锁 1:1，往回拖、拖出画面都归一成正放矩形；
   *  挪已有那框时以悬着的那框为准（它已经算好了，别再从两个对角反推） */
  function selection(): MaskRect | null {
    if (!rectDrag) return null;
    if (rectDrag.mode === "move") return pending ? pending.rect : null;
    return rectDrag.square
      ? maskSquareSelect(rectDrag.from, rectDrag.to, size.width, size.height)
      : maskRectSelect(rectDrag.from, rectDrag.to, size.width, size.height);
  }

  /** 一笔只落进遮罩层：涂白（只有 alpha 算数），橡皮挖空。给人看的那层不在这里画——
   *  它是遮罩层的染色副本，见 paintInk()。早先两层一起涂时同一条笔画上的圆点互相叠，
   *  0.45 叠三五层就成实心，而框选只叠一层，画笔和框就给出了两种浓度。 */
  function apply(m: CanvasRenderingContext2D, s: Stroke, from = 0) {
    if (s.rect) {
      block(m, "rgb(255, 255, 255)", 1, s.op, s.rect);
      return;
    }
    dab(m, "rgb(255, 255, 255)", 1, s.op, s.r, from > 0 ? s.pts.slice(from) : s.pts);
    // 填充只属于「整笔」：撤销重放、换显示色、反转之后重画都要照填，
    // 但拖动中那截增量补点（from > 0）不能重复填一次。
    if (s.fill && from === 0) fillPoly(m, s.op, s.fill);
  }

  /** 上一次的遮罩落进遮罩层（种子那份只有 alpha 有用），给人看的那层随后由它派生 */
  function drawSeed(m: CanvasRenderingContext2D) {
    if (!seedImg) return;
    m.drawImage(seedImg, 0, 0, size.width, size.height);
  }

  /** 给人看的那一层 = 遮罩层现染出来的副本：整层拷过去时按 ink 压一次浓度，再 source-in 换成
   *  MASK_INK_RGB。source-in 的结果 alpha = 源 alpha × 目标 alpha，所以颜色换得掉、浓度不会再
   *  被乘第二遍。这样浓淡只由「涂没涂到」决定：叠多少笔、叠几块都一样，橡皮挖掉的地方自动跟着没。
   *  以前是每笔往这一层各叠一次 alpha，重叠处一路加深，画笔/选框/遮罩区给出三种浓度。
   *  颜色取色板 tintRgb，默认那颗就是工作流盖给模型看的绿（lib/mask.ts 里钉着）。 */
  function paintInk() {
    const m = maskCanvas;
    const k = ctx(inkCanvas);
    if (!m || !k) return;
    k.save();
    k.clearRect(0, 0, size.width, size.height);
    k.globalAlpha = ink;
    k.drawImage(m, 0, 0);
    k.globalCompositeOperation = "source-in";
    k.globalAlpha = 1;
    k.fillStyle = `rgb(${tintRgb})`;
    k.fillRect(0, 0, size.width, size.height);
    k.restore();
  }

  /** 画笔一拖每秒几十个事件，而重染是整层合成（4096 那一档不便宜），合并到下一帧只做一次。
   *  redraw/finish 里同步补一次，交图那一刻不会停在上一帧。 */
  let inkScheduled = false;
  function syncInk() {
    if (inkScheduled) return;
    inkScheduled = true;
    const run = () => {
      inkScheduled = false;
      paintInk();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /** 把遮罩层整层反相：涂过的地方变成没涂，没涂的变成涂了（图2 那颗「反转」）。
   *  绕一张临时画布走原生路径：铺白 → 把现在这块擦掉 → 盖回遮罩层。
   *  逐像素循环在 4096² 上要卡手，和导出黑白那三步是同一个理由。 */
  function invertLayer(m: CanvasRenderingContext2D) {
    if (!scratch) scratch = document.createElement("canvas");
    const el = scratch;
    if (el.width !== size.width || el.height !== size.height) {
      el.width = size.width;
      el.height = size.height;
    }
    const s = el.getContext("2d");
    if (!s) return;
    s.save();
    s.globalCompositeOperation = "source-over";
    s.clearRect(0, 0, el.width, el.height);
    s.fillStyle = "rgb(255, 255, 255)";
    s.fillRect(0, 0, el.width, el.height);
    s.globalCompositeOperation = "destination-out";
    if (maskCanvas) s.drawImage(maskCanvas, 0, 0);
    s.restore();
    m.save();
    m.globalCompositeOperation = "source-over";
    m.clearRect(0, 0, size.width, size.height);
    m.drawImage(el, 0, 0);
    m.restore();
  }

  /** 反转：先把手上那一框落进去再反，不然刚圈的那块会被反相吞掉。
   *  反转本身进笔迹栈，所以撤销一次就退回反转之前。 */
  function invertMask() {
    if (emptyMask) return;
    commitPending();
    const m = ctx(maskCanvas);
    if (!m) return;
    strokes = [...strokes, { op: "paint", r: 0, pts: [], invert: true }];
    undone = [];
    redraw();
  }

  /** 整条重放：撤销、重做、清空、反转、改叠色/换色都走这一条，不存像素快照 */
  function redraw() {
    const m = ctx(maskCanvas);
    if (!m) return;
    m.clearRect(0, 0, size.width, size.height);
    drawSeed(m);
    for (const s of strokes) {
      if (s.invert) invertLayer(m);
      else apply(m, s);
    }
    recount(m);
    paintInk();
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
    // 选框工具下按在已选那一框里面＝挪动它，不是重画一框（图2「框内拖动移动」）。
    // Alt 除外：按住 Alt 是「减一块」的起手，不该被挪框抢走。
    if (e.button === 0 && !e.altKey && pending && tool === "select") {
      const hit = toCanvas(e);
      if (hit && maskRectContains(pending.rect, hit)) {
        rectDrag = { from: hit, to: hit, op: pending.op, square: false, mode: "move", base: pending.rect };
        cursor = null;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        e.preventDefault();
        return;
      }
    }
    // 框选：选框工具下左键就画框；画笔/橡皮下要按 Shift（加）或 Alt（减）。
    // 松手之前它一个字都没进遮罩，所以拖过头直接松开就行；圈多了也不必擦干净重画。
    const rectOp = e.button === 0 ? maskRectOp(e, tool) : null;
    if (rectOp) {
      const from = toCanvas(e);
      if (!from) return;
      // 上一框还悬着 → 先落进遮罩，这一拖是下一框（屏上同时只留一框，和图2 一样）
      commitPending();
      rectDrag = { from, to: from, op: rectOp, square: false, mode: "new", base: null };
      cursor = null; // 拖动中笔刷圈没有意义，藏掉
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const p = toCanvas(e);
    if (!p) return;
    // 开始正常涂画：悬着那一框先落定，别让它悬在画面上不明不白
    commitPending();
    drawing = true;
    // 走到这儿工具只可能是画笔或橡皮（选框在上面那支就返回了），但 TS 看不出来，明说一次
    const op: Op = tool === "erase" ? "erase" : "paint";
    const start: Stroke = { op, r: maskBrushRadius(brush, size.width, sourceWidth), pts: [p] };
    live = start;
    undone = [];
    const m = ctx(maskCanvas);
    if (m) apply(m, start);
    paintInk(); // 点一下也要立刻看见，这一处不排队
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onMove(e: PointerEvent) {
    if (rectDrag) {
      const p = toCanvas(e);
      if (!p) return;
      if (rectDrag.mode === "move" && rectDrag.base) {
        // 位移＝这一帧的鼠标位置减起笔位置，框本身不放大不缩小
        const moved = maskRectMove(
          rectDrag.base, p.x - rectDrag.from.x, p.y - rectDrag.from.y, size.width, size.height,
        );
        pending = { rect: moved, op: rectDrag.op };
        hasPending = true;
        drawPreview(moved, rectDrag.op === "erase");
        return;
      }
      // Shift 是当场生效的：按住锁 1:1，松开就恢复自由矩形（图2 那句 Shift=1:1）
      rectDrag = { from: rectDrag.from, to: p, op: rectDrag.op, square: e.shiftKey, mode: "new", base: null };
      drawPreview(selection(), rectDrag.op === "erase");
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
    if (m) apply(m, live, from);
    syncInk();
  }

  function onUp(e: PointerEvent) {
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (rectDrag) {
      const drag = rectDrag;
      const rect = selection();
      rectDrag = null;
      if (drag.mode === "move") {
        // 挪完了还悬着，等下一次操作落定；框保持画出来，让人看得见它还在挑
        if (pending) drawPreview(pending.rect, pending.op === "erase");
        return;
      }
      drawPreview(null, false);
      // 图2「外部单击取消」：什么都没拖出来、只是点了一下 → 把悬着那一框撤掉
      if (maskIsClick(drag.from, drag.to)) {
        cancelPending();
        return;
      }
      // 手抖拖出一两个像素不算一次操作：不进笔迹栈，也就不占一步撤销
      if (!maskRectIsReal(rect) || !rect) return;
      if (tool === "select") {
        // 选框工具：加与减都先悬着，让人接着挪 / 取消，到下一框或保存时才落进遮罩
        pending = { rect, op: drag.op };
        hasPending = true;
        drawPreview(rect, drag.op === "erase");
        return;
      }
      // 画笔/橡皮态按 Shift/Alt 拖的框：老口径，松手即落
      strokes = [...strokes, { op: drag.op, r: 0, pts: [], rect }];
      undone = [];
      commitRect(rect, drag.op);
      return;
    }
    panning = false;
    lastClient = null;
    if (!drawing || !live) return;
    drawing = false;
    const stroke = live;
    live = null;
    // 松手这一下才判闭合（拖到一半谁也不知道你要不要合上）：合上了就把圈里填进遮罩层。
    // 圈外那截带子照旧留着，所以填完的形状＝圈里 + 你画的那条边。
    const ring = maskEnclosedPolygon(
      stroke.pts,
      maskCloseTolerance(stroke.r, size.width, size.height),
      maskMinEnclosedArea(stroke.r, size.width, size.height),
    );
    if (ring) stroke.fill = ring;
    strokes = [...strokes, stroke];
    const m = ctx(maskCanvas);
    if (m) {
      if (ring) fillPoly(m, stroke.op, ring);
      recount(m);
    }
    if (ring) paintInk(); // 填了老大一块，当场就得看见，不排到下一帧
    if (undone.length) undone = [];
  }

  function undo() {
    // 屏上还悬着一框时，撤销先把它撤掉——它就是「最近那一下」，而且它还没进遮罩
    if (pending) {
      cancelPending();
      return;
    }
    if (!strokes.length) return;
    const last = strokes[strokes.length - 1];
    strokes = strokes.slice(0, -1);
    undone = [...undone, last].slice(-MASK_REDO_LIMIT);
    redraw();
  }

  function redo() {
    if (pending) {
      cancelPending();
      return;
    }
    if (!undone.length) return;
    const back = undone[undone.length - 1];
    undone = undone.slice(0, -1);
    strokes = [...strokes, back];
    redraw();
  }

  function clearAll() {
    if (!strokes.length && !seedImg && !pending) return;
    rectDrag = null;
    pending = null;
    hasPending = false;
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

  /** 换工具前先把悬着那一框落定：切到画笔却还剩着一框悬着，比谁都容易看错算什么 */
  function pickTool(next: Tool) {
    if (next === tool) return;
    commitPending();
    tool = next;
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
    // Alt 是「减一块」的修饰键，按住它时那一下是鼠标操作，不该顺手把 B/E/0 这类快捷键也触发
    if (e.altKey) return;
    // 空格＝临时抓手：画遮罩最常做的两件事是涂和挪，这两个键位与图库放大层一致
    if (e.code === "Space") {
      e.preventDefault();
      handing = true;
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      commitPending();
      return;
    }
    if (e.key.toLowerCase() === "b") tool = "paint";
    else if (e.key.toLowerCase() === "e") tool = "erase";
    else if (e.key.toLowerCase() === "s") tool = "select";
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
    // 还悬着一框就先落进遮罩，不能让用户以为「框还在」＝「没算进去」
    commitPending();
    // 拖动时重染排到了下一帧，交图之前先补一次，免得 tint 是上一帧那一层的
    paintInk();
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
      <div class="me-group" role="group" aria-label="工具">
        <button class="me-btn" class:is-on={tool === "paint"} aria-pressed={tool === "paint"}
          title="画笔（B）：涂上的地方＝要改的地方；涂一圈回到起点，松手自动把中间填上" onclick={() => pickTool("paint")}>画笔</button>
        <button class="me-btn" class:is-on={tool === "erase"} aria-pressed={tool === "erase"}
          title="橡皮擦（E）：擦掉涂错的地方；橡皮涂一圈回到起点，松手把圈里挖空" onclick={() => pickTool("erase")}>橡皮擦</button>
        <button class="me-btn" class:is-on={tool === "select"} aria-pressed={tool === "select"}
          title="选框（S）：拖一个框圈住一整块；拖完按框里可以挪，在框外单击取消"
          onclick={() => pickTool("select")}>选框</button>
      </div>
      <div class="me-group me-swatches" role="group" aria-label="遮罩显示色">
        {#each MASK_TINTS as tint (tint.id)}
          <button class="me-swatch" class:is-on={tintId === tint.id} aria-pressed={tintId === tint.id}
            style={`background: rgb(${tint.rgb})`}
            title={`遮罩显示色：${tint.label}（只换你看的这一层，送出去的遮罩与模型看到的染色都不变）`}
            aria-label={`遮罩显示色 ${tint.label}`} onclick={() => (tintId = tint.id)}></button>
        {/each}
      </div>
      <p class="me-legend">Shift=1:1／加选区 · Alt=减选区 · 框内拖动移动 · 外部单击取消</p>
      <div class="me-group" role="group" aria-label="笔迹">
        <button class="me-btn" disabled={!strokes.length && !hasPending} title="撤销（Ctrl+Z）：还悬着一框时先撤掉它" onclick={undo}>撤销</button>
        <button class="me-btn" disabled={!undone.length} title="重做（Ctrl+Y）" onclick={redo}>重做</button>
        <button class="me-btn" disabled={emptyMask} title="反转：涂过的和没涂的对调，撤销一次退回" onclick={invertMask}>反转</button>
        <button class="me-btn" disabled={!strokes.length && !seed && !hasPending} title="全部清掉，从空白重画" onclick={clearAll}>清空</button>
      </div>
      <div class="me-group me-actions" role="group" aria-label="结束">
        <button class="me-btn" onclick={onCancel}>取消</button>
        <button class="me-btn me-btn-go" onclick={finish}>保存遮罩</button>
      </div>
    </div>
    <div class="me-line">
      <span class="me-what"><Icon name="mask" size={14} />{label} · 遮罩</span>
      <span class="me-mode">{modeText}</span>
      <span class="me-prompt" title={promptSummary}>{promptSummary}</span>
      {#if hasPending}<span class="me-pending">框已选中：按框里拖可挪 · 框外单击取消 · 回车落定</span>{/if}
      <span class="me-count" class:is-none={emptyMask}>{emptyMask ? "还没涂" : `已涂 ${paintedSource.toLocaleString("zh-CN")} 处像素`}</span>
    </div>
    <p class="me-hint">{hint || "左键涂 · 涂到闭合自动填中间 · Shift+左键拖框加一块 · Alt+左键拖框减一块 · E 换橡皮 · 没涂的地方一个字都不动"}</p>
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
        <!-- 真正的遮罩只在这张看不见的画布上：上面那层是它现染出来的副本 -->
        <canvas class="me-mask" bind:this={maskCanvas} width={size.width} height={size.height} aria-hidden="true"></canvas>
      </div>
      {#if cursor && !handing}
        <span class="me-dab" style={cursorStyle} aria-hidden="true"></span>
      {/if}
    {:else}
      <p class="me-load">正在读这张参考图…</p>
    {/if}
  </div>

  <!-- 图2 那一排没有粗细／浓度／缩放，但这三样我们离不了（画笔不看见直径没法画），所以留在底栏 -->
  <footer class="me-bar">
    <label class="me-slider">
      <span>粗细</span>
      <input type="range" min={MASK_BRUSH_MIN} max={MASK_BRUSH_MAX} step={1} bind:value={brush}
        aria-label="笔刷粗细（源图像素）" title="画笔直径，按原图像素算；Ctrl+滚轮也能改" />
      <b>{brush}</b>
    </label>

    <label class="me-slider">
      <span>叠色</span>
      <input type="range" min={MASK_INK_MIN} max={MASK_INK_MAX} step={0.05} bind:value={ink}
        aria-label="遮罩叠层不透明度" oninput={() => setInk(ink)}
        title="只是让你看得清，不影响送给 ComfyUI 的遮罩；默认 40% 与工作流盖给模型看的那一层同浓度" />
      <b>{Math.round(ink * 100)}%</b>
    </label>

    <div class="me-group" role="group" aria-label="缩放">
      <button class="me-btn" title="缩小（-）" onclick={() => zoomBy(-0.25)}>－</button>
      <span class="me-zoom">{percent}%</span>
      <button class="me-btn" title="放大（+）" onclick={() => zoomBy(0.25)}>＋</button>
      <button class="me-btn" title="回到适应窗口（0）" onclick={fitView}>适应</button>
      <button class="me-btn" title="100%：一个像素就是一个像素" onclick={toggleRealSize}>100%</button>
    </div>

    <p class="me-bar-note">已涂的处数按原图像素算，与送出去的遮罩同口径</p>
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
  .me-legend {
    margin: 0 auto; color: var(--text-2); font-size: var(--fs-xs);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .me-swatches { gap: 6px; }
  .me-swatch {
    width: 24px; height: 24px; padding: 0; border-radius: var(--r-pill);
    border: 1px solid var(--line); cursor: pointer;
  }
  .me-swatch:hover { border-color: var(--text-3); }
  .me-swatch.is-on { border: 2px solid var(--accent); }
  .me-pending { color: var(--warn); font-size: var(--fs-xs); }
  .me-bar-note { margin: 0 0 0 auto; color: var(--text-2); font-size: var(--fs-xs); }

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
  /* 看不见的那张才是遮罩本体：显示那层每次由它现染（paintInk） */
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