import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import SettingsModal from "../components/SettingsModal.svelte";

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  settingsApi: { get: vi.fn(async () => ({ watch_dirs: [], live_enabled: true })), update: vi.fn(async (cfg: any) => cfg) },
  comfyuiApi: { status: vi.fn(async () => ({ running: false, enabled: false, url: "" })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  foldersApi: { tree: vi.fn(async () => []), archived: vi.fn(async () => []), restore: vi.fn(async () => ({ ok: true })) },
  http: vi.fn(async () => []),
}));

const read = (path: string) => readFileSync(resolve(process.cwd(), "src", path), "utf8");

describe("设置页「关于」的开发者栏目", () => {
  afterEach(() => cleanup());

  it("写明开发者，并给出微信联系方式与赞赏收款码", async () => {
    const ui = render(SettingsModal, { open: true, tab: "关于" });
    await screen.findByText("闪寻空间");
    expect(ui.getByText("开发者")).toBeTruthy();
    expect(ui.getByText(/苏醒/).textContent).toContain("苏醒");
    const alts = [...ui.container.querySelectorAll("img")].map((img) => img.getAttribute("alt"));
    expect(alts.some((a) => a?.includes("微信二维码"))).toBe(true);
    expect(alts.some((a) => a?.includes("微信收款码"))).toBe(true);
    // 二维码是随包资源，不是运行时去网上拉
    const modal = read("components/SettingsModal.svelte");
    expect(modal).toContain('import wechatContact from "../assets/about/wechat-contact.png"');
    expect(modal).toContain('import rewardQr from "../assets/about/reward-qr.png"');
  });

  it("点缩略图放大二维码，关闭按钮与 Esc 都能收起且不关掉设置页", async () => {
    const ui = render(SettingsModal, { open: true, tab: "关于" });
    await screen.findByText("闪寻空间");
    const tiles = ui.container.querySelectorAll<HTMLButtonElement>(".about-qr");
    expect(tiles).toHaveLength(2);
    expect(ui.queryByRole("dialog", { name: "微信二维码" })).toBeNull();
    await fireEvent.click(tiles[0]);
    const zoom = ui.getByRole("dialog", { name: "微信二维码" });
    expect(zoom.querySelector("img")?.getAttribute("alt")).toContain("微信二维码");
    await fireEvent.click(ui.getByRole("button", { name: "关闭" }));
    expect(ui.queryByRole("dialog", { name: "微信二维码" })).toBeNull();

    await fireEvent.click(tiles[1]);
    expect(ui.getByRole("dialog", { name: "微信收款码" })).toBeTruthy();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(ui.queryByRole("dialog", { name: "微信收款码" })).toBeNull();
    // 设置页本体还在
    expect(ui.getByRole("dialog", { name: "设置" })).toBeTruthy();
  });
});

describe("软件更新的自动更新开关", () => {
  it("开关排在自动检查更新下面，并走 set_update_auto_update", () => {
    const panel = read("components/UpdatePanel.svelte");
    expect(panel.indexOf("自动检查更新")).toBeLessThan(panel.indexOf('aria-label="发现新版本后自动更新"'));
    expect(panel).toContain('updateAction("set_update_auto_update", { enabled: e.currentTarget.checked })');
    // 没开自动检查 / 便携版不允许自动装
    expect(panel).toContain("disabled={busy || !$updateStatus.configured || !$updateStatus.automatic}");
    expect(panel).toContain("自动下载、校验并安装");
    expect(panel).toContain("正在导入素材时建议先关掉");
    // Rust 侧命令已注册
    const rust = readFileSync(resolve(process.cwd(), "..", "frontend", "src-tauri", "src", "lib.rs"), "utf8");
    expect(rust).toContain("updates::set_update_auto_update");
  });
});
