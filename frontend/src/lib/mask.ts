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
export const MASK_INK_DEFAULT = 0.45;
/** 叠在参考图上给人看的那一层面：偏洋红的红，深色底与浅色照片上都压得住 */
export const MASK_INK_RGB = "255, 59, 92";
/** 涂到的像素少于这个数就当「没画」。不是随手挑的：孤海那台裁遮罩的节点同样把 10 像素以下当空遮罩强制成全白，
 *  我们若把它当有遮罩，用户会得到一张整幅被重绘的图，还以为自己只圈了一小块。 */
export const MASK_EMPTY_PIXELS = 10;
/** 重做栈深度：撤销掉的笔迹能捞回来这么多步，再多就不留了 */
export const MASK_REDO_LIMIT = 40;
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