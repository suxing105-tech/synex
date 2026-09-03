// Lightbox 100% 放大 + 抓手拖动平移的纯函数。
//
// 设计要点：
//   - Lightbox 缩放有两种模式："fit"（按比例缩到视口内，默认）和 "zoom"（100% 原图）。
//   - zoom 模式下图像可以比视口大或小，靠 translate(x,y) 平移来浏览细节。
//   - 平移必须 clamp 到合理边界：小图不能整个移出视口外；大图至少保留 margin 像素可见。
//
// 不依赖 Svelte，方便单测。

export interface Size {
  w: number;
  h: number;
}

export interface PanOffset {
  x: number;
  y: number;
}

/**
 * 把 (panX, panY) 限制到「图像始终在视口内可被浏览」的范围内。
 *
 * - 图像 <= 视口：图像必须完全留在视口内，panX/panY 范围 = ±(viewport - image)/2。
 * - 图像 > 视口：图像至少保留 margin 像素贴住视口边缘，panX/panY 范围 = ±(image - viewport)/2 - margin。
 *
 * margin 默认 80px：用户拖动时图像边缘不会完全跑出视口，留点余量方便反向拖回。
 */
export function clampPan(
  pan: PanOffset,
  image: Size,
  viewport: Size,
  margin = 80,
): PanOffset {
  const boundX = image.w <= viewport.w
    ? (viewport.w - image.w) / 2
    : (image.w - viewport.w) / 2 - margin;
  const boundY = image.h <= viewport.h
    ? (viewport.h - image.h) / 2
    : (image.h - viewport.h) / 2 - margin;
  // 加 0 把 -0 归一为 +0，避免 JSON 序列化和深比较踩坑
  return {
    x: Math.max(-boundX, Math.min(boundX, pan.x)) + 0,
    y: Math.max(-boundY, Math.min(boundY, pan.y)) + 0,
  };
}

/**
 * 拖拽事件里根据当前鼠标位置和拖拽起点算出新的 pan。
 *
 *   newPan = 当前鼠标 - 拖拽起点 + 拖拽起始时的 pan
 *
 * 这样图像上「鼠标按下的那个像素」会一直跟着鼠标走，符合直觉。
 */
export function panFromDrag(
  mouseX: number,
  mouseY: number,
  dragStartMouseX: number,
  dragStartMouseY: number,
  dragStartPan: PanOffset,
): PanOffset {
  return {
    x: mouseX - dragStartMouseX + dragStartPan.x,
    y: mouseY - dragStartMouseY + dragStartPan.y,
  };
}

/**
 * 双击图片：fit → zoom 或 zoom → fit。
 *
 * 返回新模式 + 初始 pan。fit 模式 pan 永远是 0；zoom 模式 pan 也置 0（让 flex 居中）。
 */
export function nextZoomMode(
  current: "fit" | "zoom",
): { mode: "fit" | "zoom"; pan: PanOffset } {
  return current === "zoom"
    ? { mode: "fit", pan: { x: 0, y: 0 } }
    : { mode: "zoom", pan: { x: 0, y: 0 } };
}