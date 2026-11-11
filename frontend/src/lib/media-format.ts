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

/** 两行页脚（第一行标题 + 第二行元信息）所需的最小卡片宽 */
export const FOOTER_TIER_TWO_LINE_MIN_WIDTH = 170;
/** 单行页脚（只有第一行标题）所需的最小卡片宽 */
export const FOOTER_TIER_ONE_LINE_MIN_WIDTH = 120;
/** `--2l` 页脚的实测高度（px），与 app.css 的 .media-card-footer--2l 对齐 */
export const FOOTER_HEIGHT_TWO_LINES = 44;
/** `--1l` 页脚的实测高度（px），与 app.css 的 .media-card-footer--1l 对齐 */
export const FOOTER_HEIGHT_ONE_LINE = 26;

/** 卡片间距（px）。app.css 的 --thumb-gap 与 Feed 的贪心分列共用这一个值。 */
export const THUMB_GAP = 10;

export type FooterTier = 0 | 1 | 2;

/** 卡片能放几行页脚：>=170 两行；120-169 只放第一行；<120 整条不渲染。 */
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
 * 卡片页脚那颗徽标：素材**所在文件夹的名字**。
 * `D:/…/output/MiniMaxH3/自我介绍/x.mp4` → `自我介绍`，直接躺在 `krea2` 里的图 → `krea2`。
 *
 * 为什么这里不放模型名：2026-11-11 苏醒明确说卡片不需要告诉他这是哪个模型出的，他要看的
 * 是这张东西放在哪个文件夹里——那才是他自己组织素材的单位。换成路径还有个实打实的好处：
 * 路径本来就在手上，图片/视频/音频/文本四类一律取得到，不再出现「这条没解析出元数据就是空」
 * （本机 148 条视频里有 7 条是那样空着的）。截断沿用徽标原来的预算，24 字加省略号；
 * 没有上层文件夹（只剩文件名）返回 null，宁可不显示也不摆个盘符或斜杠上去。
 */
export function parentFolderLabel(path: string | null | undefined): string | null {
  const segments = (path ?? "").split(/[\\/]+/).filter(Boolean);
  if (segments.length < 2) return null;
  const folder = (segments[segments.length - 2] ?? "").trim();
  if (!folder) return null;
  return folder.length > 24 ? folder.slice(0, 24) + "…" : folder;
}

/** `path` 的上层目录，原样给徽标的 title 用（hover 看全路径）；没有上层目录给空串。 */
export function parentFolderPath(path: string | null | undefined): string {
  const raw = (path ?? "").trim();
  const cut = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  return cut > 0 ? raw.slice(0, cut) : "";
}

/**
 * 页脚第二行末尾那个时间：越近的事越具体，越久的事越短。
 * 刚做的一分钟一停、昨天就两个字、上个月只给月日，跨年才补上年份——
 * 200px 的卡片给不起「2026年11月9日 14:20」这种整串。
 */
export function footerTimeLabel(mtime: number | null | undefined, now: number = Date.now() / 1000): string {
  if (typeof mtime !== "number" || !Number.isFinite(mtime) || mtime <= 0) return "";
  if (typeof now !== "number" || !Number.isFinite(now)) return "";
  const diff = now - mtime;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 时前`;
  const dayIndex = (ms: number) => {
    const d = new Date(ms);
    return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
  };
  const ref = now * 1000;
  const then = mtime * 1000;
  if (dayIndex(ref) - dayIndex(then) === 1) return "昨天";
  const t = new Date(then);
  const r = new Date(ref);
  const mm = String(t.getMonth() + 1).padStart(2, "0");
  const dd = String(t.getDate()).padStart(2, "0");
  return t.getFullYear() === r.getFullYear() ? `${mm}/${dd}` : `${String(t.getFullYear()).slice(2)}/${mm}/${dd}`;
}

/** 两行页脚里「尺寸」愿意露面的最小列宽（px）。见 footerMetaBits 的降级梯子。 */
export const FOOTER_BITS_DIMS_MIN_WIDTH = 210;

export interface FooterMetaInput {
  kind: "image" | "video" | "audio" | "text";
  width: number | null;
  height: number | null;
  durationSeconds?: number | null;
  /** 素材完整路径：第二行那颗徽标取它的上层文件夹名 */
  path?: string | null;
  mtime?: number | null;
  /** 秒级时间戳的「现在」，单测用；界面上不传 */
  now?: number;
  /** 当前列宽，决定尺寸要不要露面；不传当宽的 */
  columnWidth?: number;
}

/**
 * 页脚第二行的内容：所属文件夹徽标 + 几段元信息。
 *
 * 三件事要交代清楚：
 * 1. 尺寸按类型给，不再不分类型地拼 width×height。音频的 width/height 存的是
 *    波形画布尺寸（840×360），以前就这么大剌剌地摆在音频卡上，是个 bug，顺手修掉。
 * 2. 尺寸在窄卡上不露面（<${FOOTER_BITS_DIMS_MIN_WIDTH}px）。徽标和时间才是这张卡
 *    「在哪个文件夹、什么时候做的」，尺寸缩略图自己已经说明了高宽比，细节在详情栏看。
 *    不做这个梯子，四列布局（约 202px）第二行必然溢出一串省略号。
 * 3. 文件大小从卡片上撤了：扫描时没人靠字节数挑图，详情栏和 Lightbox 都还在。
 */
export function footerMetaBits(input: FooterMetaInput): { folder: string | null; bits: string[] } {
  const bits: string[] = [];
  const wide = typeof input.columnWidth !== "number" || input.columnWidth >= FOOTER_BITS_DIMS_MIN_WIDTH;
  const dims = input.width && input.height ? `${input.width}×${input.height}` : "";
  const duration = formatDuration(input.durationSeconds ?? null);
  if (input.kind === "image") {
    if (wide && dims) bits.push(dims);
  } else if (input.kind === "video") {
    // 卡片上没有时长角标，时长只能在页脚给；尺寸同样等得起宽度
    if (duration) bits.push(duration);
    if (wide && dims) bits.push(dims);
  } else if (input.kind === "audio") {
    if (duration) bits.push(duration);
  }
  const time = footerTimeLabel(input.mtime ?? null, input.now);
  if (time) bits.push(time);
  return { folder: parentFolderLabel(input.path ?? null), bits };
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
