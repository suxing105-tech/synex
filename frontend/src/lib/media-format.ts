export function isPsdFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".psd");
}

export function thumbnailAspectRatio(
  filename: string,
  kind: "image" | "video",
  width: number | null,
  height: number | null,
): string {
  if (kind === "image" && isPsdFilename(filename)) return "9 / 16";
  if (width && height && height > 0) return `${width} / ${height}`;
  return "1 / 1";
}

export function thumbnailObjectFit(filename: string): "cover" | "contain" {
  return isPsdFilename(filename) ? "cover" : "contain";
}

export function thumbnailHeightToWidthRatio(
  filename: string,
  kind: "image" | "video",
  width: number | null,
  height: number | null,
): number {
  if (kind === "image" && isPsdFilename(filename)) return 16 / 9;
  if (width && height && width > 0) return height / width;
  return 1;
}

/** 剪贴板与拖拽共用的可导入格式判断：有 MIME 就用 MIME，否则退回扩展名（剪贴板位图叫 image.png）。 */
export function isAcceptedMediaFile(file: { name?: string; type?: string }): boolean {
  const type = file.type || "";
  if (type.startsWith("image/") || type.startsWith("video/")) return true;
  return /\.(png|webp|jpe?g|mp4|mov|m4v|webm|mkv|avi|wmv|flv)$/i.test(file.name || "");
}
