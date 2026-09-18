export interface ImageSummary {
  id: number;
  filename: string;
  path: string;
  original_url: string | null;  // 原图 URL（feed 用 ?max=1024 拿预览）
  width: number | null;
  height: number | null;
  mtime: number;
  size_bytes: number;
  favorite: boolean;
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

export interface FolderNode {
  id: number;
  parent_id: number | null;
  name: string;
  order: number;
  image_count: number;
  recursive_count: number;
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

export interface Stats {
  total_images: number;
  favorites: number;
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
  view?: "all" | "favorite" | "recent";
  q?: string;
  tag?: string;
  model?: string;
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
