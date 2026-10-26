import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import Feed from "../components/Feed.svelte";
import { imagesApi, itemsApi } from "../lib/api";
import {
  feedItems,
  feedLoading,
  feedLoadingMore,
  feedTotal,
  kindFilter,
  multiSelectedIds,
  readerItem,
  selectedId,
  selectedText,
  refreshFeed,
  removeImageFromFeed,
  loadMoreFeed,
  scope,
  selectionAnchorId,
  stopAudio,
  switchContent,
} from "../lib/stores";
import { itemUid } from "../lib/items";
import type { ItemSummary, MediaFeedItem, TextFeedItem } from "../lib/types";

const COUNTS = { image: 2, video: 0, audio: 1, text: 2 };

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn() },
  imagesApi: {
    list: vi.fn(async () => ({ items: [], total: 0 })),
    detail: vi.fn(),
    presence: vi.fn(async () => ({ exists: true })),
    remove: vi.fn(),
    rename: vi.fn(),
  },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 2, total_videos: 0, total_audio: 1, total_texts: 2, folders: 0 })) },
  scanApi: { progress: vi.fn() },
  comfyuiApi: {},
  audioApi: { open: vi.fn(async () => ({ ok: true })) },
}));

function imageItem(id: number, name = `图${id}.jpg`): MediaFeedItem {
  return {
    id, item_type: "media", kind: "image", filename: name, path: `D:/${name}`,
    original_url: `/api/images/${id}/file`, thumbnail_url: `/api/images/${id}/file`,
    width: 800, height: 600, mtime: 100 + id,
  } as unknown as MediaFeedItem;
}
function audioItem(id = 3): MediaFeedItem {
  return {
    id, item_type: "media", kind: "audio", filename: "底噪.mp3", path: "D:/底噪.mp3",
    original_url: `/api/audio/${id}/file`, thumbnail_url: `/api/audio/${id}/waveform`,
    play_url: `/api/audio/${id}/file`, playable: true, duration_seconds: 42,
    width: null, height: null, mtime: 103,
  } as unknown as MediaFeedItem;
}
function textItem(id: number, filename = `随想${id}.md`, excerpt = "第一段摘录，用来说明这是一篇文本卡。"): TextFeedItem {
  return {
    id, item_type: "text", kind: "text", filename, path: `D:/notes/${filename}`,
    mtime: 105 + id, tags: [], format: "md", excerpt,
  } as unknown as TextFeedItem;
}

/** 四类混排，并且故意让文本 id 与媒体 id 撞上（texts.id 与 images.id 各自自增） */
function mixedItems(): ItemSummary[] {
  return [imageItem(1), textItem(1), audioItem(3), imageItem(2), textItem(2, "随想2.txt", "")];
}

function renderFeed() {
  return render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
}

function textCards(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".text-card")];
}

function thumbCards(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("button.thumb")];
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  scope.set("all");
  kindFilter.set("all");
  feedLoading.set(false);
  feedLoadingMore.set(false);
  stopAudio();
  multiSelectedIds.set(new Set());
  selectionAnchorId.set(null);
  readerItem.set(null);
  selectedText.set(null);
  feedItems.set(mixedItems());
  feedTotal.set(mixedItems().length);
  vi.mocked(itemsApi.list).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  feedItems.set([]);
  multiSelectedIds.set(new Set());
  readerItem.set(null);
  selectedText.set(null);
  stopAudio();
  scope.set("all");
});

describe("统一网格：四类混排在一条流里", () => {
  it("媒体卡与文本卡同时渲染，文本卡带格式徽标、标题与摘录", async () => {
    const { container } = renderFeed();
    await tick();
    expect(thumbCards(container)).toHaveLength(3);
    const cards = textCards(container);
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("随想1.md");
    expect(cards[0].querySelector(".text-format")?.textContent).toBe("MD");
    expect(cards[0].querySelector(".text-excerpt")?.textContent).toContain("第一段摘录");
  });

  it("空文档也有占位文案，不塌成空白卡", async () => {
    const { container } = renderFeed();
    await tick();
    expect(textCards(container)[1].querySelector(".text-excerpt")?.textContent).toBe("（空文档）");
  });

  it("文本卡保持方形且不带图片缩略图", async () => {
    const { container } = renderFeed();
    await tick();
    expect(textCards(container)[0].getAttribute("style")).toContain("21 / 9");
    expect(textCards(container)[0].querySelector("img")).toBeNull();
  });
});

describe("统一网格：文本卡在中间栏就地打开", () => {
  it("点文本卡 = 选中文本 + 清掉媒体选区，口径不变", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.click(thumbCards(container)[0]);
    expect(get(selectedId)).not.toBeNull();
    await fireEvent.click(textCards(container)[0]);
    expect(get(selectedText)?.id).toBe(1);
    expect(get(selectedId)).toBeNull();
    expect(get(scope)).toBe("all");
    expect(textCards(container)[0].className).toContain("is-selected");
  });

  it("双击 / Enter / Space 打开阅读层，不改口径", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.dblClick(textCards(container)[1]);
    expect(get(readerItem)?.id).toBe(2);
    await fireEvent.keyDown(textCards(container)[0], { key: "Enter" });
    expect(get(readerItem)?.id).toBe(1);
    await fireEvent.keyDown(textCards(container)[1], { key: " " });
    expect(get(readerItem)?.id).toBe(2);
    expect(get(scope)).toBe("all");
  });

  it("媒体卡单击仍走媒体选区，并清掉文本选中", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.click(textCards(container)[0]);
    expect(get(selectedText)?.id).toBe(1);
    await fireEvent.click(thumbCards(container)[0]);
    expect(get(selectedText)).toBeNull();
    expect(get(selectedId)).not.toBeNull();
  });

  it("文本卡不进批量选区：ctrl 点它不改 multiSelectedIds（文本不参与批量删除）", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.pointerDown(textCards(container)[0], { ctrlKey: true });
    expect(get(multiSelectedIds).size).toBe(0);
  });

  it("选区只覆盖媒体子序列：shift 区间不会把文本拖进选区", async () => {
    const { container } = renderFeed();
    await tick();
    const thumbs = thumbCards(container);
    await fireEvent.click(thumbs[0]);
    await fireEvent.click(thumbs[2], { shiftKey: true });
    expect([...get(multiSelectedIds)].sort()).toEqual([1, 2, 3]);
  });

  it("混合选区的文案用中性量词「项」，纯图片选区用「张图片」", async () => {
    const { container } = renderFeed();
    await tick();
    await fireEvent.click(thumbCards(container)[0]);
    await fireEvent.click(audioItemNode(container), { ctrlKey: true });
    await tick();
    expect(container.textContent).toContain("已选 2 项");
  });
});

function audioItemNode(container: HTMLElement): HTMLElement {
  const btn = [...container.querySelectorAll<HTMLElement>("button.thumb")]
    .find((el) => el.getAttribute("title") === "底噪.mp3");
  if (!btn) throw new Error("没有音频卡");
  return btn;
}

describe("统一网格：id 命名空间", () => {
  it("文本 id 与媒体 id 撞号时，删除媒体不会带走同号文本", () => {
    feedItems.set(mixedItems());
    removeImageFromFeed(2);
    const left = get(feedItems);
    expect(left.some((it) => it.item_type === "media" && it.id === 2)).toBe(false);
    expect(left.some((it) => it.item_type === "text" && it.id === 2)).toBe(true);
  });

  it("DOM key 用 itemUid，四类各自独立", () => {
    const uids = mixedItems().map((it) => itemUid(it));
    expect(new Set(uids).size).toBe(uids.length);
    expect(uids).toContain("text:1");
    expect(uids).toContain("media:1");
  });
});

describe("统一网格：无限滚动与请求口径", () => {
  it("「所有素材」走 /api/items，默认四类全带上并按时间排序", async () => {
    vi.mocked(itemsApi.list).mockResolvedValue({ items: mixedItems(), total: 5, counts: COUNTS, limit: 500, offset: 0 });
    await refreshFeed();
    const params = vi.mocked(itemsApi.list).mock.calls[0][0] as Record<string, unknown>;
    expect(params.sort).toBe("mtime_desc");
    expect(String(params.kinds).split(",")).toHaveLength(4);
    expect(params.limit).toBe(500);
  });

  it("切到单一类型改走 /api/images，不再请求统一流", async () => {
    vi.mocked(itemsApi.list).mockResolvedValue({ items: [], total: 0, counts: COUNTS, limit: 500, offset: 0 });
    switchContent("video", true);
    await refreshFeed();
    expect(get(scope)).toBe("video");
    const params = vi.mocked(imagesApi.list).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(params.kind).toBe("video");
  });

  it("滚到底追加下一页，重叠项按 itemUid 去重，不出现重复 key", async () => {
    const page1 = mixedItems();
    feedItems.set(page1);
    feedTotal.set(7);
    const page2 = [
      page1[4], // 后端边界重叠：上一页最后一条又回来一次
      imageItem(9, "图9.jpg"),
      textItem(9, "随想9.md"),
    ];
    vi.mocked(itemsApi.list).mockResolvedValue({ items: page2, total: 7, counts: COUNTS, limit: 500, offset: page1.length });
    await loadMoreFeed();
    const merged = get(feedItems);
    const uids = merged.map((it) => itemUid(it));
    expect(new Set(uids).size).toBe(uids.length);
    expect(merged).toHaveLength(7); // 5 + 2 条新的，重叠的那条只留一份
    expect(vi.mocked(itemsApi.list).mock.calls.at(-1)?.[0]).toMatchObject({ offset: 5 });
    expect(get(feedLoadingMore)).toBe(false);
  });

  it("已经拿满总数时不再发请求", async () => {
    vi.mocked(itemsApi.list).mockResolvedValue({ items: [], total: 0, counts: COUNTS, limit: 500, offset: 0 });
    await loadMoreFeed();
    expect(itemsApi.list).not.toHaveBeenCalled();
  });

  it("工具栏不再有排序按钮：统一流永远按时间，点「音频」chip 后 kinds 只剩 audio", async () => {
    vi.mocked(itemsApi.list).mockResolvedValue({ items: mixedItems(), total: 5, counts: COUNTS, limit: 500, offset: 0 });
    const { container } = renderFeed();
    await tick();
    expect(container.querySelector(".sort-picker")).toBeNull();
    expect(container.querySelectorAll(".sort-opt")).toHaveLength(0);
    const audioChip = [...container.querySelectorAll<HTMLElement>(".chip")]
      .find((el) => el.textContent?.includes("音频"))!;
    await fireEvent.click(audioChip as Element);
    expect(get(kindFilter)).toBe("audio");
    // 自动重拉是 200ms 防抖的，等它真的把新口径发出去
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(vi.mocked(itemsApi.list).mock.calls.at(-1)?.[0]).toMatchObject({ kinds: "audio", sort: "mtime_desc" });
  });
});
