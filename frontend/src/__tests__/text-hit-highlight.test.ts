import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { get } from "svelte/store";
import TextReaderHarness from "./fixtures/TextReaderHarness.svelte";
import { textsApi } from "../lib/texts";
import { escapeHtml, highlightHtml, renderMarkdown } from "../lib/text-markdown";
import { hitOffsets, stepHit } from "../lib/text-reading";
import { closeTextReader, feedItems, openTextReader, readerItem, readerTerm, selectedText } from "../lib/stores";
import type { TextDetail } from "../lib/texts";
import type { TextFeedItem } from "../lib/types";

/**
 * 搜索命中怎么落到阅读层。
 *
 * /api/items 只回围绕命中点生成的摘录，不回偏移，所以打开文档以后由前端
 * 自己在正文里找一遍（hitOffsets），再用同一份偏移滚动定位（TextEditor.locate）。
 * 这两件事必须来自同一张表，否则「下一个命中」会和标出来的黄块错位。
 */
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(), presence: vi.fn(), remove: vi.fn(), rename: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 0, total_videos: 0, total_audio: 0, total_texts: 0, folders: 0 })) },
  scanApi: { progress: vi.fn() }, comfyuiApi: {}, videosApi: { open: vi.fn() }, audioApi: { open: vi.fn() },
}));

const BODY = "# 阅读笔记\n\n第一段提到灯塔。\n\n第二段没有相关内容。\n\n结尾又回到灯塔。";
const TERM = "灯塔";

const card = (): TextFeedItem => ({
  item_type: "text", id: 1, filename: "笔记.md", path: "C:/demo/笔记.md", kind: "text",
  mtime: 1, tags: [], format: "md", excerpt: "摘录",
});
const detail = (): TextDetail => ({
  ...card(), created: 1, opened: 1, missing: false, error: "",
  body: BODY, version: "v1", encoding: "utf-8", newline: "LF",
  bom: false, readonly: false, needs_encoding: false,
} as TextDetail);

describe("命中高亮：Markdown 渲染层", () => {
  it("第三参给命中词时，正文文本节点被包成 <mark class=\"text-hit\">", () => {
    const html = renderMarkdown("写一段 **重点** 讲灯塔，最后回到灯塔。", 7, TERM);
    expect((html.match(/<mark class="text-hit">/g) || [])).toHaveLength(2);
    expect(html).toContain("<mark class=\"text-hit\">灯塔</mark>");
  });

  it("只标文本节点：属性、href 与代码块标记都不被改写", () => {
    const html = renderMarkdown("[灯塔](本地.md) 与 `灯塔代码`。", 7, TERM);
    expect(html).toContain('data-href="本地.md"');
    expect(html).not.toContain('data-href="<mark');
    expect((html.match(/<mark class="text-hit">/g) || [])).toHaveLength(2);
  });

  it("高亮在转义之后进行：带尖括号的词不产生真标签，也不从实体中间切开", () => {
    // 按字面比的是转义后的文本，所以 "<b>" 找不到 —— 宁可少标一处，也不写出真标签
    expect(highlightHtml(escapeHtml("a <b> 标记"), "<b>")).toBe("a &lt;b&gt; 标记");
    // 命中词恰好落在实体名里（"lt" / "amp"）时整段实体跳过，否则页面会多出可见的 "lt;"
    expect(highlightHtml(escapeHtml("a <b> 标记"), "lt")).toBe("a &lt;b&gt; 标记");
    expect(highlightHtml(escapeHtml("A & B"), "amp")).toBe("A &amp; B");
    expect(highlightHtml(escapeHtml("A & B"), "&")).toBe("A &amp; B");
    // 实体前后照常标
    expect(highlightHtml(escapeHtml("灯塔 & 灯塔"), "灯塔")).toBe(
      '<mark class="text-hit">灯塔</mark> &amp; <mark class="text-hit">灯塔</mark>',
    );
  });

  it("大小写不敏感；空命中词原样返回，不多包一层", () => {
    expect(highlightHtml("ABC abc", "abc")).toBe('<mark class="text-hit">ABC</mark> <mark class="text-hit">abc</mark>');
    expect(highlightHtml("ABC abc", "   ")).toBe("ABC abc");
    expect(renderMarkdown("普通正文。", 1)).toBe(renderMarkdown("普通正文。", 1, ""));
  });
});

describe("命中偏移表", () => {
  it("按出现次序给出偏移，与 indexOf 一致；空词与空正文给空表", () => {
    const hits = hitOffsets(BODY, TERM);
    expect(hits).toEqual([BODY.indexOf("灯塔"), BODY.lastIndexOf("灯塔")]);
    expect(hits.every((at) => at >= 0)).toBe(true);
    expect(hitOffsets(BODY, "")).toEqual([]);
    expect(hitOffsets("", TERM)).toEqual([]);
  });

  it("到头循环：最后一个的下一个是第一个，第一个的上一个是最后一个", () => {
    const hits = [10, 20, 30];
    expect(stepHit(hits, 0, 1)).toBe(1);
    expect(stepHit(hits, 2, 1)).toBe(0);
    expect(stepHit(hits, 0, -1)).toBe(2);
    expect(stepHit(hits, -1, 1)).toBe(0);
    expect(stepHit([], 0, 1)).toBe(-1);
  });
});

// —— 阅读层里的行为 ——
const scrollSpy = vi.fn();

beforeEach(() => {
  localStorage.clear();
  // jsdom 不做布局：滚动本身没有意义，要验的是「滚到哪个块」
  Element.prototype.scrollIntoView = scrollSpy;
  vi.spyOn(textsApi, "detail").mockResolvedValue(detail());
  vi.spyOn(textsApi, "save").mockImplementation(async (id, b) => ({ ...detail(), body: b, version: "v2" }));
  feedItems.set([card()] as never);
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
  scrollSpy.mockClear();
  await closeTextReader();
  readerItem.set(null); readerTerm.set(""); selectedText.set(null); feedItems.set([]);
});

async function open(term: string) {
  openTextReader(card(), term);
  const ui = render(TextReaderHarness);
  await ui.findByText("已保存");
  return ui;
}

describe("阅读层：打开即定位首个命中，「下一个命中」按次序推进", () => {
  it("带命中词打开：正文里出现两个高亮块，并滚到第一个命中所在的段", async () => {
    const ui = await open(TERM);
    expect(ui.container.querySelectorAll("mark.text-hit")).toHaveLength(2);
    expect(ui.container.textContent).toContain(TERM);
    const target = scrollSpy.mock.contexts[0] as HTMLElement;
    expect(target.getAttribute("data-block-start")).toBeTruthy();
    expect(target.textContent).toContain("第一段提到灯塔");
  });

  it("「下一个命中（i/N）」跟着命中表推进，到尾端回绕到第一个", async () => {
    const ui = await open(TERM);
    // 打开时先定位第 1 个命中
    expect((scrollSpy.mock.contexts.at(-1) as HTMLElement).textContent).toContain("第一段提到灯塔");
    await fireEvent.click(ui.getByRole("button", { name: "下一个命中（1/2）" }));
    expect((scrollSpy.mock.contexts.at(-1) as HTMLElement).textContent).toContain("结尾又回到灯塔");
    await fireEvent.click(ui.getByRole("button", { name: "下一个命中（2/2）" }));
    expect((scrollSpy.mock.contexts.at(-1) as HTMLElement).textContent).toContain("第一段提到灯塔");
    expect(ui.getByRole("button", { name: "下一个命中（1/2）" })).toBeTruthy();
  });

  it("没有命中词时不显示命中按钮，也不会莫名滚动", async () => {
    const ui = await open("");
    expect(ui.queryByText("已保存")).toBeTruthy();
    expect(ui.container.querySelectorAll("mark")).toHaveLength(0);
    expect(ui.queryByRole("button", { name: /下一个命中/ })).toBeNull();
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(get(readerItem)?.id).toBe(1);
  });
});
