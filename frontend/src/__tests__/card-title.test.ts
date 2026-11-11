import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { cardTitleMode, footerTitleFor, setCardTitleMode } from "../lib/card-title";

/**
 * 卡片第一行取什么：默认文件名；切成提示词模式时取后端洗好的那句，取不到照样退回文件名。
 * 提示词本身怎么洗出来的在后端（backend/app/prompt_head.py），前端只渲染，不再加工。
 */
const STORAGE_KEY = "seekx.card-title-mode.v2";
const LEGACY_KEY = "seekx.card-title-mode.v1";

describe("卡片第一行的取法", () => {
  it("提示词模式直接给后端洗好的那句", () => {
    expect(footerTitleFor(
      { prompt_snippet: "一位穿米色风衣的女性站在落地窗前", filename: "D:\\a\\AnimateDiff_00001.png" },
      "prompt",
    )).toBe("一位穿米色风衣的女性站在落地窗前");
  });

  it("提示词模式碰上没提示词也退回文件名，不给一张空白页脚", () => {
    expect(footerTitleFor({ prompt_snippet: "", filename: "D:\\a\\山雾.PNG" }, "prompt")).toBe("山雾.PNG");
    expect(footerTitleFor({ filename: "无提示词.psd" }, "prompt")).toBe("无提示词.psd");
    expect(footerTitleFor({ prompt_snippet: "   ", filename: "b.png" }, "prompt")).toBe("b.png");
    expect(footerTitleFor({ prompt_snippet: null, filename: "c.mp4" }, "prompt")).toBe("c.mp4");
  });

  it("文件名模式永远给文件名，哪怕这条有提示词（默认就是这一档）", () => {
    expect(footerTitleFor({ prompt_snippet: "一张图", filename: "x/原始文件.psd" }, "filename")).toBe("原始文件.psd");
  });

  it("在设置里明确选过一次才记住，下次进来还是那个", () => {
    setCardTitleMode("prompt");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("prompt");
    setCardTitleMode("filename");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("filename");
  });

  it("光 store.set 不写盘：不然跑一次就把当时的默认值冻进存储，翻默认对老安装失效", () => {
    localStorage.removeItem(STORAGE_KEY);
    cardTitleMode.set("prompt");
    expect(get(cardTitleMode)).toBe("prompt");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("没存过的时候默认文件名（2026-11-11 定稿：认图认的是文件）", async () => {
    localStorage.removeItem(STORAGE_KEY);
    vi.resetModules();
    const fresh = await import("../lib/card-title");
    expect(get(fresh.cardTitleMode)).toBe("filename");
  });

  it("旧键 v1 里那条被自动写进去的 prompt 不再认，翻默认对已装的用户也生效", async () => {
    localStorage.setItem(LEGACY_KEY, "prompt");
    localStorage.removeItem(STORAGE_KEY);
    vi.resetModules();
    const fresh = await import("../lib/card-title");
    expect(get(fresh.cardTitleMode)).toBe("filename");
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
      expect(get(fresh.cardTitleMode)).toBe("filename");
      expect(() => fresh.setCardTitleMode("prompt")).not.toThrow();
      expect(get(fresh.cardTitleMode)).toBe("prompt");
    } finally {
      Object.defineProperty(window, "localStorage", { configurable: true, value: original });
    }
  });
});
