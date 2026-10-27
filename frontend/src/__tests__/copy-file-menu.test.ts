import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import Feed from "../components/Feed.svelte";
import { imagesApi, itemsApi } from "../lib/api";
import { textsApi } from "../lib/texts";
import { feedItems, feedLoading, feedTotal, kindFilter, readerItem, scope, selectedText } from "../lib/stores";
import type { MediaFeedItem, TextFeedItem } from "../lib/types";

/**
 * 音频与文本缺的是「复制这个文件」：图片有位图复制、视频有文件复制，
 * 音频没有位图可复制，文本要把文件和正文分开。两条都落到后端写文件组剪贴板。
 */
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: {
    list: vi.fn(async () => ({ items: [], total: 0 })),
    detail: vi.fn(), presence: vi.fn(async () => ({ exists: true })),
    remove: vi.fn(), rename: vi.fn(), reveal: vi.fn(),
    copyFile: vi.fn(async () => ({ ok: true, id: 7, path: "D:/sound/氛围底噪.mp3", method: "clipboard" })),
  },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 0, total_videos: 0, total_audio: 1, total_texts: 1, folders: 0 })) },
  scanApi: { progress: vi.fn() }, comfyuiApi: {}, videosApi: { open: vi.fn() },
  audioApi: { open: vi.fn(async () => ({ ok: true })), waveform: vi.fn(), fileUrl: vi.fn() },
}));
vi.mock("../lib/reveal", () => ({ revealLocation: vi.fn(async () => "backend") }));

const AUDIO = {
  id: 7, item_type: "media", kind: "audio", filename: "氛围底噪.mp3", path: "D:/sound/氛围底噪.mp3",
  thumbnail_url: "/api/audio/7/waveform", play_url: "/api/audio/7/file", playable: true,
  duration_seconds: 42, width: null, height: null, mtime: 1700000000,
} as unknown as MediaFeedItem;
const TEXT = {
  item_type: "text", id: 1, kind: "text", filename: "随想1.md", path: "D:/notes/随想1.md",
  mtime: 105, tags: [], format: "md", excerpt: "摘录",
} as unknown as TextFeedItem;
const TEXT_DETAIL = {
  ...TEXT, body: "正文内容", version: "v7", encoding: "utf-8", newline: "LF",
  bom: false, readonly: false, needs_encoding: false, missing: false, error: "", created: 1, opened: 1,
} as never;

function renderFeed() {
  return render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
}
function audioCard(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('img[alt="氛围底噪.mp3"]');
  if (!el) throw new Error("没有音频卡");
  return el;
}
function textCard(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".text-card");
  if (!el) throw new Error("没有文本卡");
  return el;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  localStorage.clear();
  scope.set("all");
  kindFilter.set("all");
  feedLoading.set(false);
  readerItem.set(null);
  selectedText.set(null);
  feedItems.set([AUDIO, TEXT] as never);
  feedTotal.set(2);
  vi.mocked(itemsApi.list).mockResolvedValue({ items: [AUDIO, TEXT], total: 2, counts: { image: 0, video: 0, audio: 1, text: 1 } } as never);
  vi.spyOn(textsApi, "detail").mockResolvedValue(TEXT_DETAIL);
  vi.spyOn(textsApi, "copyFile").mockResolvedValue({ ok: true, id: 1, path: TEXT.path, method: "clipboard" } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  feedItems.set([]);
  feedTotal.set(0);
  scope.set("all");
});

describe("复制文件到剪贴板", () => {
  it("音频右键菜单有「复制音频」，点击后复制的是文件", async () => {
    const ui = renderFeed();
    await tick();
    await fireEvent.contextMenu(audioCard(ui.container));
    const item = ui.getByRole("menuitem", { name: "复制音频" });
    // 播放仍是音频的主动作，复制排在它前面但没把它挤掉。
    expect(ui.getByRole("menuitem", { name: "播放" })).toBeTruthy();
    await fireEvent.click(item);
    await waitFor(() => expect(imagesApi.copyFile).toHaveBeenCalledWith(7));
  });

  it("文本右键菜单分得清「复制文本文件」与「复制全文」", async () => {
    const ui = renderFeed();
    await tick();
    await fireEvent.contextMenu(textCard(ui.container));
    await fireEvent.click(ui.getByRole("menuitem", { name: "复制文本文件" }));
    await waitFor(() => expect(textsApi.copyFile).toHaveBeenCalledWith(1));
    expect(textsApi.detail).not.toHaveBeenCalled();
  });

  it("「复制全文」仍然复制正文，不碰文件接口", async () => {
    const ui = renderFeed();
    await tick();
    await fireEvent.contextMenu(textCard(ui.container));
    await fireEvent.click(ui.getByRole("menuitem", { name: "复制全文" }));
    await waitFor(() => expect(textsApi.detail).toHaveBeenCalledWith(1));
    expect(textsApi.copyFile).not.toHaveBeenCalled();
  });

  it("复制失败时把后端的中文原因留在提示里", async () => {
    vi.mocked(imagesApi.copyFile).mockRejectedValueOnce(new Error("素材文件不存在，可能已被移动或删除"));
    const ui = renderFeed();
    await tick();
    await fireEvent.contextMenu(audioCard(ui.container));
    await fireEvent.click(ui.getByRole("menuitem", { name: "复制音频" }));
    await waitFor(() => expect(ui.container.querySelector(".toast")?.textContent).toContain("素材文件不存在"));
  });

  it("文本卡右键菜单里复制文件排在复制全文前面", async () => {
    const ui = renderFeed();
    await tick();
    await fireEvent.contextMenu(textCard(ui.container));
    const labels = ui.queryAllByRole("menuitem").map(el => el.textContent);
    expect(labels.indexOf("复制文本文件")).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf("复制文本文件")).toBeLessThan(labels.indexOf("复制全文"));
  });
});
