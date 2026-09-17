import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { get } from "svelte/store";
import ShortcutSettings from "../components/ShortcutSettings.svelte";
import { defaultShortcuts, shortcutSettings, saveShortcuts, loadShortcuts, validateShortcuts, matchesAction } from "../lib/shortcut-settings";
import { registerShortcuts } from "../lib/shortcuts";

beforeEach(() => { localStorage.clear(); shortcutSettings.set({ ...defaultShortcuts }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });
describe("自定义快捷键", () => {
  it("保存后重载，支持清除，损坏存储回退默认", () => {
    saveShortcuts({ ...defaultShortcuts, positive: "ctrl+q", seed: "" });
    expect(loadShortcuts().positive).toBe("ctrl+q");
    expect(loadShortcuts().seed).toBe("");
    localStorage.setItem("suxing.shortcuts.v1", "broken");
    expect(loadShortcuts()).toEqual(defaultShortcuts);
  });
  it("冲突与保留键不可保存", () => {
    expect(validateShortcuts({ ...defaultShortcuts, positive: "f" })).toContain("冲突");
    expect(() => saveShortcuts({ ...defaultShortcuts, positive: "escape" })).toThrow();
    expect(validateShortcuts({ ...defaultShortcuts, positive: "ctrl+shift+q", negative: "shift+ctrl+q" })).toContain("冲突");
  });
  it("已有绑定立即使用新配置且旧键失效", () => {
    const fn = vi.fn();
    const off = registerShortcuts([{ key: "p", action: "positive", handler: fn }]);
    saveShortcuts({ ...defaultShortcuts, positive: "ctrl+q" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", ctrlKey: true }));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });
  it("设置弹窗、输入、输入法和长按不触发", () => {
    expect(matchesAction(new KeyboardEvent("keydown", { key: "p", isComposing: true }), "positive")).toBe(false);
    expect(matchesAction(new KeyboardEvent("keydown", { key: "p", repeat: true }), "positive")).toBe(false);
    const fn = vi.fn();
    const off = registerShortcuts([{ key: "p", action: "positive", handler: fn }]);
    const input = document.createElement("input"); document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true }));
    const dialog = document.createElement("div"); dialog.setAttribute("data-settings-dialog", ""); document.body.append(dialog);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p" }));
    expect(fn).not.toHaveBeenCalled(); off();
  });
  it("录制、冲突提示、保存与恢复默认", async () => {
    const ui = render(ShortcutSettings);
    const button = ui.getByRole("button", { name: "设置复制正向 Prompt快捷键" });
    await fireEvent.click(button);
    await fireEvent.keyDown(button, { key: "f" });
    expect(ui.getByRole("status").textContent).toContain("冲突");
    await fireEvent.keyDown(button, { key: "q", ctrlKey: true });
    expect(get(shortcutSettings).positive).toBe("p");
    await fireEvent.click(ui.getByText("保存快捷键"));
    expect(get(shortcutSettings).positive).toBe("ctrl+q");
    await fireEvent.click(ui.getByText("恢复默认"));
    await fireEvent.click(ui.getByText("保存快捷键"));
    expect(get(shortcutSettings)).toEqual(defaultShortcuts);
  });
  it("存储失败时不应用未保存设置", () => {
    vi.stubGlobal("localStorage", { setItem: () => { throw new Error("存储不可用"); } });
    expect(() => saveShortcuts({ ...defaultShortcuts, positive: "q" })).toThrow();
    expect(get(shortcutSettings)).toEqual(defaultShortcuts);
  });
});
