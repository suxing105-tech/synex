import { writable, derived } from "svelte/store";
import type { ComfyuiStatus, FeedResponse, FolderNode, ImageDetail, ImageSummary, MediaKind, ScanProgress, Stats } from "./types";
import { foldersApi, imagesApi, scanApi, statsApi } from "./api";
import { nextSelection, type Modifier, type SelectionState } from "./selection";

// ---------- 当前选中图片详情 ----------


export const selectedDetail = writable<ImageDetail | null>(null);
export const selectedId = writable<number | null>(null);

// ---------- 多选状态 ----------
//
// - selectedId: 单选 / 主选。DetailPanel 和 Lightbox 都靠它驱动，保持向后兼容。
// - multiSelectedIds: 当前被选中的 id 集合（>=1 个）。环形高亮用它。
// - selectionAnchorId: shift 区间选的锚点。每次"非 shift"点击会更新。
//   设计上 selectionAnchorId === selectedId（最后一次非 shift 的 primary），
//   但单独存一份便于 shift 在 primary 之外扩展（例如：先单选 A，ctrl 选 B，
//   再 shift 点 C，区间从 B → C，而不是 A → C）。
export const multiSelectedIds = writable<Set<number>>(new Set());
export const selectionAnchorId = writable<number | null>(null);

// ---------- Feed 视图状态 ----------


export const folderId = writable<number | null>(null);
export const view = writable<"all" | "favorite" | "recent">("all");
export const kind = writable<MediaKind>("image");
export const query = writable<string>("");
export const tag = writable<string | null>(null);

export const targetColumns = writable<number>(5);

export const feedItems = writable<ImageSummary[]>([]);
export const feedTotal = writable<number>(0);

export const feedLoading = writable<boolean>(false);

export const folders = writable<FolderNode[]>([]);
export const stats = writable<Stats>({ total_images: 0, total_videos: 0, favorites: 0, folders: 0 });

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

// ---------- 多选动作 ----------
//
// 调用方传入当前 feed 快照 + 被点的 id + 修饰键，
// 由纯函数 nextSelection 计算新状态并写入 stores。

export function applySelection(
  feedItemsSnap: ImageSummary[],
  clickId: number,
  modifier: Modifier,
): void {
  const current: SelectionState = {
    primary: getSelectedId(),
    selected: getMultiSelectedIds(),
    anchor: getSelectionAnchorId(),
  };
  const r = nextSelection(feedItemsSnap, current, clickId, modifier);
  selectedId.set(r.primary);
  multiSelectedIds.set(r.selected);
  selectionAnchorId.set(r.anchor);
}

export function clearSelection(): void {
  selectedId.set(null);
  multiSelectedIds.set(new Set());
  selectionAnchorId.set(null);
}

export function removeIdsFromSelection(ids: Iterable<number>): void {
  const removeSet = new Set(ids);
  // 先把要删的 id 全部从多选集合里剔掉，再决定 primary 落到谁头上
  let after = new Set<number>();
  multiSelectedIds.update((s) => {
    const next = new Set(s);
    for (const id of removeSet) next.delete(id);
    after = next;
    return next;
  });
  // primary 若被剔除：优先保留原 primary（如果还在新集合里），否则取集合第一个，否则 null
  selectedId.update((cur) => {
    if (cur === null || !removeSet.has(cur)) return cur;
    if (after.has(cur)) return cur;
    const first = after.values().next();
    return first.done ? null : first.value;
  });
  // anchor 若被剔除：直接清 null（语义上 anchor 没"备选"概念）
  selectionAnchorId.update((cur) => (cur !== null && removeSet.has(cur) ? null : cur));
}

function getSelectedId(): number | null {
  let v: number | null = null;
  selectedId.subscribe((x) => (v = x))();
  return v;
}
function getSelectionAnchorId(): number | null {
  let v: number | null = null;
  selectionAnchorId.subscribe((x) => (v = x))();
  return v;
}
function getMultiSelectedIds(): Set<number> {
  let v: Set<number> = new Set();
  multiSelectedIds.subscribe((x) => (v = x))();
  return v;
}

// ---------- 加载动作 ----------


export async function refreshFolders() {
  folders.set(await foldersApi.tree());
}

export async function refreshStats() {
  stats.set(await statsApi.get());
}

const pendingFeedRemovals = new Set<Set<number>>();
export function removeImageFromFeed(id: number) {
  for (const pending of pendingFeedRemovals) pending.add(id);
  feedItems.update((items) => {
    const next = items.filter((item) => item.id !== id);
    if (next.length !== items.length) feedTotal.update((n) => Math.max(0, n - 1));
    return next;
  });
  removeIdsFromSelection([id]);
}

let feedRequest = 0;
export async function refreshFeed() {
  const request = ++feedRequest;
  const removed = new Set<number>();
  pendingFeedRemovals.add(removed);
  feedLoading.set(true);
  try {
    let folder: number | null | undefined;
    let v: "all" | "favorite" | "recent" | undefined;
    let k: MediaKind | undefined;
    let q: string | undefined;
    let tg: string | null | undefined;
    folderId.subscribe((v) => (folder = v))();
    view.subscribe((vv) => (v = vv as "all" | "favorite" | "recent"))();
    kind.subscribe((kk) => (k = kk))();
    query.subscribe((vv) => (q = vv))();
    tag.subscribe((vv) => (tg = vv))();
    const resp = await imagesApi.list({
      folder_id: folder,
      view: v === "all" ? undefined : v,
      kind: k,
      q,
      tag: tg ?? undefined,
      limit: 1000,
    });
    if (request !== feedRequest) return;
    const items = resp.items.filter((item) => !removed.has(item.id));
    feedItems.set(items);
    feedTotal.set(Math.max(0, resp.total - (resp.items.length - items.length)));
  } finally {
    pendingFeedRemovals.delete(removed);
    if (request === feedRequest) feedLoading.set(false);
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
  let k: MediaKind | undefined;
  let q: string | undefined;
  folderId.subscribe((v) => (folder = v))();
  view.subscribe((vv) => (v = vv as "all" | "favorite" | "recent"))();
  kind.subscribe((kk) => (k = kk))();
  query.subscribe((vv) => (q = vv))();
  const key = String(folder ?? "") + "|" + String(v) + "|" + String(k) + "|" + String(q);
  if (key === lastKey) return;
  lastKey = key;
  await refreshFeed();
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedRefresh() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    try {
      await feedAutoRefresh();
    } catch (err) {
      console.warn("feed auto-refresh failed", err);
    }
  }, 200);
}

folderId.subscribe(debouncedRefresh);
view.subscribe(debouncedRefresh);
kind.subscribe(debouncedRefresh);
query.subscribe(debouncedRefresh);
tag.subscribe(debouncedRefresh);

// ---------- 选中图片详情加载 ----------


selectedId.subscribe(async (id) => {
  if (id === null) {
    selectedDetail.set(null);
    return;
  }
  try {
    const detail = await imagesApi.detail(id);
    if (getSelectedId() === id) selectedDetail.set(detail);
  } catch {
    if (getSelectedId() === id) selectedDetail.set(null);
  }
});

// 视图/筛选变化 → 清空选区（旧选中的 id 可能已经不在当前 feed）
folderId.subscribe(() => clearSelection());
view.subscribe(() => clearSelection());
kind.subscribe(() => clearSelection());
query.subscribe(() => clearSelection());
tag.subscribe(() => clearSelection());

// feedItems 变化（删除某张图 / 新入库）→ 把不存在的 id 从选区里剔除
feedItems.subscribe((items) => {
  const valid = new Set(items.map((it) => it.id));
  let after = new Set<number>();
  multiSelectedIds.update((s) => {
    let changed = false;
    const next = new Set(s);
    for (const id of s) {
      if (!valid.has(id)) {
        next.delete(id);
        changed = true;
      }
    }
    after = next;
    return changed ? next : s;
  });
  selectedId.update((cur) => {
    if (cur === null || valid.has(cur)) return cur;
    if (after.has(cur)) return cur;
    const first = after.values().next();
    return first.done ? null : first.value;
  });
  selectionAnchorId.update((cur) => (cur !== null && !valid.has(cur) ? null : cur));
});

// ---------- 派生：当前激活文件夹名 ----------


export const activeFolderName = derived(
    [folders, folderId, view, kind],
    ([$folders, $folderId, $view, $kind]) => {
      if ($view === "favorite") return "收藏";
      if ($view === "recent") return "最近生成";
      if ($folderId === null) return $kind === "video" ? "所有视频" : "全部图片";
      const find = (nodes: FolderNode[]): FolderNode | null => {
        for (const n of nodes) {
          if (n.id === $folderId) return n;
          const f = find(n.children);
          if (f) return f;
        }
        return null;
      };
      return find($folders)?.name ?? ($kind === "video" ? "所有视频" : "全部图片");
    }
);


// ---------- ComfyUI 集成 ----------


export const comfyuiStatus = writable<ComfyuiStatus>({
  running: false,
  url: "http://127.0.0.1:8188",
  enabled: true,
  checked_at: 0,
});


export const comfyuiEnabled = writable<boolean>(true);

