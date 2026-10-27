import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import Feed from "../components/Feed.svelte";
import { itemsApi } from "../lib/api";
import { feedItems, feedLoading, feedTotal, scope } from "../lib/stores";

/**
 * F 键走到「全屏」那一步时，屏幕上也该只剩缩略图：
 * 工具栏（当前目录名、搜索、类型 chips、列数滑块）整条不渲染，而不是藏起来。
 */
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(), presence: vi.fn(), remove: vi.fn(), rename: vi.fn(), reveal: vi.fn(), copyFile: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 1, total_videos: 0, total_audio: 0, total_texts: 0, folders: 0 })) },
  scanApi: { progress: vi.fn() }, comfyuiApi: {}, videosApi: { open: vi.fn() }, audioApi: { open: vi.fn() },
}));

const IMAGE = { id: 1, item_type: "media", kind: "image", filename: "1.jpg", path: "D:/1.jpg", width: 800, height: 600, mtime: 1 };

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(2560);
  localStorage.clear();
  scope.set("all");
  feedLoading.set(false);
  feedItems.set([IMAGE] as never);
  feedTotal.set(1);
  vi.mocked(itemsApi.list).mockResolvedValue({ items: [IMAGE], total: 1, counts: { image: 1, video: 0, audio: 0, text: 0 } } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); feedItems.set([]); feedTotal.set(0); });

function renderFeed(immersive: boolean) {
  return render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0, immersive });
}

describe("沉浸满屏时只剩缩略图", () => {
  it("不是沉浸时工具栏在：搜索框与列数滑块都找得到", async () => {
    const ui = renderFeed(false);
    await tick();
    expect(ui.getByLabelText("搜索图片、视频、音频、文本")).toBeTruthy();
    expect(ui.getByLabelText("列数")).toBeTruthy();
    expect(ui.getByRole("region", { name: /素材流/ })).toBeTruthy();
  });

  it("immersive 时工具栏整条不渲染，只留缩略图区域", async () => {
    const ui = renderFeed(true);
    await tick();
    expect(ui.queryByLabelText("搜索图片、视频、音频、文本")).toBeNull();
    expect(ui.queryByLabelText("列数")).toBeNull();
    expect(ui.container.querySelector(".gallery-toolbar")).toBeNull();
    expect(ui.getByRole("region", { name: /素材流/ })).toBeTruthy();
  });
});
