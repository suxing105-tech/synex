import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";
import TextReaderHarness from "./fixtures/TextReaderHarness.svelte";
import { TextError, textsApi, type TextDetail } from "../lib/texts";
import { closeTextReader, feedItems, openTextReader, readerItem, readerTerm, selectedText } from "../lib/stores";
import type { ItemSummary, TextFeedItem } from "../lib/types";

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(), presence: vi.fn(), remove: vi.fn(), rename: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 0, total_videos: 0, total_audio: 0, total_texts: 0, folders: 0 })) },
  scanApi: { progress: vi.fn() }, comfyuiApi: {}, videosApi: { open: vi.fn() }, audioApi: { open: vi.fn() },
}));

const card = (id = 1): TextFeedItem => ({
  item_type: "text", id, filename: `${id}.md`, path: `C:/demo/${id}.md`, kind: "text",
  mtime: 1, tags: [], format: "md", excerpt: "摘录",
});
const baseDetail = (over: Partial<TextDetail> = {}): TextDetail => ({
  ...card(), created: 1, opened: 1, missing: false, error: "",
  body: "# 第一段\n\n第二段正文。", version: "v1", encoding: "utf-8", newline: "LF",
  bom: false, readonly: false, needs_encoding: false, ...over,
} as TextDetail);

/** 磁盘上那一篇的样子：每个用例在打开之前改它就行。 */
let doc = baseDetail();
let detailSpy: MockInstance<typeof textsApi.detail>;
let saveSpy: MockInstance<typeof textsApi.save>;

beforeEach(() => {
  localStorage.clear();
  doc = baseDetail();
  feedItems.set([card()] as ItemSummary[]);
  detailSpy = vi.spyOn(textsApi, "detail").mockImplementation(async (id, encoding) => ({
    ...doc, encoding: (encoding as string) ?? doc.encoding,
  }));
  saveSpy = vi.spyOn(textsApi, "save").mockImplementation(async (id, body) => ({ ...doc, body, version: "v2" }));
});
afterEach(async () => {
  cleanup(); vi.restoreAllMocks();
  await closeTextReader();
  readerItem.set(null); readerTerm.set(""); selectedText.set(null); feedItems.set([]);
});

/** 等「已保存」而不是等正文文字：正文在读取中的中间态也可能被别的节点匹配到，保存态只有一份会话时才有。 */
async function openLoaded() {
  openTextReader(card(), "");
  const ui = render(TextReaderHarness);
  await ui.findByText("已保存");
  return ui;
}

/** 进入编辑态（幂等：已经是编辑态时按钮文案是「完成编辑」，不能再点一次）。 */
async function enterEdit(ui: Awaited<ReturnType<typeof openLoaded>>) {
  if (ui.queryByRole("button", { name: "完成编辑" })) return ui;
  await fireEvent.click(ui.getByRole("button", { name: "编辑" }));
  await ui.findByRole("button", { name: "完成编辑" });
  return ui;
}

/** 编辑态是「点段改段」：先点一段，输入框才出现在那一段的位置上。 */
async function editParagraph(ui: Awaited<ReturnType<typeof openLoaded>>, value: string) {
  await enterEdit(ui);
  await fireEvent.click(ui.getByText("第二段正文。"));
  const area = await ui.findByLabelText("编辑 Markdown 段落");
  await fireEvent.input(area, { target: { value } });
  return area;
}

it("就地编辑：切编辑态出工具条，点段出现输入框，输入后自动保存", async () => {
  const ui = await openLoaded();
  await fireEvent.click(ui.getByRole("button", { name: "编辑" }));
  expect(ui.getByRole("toolbar", { name: "Markdown 工具" })).toBeTruthy();
  expect(ui.getByRole("button", { name: "完成编辑" })).toBeTruthy();
  await editParagraph(ui, "第二段改过了。");
  await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(1, expect.stringContaining("改过了"), "v1", "utf-8", false), { timeout: 3000 });
  await waitFor(() => expect(ui.getByText("已保存")).toBeTruthy(), { timeout: 3000 });
});

it("Esc 先落盘再关：编辑到一半按 Esc 不会丢字", async () => {
  const ui = await openLoaded();
  await editParagraph(ui, "只写了一半就按 Esc。");
  await fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(saveSpy).toHaveBeenCalled());
  expect(saveSpy.mock.calls[0][1]).toContain("只写了一半");
  expect(get(readerItem)).toBeNull();
});

it("外部改动了文件：保存 409 后给出冲突条，可选磁盘版本", async () => {
  saveSpy.mockRejectedValue(new TextError("磁盘上的文件已经被别的程序改过", 409));
  const ui = await openLoaded();
  await editParagraph(ui, "我的改动");
  await ui.findByRole("button", { name: "处理冲突" }, { timeout: 3000 });
  await fireEvent.click(ui.getByRole("button", { name: "处理冲突" }));
  await ui.findByRole("dialog", { name: "文本操作" });
  expect(ui.getByText("当前编辑内容")).toBeTruthy();
  await fireEvent.click(ui.getByRole("button", { name: "用磁盘版本" }));
  await waitFor(() => expect(ui.queryByRole("dialog", { name: "文本操作" })).toBeNull());
  expect(ui.container.textContent).toContain("第二段正文。");
});

it("编码读不准时给选码重读，选完不再提示，也不改写文件", async () => {
  doc = baseDetail({ needs_encoding: true, encoding: null, body: "乱码？" });
  const ui = await openLoaded();
  const notice = ui.getByRole("status");
  expect(notice.textContent).toContain("无法确定文字编码");
  await fireEvent.click(ui.getByRole("button", { name: "GB18030" }));
  await waitFor(() => expect(detailSpy).toHaveBeenCalledWith(1, "gb18030"));
  await waitFor(() => expect(ui.queryByText(/无法确定文字编码/)).toBeNull());
  expect(saveSpy).not.toHaveBeenCalled();
});

it("只读文件：可以阅读与复制，但不给编辑入口", async () => {
  doc = baseDetail({ readonly: true });
  const ui = await openLoaded();
  expect(await ui.findByText(/文件是只读的/)).toBeTruthy();
  expect(ui.queryByRole("button", { name: "编辑" })).toBeNull();
  expect(ui.getByRole("button", { name: "复制全文" })).toBeTruthy();
});

it("⋯ 菜单里有历史版本与回收站，回收站要二次确认", async () => {
  vi.spyOn(textsApi, "history").mockResolvedValue([]);
  const trash = vi.spyOn(textsApi, "trash").mockResolvedValue({ ok: true } as never);
  const ui = await openLoaded();
  await fireEvent.click(ui.getByRole("button", { name: "更多操作" }));
  await ui.findByRole("menuitem", { name: "历史版本" });
  await fireEvent.click(ui.getByRole("menuitem", { name: "历史版本" }));
  expect(await ui.findByText(/尚无历史版本/)).toBeTruthy();
  await fireEvent.click(ui.getByRole("button", { name: "×" }));
  await fireEvent.click(ui.getByRole("button", { name: "更多操作" }));
  await fireEvent.click(ui.getByRole("menuitem", { name: "移入回收站" }));
  expect(ui.getByRole("button", { name: "确认移入回收站" })).toBeTruthy();
  expect(trash).not.toHaveBeenCalled();
  await fireEvent.click(ui.getByRole("button", { name: "确认移入回收站" }));
  await waitFor(() => expect(trash).toHaveBeenCalledWith(1, "v1"));
  await waitFor(() => expect(get(readerItem)).toBeNull());
});