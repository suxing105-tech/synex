// 画布原型（?cm_canvas=1）的排布与相机算术。
//
// 为什么单独一个不带 Svelte 的文件：这批算术必须能单测。真浏览器里靠 ResizeObserver 量内容包围盒
// 是可行的，但 happy-dom 没有 ResizeObserver、rect 全是 0（这个坑这个项目已经记过一条），
// 量出来的东西一条断言都写不了。所以包围盒不靠量——由这份纯函数按批次算出来：
// 一批一条横带，最新那条在最上面，卡片尺寸由提交时挑的比例定。
// 组件只负责把算好的位置画出来，测试直接喂数据断言位置。
//
// 缩放/平移的状态机不在这里，仍然用 lib/viewer-zoom.svelte.ts（图片预览与视频播放器共用那一层），
// 这里只补它没有的那一个原语：把相机推到某一张卡片上。

import type { CloneBatch, CloneOutput } from "./clone";

/** 一格里卡片的高度（自然像素，未经缩放）。宽度由比例算，所以一排里高矮一致。 */
export const CANVAS_ROW = 240;
/** 卡片之间与四周的留白（自然像素）。 */
export const CANVAS_GAP = 16;
export const CANVAS_PAD = 20;
/** 聚焦某一张时四周留的余量（视口像素）。 */
export const CANVAS_INSET = 24;

/** fit 态够用的那张预览；再往上报更大的档，直到原图。 */
export const SOURCE_LADDER = [1024, 2048, 4096] as const;

const SQUARE = { w: 1, h: 1 };

export interface CanvasCard {
  /** 跨批次可能撞 id，key 一律带批次前缀。 */
  key: string;
  batchKey: string;
  /** 全局序号，从左到右、从新到旧，给「第 n / m 份」和左右键用。 */
  order: number;
  output: CloneOutput;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 不是最新一批：画布上变淡，最新那批才是这一轮的结果。 */
  faded: boolean;
  /** 是否属于最新一批——「刚生成的」那几个字只对它成立。 */
  latest: boolean;
}

export interface CanvasLayout {
  cards: CanvasCard[];
  /** 内容层包围盒：相机算 fit、算 displayW/H、算 clamp 边界全靠它。 */
  width: number;
  height: number;
}

export interface CanvasViewport {
  w: number;
  h: number;
}

export interface CanvasCamera {
  scale: number;
  pan: { x: number; y: number };
}

/** 提交时挑的比例认不出来就按方的排：宁可留白匀称，也不要按缩略图猜一个比例。 */
function aspectOf(batch: CloneBatch): { w: number; h: number } {
  const a = batch.aspect;
  return a && a.w > 0 && a.h > 0 ? a : SQUARE;
}

/**
 * 一批一条横带，带内从左到右，每条带在自己的行里居中。
 *
 * 批次顺序：最新的排最上面。画布坐在输入卡上方，生成完眼睛就落在那儿，
 * 上一批往下退，读起来是「这一轮的结果 / 上一轮的」，不用来回找。
 */
export function layoutCloneBatches(
  batches: CloneBatch[],
  opts: { row?: number; gap?: number; pad?: number } = {},
): CanvasLayout {
  const row = opts.row ?? CANVAS_ROW;
  const gap = opts.gap ?? CANVAS_GAP;
  const pad = opts.pad ?? CANVAS_PAD;
  if (!batches.length) return { cards: [], width: 0, height: 0 };
  const bands = batches.map((batch, bi) => {
    const aspect = aspectOf(batch);
    const w = Math.max(1, Math.round((row * aspect.w) / aspect.h));
    const width = batch.outputs.length * w + Math.max(0, batch.outputs.length - 1) * gap;
    return { batch, bi, w, width };
  });
  const contentW = bands.reduce((max, b) => Math.max(max, b.width), 0);
  const width = contentW + pad * 2;
  const height = bands.reduce((sum, b) => sum + row, 0)
    + Math.max(0, bands.length - 1) * gap + pad * 2;

  const cards: CanvasCard[] = [];
  let y = pad;
  let order = 0;
  for (const band of bands) {
    let x = (width - band.width) / 2;
    for (const output of band.batch.outputs) {
      cards.push({
        key: `${band.batch.key}:${output.id}`,
        batchKey: band.batch.key,
        order: order++,
        output,
        x: Math.round(x),
        y: Math.round(y),
        w: band.w,
        h: row,
        faded: band.bi > 0,
        latest: band.bi === 0,
      });
      x += band.w + gap;
    }
    y += row + gap;
  }
  return { cards, width: Math.round(width), height: Math.round(height) };
}

/**
 * 把相机推到某一张卡片上：这张卡片居中、撑到视口内。
 *
 * 内容层在未平移时是「按 ratio 缩放后居中于视口」的，所以卡片中心相对包围盒中心的偏移
 * 乘上倍率就是它在屏幕上的偏移；要把它挪到视口中心，pan 就是那个偏移的相反数。
 * 上下限由调用方把 ViewerZoom 的 ZOOM_LIMITS 传进来（这个文件不带 Svelte 依赖，不去 import 那一层）。
 */
export function cameraForCard(
  card: CanvasCard,
  layout: CanvasLayout,
  viewport: CanvasViewport,
  limits: { min: number; max: number } = { min: 0.05, max: 8 },
  inset: number = CANVAS_INSET,
): CanvasCamera {
  // 还没量到视口（单测里 rect 全 0）：给一个不动的相机，别让除零把断言带偏。
  if (viewport.w <= 0 || viewport.h <= 0) return { scale: 1, pan: { x: 0, y: 0 } };
  const scale = Math.max(
    limits.min,
    Math.min(limits.max, Math.min((viewport.w - inset * 2) / card.w, (viewport.h - inset * 2) / card.h)),
  );
  const cx = card.x + card.w / 2 - layout.width / 2;
  const cy = card.y + card.h / 2 - layout.height / 2;
  return { scale, pan: { x: -cx * scale, y: -cy * scale } };
}

/**
 * 该给这一张挂哪一档图源。
 *
 * 画布能放大，`?max=1024` 那张预览放大必糊，所以按「这张卡片现在要在屏幕上占多少物理像素」
 * 往上报档：够用的最小档，一路到 4096；还不够就交原图（不带 max）。
 * 视频与音频只认后端给的地址——那两个端点不是 /api/images，前端硬拼必错。
 */
export function cloneSourceUrl(out: CloneOutput, neededPx: number): string {
  if (out.kind !== "image") return out.thumbnail_url;
  const step = SOURCE_LADDER.find((max) => max >= neededPx);
  return step
    ? `/api/images/${out.id}/file?max=${step}`
    : `/api/images/${out.id}/file`;
}

/** 这张卡片在屏幕上要占的物理像素（按它的自然宽与当前倍率算）。 */
export function neededPixels(card: CanvasCard, ratio: number, dpr: number): number {
  return Math.round(card.w * Math.max(ratio, 0) * Math.max(dpr, 1));
}
/**
 * 画布交给宿主的相机句柄。宿主的 Esc 必须先问它「还在放大吗」——
 * 放大态下第一下 Esc 退回全览，第二下才关弹窗，一按就关掉整个弹窗会让人丢掉刚放大的那一份。
 */
export interface CanvasEscape {
  isZoomed: () => boolean;
  zoomOut: () => void;
}