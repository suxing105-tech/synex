import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { kind, refreshFeed, activeFolderName, folders, folderId, view } from "../lib/stores";
import { imagesApi } from "../lib/api";

vi.mock("../lib/api", () => ({
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(async () => ({})), rename: vi.fn(), bulkAssignFolder: vi.fn(), toggleFavorite: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 0, total_videos: 0, favorites: 0, folders: 0 })) },
  scanApi: { progress: vi.fn(async () => ({ running: false })) },
}));

afterEach(() => {
  vi.clearAllMocks();
  kind.set("image");
  folderId.set(null);
  view.set("all");
  folders.set([]);
});

describe("视频 kind 驱动 feed 查询", () => {
  it("refreshFeed 把 kind 传给 imagesApi.list", async () => {
    kind.set("video");
    folderId.set(null);
    view.set("all");
    await refreshFeed();
    expect(imagesApi.list).toHaveBeenCalledWith(expect.objectContaining({ kind: "video" }));
  });

  it("activeFolderName 在视频视图下识别为「所有视频」", () => {
    kind.set("video");
    folderId.set(null);
    view.set("all");
    folders.set([]);
    expect(get(activeFolderName)).toBe("所有视频");
  });

  it("图片视图默认回落到「全部图片」", () => {
    kind.set("image");
    folderId.set(null);
    view.set("all");
    folders.set([]);
    expect(get(activeFolderName)).toBe("全部图片");
  });
});
