import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/svelte";
import SettingsModal from "../components/SettingsModal.svelte";
import { updateStatus } from "../lib/updates";

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  settingsApi: { get: vi.fn(async () => ({ watch_dirs: [], live_enabled: true })), update: vi.fn(async (cfg: any) => cfg) },
  comfyuiApi: { status: vi.fn(async () => ({ running: false, enabled: false, url: "" })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  foldersApi: { tree: vi.fn(async () => []), archived: vi.fn(async () => []), restore: vi.fn(async () => ({ ok: true })) },
  http: vi.fn(async () => []),
}));

const componentDir = resolve(process.cwd(), "src", "components");
const read = (path: string) => readFileSync(resolve(process.cwd(), "src", path), "utf8");
const settingsSource = () => read("components/SettingsModal.svelte");

// 回归（用户截图）：关于行写成了 `v{$updateStatus.current_version}`，
// JS 模板字符串里没有 $ 前缀就不是插值，页面直接显示花括号原文。
describe("设置页「关于」的版本号", () => {
  beforeEach(() => updateStatus.set(null));
  afterEach(() => cleanup());

  it("读不到更新服务时退化为「网页版」，且没有花括号漏到页面上", async () => {
    const ui = render(SettingsModal, { open: true, tab: "关于" });
    await screen.findByText("闪寻空间");
    expect(ui.getByText("网页版")).toBeTruthy();
    expect(ui.container.textContent ?? "").not.toContain("{$updateStatus");
  });

  it("桌面版走 ${} 插值，显示 v + 当前版本", () => {
    const source = settingsSource();
    expect(source).toContain("`v${$updateStatus.current_version}`");
    expect(source).not.toMatch(/`v\{\$/);
  });

  // 同类写法一次性扫掉：happy-dom 渲染不了 UpdatePanel 的更新分支，
  // 桌面版那条只能在源码层面锁。
  it("没有任何组件把 Svelte 的 {$..} 写进 JS 模板字符串", () => {
    const offenders = readdirSync(componentDir)
      .filter((name) => name.endsWith(".svelte"))
      .filter((name) => /`[^`\n]*(?<!\$)\{\$/.test(readFileSync(resolve(componentDir, name), "utf8")))
      .sort();
    expect(offenders).toEqual([]);
  });
});
