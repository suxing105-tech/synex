import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { get } from "svelte/store";
import ShortcutSettings from "../components/ShortcutSettings.svelte";
import { defaultShortcuts, shortcutSettings, saveShortcuts, loadShortcuts, validateShortcuts, matchesAction } from "../lib/shortcut-settings";
import { registerShortcuts } from "../lib/shortcuts";

beforeEach(() => { localStorage.clear(); shortcutSettings.set({ ...defaultShortcuts }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });
describe("自定义快捷键", () => {
  it("旧配置补充两个侧栏默认键并保留已有改键", () => {
    localStorage.setItem("suxing.shortcuts.v1", JSON.stringify({ positive: "ctrl+q" }));
    expect(loadShortcuts()).toMatchObject({ positive: "ctrl+q", rightSidebar: "ctrl+alt+b", leftSidebar: "backquote" });
    // Tab 谁都不许绑：绑在侧栏上会把键盘焦点遍历整个吃掉（WCAG 2.1.2）
    expect(validateShortcuts({ ...defaultShortcuts, leftSidebar: "tab" })).toContain("不能绑定");
    expect(validateShortcuts({ ...defaultShortcuts, leftSidebar: "shift+tab" })).toContain("不能绑定");
  });
  it("旧配置里的 Tab 会被迁走，其余改键一个不动", () => {
    localStorage.setItem("suxing.shortcuts.v1", JSON.stringify({ rightSidebar: "tab", positive: "ctrl+q", seed: "" }));
    expect(loadShortcuts()).toMatchObject({ rightSidebar: "ctrl+alt+b", positive: "ctrl+q", seed: "" });
    localStorage.setItem("suxing.shortcuts.v1", JSON.stringify({ preview: "tab" }));
    expect(loadShortcuts().preview).toBe("");
  });
  it("Tab 录不进去且自动退出录制；波浪键照旧能录并保存", async () => {
    const ui = render(ShortcutSettings);
    const right = ui.getByRole("button", { name: "设置展开 / 收起右侧栏快捷键" });
    const left = ui.getByRole("button", { name: "设置展开 / 收起左侧栏快捷键" });
    await fireEvent.click(right);
    // fireEvent 返回 dispatchEvent 的结果：false 才说明有人吞了 Tab
    expect(await fireEvent.keyDown(right, { key: "Tab" })).toBe(true);
    expect(right.getAttribute("aria-pressed")).toBe("false"); // 录制已取消
    expect(ui.getByRole("status").textContent).toContain("不能绑定");
    await fireEvent.click(left); await fireEvent.keyDown(left, { key: "~", code: "Backquote", shiftKey: true });
    await fireEvent.click(ui.getByText("保存快捷键"));
    expect(loadShortcuts()).toMatchObject({ rightSidebar: "ctrl+alt+b", leftSidebar: "backquote" });
  });
  it("Tab 打不动任何快捷键，包括还绑着 Tab 的老配置", () => {
    expect(matchesAction(new KeyboardEvent("keydown", { key: "Tab" }), "rightSidebar")).toBe(false);
    shortcutSettings.set({ ...defaultShortcuts, rightSidebar: "tab" });
    expect(matchesAction(new KeyboardEvent("keydown", { key: "Tab" }), "rightSidebar")).toBe(false);
  });
  it("保存后重载，支持清除，损坏存储回退默认", () => {
    saveShortcuts({ ...defaultShortcuts, positive: "ctrl+q", seed: "" });
    expect(loadShortcuts().positive).toBe("ctrl+q");
    expect(loadShortcuts().seed).toBe("");
    localStorage.setItem("suxing.shortcuts.v1", "broken");
    expect(loadShortcuts()).toEqual(defaultShortcuts);
  });
  it("冲突与保留键不可保存", () => {
    expect(validateShortcuts({ ...defaultShortcuts, positive: "n" })).toContain("冲突");
    for (const key of ["0", "a", "i", "v", "t"])
      expect(validateShortcuts({ ...defaultShortcuts, positive: key })).toContain("保留");
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
    await fireEvent.keyDown(button, { key: "n" });
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
  it("预览旋转：默认 Alt + ←/→，不跟裸方向键的上一张 / 下一张抢", () => {
    expect(defaultShortcuts).toMatchObject({ rotateLeft: "alt+arrowleft", rotateRight: "alt+arrowright" });
    expect(validateShortcuts(defaultShortcuts)).toBeNull();
    const altLeft = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true });
    expect(matchesAction(altLeft, "rotateLeft")).toBe(true);
    expect(matchesAction(altLeft, "previous")).toBe(false);
    const altRight = new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true });
    expect(matchesAction(altRight, "rotateRight")).toBe(true);
    expect(matchesAction(altRight, "next")).toBe(false);
    // 设置页由 shortcutActions 自动渲染，两行新条目要在，键位照 shortcutLabel 显示
    const ui = render(ShortcutSettings);
    expect(ui.getByRole("button", { name: "设置预览：向左旋转 90°（存回原文件）快捷键" }).textContent).toBe("Alt + ←");
    expect(ui.getByRole("button", { name: "设置预览：向右旋转 90°（存回原文件）快捷键" }).textContent).toBe("Alt + →");
    // 改过键也得认：预览里那两个旋转按钮的 hover 提示读的就是这一条
    shortcutSettings.set({ ...defaultShortcuts, rotateRight: "shift+arrowright" });
    expect(matchesAction(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true }), "rotateRight")).toBe(true);
  });
});
