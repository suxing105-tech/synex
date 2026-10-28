import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import Feed from "../components/Feed.svelte";
import { feedItems, feedLoading } from "../lib/stores";
import { imagesApi } from "../lib/api";
import type { MediaFeedItem } from "../lib/types";

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 1, video: 0, audio: 1, text: 0 } })) },
  imagesApi: {
    list: vi.fn(async () => ({ items: [], total: 0 })),
    detail: vi.fn(),
    presence: vi.fn(async () => ({ exists: true })),
    remove: vi.fn(),
    rename: vi.fn(),
  },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 1, total_videos: 0, total_audio: 1, total_texts: 0, folders: 0 })) },
  scanApi: { progress: vi.fn() },
  comfyuiApi: {},
  audioApi: { open: vi.fn(async () => ({ ok: true })), waveform: vi.fn(), fileUrl: vi.fn() },
}));

const IMAGE = {
  id: 1, item_type: "media", kind: "image", filename: "山雾.jpg", path: "D:/山雾.jpg",
  original_url: "/api/images/1/file", thumbnail_url: "/api/images/1/file",
  width: 1600, height: 900, size_bytes: 3200000, mtime: 1700000000,
};
const AUDIO = {
  id: 7, item_type: "media", kind: "audio", filename: "氛围底噪.mp3", path: "D:/氛围底噪.mp3",
  original_url: "/api/audio/7/file", thumbnail_url: "/api/audio/7/waveform",
  duration_seconds: 42, width: null, height: null, mtime: 1700000000,
};

function mediaOf(img: Element): Element | null {
  return img.closest(".media-card-media");
}

beforeEach(() => {
  // 900 宽 / 5 列，列宽 172，落在两行页脚档，所以页脚一定会渲染出来
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  feedLoading.set(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  feedItems.set([]);
});

function renderWith(...items: MediaFeedItem[]) {
  feedItems.set(items);
  return render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
}

describe("缩略图淡入", () => {
  it("图没到之前只有扫光占位，页脚已经把名字和元信息排好", async () => {
    const { container } = renderWith(IMAGE as unknown as MediaFeedItem);
    await tick();
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.classList.contains("is-loaded")).toBe(false);
    expect(mediaOf(img)?.querySelector(".media-card-skeleton")).not.toBeNull();
    // 页脚不依赖图片，所以加载期卡片高度就是最终高度，图到了不跳版
    expect(container.querySelector(".media-card-name")?.textContent).toBe("山雾.jpg");
    expect(container.querySelector(".media-card-meta")?.textContent).toContain("1600×900");
  });

  it("onload 之后淡入并收掉扫光", async () => {
    const { container } = renderWith(IMAGE as unknown as MediaFeedItem);
    await tick();
    const img = container.querySelector("img") as HTMLImageElement;
    await fireEvent.load(img);
    await tick();
    expect(img.classList.contains("is-loaded")).toBe(true);
    expect(mediaOf(img)?.querySelector(".media-card-skeleton")).toBeNull();
  });

  it("读图失败不淡入，也不留一条永远闪的扫光", async () => {
    const { container } = renderWith(IMAGE as unknown as MediaFeedItem);
    await tick();
    const img = container.querySelector("img") as HTMLImageElement;
    await fireEvent.error(img);
    await tick();
    expect(img.classList.contains("is-loaded")).toBe(false);
    expect(mediaOf(img)?.querySelector(".media-card-skeleton")).toBeNull();
    // 破图由 opacity 0 + visibility hidden 双重挡住，同时仍然要核对一次文件是否存在
    expect(imagesApi.presence).toHaveBeenCalledWith(1);
  });

  it("波形失败时降级成音符图形，占位同样收掉", async () => {
    const { container } = renderWith(AUDIO as unknown as MediaFeedItem);
    await tick();
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("/api/audio/7/waveform");
    await fireEvent.error(img);
    await tick();
    expect(container.querySelector('[aria-label="波形暂不可用"]')).not.toBeNull();
    expect(mediaOf(img)?.querySelector(".media-card-skeleton")).toBeNull();
    expect(img.classList.contains("is-loaded")).toBe(false);
  });

  it("文本卡不套图片页脚，但仍走统一的卡片形状", async () => {
    feedItems.set([{
      id: 20, item_type: "text", filename: "笔记.md", path: "D:/笔记.md",
      format: "md", excerpt: "第一段", mtime: 1700000000,
    } as unknown as MediaFeedItem]);
    const { container } = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
    await tick();
    expect(container.querySelector(".text-card")).not.toBeNull();
    expect(container.querySelector(".media-card-footer")).toBeNull();
  });
});
