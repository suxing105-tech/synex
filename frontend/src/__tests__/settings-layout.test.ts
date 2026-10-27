import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, waitFor, screen as globalScreen } from "@testing-library/svelte";
import SettingsModal from "../components/SettingsModal.svelte";
import { settingsApi } from "../lib/api";

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  settingsApi: { get: vi.fn(async () => ({ watch_dirs: ["D:/AI/ComfyUI/output", "D:/素材"], live_enabled: true })), update: vi.fn(async (cfg: any) => cfg) },
  comfyuiApi: { status: vi.fn(async () => ({ running: true, enabled: true, url: "http://127.0.0.1:8188" })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  foldersApi: { tree: vi.fn(async () => []), archived: vi.fn(async () => []), restore: vi.fn(async () => ({ ok: true })) },
  http: vi.fn(async (path: string) => (path === "/api/reverse-prompt-settings" ? { default_model_id: null, instruction: "", default_instruction: "" } : [])),
}));

const read = (path: string) => readFileSync(resolve(process.cwd(), "src", path), "utf8");

describe("设置页版式：左目录 + 卡片行", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("正文按分组卡片组织，一行＝左标题右控件", () => {
    const modal = read("components/SettingsModal.svelte");
    expect(modal).toContain("<SettingsRow");
    expect(modal).toContain('class="settings-card"');
    expect(modal).toContain("settings-group-label");
    // 旧版把每个设置项摊成「标题 + 说明 + 下面一整条控件」，现在统一走行结构。
    expect(modal).not.toContain('class="setting-group"');
    const css = read("app.css");
    expect(css).toMatch(/\.setting-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
    expect(css).toMatch(/\.setting-row-side \{[^}]*justify-content: flex-end/);
    expect(css).toMatch(/\.settings-card .setting-row \+ \.setting-row \{/);
  });

  it("快捷键与软件更新也走同一套行，不再各自排版", () => {
    for (const file of ["ShortcutSettings", "UpdatePanel"]) {
      expect(read(`components/${file}.svelte`)).toContain("SettingsRow");
    }
    // 侧栏开关统一成胶囊外观，但语义仍是 checkbox，键盘焦点仍然看得见。
    const css = read("app.css");
    expect(css).toMatch(/\.settings-switch input:checked \+ \.switch-track \{/);
    expect(css).toMatch(/\.settings-switch input:focus-visible \+ \.switch-track \{/);
  });

  it("开关关掉后保存的确实是 live_enabled=false", async () => {
    render(SettingsModal, { open: true, tab: "通用" });
    const toggle = await globalScreen.findByRole("checkbox", { name: "自动收录监听目录中的新文件" });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await fireEvent.click(toggle);
    await fireEvent.click(globalScreen.getByRole("button", { name: "保存通用设置" }));
    await waitFor(() => expect(settingsApi.update).toHaveBeenCalledWith({ watch_dirs: ["D:/AI/ComfyUI/output", "D:/素材"], live_enabled: false }));
  });

  it("监听目录按行铺开，路径单独移除不会影响其他目录", async () => {
    const ui = render(SettingsModal, { open: true, tab: "通用" });
    await ui.findByText("D:/AI/ComfyUI/output");
    const paths = ui.container.querySelectorAll(".settings-subpath");
    expect(paths).toHaveLength(2);
    expect(paths[0].textContent).toBe("D:/AI/ComfyUI/output");
    await fireEvent.click(ui.getByRole("button", { name: "移除监听目录 D:/AI/ComfyUI/output" }));
    await waitFor(() => expect(ui.container.querySelectorAll(".settings-subpath")).toHaveLength(1));
    expect(ui.getByText("1 个目录")).toBeTruthy();
  });
});
