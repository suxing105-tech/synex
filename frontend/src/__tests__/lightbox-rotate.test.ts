import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { feedItems, multiSelectedIds, refreshFeed } from "../lib/stores";
import { imagesApi } from "../lib/api";
import Lightbox from "../components/Lightbox.svelte";
import { getOrientedImageSize } from "../lib/image-dims";

/**
 * 预览顶栏的「向左 / 向右旋转 90°」是真的把像素转掉写回原文件，所以前端只负责三件事：
 * 一次只放一个请求、写盘后换一个 URL 让 <img> 重新解码、刷完 feed 把 index 认回原来那一张
 * （统一流固定「新的在前」，mtime 一改这一张就跳到列表最前面）。
 */
vi.mock("../lib/image-dims", async (original) => ({
  ...(await original<object>()),
  getOrientedImageSize: vi.fn().mockResolvedValue({ w: 1200, h: 800 }),
}));
// refreshFeed 真身要重新拉整条 feed。替身按真口径重排（mtime 新的在前），
// 「index 认回原来那一张」才有东西可验；其余 store 一律用真的。
vi.mock("../lib/stores", async (original) => {
  const mod = await original<Record<string, any>>();
  return {
    ...mod,
    refreshFeed: vi.fn(async () => {
      mod.feedItems.update((items: any[]) => [...items].sort((a, b) => b.mtime - a.mtime));
    }),
    refreshStats: vi.fn(async () => {}),
    refreshSelectedDetail: vi.fn(async () => {}),
  };
});

const img = (id: number, filename: string, mtime: number, kind = "image") => ({
  item_type: "media", kind, id, filename, path: `D:/pics/${filename}`,
  width: 1200, height: 800, size_bytes: 4096, mtime, tags: [],
});
/** 打开预览时停在最后一张：旋转后它会被 mtime 顶到列表最前，正好验重新定位。 */
const open = (...items: any[]) => {
  feedItems.set(items as any);
  return render(Lightbox, { open: true, index: items.length - 1, selectedId: items[items.length - 1].id });
};
type UI = ReturnType<typeof open>;
const toast = (ui: UI) => ui.container.querySelector(".toast")?.textContent ?? "";
/** 后端旋转成功的口径：宽高互换、mtime 变成现在（真接口的返回体同样是更新后的行）。 */
function rotateStub(id: number, mtime = 999) {
  return vi.spyOn(imagesApi, "rotate").mockImplementation(async (target, dir) => {
    feedItems.update((items) =>
      items.map((it: any) =>
        it.id === target
          ? { ...it, mtime, width: it.height, height: it.width, dir }
          : it,
      ),
    );
    return { id: target } as any;
  });
}
/** getByRole 只给 HTMLElement，测试要看 disabled、点它，得按按钮来认。 */
const btn = (ui: UI, name: string) => ui.getByRole("button", { name }) as HTMLButtonElement;
const left = (ui: UI) => btn(ui, "向左旋转");
const right = (ui: UI) => btn(ui, "向右旋转");

beforeEach(() => {
  // afterEach 的 restoreAllMocks 会把这个 vi.fn 的实现清空，每条重挂一次
  vi.mocked(getOrientedImageSize).mockResolvedValue({ w: 1200, h: 800 });
  vi.mocked(refreshFeed).mockClear();
  multiSelectedIds.set(new Set());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("预览顶栏旋转 90°", () => {
  it("两个按钮在缩放开关之前，DOM 顺序和源码顺序都算", () => {
    const ui = open(img(1, "a.png", 300), img(2, "b.png", 100));
    const names = [...ui.container.querySelectorAll("header button")].map(
      (b) => b.getAttribute("aria-label") || b.textContent?.trim(),
    );
    expect(names).toContain("向左旋转");
    expect(names).toContain("向右旋转");
    // Svelte 5 的事件委托：组件排在同分支兄弟按钮之前会让后面的按钮点不动，
    // 所以旋转（原生 button）必须在 <ViewerZoomControls> 这个组件前面。
    expect(names.indexOf("向右旋转")).toBeLessThan(names.indexOf("适应窗口"));
    const src = readFileSync("src/components/Lightbox.svelte", "utf8");
    expect(src.indexOf('aria-label="向左旋转"')).toBeLessThan(src.indexOf("<ViewerZoomControls"));
  });

  it("点「向右旋转」写回原文件：换 URL 重载、提示已保存、index 认回这一张", async () => {
    const rotate = rotateStub(2);
    const ui = open(img(1, "a.png", 300), img(2, "b.png", 100));
    expect(ui.getByRole("img").getAttribute("src")).toContain("cache=2");
    expect(ui.getByRole("img").getAttribute("src")).not.toContain("v=r");
    await fireEvent.click(right(ui));
    await waitFor(() => expect(toast(ui)).toContain("已保存"));
    expect(rotate).toHaveBeenCalledWith(2, "right");
    expect(toast(ui)).toBe("已保存：顺时针旋转 90°");
    // src 一个字符不变浏览器就不会重新取图，写盘后必须带上版本号
    expect(ui.getByRole("img").getAttribute("src")).toContain("cache=2&v=r1");
    expect(refreshFeed).toHaveBeenCalledWith({ keepScroll: true });
    // 写盘把 mtime 改成现在 → 这一张排到列表最前，但看的仍是它
    expect(ui.getByRole("img").getAttribute("alt")).toBe("b.png");
    expect(ui.getByRole("img").getAttribute("src")).toContain("/api/images/2/file");
    expect(ui.container.querySelector("footer")?.textContent).toContain("1 / 2");
    expect(ui.container.querySelector("footer")?.textContent).toContain("800 × 1200");
  });

  it("点「向左旋转」发 left，提示写逆时针", async () => {
    const rotate = rotateStub(2);
    const ui = open(img(1, "a.png", 300), img(2, "b.png", 100));
    await fireEvent.click(left(ui));
    await waitFor(() => expect(toast(ui)).toContain("已保存"));
    expect(rotate).toHaveBeenCalledWith(2, "left");
    expect(toast(ui)).toBe("已保存：逆时针旋转 90°");
  });

  it("写盘没回来之前连点只发一个请求，按钮置灰且 aria-busy", async () => {
    let settle: () => void = () => {};
    const rotate = vi
      .spyOn(imagesApi, "rotate")
      .mockImplementation(() => new Promise<void>((resolve) => (settle = () => resolve())) as any);
    const ui = open(img(1, "a.png", 300), img(2, "b.png", 100));
    await fireEvent.click(left(ui));
    expect(left(ui).getAttribute("aria-busy")).toBe("true");
    expect(left(ui).disabled).toBe(true);
    // 置灰 + rotating 守卫双保险：键盘连按同一套键也不会二次提交
    left(ui).click();
    right(ui).click();
    await fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    await fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    expect(rotate).toHaveBeenCalledTimes(1);
    settle();
    await waitFor(() => expect(right(ui).disabled).toBe(false));
  });

  it("旋转失败：URL 不动，提示用后端那句中文", async () => {
    const rotate = vi
      .spyOn(imagesApi, "rotate")
      .mockRejectedValue(
        Object.assign(new Error("POST /api/images/2/rotate → 409"), { detail: "文件正被其它程序占用" }),
      );
    const ui = open(img(1, "a.png", 300), img(2, "b.png", 100));
    const before = ui.getByRole("img").getAttribute("src");
    await fireEvent.click(right(ui));
    await waitFor(() => expect(toast(ui)).toContain("旋转失败"));
    expect(rotate).toHaveBeenCalledWith(2, "right");
    expect(toast(ui)).toBe("旋转失败：文件正被其它程序占用");
    expect(ui.getByRole("img").getAttribute("src")).toBe(before);
    expect(ui.getByRole("img").getAttribute("alt")).toBe("b.png");
    expect(right(ui).disabled).toBe(false);
  });

  it("PSD 只给置灰：psd-tools 写不回原文件，点了也不发请求", async () => {
    const rotate = vi.spyOn(imagesApi, "rotate");
    const ui = open(img(1, "a.png", 300), img(2, "封面.psd", 100));
    expect(right(ui).disabled).toBe(true);
    expect(right(ui).getAttribute("title")).toContain("PSD");
    await fireEvent.click(right(ui));
    expect(rotate).not.toHaveBeenCalled();
  });

  it("视频 / 音频不渲染旋转按钮", () => {
    const video = open(img(1, "a.png", 300), img(2, "clip.mp4", 100, "video"));
    expect(video.queryByRole("button", { name: "向左旋转" })).toBeNull();
    expect(video.queryByRole("button", { name: "向右旋转" })).toBeNull();
    cleanup();
    const audio = open(img(1, "a.png", 300), img(2, "氛围底噪.mp3", 100, "audio"));
    expect(audio.queryByRole("button", { name: "向左旋转" })).toBeNull();
  });

  it("对比模式不提供旋转", () => {
    multiSelectedIds.set(new Set([1, 2]));
    const ui = open(img(1, "a.png", 300), img(2, "b.png", 100));
    expect(ui.queryByRole("button", { name: "向左旋转" })).toBeNull();
    expect(ui.getByRole("button", { name: "查看单图" })).toBeTruthy();
  });

  it("Alt + ←/→ 旋转，裸方向键仍然只管上一张 / 下一张", async () => {
    const rotate = rotateStub(2);
    const ui = open(img(1, "a.png", 300), img(2, "b.png", 100));
    await fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    await waitFor(() => expect(rotate).toHaveBeenCalledWith(2, "left"));
    expect(ui.getByRole("img").getAttribute("alt")).toBe("b.png");
    expect(ui.container.querySelector("footer")?.textContent).toContain("1 / 2");
    cleanup();
    const plain = open(img(1, "a.png", 300), img(2, "b.png", 100));
    await fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(plain.getByRole("img").getAttribute("alt")).toBe("a.png");
  });
});
