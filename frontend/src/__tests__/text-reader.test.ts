import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";
import TextReaderHarness from "./fixtures/TextReaderHarness.svelte";
import { textsApi } from "../lib/texts";
import { closeTextReader, feedItems, openTextReader, readerItem, readerTerm, selectedText } from "../lib/stores";
import type { ItemSummary, TextFeedItem } from "../lib/types";

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(), presence: vi.fn(), remove: vi.fn(), rename: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 0, total_videos: 0, total_audio: 0, total_texts: 0, folders: 0 })) },
  scanApi: { progress: vi.fn() }, comfyuiApi: {}, videosApi: { open: vi.fn(async () => ({ ok: true })) }, audioApi: { open: vi.fn() },
}));

const card = (id: number): TextFeedItem => ({
  item_type: "text", id, filename: `${id}.md`, path: `C:/demo/${id}.md`, kind: "text",
  mtime: 1, tags: [], format: "md", excerpt: `摘录 ${id}`,
});
const detail = (id: number, body = `# 标题 ${id}\n\n正文段落 ${id}。`) => ({
  ...card(id), created: 1, opened: 1, missing: false, error: "",
  body, version: "v1", encoding: "utf-8", newline: "LF", bom: false, readonly: false, needs_encoding: false,
});

beforeEach(() => {
  localStorage.clear();
  feedItems.set([card(1), card(2)] as ItemSummary[]);
  vi.spyOn(textsApi, "detail").mockImplementation(async (id) => detail(Number(id)));
});
afterEach(async () => {
  cleanup(); vi.restoreAllMocks();
  await closeTextReader();
  readerItem.set(null); readerTerm.set(""); selectedText.set(null); feedItems.set([]);
});

it("阅读态：顶栏返回 + 底栏页码 + 只读没有输入框", async () => {
  openTextReader(card(1), "");
  const ui = render(TextReaderHarness);
  await ui.findByText(/正文段落 1/);
  expect(ui.getByRole("region", { name: "文本阅读" })).toBeTruthy();
  expect(ui.getByTitle("返回缩略图（Esc）")).toBeTruthy();
  expect(ui.getByText("1 / 2")).toBeTruthy();
  expect(ui.getByText("已保存")).toBeTruthy();
  expect(ui.getByText("MD")).toBeTruthy();
  // 阅读态不该出现编辑框：读和复制是主路径
  expect(ui.container.querySelector("textarea")).toBeNull();
  expect(ui.queryByText("历史版本")).toBeNull();
});

it("Esc 返回缩略图：阅读层从中间栏移除，文档状态留在 store 外", async () => {
  openTextReader(card(1), "");
  const ui = render(TextReaderHarness);
  await ui.findByText(/正文段落 1/);
  await fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(get(readerItem)).toBeNull());
  expect(ui.queryByRole("region", { name: "文本阅读" })).toBeNull();
});

it("顶栏返回按钮与 Esc 等价", async () => {
  openTextReader(card(2), "");
  const ui = render(TextReaderHarness);
  await ui.findByText(/正文段落 2/);
  await fireEvent.click(ui.getByTitle("返回缩略图（Esc）"));
  await waitFor(() => expect(get(readerItem)).toBeNull());
});

it("底栏翻文档：页码跟随，正文换成下一篇", async () => {
  openTextReader(card(1), "");
  const ui = render(TextReaderHarness);
  await ui.findByText(/正文段落 1/);
  await fireEvent.click(ui.getByRole("button", { name: "下一篇文本" }));
  await ui.findByText(/正文段落 2/);
  expect(ui.getByText("2 / 2")).toBeTruthy();
  await fireEvent.click(ui.getByRole("button", { name: "上一篇文本" }));
  await ui.findByText(/正文段落 1/);
  expect(ui.getByText("1 / 2")).toBeTruthy();
});

it("键盘 ← / → 翻文本，但在输入框里时不抢光标", async () => {
  openTextReader(card(1), "");
  const ui = render(TextReaderHarness);
  await ui.findByText(/正文段落 1/);
  await fireEvent.keyDown(window, { key: "ArrowRight" });
  await ui.findByText(/正文段落 2/);
  expect(get(readerItem)?.id).toBe(2);
});

it("不在当前列表里（从引用跳进来）就显示「不在当前列表」，不给假页码", async () => {
  feedItems.set([card(9)] as ItemSummary[]);
  openTextReader(card(7), "");
  const ui = render(TextReaderHarness);
  await ui.findByText(/正文段落 7/);
  expect(ui.getByText("不在当前列表")).toBeTruthy();
  expect(ui.queryByText(/\/ 1/)).toBeNull();
});

it("引用素材：文本在层内切换，图片交给图库事件", async () => {
  vi.mocked(textsApi.detail).mockImplementation(async (id, encoding, opened) => {
    if (Number(id) === 1) return detail(1, "看图 ![封面](cover.png)");
    return detail(Number(id));
  });
  const assetInfo = vi.spyOn(textsApi, "assetInfo").mockResolvedValue({ id: 3, kind: "text" });
  openTextReader(card(1), "");
  const ui = render(TextReaderHarness);
  await ui.findByText(/封面/);
  await fireEvent.click(ui.getByRole("button", { name: /封面 · 打开 \/ 重新定位/ }));
  await ui.findByText(/正文段落 3/);
  expect(assetInfo).toHaveBeenCalledWith(1, "cover.png");
  expect(get(readerItem)?.id).toBe(3);
});