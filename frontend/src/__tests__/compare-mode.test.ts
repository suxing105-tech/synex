import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { compareMode, registerCompareToggle, toggleCompareMode } from "../lib/compare-mode";
import { registerShortcuts } from "../lib/shortcuts";
import { defaultShortcuts, shortcutSettings } from "../lib/shortcut-settings";

/**
 * 对比方式：默认左右、按 S 反复切换。
 *
 * 关键契约是「S 在对比里归对比」：详情栏把 S 绑成了复制 Seed，
 * 详情栏先注册、也在冒泡阶段，所以切换器必须走捕获阶段才能压住它。
 */
const KEY = "seekx.compare-mode.v1";
/** 真实按键从焦点元素冒泡到 window，捕获阶段才有优先权（直接在 window 上派发只比注册顺序）。 */
const pressS = (extra: KeyboardEventInit = {}) => {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true, ...extra }));
};

beforeEach(() => {
  localStorage.clear();
  shortcutSettings.set({ ...defaultShortcuts });
  compareMode.set("side");
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("对比方式", () => {
  it("默认左右并排，切换后记住选择", () => {
    expect(get(compareMode)).toBe("side");
    expect(toggleCompareMode()).toBe("split");
    expect(localStorage.getItem(KEY)).toBe("split");
    expect(toggleCompareMode()).toBe("side");
  });

  it("读回本地偏好，脏值回到默认", async () => {
    localStorage.setItem(KEY, "split");
    vi.resetModules();
    expect(get((await import("../lib/compare-mode")).compareMode)).toBe("split");

    localStorage.setItem(KEY, "diagonal");
    vi.resetModules();
    expect(get((await import("../lib/compare-mode")).compareMode)).toBe("side");
    // 重新加载模块后回到当前用例的 store 实例
    vi.resetModules();
  });

  it("S 只在对比开着时生效，并且抢在「复制 Seed」之前", () => {
    const seed = vi.fn();
    const offSeed = registerShortcuts([{ key: "s", action: "seed", handler: seed }]);
    let open = false;
    const off = registerCompareToggle(() => open);

    pressS();
    expect(get(compareMode)).toBe("side");
    expect(seed).toHaveBeenCalledTimes(1);

    open = true;
    pressS();
    expect(get(compareMode)).toBe("split");
    expect(seed).toHaveBeenCalledTimes(1);

    pressS({ ctrlKey: true });
    expect(get(compareMode)).toBe("split");
    off();
    offSeed();
  });

  it("输入框里按 S 不换对比方式", () => {
    const off = registerCompareToggle(() => true);
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
    expect(get(compareMode)).toBe("side");
    input.remove();
    off();
  });

  it("取消注册后 S 交还给复制 Seed", () => {
    const seed = vi.fn();
    const offSeed = registerShortcuts([{ key: "s", action: "seed", handler: seed }]);
    const off = registerCompareToggle(() => true);
    off();
    pressS();
    expect(get(compareMode)).toBe("side");
    expect(seed).toHaveBeenCalledTimes(1);
    offSeed();
  });
});
