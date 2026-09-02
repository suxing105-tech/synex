import { writable, derived } from "svelte/store";
import type { FeedResponse, FolderNode, ImageDetail, ImageSummary, ScanProgress, Stats } from "./types";
import { foldersApi, imagesApi, scanApi, statsApi } from "./api";

// ---------- 当前选中图片详情 ----------


export const selectedDetail = writable<ImageDetail | null>(null);
export const selectedId = writable<number | null>(null);

// ---------- Feed 视图状态 ----------


export const folderId = writable<number | null>(null);
export const view = writable<"all" | "favorite" | "recent">("all");
export const query = writable<string>("");

export const targetColumns = writable<number>(5);

export const feedItems = writable<ImageSummary[]>([]);
export const feedTotal = writable<number>(0);

export const feedLoading = writable<boolean>(false);

export const folders = writable<FolderNode[]>([]);
export const stats = writable<Stats>({ total_images: 0, thumbs_ready: 0, favorites: 0, folders: 0 });

export const scanProgress = writable<ScanProgress>({
  running: false,
  scanned: 0,
  indexed: 0,
  total: 0,
  current_path: "",
  error: null,
});

// ---------- 新图 NEW 徽标 ----------


export const newIds = writable<Set<number>>(new Set());

export function markNew(ids: number[]) {
  newIds.update((s) => {
    const ns = new Set(s);
    for (const i of ids) ns.add(i);
    return ns;
  });
  // 3 秒后清除 NEW 状态
  setTimeout(() => {
    newIds.update((s) => {
      const ns = new Set(s);
      for (const i of ids) ns.delete(i);
      return ns;
    });
  }, 3000);
}

// ---------- 加载动作 ----------


export async function refreshFolders() {
  folders.set(await foldersApi.tree());
}

export async function refreshStats() {
  stats.set(await statsApi.get());
}

export async function refreshFeed() {
  feedLoading.set(true);
  try {
    let folder: number | null | undefined;
    let v: "all" | "favorite" | "recent" | undefined;
    let q: string | undefined;
    folderId.subscribe((v) => (folder = v))();
    view.subscribe((vv) => (v = vv as "all" | "favorite" | "recent"))();
    query.subscribe((vv) => (q = vv))();
    const resp = await imagesApi.list({
      folder_id: folder,
      view: v === "all" ? undefined : v,
      q,
      limit: 1000,
    });
    feedItems.set(resp.items);
    feedTotal.set(resp.total);
  } finally {
    feedLoading.set(false);
  }
}

export async function refreshScanProgress() {
  scanProgress.set(await scanApi.progress());
}

// 视图/筛选变化触发 feed 刷新
let lastKey = "";
async function feedAutoRefresh() {
  let folder: number | null | undefined;
  let v: "all" | "favorite" | "recent" | undefined;
  let q: string | undefined;
  folderId.subscribe((v) => (folder = v))();
  view.subscribe((vv) => (v = vv as "all" | "favorite" | "recent"))();
  query.subscribe((vv) => (q = vv))();
  const key = `${folder ?? ""}|${v}|${q}`;
  if (key === lastKey) return;
  lastKey = key;
  await refreshFeed();
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedRefresh() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(feedAutoRefresh, 200);
}

folderId.subscribe(debouncedRefresh);
view.subscribe(debouncedRefresh);
query.subscribe(debouncedRefresh);

// ---------- 选中图片详情加载 ----------


selectedId.subscribe(async (id) => {
  if (id === null) {
    selectedDetail.set(null);
    return;
  }
  try {
    selectedDetail.set(await imagesApi.detail(id));
  } catch {
    selectedDetail.set(null);
  }
});

// ---------- 派生：当前激活文件夹名 ----------


export const activeFolderName = derived(
    [folders, folderId, view],
    ([$folders, $folderId, $view]) => {
      if ($view === "favorite") return "收藏";
      if ($view === "recent") return "最近生成";
      if ($folderId === null) return "全部图片";
      const find = (nodes: FolderNode[]): FolderNode | null => {
        for (const n of nodes) {
          if (n.id === $folderId) return n;
          const f = find(n.children);
          if (f) return f;
        }
        return null;
      };
      return find($folders)?.name ?? "全部图片";
    }
);
