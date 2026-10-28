import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { readFileSync } from "node:fs";
import VideoPlayer from "../components/VideoPlayer.svelte";
import { feedItems, multiSelectedIds } from "../lib/stores";

/**
 * 视频放大查看：与图片预览同一套「适应窗口 ⇄ 100%」。
 *
 * jsdom / happy-dom 不做布局，量不到真实画布尺寸，所以：
 * - 倍率类断言只看用户能看到的读数与按钮高亮；
 * - 结构口径（画面按显示框定尺寸、不再 contain 铺满、共用同一个缩放组件）走源码断言，
 *   防止有人把 object-contain 写回来把 100% 顶掉。
 */
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  videosApi: { open: vi.fn(async () => ({ ok: true, id: 1, path: "D:/x.mp4" })), copy: vi.fn(async () => ({ ok: true })) },
}));

const raw = readFileSync("src/components/VideoPlayer.svelte", "utf8");
const lightboxRaw = readFileSync("src/components/Lightbox.svelte", "utf8");

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

describe("视频放大查看：与图片同一组开关", () => {
  it("顶栏有「适应窗口」「100%」，默认停在适应窗口", () => {
    const ui = render(VideoPlayer, { open: true, startId: 1 });
    expect(ui.getByRole("button", { name: "适应窗口" }).getAttribute("aria-pressed")).toBe("true");
    expect(ui.getByRole("button", { name: "100%" }).getAttribute("aria-pressed")).toBe("false");
    // 顶栏最后一个读数就是当前倍率（fit 态画布量不到，按比例 = 100%）
    const readouts = ui.container.querySelectorAll("header span.text-muted");
    expect(readouts[readouts.length - 1].textContent).toBe("100%");
  });

  it("点 100%：按钮高亮，画面按原始像素定尺寸", () => {
    const ui = render(VideoPlayer, { open: true, startId: 1 });
    fireEvent.click(ui.getByRole("button", { name: "100%" }));
    expect(ui.getByRole("button", { name: "100%" }).getAttribute("aria-pressed")).toBe("true");
    const media = ui.container.querySelector("video")!;
    expect(media.style.width).toBe("1920px");
    expect(media.style.height).toBe("1080px");
    expect(media.classList.contains("video-fill")).toBe(false);
  });

  it("双击画面切到 100%，再双击回适应窗口", () => {
    const ui = render(VideoPlayer, { open: true, startId: 1 });
    const media = ui.container.querySelector("video")!;
    fireEvent.dblClick(media);
    expect(ui.getByRole("button", { name: "100%" }).getAttribute("aria-pressed")).toBe("true");
    expect(ui.queryByRole("region", { name: "视频播放器" })).toBeTruthy();
    fireEvent.dblClick(media);
    expect(ui.getByRole("button", { name: "适应窗口" }).getAttribute("aria-pressed")).toBe("true");
    expect(ui.queryByRole("region", { name: "视频播放器" })).toBeTruthy();
  });

  it("双击画面外的黑边返回缩略图，与图片一致", () => {
    const ui = render(VideoPlayer, { open: true, startId: 1 });
    fireEvent.dblClick(ui.container.querySelector(".video-stage")!);
    expect(ui.queryByRole("region", { name: "视频播放器" })).toBeNull();
  });

  it("滚轮放大：读数跟着变，画面开始平移", () => {
    const ui = render(VideoPlayer, { open: true, startId: 1 });
    fireEvent.wheel(ui.container.querySelector(".video-canvas")!, { deltaY: -100 });
    expect(ui.getByRole("button", { name: "100%" }).getAttribute("aria-pressed")).toBe("true");
    expect(ui.getByText("115%")).toBeTruthy();
    expect(ui.container.querySelector("video")!.style.transform).toContain("translate");
  });

  it("100% 态按 Esc 先退回适应窗口，再按一次才回缩略图", () => {
    const ui = render(VideoPlayer, { open: true, startId: 1 });
    fireEvent.click(ui.getByRole("button", { name: "100%" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(ui.queryByRole("region", { name: "视频播放器" })).toBeTruthy();
    expect(ui.getByRole("button", { name: "适应窗口" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(ui.queryByRole("region", { name: "视频播放器" })).toBeNull();
  });

  it("翻到下一个视频：缩放归零，不带上一支的 100%", () => {
    const ui = render(VideoPlayer, { open: true, startId: 1 });
    fireEvent.click(ui.getByRole("button", { name: "100%" }));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(ui.getByText("2 / 2")).toBeTruthy();
    expect(ui.getByRole("button", { name: "适应窗口" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("对比模式让位给对比视图：不出现缩放开关", () => {
    multiSelectedIds.set(new Set([1, 2]));
    const ui = render(VideoPlayer, { open: true, startId: 1 });
    expect(ui.getByText("对比已选中的两个视频")).toBeTruthy();
    expect(ui.queryByRole("button", { name: "100%" })).toBeNull();
    expect(ui.queryByRole("button", { name: "适应窗口" })).toBeNull();
  });

  it("进对比前先放大过：退出对比回到适应窗口，不会停在 100%", async () => {
    const ui = render(VideoPlayer, { open: true, startId: 1 });
    fireEvent.click(ui.getByRole("button", { name: "100%" }));
    multiSelectedIds.set(new Set([1, 2]));
    await tick();
    expect(ui.getByText("对比已选中的两个视频")).toBeTruthy();
    multiSelectedIds.set(new Set([1]));
    await tick();
    expect(ui.getByRole("button", { name: "适应窗口" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("放大是来停帧看细节的：进缩放会暂停，回适应窗口续播", () => {
    const ui = render(VideoPlayer, { open: true, startId: 1 });
    const media = ui.container.querySelector("video")!;
    let played = 0;
    let paused = 0;
    media.play = () => { played++; return Promise.resolve(); };
    media.pause = () => { paused++; };
    Object.defineProperty(media, "paused", { configurable: true, get: () => paused > played });
    fireEvent.click(ui.getByRole("button", { name: "100%" }));
    expect(paused).toBe(1);
    fireEvent.click(ui.getByRole("button", { name: "适应窗口" }));
    expect(played).toBe(1);
  });
});

describe("视频放大的结构口径", () => {
  it("画面按显示框定尺寸，不再 inset-0 + object-contain 铺满", () => {
    expect(raw).toContain('class="video-media"');
    expect(raw).toContain("style:width={zoom.sized ? `${zoom.displayW}px` : null}");
    expect(raw).not.toContain("absolute inset-0 h-full w-full object-contain");
    expect(raw).toContain("bind:clientWidth={viewportW}");
    expect(raw).toContain("use:viewerZoomWheel={zoom}");
  });

  it("图片与视频共用同一份缩放实现", () => {
    for (const src of [raw, lightboxRaw]) {
      expect(src).toContain('from "../lib/viewer-zoom.svelte"');
      expect(src).toContain("<ViewerZoomControls {zoom} />");
    }
    const controls = readFileSync("src/components/ViewerZoomControls.svelte", "utf8");
    expect(controls).toContain("适应窗口");
    expect(controls).toContain(">100%<");
    // 文案只许长在共享组件里，两边各自硬编码迟早漂移
    expect(raw).not.toContain(">适应窗口<");
    expect(lightboxRaw).not.toContain(">适应窗口<");
  });

  it("缩放开关排在顶栏所有按钮之后（Svelte 5 事件委托）", () => {
    for (const src of [raw, lightboxRaw]) {
      const header = src.slice(src.indexOf("<header"), src.indexOf("</header>"));
      expect(header.lastIndexOf("<button")).toBeLessThan(header.lastIndexOf("<ViewerZoomControls"));
    }
  });
});