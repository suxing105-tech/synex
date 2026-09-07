import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerShortcuts, parseKey } from "../lib/shortcuts";

// 直接解析测试
describe("parseKey（快捷键规范解析）", () => {
  it("裸键：'p' → {key:'p', 无修饰}", () => {
    expect(parseKey("p")).toEqual({ key: "p", ctrl: false, shift: false, alt: false, meta: false });
  });

  it("shift+c", () => {
    expect(parseKey("shift+c")).toEqual({ key: "c", ctrl: false, shift: true, alt: false, meta: false });
  });

  it("ctrl+f / Cmd+F 都归一化", () => {
    expect(parseKey("ctrl+f")).toEqual({ key: "f", ctrl: true, shift: false, alt: false, meta: false });
    expect(parseKey("Cmd+F").key).toBe("f");
    expect(parseKey("Cmd+F").meta).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(parseKey("Escape")).toEqual(parseKey("escape"));
    expect(parseKey("SHIFT+C")).toEqual(parseKey("shift+c"));
  });
});

// 实际绑定 + 模拟 keydown
function fire(target: EventTarget, key: string, opts: Partial<KeyboardEvent> = {}): void {
  const ev = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  target.dispatchEvent(ev);
}

describe("registerShortcuts（快捷键 hook）", () => {
  let cleanup: (() => void) | null = null;
  beforeEach(() => {
    cleanup = null;
  });
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("匹配单键 p → handler 被调用", () => {
    const handler = vi.fn();
    cleanup = registerShortcuts([{ key: "p", handler }]);
    fire(window, "p");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("匹配 shift+c → 只在 shift+c 时触发", () => {
    const handler = vi.fn();
    cleanup = registerShortcuts([{ key: "shift+c", handler }]);
    fire(window, "c");
    expect(handler).not.toHaveBeenCalled();
    fire(window, "C", { shiftKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+F 在输入框中默认被忽略（allowInInput=false）", () => {
    const handler = vi.fn();
    cleanup = registerShortcuts([{ key: "ctrl+f", handler }]);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fire(input, "f", { ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
    // 焦点离开后能触发
    input.blur();
    fire(window, "f", { ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("allowInInput=true 时输入框里也能触发", () => {
    const handler = vi.fn();
    cleanup = registerShortcuts([{ key: "p", handler, allowInInput: true }]);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fire(input, "p");
    expect(handler).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("preventDefault 默认 true（按 P 不会触发冒泡 keypress）", () => {
    const handler = vi.fn((e: KeyboardEvent) => {
      expect(e.defaultPrevented).toBe(true);
    });
    cleanup = registerShortcuts([{ key: "p", handler }]);
    fire(window, "p");
    expect(handler).toHaveBeenCalled();
  });

  it("preventDefault=false 不阻止默认", () => {
    const handler = vi.fn();
    cleanup = registerShortcuts([{ key: "p", handler, preventDefault: false }]);
    const ev = new KeyboardEvent("keydown", { key: "p", bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("cleanup 后不再触发", () => {
    const handler = vi.fn();
    const off = registerShortcuts([{ key: "p", handler }]);
    fire(window, "p");
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    fire(window, "p");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("多个 binding 按注册顺序匹配，先匹配先生效", () => {
    const a = vi.fn();
    const b = vi.fn();
    cleanup = registerShortcuts([
      { key: "p", handler: a },
      { key: "p", handler: b },
    ]);
    fire(window, "p");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });
});
