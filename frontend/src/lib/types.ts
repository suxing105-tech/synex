export type MediaKind = "image" | "video" | "audio";

/** 侧栏一行 = 一种 scope；它是浏览口径，不只是「媒体类型」。 */
export type Scope = "all" | MediaKind | "text";
export type ItemKind = MediaKind | "text";

export interface ImageSummary {
  id: number;
  filename: string;
  path: string;
  kind: MediaKind;
  original_url: string | null;  // 原图 URL（feed 用 ?max=1024 拿预览）
  thumbnail_url: string | null; // 视频=海报帧；图片=缩放预览
  play_url: string | null;      // 视频原文件 URL（播放器用），仅视频有值
  playable: boolean | null;     // 该视频容器是否可在 WebView 内播放
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  fps: number | null;
  mtime: number;
  size_bytes: number;
  folder_ids: number[];
  tags: string[];
  model: string | null;
  seed: number | null;
  new?: boolean;
  has_workflow?: boolean;
}

export interface ImageDetail extends ImageSummary {
  positive_prompt: string;
  negative_prompt: string;
  parameters: Record<string, unknown>;
  workflow: string;
  sampler: string | null;
  steps: number | null;
  cfg: number | null;
  format: string | null;
  created_at: string | null;
  indexed_at: string | null;
}

/** 一个文件夹里四类素材各自的数量；侧栏只显示当前 scope 那一种，其余进 tooltip。 */
export interface FolderCounts {
  image: number;
  video: number;
  audio: number;
  text: number;
}

export interface FolderNode {
  id: number;
  parent_id: number | null;
  name: string;
  order: number;
  counts: FolderCounts; // 含后代递归汇总
  total: number;        // counts 四项之和
  is_system?: boolean; // 监听目录文件系统子目录（不可重命名/删除/move）
  path?: string | null; // system folder 时存绝对路径（前端可在 tooltip 显示）
  children: FolderNode[];
}

export interface TagInfo {
  name: string;
  count: number;
}

export interface FeedResponse {
  items: ImageSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface ConfigOut {
  watch_dirs: string[];
  theme: string;
  live_enabled: boolean;
  scan_workers: number;
}

export interface ScanProgress {
  running: boolean;
  scanned: number;
  indexed: number;
  total: number;
  current_path: string;
  error: string | null;
}

/** 后端 media_tools.status()：ffmpeg / ffprobe 的来源与版本。 */
export interface MediaToolInfo {
  path: string | null;
  source: string | null;
  version: string | null;
}

export interface MediaToolsStatus {
  available: boolean;
  missing: string[];
  tools: Record<"ffmpeg" | "ffprobe", MediaToolInfo>;
  versions: Record<"ffmpeg" | "ffprobe", string | null>;
}

export interface HealthPayload {
  status: string;
  media_tools?: MediaToolsStatus;
}

export interface Stats {
  total_images: number;
  total_videos: number;
  total_audio: number;
  total_texts: number;
  folders: number;
}

export interface ImportResultItem {
  id: number;
  filename: string;
  path: string;
}

export interface ImportSkippedItem {
  filename: string;
  reason: string;  // unsupported_format / too_large / write_failed / indexed_failed / name_collision_exhausted
}

export interface ImportResponse {
  saved: ImportResultItem[];
  skipped: ImportSkippedItem[];
  folder_id: number | null;
  inbox_dir: string;
}

export type FeedQuery = {
  folder_id?: number | null;
  kind?: MediaKind;
  q?: string;
  tag?: string;
  model?: string;
  limit?: number;
  offset?: number;
};

// ---------- 「所有素材」统一流 ----------

/** 统一流里的媒体项：后端在 ImageSummary 上多打了一个 item_type 标记。 */
export interface MediaFeedItem extends ImageSummary {
  item_type: "media";
}

/** 统一流里的文本项：只有卡片要显示的那几项，正文仍在文本工作区取。 */
export interface TextFeedItem {
  item_type: "text";
  id: number;
  filename: string;
  path: string;
  kind: "text";
  mtime: number;
  tags: string[];
  format: string;
  excerpt: string;
}

/**
 * texts.id 与 images.id 各自自增，会撞车 —— 前端一律用 item_type + ":" + id
 * 作为 DOM key / 选区映射（见 lib/items.ts 的 itemUid）。
 */
export type ItemSummary = MediaFeedItem | TextFeedItem;

export interface ItemsResponse {
  items: ItemSummary[];
  total: number;
  counts: FolderCounts;
  limit: number;
  offset: number;
}

export type ItemFeedQuery = {
  folder_id?: number | null;
  q?: string;
  tag?: string;
  kinds?: string;
  sort?: "mtime_desc" | "name_asc";
  limit?: number;
  offset?: number;
};

// ---------- ComfyUI 集成 ----------

export interface ComfyuiStatus {
  running: boolean;
  url: string;
  enabled: boolean;
  checked_at: number;
}

export interface ComfyuiConfigUpdate {
  url?: string;
  enabled?: boolean;
}

export interface OpenWorkflowResult {
  workflow?: Record<string, unknown>;
  ok: boolean;
  image_id: number;
  file_path: string;
  /** 落盘的 .json 文件名（不含扩展名），取自图片 filename */
  workflow_name: string;
  comfyui_url: string;
  /** 后端不再弹窗，恒为 false；保留字段以兼容既有响应类型 */
  browser_opened: boolean;
  message: string;
}
