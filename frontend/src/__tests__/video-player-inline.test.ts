import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import VideoPlayer from "../components/VideoPlayer.svelte";
import { feedItems, multiSelectedIds } from "../lib/stores";

/**
 * 视频播放器必须是中间栏的内嵌层，而不是盖住整个应用的全屏黑场。
 *
 * 尺寸口径靠 CSS 结构锁死：只要有人把 vh / vw / fixed inset-0 写回来，
 * 画面就会重新算到左右侧栏头上，所以这些断言是故意做成源码断言的
 * （jsdom 不做布局，量不出真实尺寸）。行为部分只锁用户能感觉到的两件事：
 * Esc 回缩略图、底栏有页码。
 */
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  videosApi: { open: vi.fn(async () => ({ ok: true, id: 1, path: "D:/x.mp4" })), copy: vi.fn(async () => ({ ok: true })) },
}));

const raw = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "VideoPlayer.svelte"), "utf8");

const video = (id: number) => ({
  id, filename: `${id}.mp4`, path: `D:/${id}.mp4`, kind: "video",
  thumbnail_url: `/api/videos/${id}/thumb`, play_url: `/api/videos/${id}/file`, playable: true,
  width: 1920, height: 1080, duration_seconds: 12, mtime: 1, size_bytes: 1000,
  folder_ids: [], tags: [], model: null, seed: null,
});

beforeEach(() => {
  multiSelectedIds.set(new Set());
  feedItems.set([video(1), video(2)] as never);
});
afterEach(() => { cleanup(); multiSelectedIds.set(new Set()); feedItems.set([]); });

describe("视频播放器收进中间栏：结构与尺寸口径", () => {
  it("根节点与图片预览 / 文本阅读同一层（inline-viewer absolute inset-0）", () => {
    const ui = render(VideoPlayer, { open: true, startId: 1 });
    const root = ui.getByRole("region", { name: "视频播放器" });
    expect(root.className).toContain("inline-viewer");
    expect(root.className).toContain("absolute inset-0");
    expect(root.className).toContain("flex flex-col");
  });

  it("不再用 fixed 全屏层，也不再按视口高度算尺寸", () => {
    expect(raw).not.toMatch(/fixed\s+inset-0/);
    expect(raw).not.toMatch(/z-\[100\]/);
    expect(raw).not.toMatch(/\d+v[hw]/);
    expect(raw).not.toMatch(/role="dialog"/);
  });

  it("顶栏有「← 返回」并写明 Esc，底栏有页码与提示", () => {
    const ui = render(VideoPlayer, { open: true, startId: 1 });
    expect(ui.getByRole("button", { name: "返回缩略图" }).getAttribute("title")).toBe("返回缩略图（Esc）");
    expect(ui.getByText("1 / 2")).toBeTruthy();
    expect(ui.getByText("Esc 返回缩略图 · ← / → 切换视频")).toBeTruthy();
  });

  it("Esc 关闭；右箭头翻到下一个视频", async () => {
    const ui = render(VideoPlayer, { open: true, startId: 1 });
    await fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(ui.getByText("2 / 2")).toBeTruthy();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(ui.queryByRole("region", { name: "视频播放器" })).toBeNull();
  });

  it("底栏箭头同样翻页，App 靠 open 双向绑定收回图层", async () => {
    const ui = render(VideoPlayer, { open: true, startId: 2 });
    await fireEvent.click(ui.getByRole("button", { name: "上一个视频页码" }));
    expect(ui.getByText("1 / 2")).toBeTruthy();
    await fireEvent.click(ui.getByRole("button", { name: "返回缩略图" }));
    expect(ui.queryByRole("region", { name: "视频播放器" })).toBeNull();
  });
});
