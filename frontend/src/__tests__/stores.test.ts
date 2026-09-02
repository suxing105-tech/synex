import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  query,
  view,
  folderId,
  targetColumns,
  feedItems,
  feedTotal,
  newIds,
  markNew,
  multiSelectedIds,
  selectionAnchorId,
  selectedId,
  applySelection,
  clearSelection,
  removeIdsFromSelection,
} from "../lib/stores";
import type { ImageSummary } from "../lib/types";

describe("前端 stores", () => {
  beforeEach(() => {
    query.set("");
    view.set("all");
    folderId.set(null);
    targetColumns.set(5);
    feedItems.set([]);
    feedTotal.set(0);
    newIds.set(new Set());
    multiSelectedIds.set(new Set());
    selectionAnchorId.set(null);
    selectedId.set(null);
  });

  it("默认查询是空字符串", () => {
    expect(get(query)).toBe("");
  });

  it("默认视图是 all", () => {
    expect(get(view)).toBe("all");
  });

  it("默认列数 5", () => {
    expect(get(targetColumns)).toBe(5);
  });

  it("列数范围在 4~12 内", () => {
    targetColumns.set(4);
    expect(get(targetColumns)).toBe(4);
    targetColumns.set(12);
    expect(get(targetColumns)).toBe(12);
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
      original_url: "/api/images/1/file?max=1024&v=1.0",
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

  describe("多选 stores", () => {
    const items: ImageSummary[] = [
      {
        id: 1, filename: "a.png", path: "a.png",
        original_url: "/api/images/1/file?max=1024", width: 1024, height: 1024,
        mtime: 1, size_bytes: 100, favorite: false, folder_ids: [], tags: [], model: null, seed: 1,
      },
      {
        id: 2, filename: "b.png", path: "b.png",
        original_url: "/api/images/2/file?max=1024", width: 1024, height: 1024,
        mtime: 2, size_bytes: 100, favorite: false, folder_ids: [], tags: [], model: null, seed: 2,
      },
      {
        id: 3, filename: "c.png", path: "c.png",
        original_url: "/api/images/3/file?max=1024", width: 1024, height: 1024,
        mtime: 3, size_bytes: 100, favorite: false, folder_ids: [], tags: [], model: null, seed: 3,
      },
    ];

    it("applySelection(none) 把 stores 切到单选状态", () => {
      applySelection(items, 2, "none");
      expect(get(selectedId)).toBe(2);
      expect(get(multiSelectedIds).size).toBe(1);
      expect(get(multiSelectedIds).has(2)).toBe(true);
      expect(get(selectionAnchorId)).toBe(2);
    });

    it("applySelection(ctrl) 在已有选区里追加", () => {
      applySelection(items, 1, "none");
      applySelection(items, 2, "ctrl");
      expect(get(selectedId)).toBe(2);
      expect([...get(multiSelectedIds)].sort()).toEqual([1, 2]);
      expect(get(selectionAnchorId)).toBe(2);
    });

    it("applySelection(ctrl) 点掉已在集合里的项", () => {
      applySelection(items, 1, "none");
      applySelection(items, 2, "ctrl");
      applySelection(items, 2, "ctrl");
      expect([...get(multiSelectedIds)].sort()).toEqual([1]);
      // primary 退到原 primary (1) 因为它仍在集合里
      expect(get(selectedId)).toBe(1);
    });

    it("applySelection(shift) 区间选", () => {
      applySelection(items, 1, "none");
      applySelection(items, 3, "shift");
      expect([...get(multiSelectedIds)].sort()).toEqual([1, 2, 3]);
      expect(get(selectedId)).toBe(3);
      expect(get(selectionAnchorId)).toBe(1);
    });

    it("clearSelection 清空所有三个 store", () => {
      applySelection(items, 1, "none");
      applySelection(items, 2, "ctrl");
      clearSelection();
      expect(get(selectedId)).toBe(null);
      expect(get(multiSelectedIds).size).toBe(0);
      expect(get(selectionAnchorId)).toBe(null);
    });

    it("removeIdsFromSelection 把指定 id 从集合剔除 + 必要时清空 primary", () => {
      applySelection(items, 1, "none");
      applySelection(items, 2, "ctrl");
      applySelection(items, 3, "ctrl");
      removeIdsFromSelection([2]);
      expect([...get(multiSelectedIds)].sort()).toEqual([1, 3]);
      expect(get(selectedId)).toBe(3);
      removeIdsFromSelection([3]);
      expect([...get(multiSelectedIds)].sort()).toEqual([1]);
      expect(get(selectedId)).toBe(1);
      removeIdsFromSelection([1]);
      expect(get(selectedId)).toBe(null);
      expect(get(selectionAnchorId)).toBe(null);
    });

    it("feedItems 变化时，把不在新 feed 的 id 从多选剔除", () => {
      applySelection(items, 1, "none");
      applySelection(items, 2, "ctrl");
      // 新 feed 只有 id=1 / id=3，id=2 应该被剔除
      feedItems.set([items[0], items[2]]);
      expect([...get(multiSelectedIds)].sort()).toEqual([1]);
      // primary=1 仍在 → 保留
      expect(get(selectedId)).toBe(1);
    });
  });
});
