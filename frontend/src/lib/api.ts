import { backendUrl } from "./backend-url";
import type {
  ComfyuiConfigUpdate,
  ComfyuiStatus,
  ConfigOut,
  FeedQuery,
  FeedResponse,
  FolderNode,
  ImageDetail,
  ImageSummary,
  ImportResponse,
  OpenWorkflowResult,
  ScanProgress,
  Stats,
  TagInfo,
} from "./types";

export async function http<T>(path: string, init?: RequestInit): Promise<T> {
  // FormData 时让浏览器自动设置 multipart 边界，绝不能手动覆盖 Content-Type。
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const headers = isFormData
    ? { ...(init?.headers || {}) }
    : { "Content-Type": "application/json", ...(init?.headers || {}) };
  const res = await fetch(backendUrl(path), {
    ...init,
    headers,
  });
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 240);
    } catch {
      /* ignore */
    }
    const url = (init && (init as any).method) ? `${(init as any).method} ${path}` : path;
    let detail: string | undefined;
    try { const parsed = JSON.parse(body); if (typeof parsed.detail === "string") detail = parsed.detail; } catch { /* 非 JSON 错误保留在诊断信息中 */ }
    throw Object.assign(new Error(`${url} → ${res.status}${body ? `: ${body}` : ""}`), { detail });
  }
  if (res.headers.get("content-type")?.includes("text/html")) {
    throw new Error("接口返回了网页，未连接到图库后端。请更新桌面版后重试。");
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
  copyFiles(paths: string[], folder_id: number | null): Promise<ImportResponse> {
    return http('/api/images/copy-files', { method: 'POST', body: JSON.stringify({ paths, folder_id }) });
  },
  presence(id: number): Promise<{ exists: boolean }> { return http(`/api/images/${id}/presence`); },
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

  bulkAssignFolder(
    image_ids: number[],
    folder_id: number | null,
  ): Promise<{ ids: number[]; folder_id: number | null }> {
    return http(`/api/images/bulk-assign-folder`, {
      method: "POST",
      body: JSON.stringify({ image_ids, folder_id }),
    });
  },
  remove(id: number, removeFile = false): Promise<{ ok: boolean; cleaned_previews: number }> {
    return http(`/api/images/${id}?remove_file=${removeFile}`, { method: "DELETE" });
  },
  rename(id: number, filename: string): Promise<ImageSummary> {
    return http<ImageSummary>(`/api/images/${id}/filename`, {
      method: "PATCH",
      body: JSON.stringify({ filename }),
    });
  },
  reveal(id: number): Promise<{ ok: boolean; id: number; path: string; method: string }> {
    return http(`/api/images/${id}/reveal`, { method: "POST" });
  },
  /**
   * 把多个文件拖入当前文件夹。
   * - `folderId` 为 null/undefined → 仅入库收件箱，不分配文件夹；
   * - 否则后端会校验文件夹存在并自动指派。
   * 返回的 saved[] 与 skipped[] 各自带原因，前端用 toast 反馈。
   */
  import(files: File[], folderId: number | null | undefined): Promise<ImportResponse> {
    const fd = new FormData();
    for (const f of files) fd.append("files", f, f.name);
    if (folderId != null) fd.append("folder_id", String(folderId));
    return http<ImportResponse>("/api/images/import", { method: "POST", body: fd });
  },
};


// ---------- 文件夹 ----------


export const foldersApi = {
  reorder(id: number, target_id: number, position: "before" | "after"): Promise<{ ok: boolean }> {
    return http(`/api/folders/${id}/reorder`, {
      method: "POST", body: JSON.stringify({ target_id, position }),
    });
  },
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
  importDirectory(path: string): Promise<{ ok: boolean; path: string }> {
    return http("/api/directories/import", { method: "POST", body: JSON.stringify({ path }) });
  },
  validateDirectory(path: string): Promise<{ path: string }> {
    return http("/api/directories/validate", { method: "POST", body: JSON.stringify({ path }) });
  },
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



// ---------- ComfyUI 集成 ----------


export const comfyuiApi = {
  status(): Promise<ComfyuiStatus> {
    return http<ComfyuiStatus>("/api/integrations/comfyui/status");
  },
  updateConfig(patch: ComfyuiConfigUpdate): Promise<ComfyuiStatus> {
    return http<ComfyuiStatus>("/api/integrations/comfyui/config", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
  openWorkflow(id: number): Promise<OpenWorkflowResult> {
    return http<OpenWorkflowResult>(
      `/api/integrations/comfyui/open_workflow/${id}`,
      { method: "POST" },
    );
  },
};
