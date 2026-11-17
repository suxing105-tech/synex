import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { readFileSync } from "node:fs";
import { get } from "svelte/store";
import Feed from "../components/Feed.svelte";
import { firstBox, nearestInDirection, previewTargetId, type GridBox } from "../lib/grid-nav";
import { itemsApi } from "../lib/api";
import {
  feedItems,
  feedLoading,
  feedLoadingMore,
  feedTotal,
  kindFilter,
  multiSelectedIds,
  scope,
  selectedId,
  selectedText,
  selectionAnchorId,
  stopAudio,
} from "../lib/stores";
import type { ItemSummary, MediaFeedItem, TextFeedItem } from "../lib/types";

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn() },
  imagesApi: {
    list: vi.fn(async () => ({ items: [], total: 0 })),
    detail: vi.fn(),
    presence: vi.fn(async () => ({ exists: true })),
    remove: vi.fn(),
    rename: vi.fn(),
  },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 3, total_videos: 0, total_audio: 0, total_texts: 1, folders: 0 })) },
  scanApi: { progress: vi.fn() },
  comfyuiApi: {},
  audioApi: { open: vi.fn(async () => ({ ok: true })) },
}));

/** 一张卡的位置：uid 就是 data-nav-id，left/top 用容器坐标。 */
function box(id: string, left: number, top: number, width = 100, height = 100): GridBox {
  return { id, left, top, width, height };
}

describe("nearestInDirection · 只认画面位置", () => {
  // 规整的 2 行 × 3 列：列 x = 0 / 108 / 216，行 y = 0 / 108，卡 100×100
  const grid = [
    box("media:1", 0, 0), box("media:2", 108, 0), box("media:3", 216, 0),
    box("media:4", 0, 108), box("text:2", 108, 108), box("media:6", 216, 108),
  ];

  it("向右走到同行紧邻的那一张", () => {
    expect(nearestInDirection(grid, "media:1", "right")).toBe("media:2");
    expect(nearestInDirection(grid, "media:2", "right")).toBe("media:3");
  });

  it("向下走到同列的下一张", () => {
    expect(nearestInDirection(grid, "media:1", "down")).toBe("media:4");
    expect(nearestInDirection(grid, "media:2", "down")).toBe("text:2");
  });

  it("向左 / 向上是反方向，走到头返回 null，不绕回另一端", () => {
    expect(nearestInDirection(grid, "media:2", "left")).toBe("media:1");
    expect(nearestInDirection(grid, "media:4", "up")).toBe("media:1");
    expect(nearestInDirection(grid, "media:1", "left")).toBeNull();
    expect(nearestInDirection(grid, "media:1", "up")).toBeNull();
  });

  it("起点不存在时不瞎指", () => {
    expect(nearestInDirection(grid, "media:99", "right")).toBeNull();
  });

  it("瀑布流错位时不按列表下标走：同列的下一张优先于邻列更高的那张", () => {
    // col0：A 高 200、D 跟在它下面；col1：B 高 100、C 跟在 B 下面
    const masonry = [
      box("media:1", 0, 0, 100, 200),    // A
      box("media:2", 108, 0, 100, 100),  // B
      box("media:3", 108, 108, 100, 100),// C —— 下标上它就在 A 后面，屏幕上是邻列
      box("media:4", 0, 208, 100, 100),  // D
    ];
    expect(nearestInDirection(masonry, "media:1", "down")).toBe("media:4");
    expect(nearestInDirection(masonry, "media:1", "right")).toBe("media:2");
  });

  it("那一侧没有正对的卡时兜一张最近的，不让方向键撞墙", () => {
    // 同列上面没有了，但邻列左上还有一张：放宽交叉轴，别返回 null
    const sparse = [box("media:1", 108, 108), box("media:2", 0, 0)];
    expect(nearestInDirection(sparse, "media:1", "up")).toBe("media:2");
  });

  it("firstBox 落在最上、然后最左的那一张", () => {
    expect(firstBox([box("media:6", 216, 108), box("media:1", 0, 0), box("media:2", 108, 0)])).toBe("media:1");
    expect(firstBox([])).toBeNull();
  });
});

// ---------- 接线：Feed 里的方向键真的换选中 ----------

function imageItem(id: number): MediaFeedItem {
  return {
    id, item_type: "media", kind: "image", filename: `图${id}.jpg`, path: `D:/图${id}.jpg`,
    original_url: `/api/images/${id}/file`, thumbnail_url: `/api/images/${id}/file`,
    width: 800, height: 600, mtime: 100 + id,
  } as unknown as MediaFeedItem;
}
function textItem(id: number): TextFeedItem {
  return {
    id, item_type: "text", kind: "text", filename: `随想${id}.md`, path: `D:/随想${id}.md`,
    mtime: 105 + id, tags: [], format: "md", excerpt: "摘录",
  } as unknown as TextFeedItem;
}

/** 与上面纯函数用例同一套几何：happy-dom 量不出布局，矩形由这里喂进去 */
const LAYOUT: Record<string, [number, number]> = {
  "media:1": [0, 0], "media:2": [108, 0], "media:3": [216, 0],
  "media:4": [0, 108], "text:2": [108, 108],
};
const ITEMS: ItemSummary[] = [imageItem(1), imageItem(2), imageItem(3), imageItem(4), textItem(2)];

function stubLayout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const uid = this.dataset?.navId;
    const at = uid ? LAYOUT[uid] : undefined;
    const [left, top] = at ?? [0, 0];
    return { left, top, right: left + 100, bottom: top + 100, width: 100, height: 100, x: left, y: top, toJSON() { return {}; } } as DOMRect;
  });
}

function renderFeed() {
  return render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
}

function press(key: string, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(window, { key, ...init });
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  scope.set("all");
  kindFilter.set("all");
  feedLoading.set(false);
  feedLoadingMore.set(false);
  stopAudio();
  multiSelectedIds.set(new Set());
  selectionAnchorId.set(null);
  selectedText.set(null);
  selectedId.set(null);
  feedItems.set(ITEMS);
  feedTotal.set(ITEMS.length);
  vi.mocked(itemsApi.list).mockReset();
  stubLayout();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  feedItems.set([]);
  multiSelectedIds.set(new Set());
  selectedText.set(null);
  selectedId.set(null);
});

describe("方向键移动选中", () => {
  it("每张卡都带上了导航身份，媒体与文本同一套", async () => {
    const { container } = renderFeed();
    await tick();
    const ids = [...container.querySelectorAll<HTMLElement>("[data-nav-id]")].map((el) => el.dataset.navId);
    expect(ids.sort()).toEqual(["media:1", "media:2", "media:3", "media:4", "text:2"]);
  });

  it("一张都没选中时先给落点：第一下落在最上最靠左那张，第二下才开始走", async () => {
    renderFeed();
    await tick();
    await press("ArrowRight");
    expect(get(selectedId)).toBe(1);
    expect(document.activeElement?.getAttribute("data-nav-id")).toBe("media:1");
    await press("ArrowRight");
    expect(get(selectedId)).toBe(2);
  });

  it("右方向逐格走，选中跟着走", async () => {
    renderFeed();
    await tick();
    selectedId.set(1);
    await press("ArrowRight");
    expect(get(selectedId)).toBe(2);
    expect([...get(multiSelectedIds)]).toEqual([2]);
    await press("ArrowRight");
    expect(get(selectedId)).toBe(3);
    expect(document.activeElement?.getAttribute("data-nav-id")).toBe("media:3");
  });

  it("下方向走到同列下一张，左走到头不再变", async () => {
    renderFeed();
    await tick();
    selectedId.set(1);
    await press("ArrowDown");
    expect(get(selectedId)).toBe(4);
    await press("ArrowLeft");
    expect(get(selectedId)).toBe(4);
  });

  it("走到文本卡上换成文本详情，不塞进媒体选区", async () => {
    renderFeed();
    await tick();
    selectedId.set(2);
    await press("ArrowDown");
    expect(get(selectedText)?.id).toBe(2);
    expect(get(selectedText)?.item_type).toBe("text");
    expect(get(multiSelectedIds).size).toBe(0);
  });

  it("Shift + 方向键沿轨迹扩选区（与 Shift + 点击同一套语义）", async () => {
    renderFeed();
    await tick();
    selectedId.set(1);
    selectionAnchorId.set(1);
    multiSelectedIds.set(new Set([1]));
    await press("ArrowRight", { shiftKey: true });
    expect([...get(multiSelectedIds)].sort()).toEqual([1, 2]);
    expect(get(selectedId)).toBe(2);
  });

  it("带着 Ctrl / Alt 不按导航走，留给既有快捷键", async () => {
    renderFeed();
    await tick();
    selectedId.set(1);
    await press("ArrowRight", { ctrlKey: true });
    expect(get(selectedId)).toBe(1);
  });

  it("输入框里的方向键不抢：光标还在打字就别动选区", async () => {
    const { container } = renderFeed();
    await tick();
    selectedId.set(1);
    const input = container.ownerDocument.createElement("input");
    container.appendChild(input);
    input.focus();
    await fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(get(selectedId)).toBe(1);
  });
});

describe("空格放大认的是当前那一张（2026-11-16 苏醒：与鼠标悬停冲突）", () => {
  it("有选中就以选中为准：鼠标停在别的卡上，开的仍是键盘选中的那一张", () => {
    expect(previewTargetId([], 2, 3)).toBe(2);
    expect(previewTargetId([2], 2, 3)).toBe(2);
  });

  it("一张都没选中才退回鼠标滑过的那张（纯鼠标那套手势不欠）", () => {
    expect(previewTargetId([], null, 3)).toBe(3);
    expect(previewTargetId([], null, null)).toBeNull();
  });

  it("正好选中两张走对比，开的是先选上的那一张", () => {
    expect(previewTargetId([4, 2], 2, 3)).toBe(4);
  });

  it("Feed 真的按这条判据取目标，没在调用点上把顺序又倒回去", () => {
    const feedSrc = readFileSync("src/components/Feed.svelte", "utf8");
    expect(feedSrc).toContain("previewTargetId([...$multiSelectedIds], selectedId, hoveredId)");
    // 旧的「悬停优先」写法不许复活
    expect(feedSrc).not.toMatch(/hoveredId\s*\?\?\s*selectedId/);
  });

  it("焦点环与选中环同一圈白：四类卡不分家", () => {
    const appCss = readFileSync("src/app.css", "utf8");
    const feedSrc = readFileSync("src/components/Feed.svelte", "utf8");
    const media = appCss.slice(appCss.indexOf(".thumb.media-card:focus-visible::after"));
    expect(media.slice(0, media.indexOf("}"))).toContain("box-shadow: inset 0 0 0 1px var(--thumb-ring)");
    // 旧的红色焦点环不许复活（品牌红只留给选中 · 进行中 · 主动作）
    expect(media.slice(0, media.indexOf("}"))).not.toContain("--accent");
    expect(feedSrc).toContain(".text-card:focus-visible::after { box-shadow: inset 0 0 0 1px var(--thumb-ring); }");
  });
});

describe("选中描边是内描边（2026-11-15 苏醒）", () => {
  // happy-dom 量不到合成样式，这里照本仓老规矩钉源文本：图片卡在 app.css、文本卡在 Feed 的 <style>
  const appCss = readFileSync("src/app.css", "utf8");
  const feedSrc = readFileSync("src/components/Feed.svelte", "utf8");

  it("图片 / 视频 / 音频卡的环是内描边，且画在最上层的覆盖层上", () => {
    const at = appCss.indexOf(".media-card.is-selected::after");
    expect(at, "选中环的 ::after 覆盖层规则没了").toBeGreaterThan(-1);
    const body = appCss.slice(at, appCss.indexOf("}", at));
    expect(body).toContain("box-shadow: inset 0 0 0 1px var(--thumb-ring)");
    // 卡片本体只许留投影：inset 阴影 / outline 都在图区那一层之下，画了等于没画
    const own = appCss.slice(appCss.indexOf(".media-card.is-selected {"));
    const ownBody = own.slice(0, own.indexOf("}"));
    expect(ownBody).not.toMatch(/outline/);
    expect(ownBody).not.toMatch(/box-shadow:[^;]*inset/);
  });

  it("文本卡同一条口径，四类卡不分家", () => {
    const at = feedSrc.indexOf(".text-card.is-selected::after");
    expect(at, "文本卡的 ::after 环没了").toBeGreaterThan(-1);
    const body = feedSrc.slice(at, feedSrc.indexOf("}", at));
    expect(body).toContain("box-shadow: inset 0 0 0 1px var(--thumb-ring)");
  });
});
