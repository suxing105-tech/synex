import type {
  ConfigOut,
  FeedQuery,
  FeedResponse,
  FolderNode,
  ImageDetail,
  ScanProgress,
  Stats,
  TagInfo,
} from "./types";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

function qs(obj: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---------- 图片 ----------


export const imagesApi = {
  list(query: FeedQuery = {}): Promise<FeedResponse> {
    return http<FeedResponse>(`/api/images${qs(query as Record<string, unknown>)}`);
  },
  detail(id: number): Promise<ImageDetail> {
    return http<ImageDetail>(`/api/images/${id}`);
  },
  toggleFavorite(id: number, favorite: boolean): Promise<{ id: number; favorite: boolean }> {
    return http(`/api/images/${id}/favorite`, {
      method: "POST",
      body: JSON.stringify({ favorite }),
    });
  },
  setTags(id: number, tags: string[]): Promise<{ id: number; tags: string[] }> {
    return http(`/api/images/${id}/tags`, {
      method: "POST",
      body: JSON.stringify({ tags }),
    });
  },
  assignFolder(id: number, folder_id: number | null): Promise<{ id: number; folder_id: number | null }> {
    return http(`/api/images/${id}/folder`, {
      method: "POST",
      body: JSON.stringify({ folder_id }),
    });
  },
  remove(id: number, removeFile = false): Promise<{ ok: boolean }> {
    return http(`/api/images/${id}?remove_file=${removeFile}`, { method: "DELETE" });
  },
  rename(id: number, filename: string): Promise<ImageSummary> {
    return http<ImageSummary>(`/api/images/${id}/filename`, {
      method: "PATCH",
      body: JSON.stringify({ filename }),
    });
  },
  reveal(id: number): Promise<{ ok: boolean; id: number; path: string }> {
    return http(`/api/images/${id}/reveal`, { method: "POST" });
  },
};


// ---------- 文件夹 ----------


export const foldersApi = {
  tree(): Promise<FolderNode[]> {
    return http<FolderNode[]>("/api/folders");
  },
  create(name: string, parent_id: number | null = null): Promise<FolderNode> {
    return http("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name, parent_id }),
    });
  },
  rename(id: number, name: string): Promise<FolderNode> {
    return http(`/api/folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  },
  move(id: number, direction: "up" | "down"): Promise<{ ok: boolean }> {
    return http(`/api/folders/${id}/move?direction=${direction}`, { method: "POST" });
  },
  remove(id: number): Promise<{ ok: boolean }> {
    return http(`/api/folders/${id}`, { method: "DELETE" });
  },
};

// ---------- 标签 ----------


export const tagsApi = {
  list(): Promise<TagInfo[]> {
    return http<TagInfo[]>("/api/tags");
  },
};

// ---------- 设置 / 扫描 ----------


export const settingsApi = {
  get(): Promise<ConfigOut> {
    return http<ConfigOut>("/api/settings");
  },
  update(patch: Partial<ConfigOut>): Promise<ConfigOut> {
    return http<ConfigOut>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
};

export const scanApi = {
  start(path?: string): Promise<{ ok: boolean; target: string }> {
    return http("/api/scan", {
      method: "POST",
      body: JSON.stringify(path ? { path } : {}),
    });
  },
  progress(): Promise<ScanProgress> {
    return http<ScanProgress>("/api/scan/progress");
  },
};

export const statsApi = {
  get(): Promise<Stats> {
    return http<Stats>("/api/stats");
  },
};

