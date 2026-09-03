// 拿到图片「视觉」尺寸（已应用 EXIF 旋转）。
//
// 为什么需要这个：
//   手机拍的 JPEG 通常带 EXIF orientation tag（例如 6 = 顺时针 90°）。
//   浏览器在渲染时会自动旋转图片，但 <img>.naturalWidth/Height 在 Chrome / Edge /
//   Safari 里返回的是「存储像素」（未旋转），Firefox 又是「视觉像素」（已旋转）。
//   所以仅靠 bind:naturalWidth 不可靠 —— 用 createImageBitmap(imageOrientation: from-image)
//   能跨浏览器拿到真正显示出来的视觉宽高。
//
// 用法：
//   const dims = await getOrientedImageSize(url);
//   // dims = { w: 4096, h: 2048 } （已旋转后的视觉宽高）
//
// 失败时 fallback 到调用方传入的默认尺寸（通常是 naturalWidth/Height）。

export interface ImageSize {
  w: number;
  h: number;
}

export async function getOrientedImageSize(
  url: string,
  fallback?: ImageSize,
): Promise<ImageSize> {
  if (typeof createImageBitmap !== "function") {
    return fallback ?? { w: 0, h: 0 };
  }
  try {
    const resp = await fetch(url, { cache: "force-cache" });
    if (!resp.ok) return fallback ?? { w: 0, h: 0 };
    const blob = await resp.blob();
    // imageOrientation: "from-image" 让 createImageBitmap 按 EXIF 旋转，返回的 bitmap
    // 尺寸就是浏览器最终渲染出来的视觉尺寸
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const dims = { w: bitmap.width, h: bitmap.height };
    if (typeof bitmap.close === "function") bitmap.close();
    return dims;
  } catch {
    return fallback ?? { w: 0, h: 0 };
  }
}

/**
 * 在「视觉尺寸 oriented」（createImageBitmap(imageOrientation: from-image) 输出）
 * 和「像素尺寸 natural」（浏览器解码 <img> 拿到的 naturalWidth/naturalHeight）之间
 * 做防御性选择，返回该用作 fitRatio / displayW/H / clampPan 输入的尺寸。
 *
 * 背景：场景_00002_ 这类 2880×1616 大横图切图时，<img> 的 naturalWidth 已经更新到
 * 新图的尺寸，但 visualW/H 还没等 createImageBitmap 异步返回（旧的上一张图的值还在），
 * 导致 fitRatio / displayW / displayH 用旧图 aspect 算出来，把新图挤变形。
 * 反过来如果 createImageBitmap 真的返回 EXIF 校正后的尺寸，又必须用它，否则手机拍的
 * 旋转 90° 的 JPEG 会被拍扁。
 *
 * 决策规则（保守优先用 natural）：
 *   1. oriented 不可用（0/失败）     → 用 natural
 *   2. natural 不可用（0）           → 用 oriented
 *   3. natural.w === oriented.h 且 natural.h === oriented.w
 *                                  → 90°/270° EXIF 互换，确认是 EXIF 旋转 → 用 oriented
 *   4. aspect 差异 > 20%（兜底）     → 用 oriented
 *   5. 其余（含不同图之间的小差异）    → 用 natural（防御旧 visualW/H 跨图污染）
 */
export function safeOrientedSize(
  natural: ImageSize,
  oriented: ImageSize,
): ImageSize {
  const natOK = natural.w > 0 && natural.h > 0;
  const ortOK = oriented.w > 0 && oriented.h > 0;
  if (!ortOK) return natOK ? natural : { w: 0, h: 0 };
  if (!natOK) return oriented;
  // 90° 旋转类 EXIF：w/h 互换（orientation 5/6/7/8 都符合这一形态）
  if (natural.w === oriented.h && natural.h === oriented.w) return oriented;
  // 兜底：用较大者做分母避免除零
  const natAspect = natural.w / natural.h;
  const ortAspect = oriented.w / oriented.h;
  const denom = Math.max(natAspect, ortAspect, 0.0001);
  if (Math.abs(natAspect - ortAspect) / denom > 0.20) return oriented;
  // 默认：natural 是浏览器解出来的真实像素，跨图之间的小 aspect 差异都不该用它替换
  return natural;
}
