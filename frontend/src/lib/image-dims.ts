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