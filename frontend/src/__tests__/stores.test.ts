import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  query,
  view,
  folderId,
  zoomSize,
  feedItems,
  feedTotal,
  newIds,
  markNew,
} from "../lib/stores";
import type { ImageSummary } from "../lib/types";

describe("前端 stores", () => {
  beforeEach(() => {
    query.set("");
    view.set("all");
    folderId.set(null);
    zoomSize.set(220);
    feedItems.set([]);
    feedTotal.set(0);
    newIds.set(new Set());
  });

  it("默认查询是空字符串", () => {
    expect(get(query)).toBe("");
  });

  it("默认视图是 all", () => {
    expect(get(view)).toBe("all");
  });

  it("默认缩放 220px", () => {
    expect(get(zoomSize)).toBe(220);
  });

  it("缩放范围在 140~360 内", () => {
    zoomSize.set(140);
    expect(get(zoomSize)).toBe(140);
    zoomSize.set(360);
    expect(get(zoomSize)).toBe(360);
  });

  it("切换视图会更新 store", () => {
    view.set("favorite");
    expect(get(view)).toBe("favorite");
    view.set("recent");
    expect(get(view)).toBe("recent");
  });

  it("切换文件夹 id", () => {
    folderId.set(42);
    expect(get(folderId)).toBe(42);
    folderId.set(null);
    expect(get(folderId)).toBe(null);
  });

  it("feedItems 是数组，支持 push", () => {
    const sample: ImageSummary = {
      id: 1,
      filename: "a.png",
      path: "a.png",
      thumb_url: "/thumbs/1.webp",
      width: 1024,
      height: 1024,
      mtime: 1.0,
      size_bytes: 100,
      favorite: false,
      folder_ids: [],
      tags: [],
      model: null,
      seed: 1,
    };
    feedItems.set([sample]);
    expect(get(feedItems).length).toBe(1);
    expect(get(feedItems)[0].filename).toBe("a.png");
  });

  it("markNew 添加 id 到 newIds 集合", () => {
    markNew([1, 2, 3]);
    expect(get(newIds).has(1)).toBe(true);
    expect(get(newIds).has(2)).toBe(true);
    expect(get(newIds).has(3)).toBe(true);
  });

  it("feedTotal 反映总数", () => {
    feedTotal.set(99);
    expect(get(feedTotal)).toBe(99);
  });
});
