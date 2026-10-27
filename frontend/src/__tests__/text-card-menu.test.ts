import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import Feed from "../components/Feed.svelte";
import { itemsApi } from "../lib/api";
import { textsApi } from "../lib/texts";
import { feedItems, feedLoading, feedLoadingMore, feedTotal, kindFilter, readerItem, readerWantsEdit, scope, selectedText } from "../lib/stores";
import type { TextDetail } from "../lib/texts";
import type { ItemSummary, TextFeedItem } from "../lib/types";

/**
 * 网格上文本卡的右键菜单：文本的全部文件级动作都要能在网格里做到，
 * 不必先进某个全屏页面。改名 / 回收站需要 version，所以先取详情再动手。
 */
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(), presence: vi.fn(async () => ({ exists: true })), remove: vi.fn(), rename: vi.fn(), reveal: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 0, total_videos: 0, total_audio: 0, total_texts: 1, folders: 0 })) },
  scanApi: { progress: vi.fn() }, comfyuiApi: {}, videosApi: { open: vi.fn() }, audioApi: { open: vi.fn(async () => ({ ok: true })) },
}));

const card = (id = 1, filename = "随想1.md"): TextFeedItem => ({
  item_type: "text", id, kind: "text", filename, path: `D:/notes/${filename}`,
  mtime: 105 + id, tags: [], format: filename.endsWith(".md") ? "md" : "txt", excerpt: "摘录",
} as TextFeedItem);

const detail = (): TextDetail => ({
  ...card(), created: 1, opened: 1, missing: false, error: "",
  body: "正文内容", version: "v7", encoding: "utf-8", newline: "LF",
  bom: false, readonly: false, needs_encoding: false,
} as TextDetail);

function renderFeed() {
  return render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
}
function textCard(container: HTMLElement, index = 0): HTMLElement {
  const el = container.querySelectorAll<HTMLElement>(".text-card")[index];
  if (!el) throw new Error("没有文本卡");
  return el;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  localStorage.clear();
  scope.set("all");
  kindFilter.set("all");
  feedLoading.set(false);
  feedLoadingMore.set(false);
  readerItem.set(null);
  readerWantsEdit.set(false);
  selectedText.set(null);
  feedItems.set([card()] as ItemSummary[]);
  feedTotal.set(1);
  vi.mocked(itemsApi.list).mockResolvedValue({ items: [card()], total: 1, counts: { image: 0, video: 0, audio: 0, text: 1 }, limit: 500, offset: 0 });
  vi.spyOn(textsApi, "detail").mockResolvedValue(detail());
  vi.spyOn(textsApi, "move").mockResolvedValue(detail());
  vi.spyOn(textsApi, "trash").mockResolvedValue({ ok: true } as never);
  vi.spyOn(textsApi, "reveal").mockResolvedValue({ ok: true } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  feedItems.set([]);
  feedTotal.set(0);
  readerItem.set(null);
  readerWantsEdit.set(false);
  selectedText.set(null);
  scope.set("all");
});

describe("文本卡右键菜单", () => {
  it("菜单里有阅读 / 就地编辑 / 复制文本文件 / 复制全文 / 文件位置 / 重命名 / 移入回收站", async () => {
    const ui = renderFeed();
    await tick();
    await fireEvent.contextMenu(textCard(ui.container));
    for (const label of ["阅读", "就地编辑", "复制文本文件", "复制全文", "文件位置", "重命名", "移入回收站"]) {
      expect(ui.queryByRole("menuitem", { name: label })).toBeTruthy();
    }
  });

  it("「阅读」在中间栏打开这一篇并选中它，不改口径", async () => {
    const ui = renderFeed();
    await tick();
    await fireEvent.contextMenu(textCard(ui.container));
    await fireEvent.click(ui.getByRole("menuitem", { name: "阅读" }));
    expect(get(readerItem)?.id).toBe(1);
    expect(get(readerWantsEdit)).toBe(false);
    expect(get(selectedText)?.id).toBe(1);
    expect(get(scope)).toBe("all");
  });

  it("「就地编辑」打开时直接进编辑态", async () => {
    const ui = renderFeed();
    await tick();
    await fireEvent.contextMenu(textCard(ui.container));
    await fireEvent.click(ui.getByRole("menuitem", { name: "就地编辑" }));
    expect(get(readerItem)?.id).toBe(1);
    expect(get(readerWantsEdit)).toBe(true);
  });

  it("「文件位置」走 reveal，桌面壳不在时用后端接口", async () => {
    const ui = renderFeed();
    await tick();
    await fireEvent.contextMenu(textCard(ui.container));
    await fireEvent.click(ui.getByRole("menuitem", { name: "文件位置" }));
    await waitFor(() => expect(textsApi.reveal).toHaveBeenCalledWith(1));
  });

  it("「重命名」先取详情拿 version，再带 version 调 move 并刷新网格", async () => {
    const ui = renderFeed();
    await tick();
    await fireEvent.contextMenu(textCard(ui.container));
    await fireEvent.click(ui.getByRole("menuitem", { name: "重命名" }));
    const dialog = ui.getByRole("dialog", { name: "重命名文本" });
    const input = dialog.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("随想1.md");
    await fireEvent.input(input, { target: { value: "随想改名.md" } });
    await fireEvent.click(ui.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(textsApi.move).toHaveBeenCalledWith(1, "D:/notes", "随想改名.md", "v7"));
    await waitFor(() => expect(itemsApi.list).toHaveBeenCalled());
    expect(ui.queryByRole("dialog", { name: "重命名文本" })).toBeNull();
  });

  it("改名不填就不发请求，弹层里给出原因而不是静默关掉", async () => {
    const ui = renderFeed();
    await tick();
    await fireEvent.contextMenu(textCard(ui.container));
    await fireEvent.click(ui.getByRole("menuitem", { name: "重命名" }));
    const input = ui.getByRole("dialog", { name: "重命名文本" }).querySelector("input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "   " } });
    await fireEvent.click(ui.getByRole("button", { name: "保存" }));
    expect(await ui.findByRole("alert")).toBeTruthy();
    expect(ui.getByRole("alert").textContent).toContain("文件名不能为空");
    expect(textsApi.move).not.toHaveBeenCalled();
  });

  it("「移入回收站」要二次确认，确认后带 version 移入并清掉选中的文本", async () => {
    const ui = renderFeed();
    await tick();
    await fireEvent.click(textCard(ui.container));
    expect(get(selectedText)?.id).toBe(1);
    await fireEvent.contextMenu(textCard(ui.container));
    await fireEvent.click(ui.getByRole("menuitem", { name: "移入回收站" }));
    const dialog = ui.getByRole("dialog", { name: "移入回收站" });
    expect(dialog.textContent).toContain("D:/notes/随想1.md");
    expect(textsApi.trash).not.toHaveBeenCalled();
    await fireEvent.click(ui.getByRole("button", { name: "确认移入回收站" }));
    await waitFor(() => expect(textsApi.trash).toHaveBeenCalledWith(1, "v7"));
    await waitFor(() => expect(get(selectedText)).toBeNull());
  });
});
