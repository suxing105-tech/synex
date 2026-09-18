import { backendUrl } from "./backend-url";

/** 剪贴板使用原图分辨率；JPEG/WebP 等解码为 PNG，兼容系统图片粘贴。 */
export async function originalImagePng(id: number): Promise<Blob> {
  const response = await fetch(backendUrl(`/api/images/${id}/file`), { cache: "no-cache" });
  if (!response.ok) throw new Error("读取原图失败");
  const original = await response.blob();
  if (original.type === "image/png") return original;
  const bitmap = await createImageBitmap(original);
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

export async function copyOriginalImage(id: number): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("当前环境不支持复制图片，请在桌面版中重试");
  }
  // 在点击事件内立即请求写入，异步图片读取通过 Promise 交给 ClipboardItem。
  const png = originalImagePng(id);
  void png.catch(() => {});
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
