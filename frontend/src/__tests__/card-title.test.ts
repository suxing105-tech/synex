import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { cardTitleMode, footerTitleFor } from "../lib/card-title";

/**
 * 卡片第一行取什么：提示词开头优先，取不到退回文件名；开关整站一份并且记住。
 * 提示词本身怎么洗出来的在后端（backend/app/prompt_head.py），前端只渲染，不再加工。
 */
const STORAGE_KEY = "seekx.card-title-mode.v1";

describe("卡片第一行的取法", () => {
  it("提示词模式直接给后端洗好的那句", () => {
    expect(footerTitleFor(
      { prompt_snippet: "一位穿米色风衣的女性站在落地窗前", filename: "D:\\a\\AnimateDiff_00001.png" },
      "prompt",
    )).toBe("一位穿米色风衣的女性站在落地窗前");
  });

  it("没有提示词就退回文件名，不给一张空白页脚", () => {
    expect(footerTitleFor({ prompt_snippet: "", filename: "D:\\a\\山雾.PNG" }, "prompt")).toBe("山雾.PNG");
    expect(footerTitleFor({ filename: "无提示词.psd" }, "prompt")).toBe("无提示词.psd");
    expect(footerTitleFor({ prompt_snippet: "   ", filename: "b.png" }, "prompt")).toBe("b.png");
    expect(footerTitleFor({ prompt_snippet: null, filename: "c.mp4" }, "prompt")).toBe("c.mp4");
  });

  it("文件名模式永远给文件名，哪怕这条有提示词", () => {
    expect(footerTitleFor({ prompt_snippet: "一张图", filename: "x/原始文件.psd" }, "filename")).toBe("原始文件.psd");
  });

  it("切换记住到 localStorage，下次进来还是那个", () => {
    cardTitleMode.set("filename");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("filename");
    cardTitleMode.set("prompt");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("prompt");
  });

  it("没存过的时候默认提示词", async () => {
    localStorage.removeItem(STORAGE_KEY);
    vi.resetModules();
    const fresh = await import("../lib/card-title");
    expect(get(fresh.cardTitleMode)).toBe("prompt");
  });

  it("localStorage 读坏了也不炸界面（无痕模式）", async () => {
    const original = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new Error("SecurityError"); },
    });
    try {
      vi.resetModules();
      const fresh = await import("../lib/card-title");
      expect(get(fresh.cardTitleMode)).toBe("prompt");
      expect(() => fresh.cardTitleMode.set("filename")).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", { configurable: true, value: original });
    }
  });
});
