import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import Feed from "../components/Feed.svelte";
import { imagesApi, itemsApi } from "../lib/api";
import {
  feedItems, feedLoading, feedLoadingMore, folders, kindFilter,
  refreshFeed, scope, switchContent,
} from "../lib/stores";
import { feedSort, setFeedSort } from "../lib/feed-sort";
import type { ItemSummary } from "../lib/types";

/**
 * 卡片右键菜单里的「排序」子菜单（2026-11-24 苏醒要求）。
 *
 * 要钉住的不只是「菜单里多了两项」，而是**四种卡片都有入口**、**换档真的会重拉**、
 * 以及**两条后端路都收到新 sort**：侧栏单一口径走 /api/images、统一流走 /api/items，
 * 少接一条就是四种口径里有三种点了没反应。
 */
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 }, limit: 500, offset: 0 })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(), presence: vi.fn(async () => ({ exists: true })), remove: vi.fn(), rename: vi.fn(), reveal: vi.fn(), copyFile: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 1, total_videos: 1, total_audio: 1, total_texts: 1, folders: 0 })) },
  scanApi: { progress: vi.fn(async () => ({ scanning: false, total: 0, done: 0 })) },
  comfyuiApi: {}, videosApi: { open: vi.fn() }, audioApi: { open: vi.fn(async () => ({ ok: true })) },
}));

const IMAGE = { item_type: "media", id: 1, kind: "image", filename: "a.png", path: "D:/a.png", mtime: 500, width: 1600, height: 900 };
const VIDEO = { item_type: "media", id: 2, kind: "video", filename: "b.mp4", path: "D:/b.mp4", mtime: 400, width: 1920, height: 1080, duration_seconds: 12 };
const AUDIO = { item_type: "media", id: 3, kind: "audio", filename: "c.mp3", path: "D:/c.mp3", mtime: 300, duration_seconds: 42 };
const TEXT = { item_type: "text", id: 4, kind: "text", filename: "d.md", path: "D:/d.md", mtime: 200, tags: [], format: "md", excerpt: "摘录" };
const FOUR = [IMAGE, VIDEO, AUDIO, TEXT] as unknown as ItemSummary[];

/** 四类卡：媒体卡与文本卡是两个不同的渲染分支、两份不同的菜单构建，必须挨个点名。 */
const CARDS: { name: string; nav: string }[] = [
  { name: "图片", nav: "media:1" },
  { name: "视频", nav: "media:2" },
  { name: "音频", nav: "media:3" },
  { name: "文本", nav: "text:4" },
];

function renderFeed() {
  return render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
}
async function openMenuOn(ui: ReturnType<typeof renderFeed>, nav: string) {
  const card = ui.container.querySelector(`[data-nav-id="${nav}"]`);
  if (!card) throw new Error(`画不出这张卡：${nav}`);
  await fireEvent.contextMenu(card, { clientX: 60, clientY: 60 });
  await tick();
  return card;
}
async function expandSort(ui: ReturnType<typeof renderFeed>) {
  const item = ui.getByRole("menuitem", { name: "排序" });
  await fireEvent.pointerEnter(item);
  await tick();
  return item;
}
/** 取标签本体：带子菜单那一项的 textContent 尾巴上有个箭头，整串比会误判成「没有这一项」。 */
function labels(ui: ReturnType<typeof renderFeed>): string[] {
  const menus = ui.container.querySelectorAll<HTMLElement>('[role="menu"]');
  return [...menus[0].querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
    (n) => n.querySelector("span")?.textContent?.trim() ?? "",
  );
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  localStorage.clear();
  feedSort.set("mtime_desc");
  scope.set("all");
  kindFilter.set("all");
  folders.set([]);
  feedLoading.set(false);
  feedLoadingMore.set(false);
  feedItems.set(FOUR);
  vi.mocked(itemsApi.list).mockClear().mockResolvedValue({
    items: FOUR, total: 4, counts: { image: 1, video: 1, audio: 1, text: 1 }, limit: 500, offset: 0,
  } as never);
  vi.mocked(imagesApi.list).mockClear().mockResolvedValue({
    items: FOUR.filter((it) => it.item_type === "media"), total: 3,
  } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  feedItems.set([]);
  scope.set("all");
  kindFilter.set("all");
  feedSort.set("mtime_desc");
});

describe("卡片右键菜单的「排序」子菜单", () => {
  it("图片 / 视频 / 音频 / 文本四类卡的菜单里都有「排序」，而且它是个子菜单", async () => {
    const ui = renderFeed();
    await tick();
    for (const card of CARDS) {
      await openMenuOn(ui, card.nav);
      const item = ui.getByRole("menuitem", { name: "排序" });
      expect(item.getAttribute("aria-haspopup"), `${card.name}卡的「排序」不是子菜单`).toBe("menu");
      expect(ui.queryByText("按名称排序")).toBeNull();
      await expandSort(ui);
      expect(ui.getByRole("menuitem", { name: "按名称排序" })).toBeTruthy();
      expect(ui.getByRole("menuitem", { name: "按时间排序" })).toBeTruthy();
      await fireEvent.keyDown(document.body, { key: "Escape" });
    }
  });

  it("当前生效那一档点亮，另一档不亮", async () => {
    const ui = renderFeed();
    await tick();
    await openMenuOn(ui, "media:1");
    await expandSort(ui);
    const active = [...ui.container.querySelectorAll<HTMLElement>('[role="menuitem"].active')].map((n) => n.textContent?.trim());
    expect(active).toEqual(["按时间排序"]);
    setFeedSort("name_asc");
    await tick();
    await openMenuOn(ui, "media:1");
    await expandSort(ui);
    expect([...ui.container.querySelectorAll<HTMLElement>('[role="menuitem"].active')].map((n) => n.textContent?.trim())).toEqual(["按名称排序"]);
  });

  it("「排序」排在子菜单那一堆里、危险项之前：移动到… → 排序 → 移入回收站", async () => {
    const ui = renderFeed();
    await tick();
    await openMenuOn(ui, "media:1");
    const media = labels(ui);
    expect(media.indexOf("排序")).toBe(media.indexOf("移动到…") + 1);
    expect(media[media.length - 1]).toBe("移入回收站");
    await fireEvent.keyDown(document.body, { key: "Escape" });

    await openMenuOn(ui, "text:4");
    const text = labels(ui);
    expect(text.indexOf("排序")).toBe(text.indexOf("重命名") + 1);
    expect(text[text.length - 1]).toBe("移入回收站");
  });

  it("统一流里点「按名称排序」：换 store、关菜单、重拉时把 sort 送给 /api/items", async () => {
    const ui = renderFeed();
    await tick();
    const before = vi.mocked(itemsApi.list).mock.calls.length;
    await openMenuOn(ui, "media:1");
    await expandSort(ui);
    await fireEvent.click(ui.getByRole("menuitem", { name: "按名称排序" }));
    expect(get(feedSort)).toBe("name_asc");
    expect(ui.container.querySelector('[role="menu"]')).toBeNull();
    // 自动重拉是 200ms 防抖的，等它真的把新口径发出去
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(vi.mocked(itemsApi.list).mock.calls.length).toBeGreaterThan(before);
    expect(vi.mocked(itemsApi.list).mock.calls.at(-1)?.[0]).toMatchObject({ sort: "name_asc" });
  });

  it("侧栏单一口径（全部视频）走 /api/images，也一样收到新 sort", async () => {
    switchContent("video", true);
    await refreshFeed();
    const ui = renderFeed();
    await tick();
    expect(vi.mocked(imagesApi.list).mock.calls.at(-1)?.[0]).toMatchObject({ kind: "video", sort: "mtime_desc" });
    await openMenuOn(ui, "media:2");
    await expandSort(ui);
    await fireEvent.click(ui.getByRole("menuitem", { name: "按名称排序" }));
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(vi.mocked(imagesApi.list).mock.calls.at(-1)?.[0]).toMatchObject({ kind: "video", sort: "name_asc" });
  });

  it("点已经生效那一档不产生第二次请求：换档靠 key 比对，不靠重复点", async () => {
    const ui = renderFeed();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 260));
    const before = vi.mocked(itemsApi.list).mock.calls.length;
    await openMenuOn(ui, "media:1");
    await expandSort(ui);
    await fireEvent.click(ui.getByRole("menuitem", { name: "按时间排序" }));
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(get(feedSort)).toBe("mtime_desc");
    expect(vi.mocked(itemsApi.list).mock.calls.length).toBe(before);
  });
});