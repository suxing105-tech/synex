import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import SettingsModal from "../components/SettingsModal.svelte";

/**
 * 设置页的 Esc（2026-11-11 苏醒：「设置页开着时按 Esc 关掉，修一下」）。
 *
 * 以前整页只认左上角那颗返回按钮，键盘按 Esc 什么也不发生——而 Esc 在本应用里
 * 一路是「退回上一层」：Lightbox、阅读层、视频层、各种弹层都认，只有设置页不认。
 * 这里钉住三条边界：正文里按要关、焦点在输入框里按不许关、快捷键录制中按只取消录制。
 */

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  settingsApi: { get: vi.fn(async () => ({ watch_dirs: [], live_enabled: true })), update: vi.fn(async (cfg: any) => cfg) },
  comfyuiApi: { status: vi.fn(async () => ({ running: false, enabled: false, url: "" })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  foldersApi: { tree: vi.fn(async () => []), archived: vi.fn(async () => []), restore: vi.fn(async () => ({ ok: true })) },
  http: vi.fn(async () => []),
}));

const openSettings = async (tab = "通用") => {
  render(SettingsModal, { open: true, tab });
  await screen.findByRole("dialog", { name: "设置" });
};

describe("设置页的 Esc", () => {
  afterEach(() => cleanup());

  it("焦点在页面正文里按 Esc，整页关掉", async () => {
    await openSettings();
    await fireEvent.keyDown(screen.getByRole("dialog", { name: "设置" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull();
  });

  it("刚从侧栏 ⚙ 打开、焦点还留在那颗按钮上时，Esc 也关得掉", async () => {
    // 这一枪的目标不是 dialog 的子节点，所以监听必须挂在 window 上才接得住
    await openSettings();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull();
  });

  it("焦点在输入框里时 Esc 归输入框，不把整页带走", async () => {
    await openSettings();
    await fireEvent.keyDown(screen.getByLabelText("搜索设置"), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
  });

  it("快捷键录制中按 Esc 只取消录制，设置页留在原地", async () => {
    await openSettings("快捷键");
    const record = screen.getByRole("button", { name: "设置展开 / 收起右侧栏快捷键" });
    await fireEvent.click(record);
    expect(record.getAttribute("aria-pressed")).toBe("true");
    await fireEvent.keyDown(record, { key: "Escape" });
    expect(record.getAttribute("aria-pressed")).not.toBe("true");
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
  });

  it("设置页开着时网格的键盘处理让路，Esc 不顺手清空背后的选区", () => {
    // 网格只认 overlayOpen / cloneOpen，设置页必须算进「中间栏之上还有东西」
    const app = readFileSync("src/App.svelte", "utf8");
    expect(app).toMatch(/overlayOpen=\{[^}]*\|\| settingsOpen\}/);
  });
});
