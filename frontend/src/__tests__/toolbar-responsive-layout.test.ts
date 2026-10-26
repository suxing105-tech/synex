import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { get } from "svelte/store";
import Feed from "../components/Feed.svelte";
import { feedItems, feedLoading, scope, targetColumns } from "../lib/stores";

/**
 * 「打开右侧详情栏就把工具栏裁掉」的回归测试。
 *
 * jsdom 不跑布局，所以这个文件分两层：
 *  - DOM 层：控件的先后顺序（滑块永远在最右）与结构不变量；
 *  - 源码 CSS 契约层：裁切来自「三列网格 + 内容不可缩」，jsdom 测不出来，
 *    就直接把组件源码里的规则钉住（和 comfyui.rs 那套 flag 计数同一思路）。
 */
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn() },
  scanApi: { progress: vi.fn() },
  comfyuiApi: {},
}));

// vitest 里 import.meta.url 是 http，只能按 cwd（frontend/）拼源码路径
const read = (name: string) => readFileSync(resolve(process.cwd(), "src/components", name), "utf8");
const FEED_SOURCE = read("Feed.svelte");
const CHIPS_SOURCE = read("TypeChips.svelte");
const SEARCH_SOURCE = read("GallerySearch.svelte");

const items = [1, 2].map((id) => ({
  id, item_type: "media", kind: "image", filename: `${id}.jpg`, path: `D:/${id}.jpg`,
  original_url: `/api/images/${id}/file`, thumbnail_url: `/api/images/${id}/file`, width: 900, height: 1200, mtime: id,
}));

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640); // 模拟详情栏打开后的窄 feed 列
  feedLoading.set(false);
  scope.set("all");
  feedItems.set(items as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  feedItems.set([]);
  scope.set("all");
});

describe("工具栏结构：图标内容靠左，滑块靠右", () => {
  it("工具栏还是三段：信息 / 搜索 / 控件", () => {
    const { container } = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
    const toolbar = container.querySelector(".gallery-toolbar")!;
    expect(toolbar.children).toHaveLength(3);
    expect(toolbar.children[0]).toBe(container.querySelector(".toolbar-info"));
    expect(toolbar.children[1]).toBe(container.querySelector(".gallery-search"));
    expect(toolbar.children[2]).toBe(container.querySelector(".toolbar-actions"));
  });

  it("控件组只有类型 chips 与列数滑块，滑块永远在最右（整组贴右，chips 挨着滑块）", () => {
    const { container } = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
    const kids = [...container.querySelectorAll<HTMLElement>(".toolbar-actions > *")];
    expect(kids.map((el) => el.className.split(" ")[0])).toEqual(["type-chips", "columns-slider"]);
  });

  it("排序按钮已经撤掉：统一流只有「新的在前」一个口径", () => {
    const { container } = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
    expect(container.querySelector(".sort-picker")).toBeNull();
    expect(container.querySelectorAll(".sort-opt")).toHaveLength(0);
    expect(container.textContent).not.toContain("名称");
  });

  it("单一类型不渲染 chips，滑块仍然在最右", () => {
    scope.set("audio");
    const { container } = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
    expect(container.querySelector(".type-chips")).toBeNull();
    const kids = [...container.querySelectorAll<HTMLElement>(".toolbar-actions > *")];
    expect(kids.at(-1)!.className).toContain("columns-slider");
  });

  it("滑块仍然工作：拖动改列数", async () => {
    const { container } = render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
    const slider = container.querySelector<HTMLInputElement>(".columns-slider")!;
    await fireEvent.input(slider, { target: { value: "7" } });
    expect(get(targetColumns)).toBe(7);
  });
});

describe("工具栏布局契约：宽列居中、窄列不裁切", () => {
  it("宽列三段网格，左右轨道都是 minmax(0, 1fr) —— 两侧严格等宽，搜索框才真的居中", () => {
    const rule = FEED_SOURCE.match(/\.gallery-toolbar \{ display: grid;([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain("grid-template-columns: minmax(0, 1fr) minmax(200px, 30%) minmax(0, 1fr)");
    // 侧轨下限必须是 0：0.2.22 的裁切正是网格侧列设了 min 下限（minmax(280px, 1fr)）撑破容器
    expect((rule![1].match(/minmax\(0, 1fr\)/g) ?? []).length).toBe(2);
    expect(rule![1]).not.toMatch(/minmax\(\d+px, 1fr\)/);
  });

  it("搜索框在中间那一列，最大 480 且自身 mx-auto", () => {
    expect(SEARCH_SOURCE).toContain("max-w-[480px] mx-auto");
  });

  it("窄容器（详情栏打开、窗口变小）回退成可换行 flex，整组换行不裁切", () => {
    expect(FEED_SOURCE).toMatch(/@container \(max-width: 1280px\) \{\s*\.gallery-toolbar \{ display: flex; flex-wrap: wrap; \}/);
    expect(FEED_SOURCE).toMatch(/:global\(\.gallery-toolbar \.gallery-search\) \{ flex: /);
  });

  it("控件组整组贴右（宽列靠 justify-content，窄列再加 margin-left:auto，chips 始终挨着滑块）", () => {
    expect(FEED_SOURCE).toMatch(/\.toolbar-actions \{ min-width: 0; justify-content: flex-end/);
    expect(FEED_SOURCE).toMatch(/\.toolbar-actions \{ flex: 0 1 auto; margin-left: auto; justify-content: flex-end/);
  });

  it("滑块不参与压缩，也不再自己 margin-left:auto 撑出空档", () => {
    expect(FEED_SOURCE).toMatch(/\.toolbar-actions \.columns-slider \{ flex-shrink: 0; \}/);
    expect(FEED_SOURCE).not.toMatch(/\.toolbar-actions \.columns-slider \{[^}]*margin-left: auto/);
  });

  it("chips 装不下时自己换行，而不是撑破工具栏", () => {
    expect(CHIPS_SOURCE).toMatch(/\.type-chips \{[^}]*flex-wrap: wrap/);
    expect(CHIPS_SOURCE).not.toMatch(/\.type-chips \{[^}]*flex-shrink: 0/);
  });

  it("搜索框带上可被外层命中的类（跨组件样式需要 :global）", () => {
    expect(SEARCH_SOURCE).toContain("gallery-search");
    expect(FEED_SOURCE).toMatch(/:global\(\.gallery-toolbar \.gallery-search\) \{ flex: /);
  });
});
