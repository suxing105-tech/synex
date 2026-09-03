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
