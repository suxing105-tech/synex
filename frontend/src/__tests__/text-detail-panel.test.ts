import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "svelte/store";
import TextDetailPanel from "../components/TextDetailPanel.svelte";
import { itemsApi } from "../lib/api";
import { textsApi } from "../lib/texts";
import { feedItems, readerItem, readerWantsEdit, scope, selectedDetail, selectedText } from "../lib/stores";
import type { TextDetail } from "../lib/texts";
import type { TextFeedItem } from "../lib/types";

/**
 * 右侧详情栏的文本分支。
 *
 * 单击文本卡就该在这里看到这一篇的样子，但选中不该把整篇正文读进来：
 * 只有「复制全文」和改名 / 回收站这类要 version 的动作才去取详情。
 */
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(), presence: vi.fn(), remove: vi.fn(), rename: vi.fn(), reveal: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 0, total_videos: 0, total_audio: 0, total_texts: 1, folders: 0 })) },
  scanApi: { progress: vi.fn() }, comfyuiApi: {}, videosApi: { open: vi.fn() }, audioApi: { open: vi.fn() },
}));

const card = (): TextFeedItem => ({
  item_type: "text", id: 4, kind: "text", filename: "随想4.md", path: "D:/notes/随想4.md",
  mtime: 1760000000, tags: ["灵感", "草稿"], format: "md", excerpt: "摘录：深夜的灯塔。",
} as TextFeedItem);
const detail = (): TextDetail => ({
  ...card(), created: 1, opened: 1, missing: false, error: "",
  body: "正文内容", version: "v9", encoding: "utf-8", newline: "LF", bom: false, readonly: false, needs_encoding: false,
} as TextDetail);

const detailPanelSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "DetailPanel.svelte"), "utf8");

beforeEach(() => {
  localStorage.clear();
  scope.set("all");
  selectedDetail.set(null);
  readerItem.set(null);
  readerWantsEdit.set(false);
  feedItems.set([card()] as never);
  selectedText.set(card());
  vi.mocked(itemsApi.list).mockResolvedValue({ items: [card()], total: 1, counts: { image: 0, video: 0, audio: 0, text: 1 }, limit: 500, offset: 0 });
  vi.spyOn(textsApi, "detail").mockResolvedValue(detail());
  vi.spyOn(textsApi, "move").mockResolvedValue(detail());
  vi.spyOn(textsApi, "trash").mockResolvedValue({ ok: true } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectedText.set(null);
  selectedDetail.set(null);
  readerItem.set(null);
  readerWantsEdit.set(false);
  feedItems.set([]);
});

describe("右侧详情栏：文本分支", () => {
  it("选中文本时显示徽标、摘录、路径与标签，且不去读正文", () => {
    const ui = render(TextDetailPanel);
    expect(ui.getByLabelText("文本徽标").textContent).toBe("MD");
    expect(ui.getByText("随想4.md")).toBeTruthy();
    expect(ui.getByText("摘录：深夜的灯塔。")).toBeTruthy();
    expect(ui.getByText("D:/notes/随想4.md")).toBeTruthy();
    expect(ui.getByRole("button", { name: "复制路径" })).toBeTruthy();
    expect(textsApi.detail).not.toHaveBeenCalled();
  });

  it("「阅读」在中间栏打开这一篇，「就地编辑」直接进编辑态", async () => {
    const ui = render(TextDetailPanel);
    await fireEvent.click(ui.getByRole("button", { name: "打开阅读" }));
    expect(get(readerItem)?.id).toBe(4);
    expect(get(readerWantsEdit)).toBe(false);
    await fireEvent.click(ui.getByRole("button", { name: "就地编辑" }));
    expect(get(readerItem)?.id).toBe(4);
    expect(get(readerWantsEdit)).toBe(true);
  });

  it("点标签派发 open-tag-search，用当前文本口径去搜", async () => {
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<{ tag: string }>).detail.tag);
    window.addEventListener("open-tag-search", listener);
    const ui = render(TextDetailPanel);
    await fireEvent.click(ui.getByRole("button", { name: "灵感" }));
    window.removeEventListener("open-tag-search", listener);
    expect(seen).toEqual(["灵感"]);
  });

  it("「复制全文」这时候才取正文，选中本身不读正文", async () => {
    const ui = render(TextDetailPanel);
    await fireEvent.click(ui.getByRole("button", { name: "更多操作" }));
    await fireEvent.click(ui.getByRole("menuitem", { name: "复制全文" }));
    await waitFor(() => expect(textsApi.detail).toHaveBeenCalledWith(4));
  });

  it("重命名：先取 version 再 move，改完右侧立刻显示新名字", async () => {
    const ui = render(TextDetailPanel);
    await fireEvent.click(ui.getByRole("button", { name: "更多操作" }));
    await fireEvent.click(ui.getByRole("menuitem", { name: "重命名" }));
    const input = ui.getByLabelText("文件名") as HTMLInputElement;
    expect(input.value).toBe("随想4.md");
    await fireEvent.input(input, { target: { value: "随想改名.md" } });
    await fireEvent.click(ui.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(textsApi.move).toHaveBeenCalledWith(4, "D:/notes", "随想改名.md", "v9"));
    await waitFor(() => expect(ui.getByText("随想改名.md")).toBeTruthy());
  });

  it("移入回收站要二次确认，确认后带 version 移入并清掉选中", async () => {
    const ui = render(TextDetailPanel);
    await fireEvent.click(ui.getByRole("button", { name: "更多操作" }));
    await fireEvent.click(ui.getByRole("menuitem", { name: "移入回收站" }));
    const dialog = ui.getByRole("alertdialog", { name: "确认移入回收站" });
    expect(dialog.textContent).toContain("D:/notes/随想4.md");
    expect(textsApi.trash).not.toHaveBeenCalled();
    await fireEvent.click(ui.getByRole("button", { name: "确认移入回收站" }));
    await waitFor(() => expect(textsApi.trash).toHaveBeenCalledWith(4, "v9"));
    await waitFor(() => expect(get(selectedText)).toBeNull());
  });

  it("换一篇时收起没做完的改名输入", async () => {
    const ui = render(TextDetailPanel);
    await fireEvent.click(ui.getByRole("button", { name: "更多操作" }));
    await fireEvent.click(ui.getByRole("menuitem", { name: "重命名" }));
    expect(ui.getByLabelText("文件名")).toBeTruthy();
    selectedText.set({ ...card(), id: 5, filename: "随想5.txt", format: "txt" } as TextFeedItem);
    await waitFor(() => expect(ui.queryByLabelText("文件名")).toBeNull());
    expect(ui.getByText("随想5.txt")).toBeTruthy();
  });
});

describe("DetailPanel 把文本交给专门的分支", () => {
  it("模板先判 selectedText，空状态文案同时提到图片与文本", () => {
    expect(detailPanelSource).toContain("{#if $selectedText}");
    expect(detailPanelSource).toContain("<TextDetailPanel");
    expect(detailPanelSource).toMatch(/在中间选一张图片或文本/);
    // 文本分支必须排在「没选中任何媒体」之前，否则选中文本时会被空状态盖掉
    expect(detailPanelSource.indexOf("{#if $selectedText}")).toBeLessThan(detailPanelSource.indexOf("!$selectedDetail"));
  });
});
