export interface ImageSummary {
  id: number;
  filename: string;
  path: string;
  thumb_url: string | null;
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
  thumb_status: string;
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
  thumb_size: number;
  thumb_quality: number;
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
  thumbs_ready: number;
  favorites: number;
  folders: number;
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
