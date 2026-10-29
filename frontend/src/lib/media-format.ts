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

// ---------- 卡片页脚（全站缩略图统一规范） ----------
//
// 页脚是图片下方那条实体底，宽度不够就得降级，所以「显示几行」和「占多高」
// 必须是同一个事实源：Feed 的贪心分列按 footerHeightFor 预计算列高，
// 渲染按 footerTierFor 决定挂哪个 class。两者一旦分叉，瀑布流就会重叠或留大缝。

/**
 * 把卡片按「当前最矮的一列」依次投放，得到等宽多列（masonry）。
 *
 * 为什么要自己分列：CSS grid 的行高由这一行里最高的卡决定，等比例缩略图竖横混排时，
 * 同行那张矮卡下面会空出一大块（图库素材选择器里被圈出来的就是它）。分列之后每列
 * 自己往下堆，不再有行对齐这回事。投放顺序按 items 原顺序，同一批输入的结果稳定。
 */
export function splitIntoColumns<T>(
  items: T[],
  columns: number,
  heightWeight: (item: T) => number,
): T[][] {
  const count = Math.max(1, Math.floor(columns) || 1);
  const buckets: T[][] = Array.from({ length: count }, () => [] as T[]);
  const heights = new Array<number>(count).fill(0);
  for (const item of items) {
    let target = 0;
    for (let i = 1; i < count; i += 1) {
      if (heights[i] < heights[target]) target = i;
    }
    buckets[target].push(item);
    const weight = heightWeight(item);
    heights[target] += Number.isFinite(weight) ? weight : 1;
  }
  return buckets;
}

/** 两行页脚（文件名 + 元信息）所需的最小卡片宽 */
export const FOOTER_TIER_TWO_LINE_MIN_WIDTH = 170;
/** 单行页脚（只有文件名）所需的最小卡片宽 */
export const FOOTER_TIER_ONE_LINE_MIN_WIDTH = 120;
/** `--2l` 页脚的实测高度（px），与 app.css 的 .media-card-footer--2l 对齐 */
export const FOOTER_HEIGHT_TWO_LINES = 44;
/** `--1l` 页脚的实测高度（px），与 app.css 的 .media-card-footer--1l 对齐 */
export const FOOTER_HEIGHT_ONE_LINE = 26;

/** 卡片间距（px）。app.css 的 --thumb-gap 与 Feed 的贪心分列共用这一个值。 */
export const THUMB_GAP = 10;

export type FooterTier = 0 | 1 | 2;

/** 卡片能放几行页脚：>=170 两行；120-169 只放文件名；<120 整条不渲染。 */
export function footerTierFor(columnWidth: number): FooterTier {
  if (!Number.isFinite(columnWidth) || columnWidth < FOOTER_TIER_ONE_LINE_MIN_WIDTH) return 0;
  if (columnWidth >= FOOTER_TIER_TWO_LINE_MIN_WIDTH) return 2;
  return 1;
}

/** 该宽度下页脚实际占的高度，供贪心分列计入卡片总高。 */
export function footerHeightFor(columnWidth: number): number {
  const tier = footerTierFor(columnWidth);
  if (tier === 2) return FOOTER_HEIGHT_TWO_LINES;
  if (tier === 1) return FOOTER_HEIGHT_ONE_LINE;
  return 0;
}

/**
 * 页脚第一行：只去掉目录，**保留扩展名**（用户要看得出这是 .png 还是 .psd）。
 * 重命名输入框仍然只喂去掉扩展名的部分，改不到后缀。
 */
export function basenameOnly(filename: string): string {
  return filename.split(/[\\/]/).pop() || filename;
}

/**
 * 页脚第二行：`1920×1080 · 5.5MB · 0:12`。
 * 尺寸分隔符用 `×`，和 Lightbox 的读数同一口径；缺哪个字段就整段省略，
 * 不留空的分隔符。sizeText 由调用方用 ws.ts 的 formatSize 先算好。
 */
export function footerMetaText(parts: {
  width: number | null;
  height: number | null;
  sizeText?: string | null;
  durationSeconds?: number | null;
}): string {
  const bits: string[] = [];
  if (parts.width && parts.height) bits.push(`${parts.width}×${parts.height}`);
  if (parts.sizeText) bits.push(parts.sizeText);
  const duration = formatDuration(parts.durationSeconds ?? null);
  if (duration) bits.push(duration);
  return bits.join(" · ");
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
