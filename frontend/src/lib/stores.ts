import { writable, derived, get } from "svelte/store";
import { tick } from "svelte";
import type {
  ComfyuiStatus,
  FolderCounts,
  FolderNode,
  ImageDetail,
  ItemKind,
  ItemSummary,
  MediaFeedItem,
  Scope,
  TextFeedItem,
  ScanProgress,
  Stats,
} from "./types";
import { foldersApi, imagesApi, itemsApi, scanApi, statsApi } from "./api";
import { isMediaItem, itemUid, mediaOnly } from "./items";
import { nextSelection, type Modifier, type SelectionState } from "./selection";

// ---------- 当前选中图片详情 ----------


export const selectedDetail = writable<ImageDetail | null>(null);
export const selectedId = writable<number | null>(null);

// ---------- 多选状态 ----------
//
// - selectedId: 单选 / 主选。DetailPanel 和 Lightbox 都靠它驱动，保持向后兼容。
// - multiSelectedIds: 当前被选中的 id 集合（>=1 个）。环形高亮用它。
// - selectionAnchorId: shift 区间选的锚点。每次"非 shift"点击会更新。
//   选区只覆盖媒体项：文本卡在统一流里是只读入口，不参与选区。
export const multiSelectedIds = writable<Set<number>>(new Set());
export const selectionAnchorId = writable<number | null>(null);

// ---------- 浏览口径（scope） ----------
//
// 侧栏一行 = 一个 scope，同时决定：feed 请求参数、计数量词、卡片类型、快捷键。
// 0.2.21 之前这是 kind + textMode + view 三个 store，同一行数字在三种组合下含义不同，
// 用户看不出「这个数字数的是什么」；现在收成一个 scope，口径由 lib/counts.ts 单点定义。

export const scope = writable<Scope>("all");

/**
 * 遗留开关：文本工作区是否可见。
 *
 * 0.2.24 之前它是 `derived(scope === 'text')`，所以「文本口径」= 卸载整个图库、
 * 换成全屏 TextWorkspace —— 这就是文本用起来像另一个应用的原因。现在文本和图片
 * 一样在中间栏里就地打开（TextReader / Lightbox / VideoPlayer 同一层），
 * scope 只决定网格里放什么。工作区入口已全部收掉、组件不再挂载，
 * 这个 store 只给它内部那批 `get(textMode)` 门控用，下一轮随文件一起删除。
 */
export const textMode = writable(false);

export const folderId = writable<number | null>(null);
export const query = writable<string>("");
export const tag = writable<string | null>(null);

/** 每个 scope 记住自己的文件夹与搜索条件，切回来不用重新选。 */
type ScopeMemory = { folder: number | null; query: string; tag: string | null };
const scopeMemory = new Map<Scope, ScopeMemory>();

export function switchContent(next: Scope, all = false, keepFolder = false) {
  const current = get(scope);
  if (current !== next) {
    scopeMemory.set(current, { folder: get(folderId), query: get(query), tag: get(tag) });
  }
  const saved = scopeMemory.get(next);
  const folder = get(folderId);
  scope.set(next);
  folderId.set(keepFolder ? folder : all ? null : saved?.folder ?? null);
  query.set(all ? "" : saved?.query ?? "");
  tag.set(all ? null : saved?.tag ?? null);
}

/**
 * 「所有素材」的类型过滤（chips）：**单选**。
 * 「全部」= 四类都要；点某一类 = 只看那一类。原来做成可任意组合的多选，
 * 长相是切换器、行为是筛选器，第二下几乎没人点；改成和侧栏同构的单选。
 */
export const ALL_KINDS: readonly ItemKind[] = ["image", "video", "audio", "text"];
export type KindFilter = ItemKind | "all";
const KIND_STORAGE_KEY = "seekx.item-kind.v1";
/** 0.2.22 r4 之前的多选键，只用于一次性迁移；组合选择单选表达不了，直接放弃。 */
const LEGACY_KINDS_KEY = "seekx.item-kinds.v1";

function isKind(value: unknown): value is ItemKind {
  return typeof value === "string" && (ALL_KINDS as readonly string[]).includes(value);
}

function readStoredKindFilter(): KindFilter {
  try {
    const saved = localStorage.getItem(KIND_STORAGE_KEY);
    if (isKind(saved)) return saved;
    const legacy = localStorage.getItem(LEGACY_KINDS_KEY);
    if (legacy !== null) {
      localStorage.removeItem(LEGACY_KINDS_KEY);
      const parsed: unknown = JSON.parse(legacy);
      const picked = Array.isArray(parsed) ? parsed.filter(isKind) : [];
      if (picked.length === 1) return picked[0];
    }
    return "all";
  } catch {
    /* 隐私模式下 localStorage 不可用：过滤只在本次会话内生效，不影响浏览 */
    return "all";
  }
}

export const kindFilter = writable<KindFilter>(readStoredKindFilter());

/** 单选：再点已选中的那一类不取消 —— 过滤条件为空没有意义。 */
export function selectKind(next: KindFilter): void {
  kindFilter.set(next);
  try {
    localStorage.setItem(KIND_STORAGE_KEY, next);
  } catch {
    /* 同上 */
  }
}

/** 发给 /api/items 的 kinds：「全部」= 四类全带上，与后端 counts 口径一致。 */
export function kindsOfFilter(value: KindFilter): ItemKind[] {
  return value === "all" ? [...ALL_KINDS] : [value];
}

export const targetColumns = writable<number>(5);

/** 统一流：scope==='all' 时是四类混排，'text' 时只有文本，其余 scope 只有媒体。 */
export const feedItems = writable<ItemSummary[]>([]);
export const feedTotal = writable<number>(0);
export const feedLoading = writable<boolean>(false);
export const feedLoadingMore = writable<boolean>(false);
/** 当前过滤条件下的四类计数（不含 kinds 过滤），供工具栏与 chips 显示。 */
export const feedCounts = writable<FolderCounts>({ image: 0, video: 0, audio: 0, text: 0 });

/** 选区 / Lightbox / 删除 / 移动只认这条媒体子序列。 */
export const mediaItems = derived(feedItems, (items) => mediaOnly(items));

/** 当前在播的是哪条音频（null = 没有）。全应用只有一个 <audio> 实例（AudioEngine.svelte），
 *  控制界面在音频卡本身上，没有待机播放条。 */
export const playingAudio = writable<MediaFeedItem | null>(null);

/** 当前播放位置（秒），由 AudioEngine 写入，只有 playingAudio 非空时有意义。 */
export const audioProgress = writable<number>(0);

export function playAudio(item: MediaFeedItem) {
  audioProgress.set(0);
  playingAudio.set(item);
}

export function stopAudio() {
  playingAudio.set(null);
  audioProgress.set(0);
}

/** 统一流里点文本卡 → 文本工作区要打开哪一篇。TextWorkspace 常驻（靠 display:none 隐藏），
 *  卸载期的 window 事件会丢，所以走 store。遗留：随工作区一起删除。 */
export const pendingTextOpen = writable<number | null>(null);

// ---------- 文本：选中 / 阅读层 / 关联 ----------
//
// 三个通道都不能借用 selectedId：texts.id 与 images.id 各自自增，
// 同一个数字可以同时指向一篇文章和一张图（见 lib/items.ts 的 itemUid）。
export const selectedText = writable<TextFeedItem | null>(null);
/** 中间栏阅读层打开的那一篇，null = 阅读层关闭。 */
export const readerItem = writable<TextFeedItem | null>(null);
/** 打开阅读层那一刻的搜索词快照：正文命中高亮与跳转都按它算。 */
export const readerTerm = writable<string>("");
/** 拖到侧栏 / 网格的 .txt/.md/.srt/.vtt 路径，交给关联弹层处理。 */
export const associateTextPaths = writable<string[] | null>(null);

/** 阅读层里存过盘或改过元数据，关闭时要把网格摘录刷新一次。 */
let textFeedStale = false;
export function markTextFeedStale(): void { textFeedStale = true; }

/** 单击文本卡 = 选中文本并清掉媒体选区（两套选中互斥，右侧栏只讲一件事）。 */
export function selectTextItem(item: TextFeedItem): void {
  selectedId.set(null);
  multiSelectedIds.set(new Set());
  selectionAnchorId.set(null);
  selectedDetail.set(null);
  selectedText.set(item);
}

/** 打开后是否直接进编辑态：详情栏「就地编辑」与右键菜单用它，阅读层读完就清掉。 */
export const readerWantsEdit = writable(false);

/** 双击 / 空格：在中间栏打开这一篇，term 默认取当前搜索词。 */
export function openTextReader(item: TextFeedItem, term = get(query), edit = false): void {
  selectTextItem(item);
  readerTerm.set(term.trim());
  readerWantsEdit.set(edit);
  readerItem.set(item);
}

/** 返回缩略图：只在正文或元数据真变过时才重新拉一页，避免白跑一次网络。 */
export async function closeTextReader(): Promise<void> {
  readerItem.set(null);
  readerTerm.set("");
  if (!textFeedStale) return;
  textFeedStale = false;
  await refreshFeed({ keepScroll: true });
}

export const folders = writable<FolderNode[]>([]);
export const stats = writable<Stats>({
  total_images: 0,
  total_videos: 0,
  total_audio: 0,
  total_texts: 0,
  folders: 0,
});

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
// 调用方传入当前媒体子序列 + 被点的 id + 修饰键，
// 由纯函数 nextSelection 计算新状态并写入 stores。

export function applySelection(
  mediaSnapshot: ReadonlyArray<{ id: number }>,
  clickId: number,
  modifier: Modifier,
): void {
  const current: SelectionState = {
    primary: getSelectedId(),
    selected: getMultiSelectedIds(),
    anchor: getSelectionAnchorId(),
  };
  const r = nextSelection(mediaSnapshot, current, clickId, modifier);
  selectedId.set(r.primary);
  multiSelectedIds.set(r.selected);
  selectionAnchorId.set(r.anchor);
  selectedText.set(null);
}

export function clearSelection(): void {
  selectedId.set(null);
  multiSelectedIds.set(new Set());
  selectionAnchorId.set(null);
  selectedText.set(null);
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
    const next = items.filter((item) => !(isMediaItem(item) && item.id === id));
    if (next.length !== items.length) feedTotal.update((n) => Math.max(0, n - 1));
    return next;
  });
  removeIdsFromSelection([id]);
}

/**
 * 重拉当前选中项的详情。文件被真实移动后要刷新「所在文件夹」，
 * 传 ids 时只有选中项在 ids 里才发请求（批量移动只关心正打开的那一张）。
 * 失败（文件正在被搬走 / 已删除）保留旧详情，提示交给调用方。
 */
export async function refreshSelectedDetail(ids?: Iterable<number>): Promise<void> {
  const detail = get(selectedDetail);
  if (!detail) return;
  if (ids && !Array.from(ids).includes(detail.id)) return;
  try {
    const fresh = await imagesApi.detail(detail.id);
    if (get(selectedDetail)?.id === detail.id) selectedDetail.set(fresh);
  } catch {
    // 保留旧详情：详情面板显示上一次已知位置，不额外弹错
  }
}

// ---------- feed 拉取 ----------

/** 一屏 500 项：比原来一次性拉 1000 项首屏更快，剩下的滚到底再要。 */
export const FEED_PAGE = 500;

type FeedParams = {
  folder: number | null;
  scope: Scope;
  q: string;
  tag: string | null;
  kinds: ItemKind[];
};

function currentFeedParams(): FeedParams {
  return {
    folder: get(folderId),
    scope: get(scope),
    q: get(query),
    tag: get(tag),
    kinds: kindsOfFilter(get(kindFilter)),
  };
}

function countsForSingleKind(scope: Scope, total: number): FolderCounts {
  const base: FolderCounts = { image: 0, video: 0, audio: 0, text: 0 };
  // 单一口径只数这一类：文本口径也不例外，否则「全部文本」下 chip 会显示 0 篇文本
  if (scope !== "all") base[scope] = total;
  return base;
}

/** Feed 注册进来：实时刷新要保住滚动位置，切换筛选则要回到顶部。 */
let scrollBridge: { capture(): number; restore(value: number): void } | null = null;
export function setFeedScrollBridge(bridge: typeof scrollBridge) {
  scrollBridge = bridge;
}

async function fetchFeedPage(params: FeedParams, offset: number, removed: Set<number>) {
  // 「全部文本」也走统一流：只有 /api/items 会给带 item_type:"text" 的行，
  // /api/images?kind=text 那条从来不返回文本，Feed 也就画不出文本卡。
  if (params.scope === "all" || params.scope === "text") {
    if (params.scope === "text") params.kinds = ["text"];
    const resp = await itemsApi.list({
      folder_id: params.folder,
      q: params.q || undefined,
      tag: params.tag || undefined,
      kinds: params.kinds.join(","),
      // 统一流固定「新的在前」：0.2.22 验收时撤掉了名称排序按钮，后端仍保留 sort 参数
      sort: "mtime_desc",
      limit: FEED_PAGE,
      offset,
    });
    const items = resp.items.filter((item) => !(isMediaItem(item) && removed.has(item.id)));
    const total = Math.max(0, resp.total - (resp.items.length - items.length));
    // 单一口径下侧栏只数这一类，counts 别把另外三类的结构带过去（与 image/video/audio 一致）。
    const counts = params.scope === "text" ? countsForSingleKind("text", total) : resp.counts;
    return { items, total, counts };
  }
  const resp = await imagesApi.list({
    folder_id: params.folder,
    kind: params.scope as Exclude<Scope, "all" | "text">,
    q: params.q || undefined,
    tag: params.tag || undefined,
    limit: FEED_PAGE,
    offset,
  });
  const items: MediaFeedItem[] = resp.items
    .filter((item) => !removed.has(item.id))
    .map((item) => ({ ...item, item_type: "media" as const }));
  return {
    items,
    total: Math.max(0, resp.total - (resp.items.length - items.length)),
    counts: countsForSingleKind(params.scope, resp.total),
  };
}

export async function refreshFeed(opts?: { keepScroll?: boolean }): Promise<void> {
  const request = ++feedRequest;
  const removed = new Set<number>();
  pendingFeedRemovals.add(removed);
  const keepScroll = opts?.keepScroll === true;
  const scrollTop = keepScroll ? (scrollBridge?.capture() ?? 0) : 0;
  feedLoading.set(true);
  try {
    const params = currentFeedParams();
    const page = await fetchFeedPage(params, 0, removed);
    if (request !== feedRequest) return;
    feedItems.set(page.items);
    feedTotal.set(page.total);
    feedCounts.set(page.counts);
    if (keepScroll) {
      await tick();
      scrollBridge?.restore(scrollTop);
    }
  } finally {
    pendingFeedRemovals.delete(removed);
    if (request === feedRequest) feedLoading.set(false);
  }
}

/** 滚到底接着要下一页；重复项按 itemUid 去重，绝不出现在两屏里。 */
export async function loadMoreFeed(): Promise<void> {
  if (get(feedLoading) || get(feedLoadingMore)) return;
  const params = currentFeedParams();
  const loaded = get(feedItems);
  if (loaded.length >= get(feedTotal)) return;
  const request = feedRequest;
  feedLoadingMore.set(true);
  try {
    const page = await fetchFeedPage(params, loaded.length, new Set());
    if (request !== feedRequest || get(feedItems).length !== loaded.length) return;
    const seen = new Set(loaded.map((item) => itemUid(item)));
    const merged = [...loaded];
    for (const item of page.items) {
      const uid = itemUid(item);
      if (seen.has(uid)) continue;
      seen.add(uid);
      merged.push(item);
    }
    feedItems.set(merged);
    feedTotal.set(Math.max(page.total, merged.length));
    feedCounts.set(page.counts);
  } finally {
    feedLoadingMore.set(false);
  }
}

export async function refreshScanProgress() {
  scanProgress.set(await scanApi.progress());
}

// ---------- 订阅：口径/筛选变化 → 重拉 ----------

let feedRequest = 0;
let lastKey = "";
async function feedAutoRefresh() {
  const params = currentFeedParams();
  const key = [
    params.folder ?? "",
    params.scope,
    params.q,
    params.scope === "all" ? [...params.kinds].sort().join(",") : "",
    params.tag ?? "",
  ].join("|");
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
scope.subscribe(debouncedRefresh);
query.subscribe(debouncedRefresh);
tag.subscribe(debouncedRefresh);
kindFilter.subscribe(debouncedRefresh);

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

// 口径/筛选变化 → 清空选区（旧选中的 id 可能已经不在当前 feed）
folderId.subscribe(() => clearSelection());
scope.subscribe(() => clearSelection());
query.subscribe(() => clearSelection());
tag.subscribe(() => clearSelection());

// feedItems 变化（删除某张图 / 新入库）→ 把不存在的 id 从选区里剔除。
// 只看媒体子序列：文本项的 id 与媒体 id 会撞号，不能拿来验真。
feedItems.subscribe((items) => {
  const valid = new Set(mediaOnly(items).map((it) => it.id));
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

const SCOPE_TITLES: Record<Scope, string> = {
  all: "所有素材",
  image: "全部图片",
  video: "所有视频",
  audio: "全部音频",
  text: "全部文本",
};

export const activeFolderName = derived([folders, folderId, scope], ([$folders, $folderId, $scope]) => {
  if ($folderId === null) return SCOPE_TITLES[$scope];
  const find = (nodes: FolderNode[]): FolderNode | null => {
    for (const n of nodes) {
      if (n.id === $folderId) return n;
      const f = find(n.children);
      if (f) return f;
    }
    return null;
  };
  return find($folders)?.name ?? SCOPE_TITLES[$scope];
});

export const activeScopeTitle = derived(scope, (s) => SCOPE_TITLES[s]);


// ---------- ComfyUI 集成 ----------


export const comfyuiStatus = writable<ComfyuiStatus>({
  running: false,
  url: "http://127.0.0.1:8188",
  enabled: true,
  checked_at: 0,
});


export const comfyuiEnabled = writable<boolean>(true);