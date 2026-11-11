import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import SettingsModal from "../components/SettingsModal.svelte";

/**
 * 弹层与内嵌阅读层的焦点归属（2026-11-11 无障碍审计 P1）。
 *
 * 审计实测：从侧栏 ⚙ 打开设置后焦点还留在那颗按钮上，连按 Tab 走进的是背后的搜索框、
 * 类型 chips；图片预览层更干脆，进出焦点都落在 <body>。lib/modal-focus.ts 早就有
 * 「打开收进来、Tab 锁在里面、关掉还给触发元素」这套动作，只是这几个地方没挂。
 * 这里钉住：设置页 + 三个内嵌阅读层（图片 / 文本 / 视频）谁都不许漏。
 */

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  settingsApi: { get: vi.fn(async () => ({ watch_dirs: [], live_enabled: true })), update: vi.fn(async (cfg: any) => cfg) },
  comfyuiApi: { status: vi.fn(async () => ({ running: false, enabled: false, url: "" })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  foldersApi: { tree: vi.fn(async () => []), archived: vi.fn(async () => []), restore: vi.fn(async () => ({ ok: true })) },
  http: vi.fn(async () => []),
}));

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("设置页的焦点归属", () => {
  afterEach(() => cleanup());

  it("打开即把焦点收进对话框，关掉还给触发它的那颗按钮", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "设置";
    document.body.append(trigger);
    trigger.focus();
    render(SettingsModal, { open: true, tab: "通用" });
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(document.activeElement).toBe(dialog);

    await fireEvent.click(screen.getByLabelText("返回图库"));
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("Tab 走不出设置页", async () => {
    render(SettingsModal, { open: true, tab: "通用" });
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,[tabindex="0"]'),
    );
    expect(focusables.length).toBeGreaterThan(3);
    focusables[focusables.length - 1].focus();
    await fireEvent.keyDown(focusables[focusables.length - 1], { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("三个内嵌阅读层都得把焦点收进来", () => {
  // 图片 Lightbox、文本阅读、视频播放器共用同一条 inline-viewer 规矩，漏一个就是漏一类素材
  for (const file of ["Lightbox.svelte", "TextReader.svelte", "VideoPlayer.svelte"]) {
    it(`${file} 的根节点带 tabindex="-1" 与 use:modalFocus`, () => {
      const root = /<section class="inline-viewer[^>]*>/.exec(read("../components/" + file))?.[0] ?? "";
      expect(root).toContain('tabindex="-1"');
      expect(root).toContain("use:modalFocus");
    });
  }

  it("设置页的整屏对话框同样锁焦点", () => {
    const root = /<div class="fixed inset-0 z-\[60\][^"]*"[^>]*>/.exec(read("../components/SettingsModal.svelte"))?.[0] ?? "";
    expect(root).toContain("aria-modal=\"true\"");
    expect(root).toContain('tabindex="-1"');
    expect(root).toContain("use:modalFocus");
  });
});
