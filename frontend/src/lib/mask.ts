/**
 * 遮罩编辑的纯逻辑：画笔与尺寸口径、笔迹补间、像素统计，以及「哪一格能画遮罩、
 * 提示词留空算不算一个模式」这些判定。
 *
 * 为什么把判定全放这一个文件：MaskEditor.svelte 里全是 canvas 与指针事件，happy-dom 不放画布，
 * 规则写进组件就等于没测。规则只有这一份，组件只负责画与拖动。
 *
 * 与后端的三条硬约定（backend/app/clone_jobs.py + 孤海 加载图像 的口径，改一头就得两头一起改）：
 * 1. 交给后端的是 base64 灰度 PNG，**白＝要改的地方**，黑＝不动。
 * 2. 编辑器自己的画布是「透明底 + 涂过的地方不透明」，涂的颜色只给人看，不参与判定；
 *    黑白那张在导出时按 alpha 现推（见 MaskEditor 里 paint黑白 那三步）。
 * 3. 长边超过 4096 后端直接拒收，所以这里先降采样再画。
 */
import { referenceCells, type CloneTemplate, type RefCell } from "./clone";

/** 后端 MAX_MASK_EDGE，两边必须同一个数 */
export const MASK_EDGE_LIMIT = 4096;
export const MASK_BRUSH_MIN = 6;
export const MASK_BRUSH_MAX = 200;
export const MASK_BRUSH_DEFAULT = 60;
export const MASK_INK_MIN = 0.15;
export const MASK_INK_MAX = 0.8;
/** 默认浓度对齐随包工作流里 204 孤海-图像合并（遮罩）那颗「透明度 0.4」：
 *  不去拖滑杆时，屏幕上这一层就是模型真看到的那一层。滑杆只负责让人看得清。 */
export const MASK_INK_DEFAULT = 0.4;
/**
 * 叠在参考图上给人看的那一层，跟随包工作流盖给模型看的那份**同一个绿**：
 * 204 把 205 LayerUtility: ColorImage 的 #00ff00 按 40% 盖在遮罩区域上，118 那句写的是
 * 「移除图像中的绿色区域」（backend/tests/test_clone_bundled.py 钉死这两处同色）。
 * 这层以前是红的（255, 59, 92），于是「屏幕上涂红、模型收到绿」，照屏幕理解指令必然对不上
 * ——2026-11-12 苏醒两次指出这件事，第二次把它改成同色了。要动颜色得连 205/118 一起动，
 * 见 materials/43-mask-edit-contract.md §9 与 §11。
 * 写成 rgb(...) 而不是裸 hex：design-tokens.test.ts 的 hex 棘轮连 script 里的画布颜色一起数。
 * 它就是下面色板 MASK_TINTS 第一颗；色板只是换「给人看的这一层」的颜色，这颗默认值不许动。
 */
export const MASK_INK_RGB = "0, 255, 0";

/** 顶栏那颗色板：只换「给人看的这一层」用什么色，改不了工作流盖给模型的染色。 */
export interface MaskTint { id: string; label: string; rgb: string }
/**
 * 三颗与孤海那台编辑器的色板对齐（绿/灰/黑）。默认绿是有原因的（见上面 MASK_INK_RGB）：
 * 不点色板时屏幕上这层＝模型收到的那层。挑灰或黑只是换个看得清的颜色，模型那边不会跟着换。
 */
export const MASK_TINTS: MaskTint[] = [
  { id: "green", label: "绿", rgb: MASK_INK_RGB },
  { id: "gray", label: "灰", rgb: "214, 214, 218" },
  { id: "black", label: "黑", rgb: "0, 0, 0" },
];
export const MASK_TINT_DEFAULT = "green";

/** 色板 id → 画布用的 rgb 三元组；认不出来回默认那颗（色板以后增删也不至于画出全透明） */
export function maskTintRgb(id: string | null | undefined): string {
  return MASK_TINTS.find((t) => t.id === id)?.rgb ?? MASK_TINTS[0].rgb;
}
/** 涂到的像素少于这个数就当「没画」。不是随手挑的：孤海那台裁遮罩的节点同样把 10 像素以下当空遮罩强制成全白，
 *  我们若把它当有遮罩，用户会得到一张整幅被重绘的图，还以为自己只圈了一小块。 */
export const MASK_EMPTY_PIXELS = 10;
/** 重做栈深度：撤销掉的笔迹能捞回来这么多步，再多就不留了 */
export const MASK_REDO_LIMIT = 40;
/** 落在遮罩层上的两种动作：加一块 / 减一块。笔迹只认这两个。 */
export type MaskOp = "paint" | "erase";
/** 顶栏那三件工具：与孤海那台编辑器一样，选框是一件工具，不只是画笔的修饰键 */
export type MaskTool = "paint" | "erase" | "select";

/**
 * 这一记左键要不要框选、框出来是加还是减。返 null = 该交给画笔正常涂。
 * 与孤海那台编辑器同口径：Alt＝减选区，Shift＝加选区。
 *
 * - 选框工具下左键本来就画框，没有修饰键也算（返 paint）；Shift 那一下留给 1:1（见 maskSquareSelect）。
 * - 画笔/橡皮下必须按住修饰键才进框选，左键仍然是涂/擦——不然谁还敢正常画笔。
 * - Alt 排在最前：手里拿着画笔也能直接挖一块，不必先按 E 换工具再拖。
 */
export function maskRectOp(
  e: { shiftKey?: boolean; altKey?: boolean },
  tool: MaskTool,
): MaskOp | null {
  if (e.altKey) return "erase";
  if (tool === "select") return "paint";
  if (e.shiftKey) return tool === "erase" ? "erase" : "paint";
  return null;
}

/**
 * Shift 拖框时锁成正方形（图2 那句「Shift=1:1」）：边长取横向与纵向里短的那一个，
 * 拖动方向照原样保留（往左上拖还是往左上）。钳进画面仍然交给 maskRectSelect。
 */
export function maskSquareSelect(
  from: MaskPoint,
  to: MaskPoint,
  width: number,
  height: number,
): MaskRect {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const side = Math.min(Math.abs(dx), Math.abs(dy));
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  return maskRectSelect(from, { x: from.x + sx * side, y: from.y + sy * side }, width, height);
}

/** 这一点在不在框里（图2 那句「框内拖动移动」：按在已选的那块里是挪动，不是重画一框） */
export function maskRectContains(rect: MaskRect, p: MaskPoint): boolean {
  return (
    p.x >= rect.x && p.x <= rect.x + rect.width
    && p.y >= rect.y && p.y <= rect.y + rect.height
  );
}

/** 把框挪 dx/dy，挪不出画面（贴到边上就停下），尺寸不变 */
export function maskRectMove(
  rect: MaskRect,
  dx: number,
  dy: number,
  width: number,
  height: number,
): MaskRect {
  return {
    x: Math.min(Math.max(0, rect.x + dx), Math.max(0, width - rect.width)),
    y: Math.min(Math.max(0, rect.y + dy), Math.max(0, height - rect.height)),
    width: rect.width,
    height: rect.height,
  };
}

/** 按下与松开差不到这个数当「单击」而不是拖框——图2 那句「外部单击取消」靠它区分 */
export const MASK_CLICK_SLOP = 3;
export function maskIsClick(from: MaskPoint, to: MaskPoint, slop = MASK_CLICK_SLOP): boolean {
  return Math.abs(to.x - from.x) <= slop && Math.abs(to.y - from.y) <= slop;
}
/** 两个鼠标位置之间按笔刷半径的几分之几补一个点 */
const MASK_STEP_RATIO = 0.34;
/** 参考位能画遮罩的标记值，后端 _cell() 只发这一个值 */
export const MASK_FLAG = "alpha";

export interface MaskPoint {
  x: number;
  y: number;
}

/** 一次画完的遮罩：三样东西各管一处，存进弹窗的那格上 */
export interface MaskEdit {
  /** 透明底 + 涂过处不透明的 PNG（data URL）。编辑器重开时拿它当底，能接着改。 */
  coverage: string;
  /** 白＝要改的灰度 PNG 的 base64，提交给后端的那一份 */
  png: string;
  /** 涂过的地方染成 MASK_INK_RGB 的透明 PNG，贴在大图与参考位角上做提示 */
  tint: string;
  /** 涂到多少像素，用来判「其实没画」 */
  pixels: number;
  /** 画在哪一份参考图上。换图之后就对不上了，靠它把旧遮罩清掉。 */
  imageId: number;
}

/**
 * 画布尺寸：长边超上限才降，没超就照原图大小画。
 * 为什么要降：遮罩最后要跟参考图一样大才贴得回去，而 8000 像素的图在画布上画一笔就是几千万次像素操作，
 * 手感直接废掉；降采样丢的那点边缘精度，由工作流自己的「遮罩羽化」补回来。
 */
export function maskCanvasSize(
  width: number,
  height: number,
  limit = MASK_EDGE_LIMIT,
): { width: number; height: number } {
  const long = Math.max(width, height);
  const w = Math.max(1, Math.round(width || 1));
  const h = Math.max(1, Math.round(height || 1));
  if (!long || long <= limit) return { width: w, height: h };
  const k = limit / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}
/**
 * 遮罩编辑器底图的地址：把参考图地址里的 max 档位抬到画布上限，上限以内直接要原图。
 * cache-bust 的 v 原样留着；fit 只给 PSD 裁切用，这儿用不上，去掉。
 *
 * 为什么不能拿列表给的那个地址直接画：original_url 是 feed 用的 ?max=1024 预览，
 * 一张 1136×2016 的图进来只剩 577×1024，画布就跟着这张小图走了，两支笔的账全乱：
 * 笔刷标的「原图像素」在画布上只有一半粗，导出的遮罩又被后端拉回原图尺寸贴上去，
 * 涂出来的一条变成两倍粗、四倍面积，「已涂多少像素」跟着少报四倍。
 * 真跑过一次量出来的：编辑器说 62290，送给 ComfyUI 的那张实际是 252182。
 */
export function maskBaseImageUrl(url: string, width: number, height: number): string {
  const base = String(url || "").trim();
  if (!base) return "";
  const cut = base.indexOf("?");
  const head = cut >= 0 ? base.slice(0, cut) : base;
  const params = new URLSearchParams(cut >= 0 ? base.slice(cut + 1) : "");
  params.delete("fit");
  const long = Math.max(Math.round(width || 0), Math.round(height || 0));
  if (long > MASK_EDGE_LIMIT) params.set("max", String(MASK_EDGE_LIMIT));
  else params.delete("max");
  const qs = params.toString();
  return qs ? `${head}?${qs}` : head;
}

/** 画布相对源图缩了几倍（只会 ≤1）：笔刷粗细和像素计数都要按它换算回源图口径。 */
export function maskCanvasScale(canvasWidth: number, sourceWidth: number): number {
  const canvas = Math.max(1, Math.round(canvasWidth || 1));
  const source = Math.max(1, Math.round(sourceWidth || 0));
  return source > canvas ? canvas / source : 1;
}

/** 笔刷直径按源图像素说话：落到缩过的画布上要先缩，再取半径。 */
export function maskBrushRadius(brushPx: number, canvasWidth: number, sourceWidth: number): number {
  return Math.max(0.5, (Math.max(0, brushPx) / 2) * maskCanvasScale(canvasWidth, sourceWidth));
}

/** 画布上数出来的像素换回源图像素：线性缩 k 倍，面积就差 k 平方。 */
export function maskPixelsInSource(paintedCanvas: number, canvasWidth: number, sourceWidth: number): number {
  const painted = Math.max(0, paintedCanvas || 0);
  const k = maskCanvasScale(canvasWidth, sourceWidth);
  if (k >= 1) return Math.round(painted);
  return Math.max(painted > 0 ? 1 : 0, Math.round(painted / (k * k)));
}

/**
 * 两个事件位置之间补出中间的点。
 * 拖得快时浏览器只报两三个位置，挨着画圆就是虚线——一笔下去满是断点，用户只会以为笔刷坏了。
 * 步长按笔刷半径给：粗笔少补几点也连得上，细笔得多补几层。
 */
export function strokePoints(from: MaskPoint, to: MaskPoint, radius: number): MaskPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const step = Math.max(1, radius * MASK_STEP_RATIO);
  const n = Math.max(1, Math.ceil(dist / step));
  const out: MaskPoint[] = [];
  for (let i = 1; i <= n; i += 1) out.push({ x: from.x + (dx * i) / n, y: from.y + (dy * i) / n });
  return out;
}

/** 框出来的一块：画布坐标，左上角 + 宽高，永远正放（拖动方向随意） */
export interface MaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Shift+左键拖出来的框：两个对角换算成正放矩形，越界的部分裁进画布。
 * 从右下角往左上拖、拖出画面外，都该得到同一块地方——用户不该为浏览器给的坐标方向负责。
 */
export function maskRectSelect(
  from: MaskPoint,
  to: MaskPoint,
  width: number,
  height: number,
): MaskRect {
  const w = Math.max(1, Math.round(width || 1));
  const h = Math.max(1, Math.round(height || 1));
  const cx = (v: number) => Math.min(w, Math.max(0, Number.isFinite(v) ? v : 0));
  const cy = (v: number) => Math.min(h, Math.max(0, Number.isFinite(v) ? v : 0));
  const x0 = cx(from.x);
  const x1 = cx(to.x);
  const y0 = cy(from.y);
  const y1 = cy(to.y);
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/** 框要多大才算真框了一块：拖出去一两个像素多半是手抖，不该占一步撤销、也不该送出 4 个像素的遮罩。 */
export const MASK_RECT_MIN = 2;

export function maskRectIsReal(rect: MaskRect | null | undefined, min = MASK_RECT_MIN): boolean {
  return !!rect && rect.width >= min && rect.height >= min;
}

/**
 * 数涂到多少像素。按 alpha 数（rgba 数据每 4 个取第 4 个）：编辑器的画布是透明底，涂过才有 alpha，
 * 涂的是什么颜色不算数。
 */
export function countMaskPixels(values: ArrayLike<number>, threshold = 8): number {
  let painted = 0;
  for (let i = 3; i < values.length; i += 4) if (values[i] > threshold) painted += 1;
  return painted;
}

export function isMaskEmpty(paintedPixels: number): boolean {
  return paintedPixels < MASK_EMPTY_PIXELS;
}

/**
 * canvas.toDataURL 给的是 `data:image/png;base64,...`，后端两种都收（它自己会剥前缀），
 * 前端先剥干净：请求体小一成，日志里也好认。
 */
export function stripDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return dataUrl.startsWith("data:") && comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** 这一格能不能画遮罩：只看后端给的标记。音、视频格一律不算——工作流里没有它们的遮罩可接。 */
export function cellAcceptsMask(cell: RefCell | null | undefined): boolean {
  if (!cell || cell.kind === "audio" || cell.kind === "video") return false;
  return cell.mask === MASK_FLAG;
}

/** 这份工作流里能画遮罩的参考位，按参考位顺序（图片1 在最前）。 */
export function maskableCellKeys(template: CloneTemplate | null | undefined): string[] {
  return referenceCells(template)
    .filter(cellAcceptsMask)
    .map((cell) => cell.key);
}

export function templateAcceptsMask(template: CloneTemplate | null | undefined): boolean {
  return maskableCellKeys(template).length > 0;
}

/** 大图这一格摆哪一格的图：第一条能画遮罩的参考位。画遮罩要看得见落点，摆被点的那张卡对不上。 */
export function maskHeroKey(template: CloneTemplate | null | undefined): string {
  return maskableCellKeys(template)[0] ?? "";
}

/**
 * 提示词能不能留空：只有工作流自己把「留空」声明成一个模式才行（局部重绘那条＝留空走移除）。
 * 别的工作流留空是整条链没文本，只会出一张没人要的图，所以默认还是得填。
 */
export function promptMayBeEmpty(template: CloneTemplate | null | undefined): boolean {
  return (template?.slots ?? []).some((slot) => slot.kind === "prompt" && slot.allow_empty === true);
}

/** 留空时该干什么，由工作流自己在槽位上写一句话（empty_hint），前端不替它编。 */
export function promptEmptyHint(template: CloneTemplate | null | undefined): string {
  const slot = (template?.slots ?? []).find(
    (item) => item.kind === "prompt" && item.allow_empty === true && item.empty_hint,
  );
  return String(slot?.empty_hint ?? "");
}

export type MaskMode = "repaint" | "remove";

/** 填了提示词＝按这句话改涂出来的地方；留空＝走移除。两个模式共用一个提示词框，靠这一句说清现在在哪个。 */
export function maskMode(prompt: string): MaskMode {
  return prompt.trim() ? "repaint" : "remove";
}

export function maskModeLabel(prompt: string): string {
  return maskMode(prompt) === "repaint"
    ? "局部重绘 · 只改涂出来的地方"
    : "移除 · 提示词留空，把涂出来的地方去掉";
}

/** 提交给后端的那份：只带真画过的格子，一张没画就整个键都不带，老请求体一字不改。 */
export function maskRequestPayload(edits: Record<string, MaskEdit | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, edit] of Object.entries(edits)) {
    if (edit?.png) out[key] = edit.png;
  }
  return out;
}

/** 有几格画了遮罩（空遮罩不算）。用来决定生成前要不要提醒一句。 */
export function paintedMaskCount(edits: Record<string, MaskEdit | undefined>): number {
  return Object.values(edits).filter((edit) => edit && !isMaskEmpty(edit.pixels)).length;
}

/** 参考位小角标上的字：没画就空着，不占地方。 */
export function maskBadgeText(edit: MaskEdit | undefined): string {
  return edit && !isMaskEmpty(edit.pixels) ? "遮罩" : "";
}

/** 大图左上角那颗的文案：画过就说「改」，没画就说「画」，别让人以为进去是看一遍。 */
export function maskEntryLabel(edit: MaskEdit | undefined): string {
  return edit && !isMaskEmpty(edit.pixels) ? "改遮罩" : "画遮罩";
}

/** 提示词摘要（编辑层顶栏只读回显用）：太长截一句，看完就够认出现在是哪条指令。 */
export function maskPromptSummary(prompt: string, limit = 40): string {
  const text = prompt.trim().replace(/\s+/g, " ");
  if (!text) return "（提示词留空）";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}