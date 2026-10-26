import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import Feed from "../components/Feed.svelte";
import { itemsApi } from "../lib/api";
import { textsApi } from "../lib/texts";
import { isTextFilePath } from "../lib/text-reading";
import {
  associateTextPaths,
  feedCounts,
  feedItems,
  feedLoading,
  feedLoadingMore,
  kindFilter,
  query,
  readerItem,
  readerWantsEdit,
  refreshFeed,
  scope,
  selectedText,
  switchContent,
} from "../lib/stores";
import type { TextDetail } from "../lib/texts";
import type { ItemSummary, TextFeedItem } from "../lib/types";

/**
 * 「全部文本」口径：文本必须是网格里的普通一格，而不是另一个页面。
 *
 * 这里锁三件事：请求口径只能走统一流（/api/items 才给 item_type:"text"）、
 * 工具栏只留「新建 / 关联」两个入口、页面上找不到任何文本工作台入口。
 */
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(), presence: vi.fn(async () => ({ exists: true })), remove: vi.fn(), rename: vi.fn(), reveal: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 0, total_videos: 0, total_audio: 0, total_texts: 2, folders: 0 })) },
  scanApi: { progress: vi.fn() }, comfyuiApi: {}, videosApi: { open: vi.fn() }, audioApi: { open: vi.fn(async () => ({ ok: true })) },
}));

const card = (id: number, filename = `随想${id}.md`): TextFeedItem => ({
  item_type: "text", id, kind: "text", filename, path: `D:/notes/${filename}`,
  mtime: 105 + id, tags: [], format: filename.endsWith(".md") ? "md" : "txt", excerpt: "摘录",
} as TextFeedItem);

const created = (): TextDetail => ({
  ...card(9, "新笔记.md"), created: 1, opened: 1, missing: false, error: "",
  body: "", version: "v1", encoding: "utf-8", newline: "LF", bom: false, readonly: false, needs_encoding: false,
} as TextDetail);

function renderFeed() {
  return render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
}
const toolbarButton = (ui: ReturnType<typeof renderFeed>, name: string) =>
  [...ui.container.querySelectorAll<HTMLElement>("button")].find((el) => el.textContent?.trim() === name);

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  localStorage.clear();
  scope.set("all");
  kindFilter.set("all");
  query.set("");
  feedLoading.set(false);
  feedLoadingMore.set(false);
  readerItem.set(null);
  readerWantsEdit.set(false);
  selectedText.set(null);
  associateTextPaths.set(null);
  feedItems.set([]);
  vi.mocked(itemsApi.list).mockReset();
  vi.mocked(itemsApi.list).mockResolvedValue({ items: [card(1), card(2)], total: 2, counts: { image: 0, video: 0, audio: 0, text: 2 }, limit: 500, offset: 0 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  feedItems.set([]);
  readerItem.set(null);
  readerWantsEdit.set(false);
  selectedText.set(null);
  associateTextPaths.set(null);
  scope.set("all");
  kindFilter.set("all");
});

describe("「全部文本」口径的请求", () => {
  it("走统一流并且 kinds 只剩 text，不再请求 /api/images", async () => {
    switchContent("text", true);
    await refreshFeed();
    expect(get(scope)).toBe("text");
    expect(vi.mocked(itemsApi.list).mock.calls.at(-1)?.[0]).toMatchObject({ kinds: "text", sort: "mtime_desc" });
  });

  it("counts 归一成只填文本这一类，侧栏不会拿到另外三类的数字", async () => {
    switchContent("text", true);
    await refreshFeed();
    expect(get(feedCounts)).toEqual({ image: 0, video: 0, audio: 0, text: 2 });
    expect(get(feedItems)).toHaveLength(2);
  });
});

describe("「全部文本」口径的网格与工具栏", () => {
  it("文本卡直接画在网格里，搜索框文案跟着换成「搜索文本」", async () => {
    feedItems.set([card(1), card(2, "随想2.txt")] as ItemSummary[]);
    switchContent("text", true);
    const ui = renderFeed();
    await tick();
    expect(ui.container.querySelectorAll(".text-card")).toHaveLength(2);
    expect(ui.getByRole("searchbox", { name: "搜索文本" })).toBeTruthy();
  });

  it("工具栏只有「新建文本」「关联本地文本」，页面上没有文本工作台入口", async () => {
    feedItems.set([card(1)] as ItemSummary[]);
    switchContent("text", true);
    const ui = renderFeed();
    await tick();
    expect(toolbarButton(ui, "新建文本")).toBeTruthy();
    expect(toolbarButton(ui, "关联本地文本")).toBeTruthy();
    expect(ui.container.textContent).not.toMatch(/工作台|工作区/);
  });

  it("类型筛选只勾文本时同样给出这两个入口", async () => {
    feedItems.set([card(1)] as ItemSummary[]);
    kindFilter.set("text");
    const ui = renderFeed();
    await tick();
    expect(toolbarButton(ui, "新建文本")).toBeTruthy();
    expect(toolbarButton(ui, "关联本地文本")).toBeTruthy();
  });

  it("图片口径不显示这两个入口", async () => {
    feedItems.set([card(1)] as ItemSummary[]);
    const ui = renderFeed();
    await tick();
    expect(toolbarButton(ui, "新建文本")).toBeUndefined();
    expect(toolbarButton(ui, "关联本地文本")).toBeUndefined();
  });

  it("空文本口径给「新建文本 / 关联本地文本」两个起手式", async () => {
    feedItems.set([]);
    switchContent("text", true);
    const ui = renderFeed();
    await tick();
    const empty = ui.getByLabelText("还没有文本");
    expect(empty.textContent).toContain("新建文本");
    expect(empty.textContent).toContain("关联本地文本");
  });
});

describe("文本口径的两个入口", () => {
  it("「新建文本」打开建档弹层，创建成功后直接在中间栏进编辑态", async () => {
    const create = vi.spyOn(textsApi, "create").mockResolvedValue(created());
    feedItems.set([]);
    switchContent("text", true);
    const ui = renderFeed();
    await tick();
    await fireEvent.click(toolbarButton(ui, "新建文本")!);
    const dialog = await ui.findByRole("dialog", { name: "新建文本" });
    await fireEvent.input(dialog.querySelector('[aria-label="保存目录"]')!, { target: { value: "D:/notes" } });
    await fireEvent.input(dialog.querySelector('[aria-label="文件名"]')!, { target: { value: "新笔记" } });
    await fireEvent.click(ui.getByRole("button", { name: "创建并编辑" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(vi.mocked(create).mock.calls[0][0]).toMatchObject({ directory: "D:/notes", name: "新笔记.md" });
    await waitFor(() => expect(get(readerItem)?.id).toBe(9));
    expect(get(readerWantsEdit)).toBe(true);
    expect(get(selectedText)?.id).toBe(9);
  });

  it("「关联本地文本」把路径交给关联弹层，由它先预览范围", async () => {
    vi.spyOn(textsApi, "preview").mockResolvedValue({ total: 1, formats: { md: 1 }, roots: [], errors: [] });
    feedItems.set([card(1)] as ItemSummary[]);
    switchContent("text", true);
    const ui = renderFeed();
    await tick();
    await fireEvent.click(toolbarButton(ui, "关联本地文本")!);
    expect(await ui.findByRole("dialog", { name: "关联本地文本" })).toBeTruthy();
    expect(get(associateTextPaths)).toEqual([]);
  });

  it("拖进来的路径按后缀分流：文本走关联，其余仍走图片导入", () => {
    // Feed 与 FolderTree 共用这一个判定，拖放事件本身由 subscribeFileDrop 给路径
    expect(["D:/笔记.md", "C:/a/b.TXT", "D:/x.srt"].map(isTextFilePath)).toEqual([true, true, true]);
    expect(["D:/猫.jpg", "D:/片头.mp4", "D:/底噪.mp3", "D:/无后缀"].map(isTextFilePath)).toEqual([false, false, false, false]);
  });
});
