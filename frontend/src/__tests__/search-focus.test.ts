import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Feed from "../components/Feed.svelte";
import { itemsApi } from "../lib/api";
import { focusGallerySearch, gallerySearchElement, registerGallerySearchElement, registerSearchFocusShortcut } from "../lib/search-focus";
import { defaultShortcuts, saveShortcuts, shortcutSettings } from "../lib/shortcut-settings";
import { feedItems, feedLoading, feedTotal, scope } from "../lib/stores";

/**
 * Ctrl+F 把光标送进中间栏的搜索框。
 *
 * 搜索框在网格工具栏里，内嵌层开着时那块整体是 inert，聚焦会被浏览器静默拒绝，
 * 所以定位要等层关掉、inert 撤掉为止 —— 这里逐帧重试，不靠运气。
 */
const APP_SOURCE = readFileSync(resolve(process.cwd(), "src/App.svelte"), "utf8");
const READER_SOURCE = readFileSync(resolve(process.cwd(), "src/components/TextReader.svelte"), "utf8");

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn(), presence: vi.fn(), remove: vi.fn(), rename: vi.fn(), reveal: vi.fn(), copyFile: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn(async () => ({ total_images: 1, total_videos: 0, total_audio: 0, total_texts: 0, folders: 0 })) },
  scanApi: { progress: vi.fn() }, comfyuiApi: {}, videosApi: { open: vi.fn() }, audioApi: { open: vi.fn() },
}));

const IMAGE = { id: 1, item_type: "media", kind: "image", filename: "1.jpg", path: "D:/1.jpg", width: 800, height: 600, mtime: 1 };

function renderFeed() {
  return render(Feed, { selectedId: null, lightboxOpen: false, lightboxIndex: 0 });
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  localStorage.clear();
  scope.set("all");
  feedLoading.set(false);
  feedItems.set([IMAGE] as never);
  feedTotal.set(1);
  vi.mocked(itemsApi.list).mockResolvedValue({ items: [IMAGE], total: 1, counts: { image: 1, video: 0, audio: 0, text: 0 } } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  feedItems.set([]);
  feedTotal.set(0);
  registerGallerySearchElement(null);
});

describe("Ctrl+F 定位搜索框", () => {
  it("搜索框挂载时把自己交给 search-focus，卸载后交还", async () => {
    const ui = renderFeed();
    await tick();
    const input = ui.getByLabelText("搜索图片、视频、音频、文本") as HTMLInputElement;
    expect(gallerySearchElement()).toBe(input);
    cleanup();
    expect(gallerySearchElement()).toBeNull();
  });

  it("定位后光标在搜索框里，已有内容整段选中", async () => {
    const ui = renderFeed();
    await tick();
    const input = ui.getByLabelText("搜索图片、视频、音频、文本") as HTMLInputElement;
    input.value = "灯塔";
    expect(await focusGallerySearch()).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(2);
  });

  it("网格还被 inert 挡住时不假装成功，等 inert 撤掉再聚焦", async () => {
    const ui = renderFeed();
    await tick();
    const input = ui.getByLabelText("搜索图片、视频、音频、文本") as HTMLInputElement;
    ui.container.setAttribute("inert", "");
    const pending = focusGallerySearch();
    // 内嵌层关闭后 inert 撤掉：定位成功（真实路径 = 应用先关层，再调定位）。
    requestAnimationFrame(() => ui.container.removeAttribute("inert"));
    expect(await pending).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("inert 一直不撤就放弃，不无限等", async () => {
    const ui = renderFeed();
    await tick();
    ui.container.setAttribute("inert", "");
    expect(await focusGallerySearch()).toBe(false);
  });

  it("正在别的输入框里打字时按 Ctrl+F 也能跳，改键与清空都跟着设置", () => {
    const fired: number[] = [];
    const off = registerSearchFocusShortcut(() => fired.push(1));
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    expect(fired).toEqual([1]);

    // 改键后旧键失效、新键生效；清空快捷键后彻底不响应。
    saveShortcuts({ ...defaultShortcuts, searchFocus: "ctrl+k" });
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    expect(fired).toEqual([1]);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    expect(fired).toEqual([1, 1]);
    shortcutSettings.set({ ...defaultShortcuts, searchFocus: "" });
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    expect(fired).toEqual([1, 1]);

    input.remove();
    off();
    shortcutSettings.set({ ...defaultShortcuts });
  });

  it("设置弹窗打开时不跳搜索框", () => {
    const fired: number[] = [];
    const off = registerSearchFocusShortcut(() => fired.push(1));
    const dialog = document.createElement("div");
    dialog.setAttribute("data-settings-dialog", "");
    document.body.append(dialog);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    expect(fired).toEqual([]);
    dialog.remove();
    off();
  });

  it("弹窗开着时不抢焦点，光标留在对话框里", () => {
    const fired: number[] = [];
    const off = registerSearchFocusShortcut(() => fired.push(1));
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    const area = document.createElement("textarea");
    modal.append(area);
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    expect(fired).toEqual([]);
    modal.remove();
    off();
  });

  it("App 用可改键的 searchFocus 接线，并先退掉内嵌层", () => {
    expect(APP_SOURCE).toContain("registerSearchFocusShortcut(");
    expect(APP_SOURCE).toContain("closeOpenViewers();");
    // 阅读层必须先落盘再关，所以 App 只发事件，不直接清 readerItem。
    expect(APP_SOURCE).toContain('new Event("close-text-reader")');
    expect(READER_SOURCE).toContain("'close-text-reader'");
    expect(READER_SOURCE).toContain("if (open) void close()");
    // 满屏那一步没有工具栏，Ctrl+F 要先退出满屏再聚焦，否则这一下按下去毫无反应。
    expect(APP_SOURCE).toContain('if (focusStage === "fullscreen") leaveFocusMode();');
  });
});
