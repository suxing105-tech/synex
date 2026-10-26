import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import {
  activeFolderName,
  folderId,
  folders,
  query,
  refreshFeed,
  scope,
  switchContent,
  tag,
} from "../lib/stores";
import { imagesApi, itemsApi } from "../lib/api";

const EMPTY_COUNTS = { image: 0, video: 0, audio: 0, text: 0 };

vi.mock("../lib/api", () => ({
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(async () => ({})) },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 0, total_videos: 0, total_audio: 0, total_texts: 0, folders: 0 })) },
  scanApi: { progress: vi.fn(async () => ({ running: false })) },
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
}));

afterEach(() => {
  vi.clearAllMocks();
  scope.set("all");
  folderId.set(null);
  query.set("");
  tag.set(null);
  folders.set([]);
});

describe("素材口径驱动 feed 查询", () => {
  it("单一口径把 scope 作为 kind 传给 imagesApi.list", async () => {
    scope.set("video");
    folderId.set(null);
    await refreshFeed();
    expect(imagesApi.list).toHaveBeenCalledWith(expect.objectContaining({ kind: "video" }));
    expect(itemsApi.list).not.toHaveBeenCalled();
  });

  it("所有素材口径走统一流，并把类型过滤一起带上", async () => {
    scope.set("all");
    await refreshFeed();
    expect(itemsApi.list).toHaveBeenCalledWith(expect.objectContaining({ kinds: "image,video,audio,text" }));
    expect(imagesApi.list).not.toHaveBeenCalled();
  });

  it("activeFolderName 在口径切换后给出对应标题", () => {
    folders.set([]);
    folderId.set(null);
    scope.set("video");
    expect(get(activeFolderName)).toBe("所有视频");
    scope.set("image");
    expect(get(activeFolderName)).toBe("全部图片");
    scope.set("audio");
    expect(get(activeFolderName)).toBe("全部音频");
    scope.set("all");
    expect(get(activeFolderName)).toBe("所有素材");
  });

  it("每个口径记住自己的文件夹与搜索条件", () => {
    folders.set([{ id: 7, name: "定妆", children: [], counts: { image: 1, video: 0, audio: 0, text: 0 }, total: 1 }] as any);
    switchContent("image", true);
    folderId.set(7);
    query.set("猫");
    switchContent("audio");
    expect(get(folderId)).toBe(null);
    expect(get(query)).toBe("");
    switchContent("image");
    expect(get(folderId)).toBe(7);
    expect(get(query)).toBe("猫");
  });

  it("点侧栏系统行时 keepAll 会清掉文件夹与筛选", () => {
    folders.set([{ id: 7, name: "定妆", children: [], counts: EMPTY_COUNTS, total: 0 }] as any);
    folderId.set(7);
    tag.set("红");
    switchContent("video", true);
    expect(get(scope)).toBe("video");
    expect(get(folderId)).toBe(null);
    expect(get(tag)).toBe(null);
  });
});
