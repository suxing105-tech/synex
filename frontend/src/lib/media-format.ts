export function isPsdFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".psd");
}

export function thumbnailAspectRatio(
  filename: string,
  kind: "image" | "video" | "audio" | "text",
  width: number | null,
  height: number | null,
): string {
  // 音频波形与文本卡统一 21:9 横幅；波形默认出图 840x360 同比例，
  // 边框与图片/视频共用同一套 .thumb，不给音频特殊描边
  if (kind === "audio") return "21 / 9";
  if (kind === "text") return "21 / 9";
  if (kind === "image" && isPsdFilename(filename)) return "9 / 16";
  if (width && height && height > 0) return `${width} / ${height}`;
  return "1 / 1";
}

export function thumbnailObjectFit(filename: string): "cover" | "contain" {
  return isPsdFilename(filename) ? "cover" : "contain";
}

export function thumbnailHeightToWidthRatio(
  filename: string,
  kind: "image" | "video" | "audio" | "text",
  width: number | null,
  height: number | null,
): number {
  if (kind === "audio") return 9 / 21;
  if (kind === "text") return 9 / 21;
  if (kind === "image" && isPsdFilename(filename)) return 16 / 9;
  if (width && height && width > 0) return height / width;
  return 1;
}

/** 时长统一写成 `m:ss`（超过一小时也继续累加分钟，和视频页/详情面板同一口径）。 */
export function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 剪贴板与拖拽共用的可导入格式判断：有 MIME 就用 MIME，否则退回扩展名（剪贴板位图叫 image.png）。 */
export const AUDIO_EXT_PATTERN = "mp3|wav|flac|m4a|aac|opus|ogg";

export function isAcceptedMediaFile(file: { name?: string; type?: string }): boolean {
  const type = file.type || "";
  if (type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) return true;
  return new RegExp(`\\.(png|webp|jpe?g|mp4|mov|m4v|webm|mkv|avi|wmv|flv|${AUDIO_EXT_PATTERN})$`, "i").test(file.name || "");
}

/** 拖拽/粘贴导入时按扩展名分类型，决定 toast 里的量词。 */
export function mediaKindOfFilename(filename: string): "image" | "video" | "audio" {
  if (/\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv)$/i.test(filename)) return "video";
  if (new RegExp(`\\.(${AUDIO_EXT_PATTERN})$`, "i").test(filename)) return "audio";
  return "image";
}
