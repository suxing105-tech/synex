import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { FEED_SORT_OPTIONS, feedSort, setFeedSort } from "../lib/feed-sort";

/**
 * 素材流排序偏好：全站一个值、存 localStorage、只有用户真的选过一次才落盘。
 * 存储那一套照 card-title.ts 的定稿走——它的 v1 就是栽在「一订阅就把当前值写进盘」，
 * 写进去之后翻默认值对老用户再也不生效，所以「store.set 不落盘」这条必须单独钉。
 */
const STORAGE_KEY = "seekx.feed-sort.v1";

beforeEach(() => {
  localStorage.clear();
  feedSort.set("mtime_desc");
});

describe("排序偏好这一个值", () => {
  it("默认是按时间新的在前，菜单两项的长相与顺序就是这一份真源", () => {
    expect(get(feedSort)).toBe("mtime_desc");
    expect(FEED_SORT_OPTIONS.map((o) => o.label)).toEqual(["按名称排序", "按时间排序"]);
    expect(FEED_SORT_OPTIONS.map((o) => o.value)).toEqual(["name_asc", "mtime_desc"]);
  });

  it("在菜单里选过一次就记住，下次进来还是那个", () => {
    setFeedSort("name_asc");
    expect(get(feedSort)).toBe("name_asc");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("name_asc");
  });

  it("单纯 store.set 不落盘：临时切换不该被当成用户的选择记下来", () => {
    feedSort.set("name_asc");
    expect(get(feedSort)).toBe("name_asc");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("落不了盘也不炸（无痕模式），本次会话内照样生效", () => {
    const original = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } },
    });
    try {
      expect(() => setFeedSort("name_asc")).not.toThrow();
      expect(get(feedSort)).toBe("name_asc");
    } finally {
      Object.defineProperty(window, "localStorage", { configurable: true, value: original });
    }
  });

  it("盘里是脏值时回落默认，不把脏值原样送进请求", async () => {
    localStorage.setItem(STORAGE_KEY, "name_desc");
    vi.resetModules();
    const fresh = await import("../lib/feed-sort");
    expect(get(fresh.feedSort)).toBe("mtime_desc");
  });
});