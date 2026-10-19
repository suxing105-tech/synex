import { backendUrl } from "./backend-url";

/** 剪贴板只稳妥吃 PNG，JPEG/WebP 先按原始宽高解码转换，不缩成预览尺寸。 */
export async function blobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法转换原图格式");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片转换失败")), "image/png"));
  } finally { bitmap.close(); }
}

function requireImageClipboard() {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("当前环境不支持复制图片，请在桌面版中重试");
  }
}

/** 复制任意 Blob。到 clipboard.write 之前没有 await，仍在点击手势内。 */
export async function copyBlobAsImage(blob: Blob): Promise<void> {
  requireImageClipboard();
  const png = blobToPng(blob);
  void png.catch(() => {});
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** 后端返回的 data URL 转 Blob，用于缩略图复制与下载。 */
export function dataUrlToBlob(url: string): Blob {
  const [meta, payload] = url.split(",");
  const mime = /:(.*?);/.exec(meta || "")?.[1] ?? "image/jpeg";
  const binary = atob(payload || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function copyDataUrlImage(url: string): Promise<void> {
  return copyBlobAsImage(dataUrlToBlob(url));
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** 剪贴板使用原图分辨率；JPEG/WebP 等解码为 PNG，兼容系统图片粘贴。 */
export async function originalImagePng(id: number): Promise<Blob> {
  const response = await fetch(backendUrl(`/api/images/${id}/file`), { cache: "no-cache" });
  if (!response.ok) throw new Error("读取原图失败");
  return blobToPng(await response.blob());
}

export async function copyOriginalImage(id: number): Promise<void> {
  requireImageClipboard();
  // 在点击事件内立即请求写入，异步图片读取通过 Promise 交给 ClipboardItem。
  const png = originalImagePng(id);
  void png.catch(() => {});
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
