import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import TypeChips from "../components/TypeChips.svelte";
import { ALL_KINDS, feedCounts, kindFilter, scope, selectKind } from "../lib/stores";
import type { ItemKind } from "../lib/types";
import { ICON_PATHS } from "../lib/icons";

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn() },
  scanApi: { progress: vi.fn() },
  comfyuiApi: {},
}));

const KEY = "seekx.item-kind.v1";
const LEGACY_KEY = "seekx.item-kinds.v1";
const ALL: ItemKind[] = ["image", "video", "audio", "text"];

/** happy-dom 会把自闭合标签补成 <rect ...></rect>，归一化后才能和 ICON_PATHS 原文比对 */
function innerSvg(el?: Element | null): string {
  return (el?.innerHTML ?? "").replace(/<([a-z]+)([^>]*?)><\/\1>/gi, "<$1$2/>");
}


function chipByText(container: HTMLElement, text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll<HTMLButtonElement>(".chip")]
    .find((b) => b.textContent?.includes(text));
  if (!el) throw new Error(`没有「${text}」chip`);
  return el;
}

function pressedChips(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".chip")]
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.querySelector(".label")?.textContent || "");
}

beforeEach(() => {
  localStorage.clear();
  scope.set("all");
  feedCounts.set({ image: 40, video: 11, audio: 3, text: 40 });
  kindFilter.set("all");
});

afterEach(() => {
  cleanup();
  scope.set("all");
  kindFilter.set("all");
  localStorage.clear();
});

describe("TypeChips 只在「所有素材」出现", () => {
  it("scope=all 时渲染五个 chip", () => {
    const { container } = render(TypeChips);
    const labels = [...container.querySelectorAll(".chip .label")].map((el) => el.textContent);
    expect(labels).toEqual(["全部", "图片", "视频", "音频", "文本"]);
  });

  it("切到单一类型就不渲染：导航已经交给侧栏，同屏不该有两套类型控件", async () => {
    const { container } = render(TypeChips);
    for (const next of ALL) {
      scope.set(next);
      await tick();
      expect(container.querySelector(".type-chips")).toBeNull();
    }
    scope.set("all");
    await tick();
    expect(container.querySelectorAll(".chip")).toHaveLength(5);
  });
});

describe("单选语义：一次只亮一个", () => {
  it("默认「全部」亮，其余灭", () => {
    const { container } = render(TypeChips);
    expect(pressedChips(container)).toEqual(["全部"]);
  });

  it("点任意一类 → 只亮那一类，「全部」熄灭", async () => {
    const { container } = render(TypeChips);
    for (const [label, kind] of [["图片", "image"], ["视频", "video"], ["音频", "audio"], ["文本", "text"]] as const) {
      await fireEvent.click(chipByText(container, label));
      expect(get(kindFilter)).toBe(kind);
      expect(pressedChips(container)).toEqual([label]);
    }
  });

  it("再点已选中的那一类不取消：过滤条件不能为空", async () => {
    const { container } = render(TypeChips);
    await fireEvent.click(chipByText(container, "音频"));
    await fireEvent.click(chipByText(container, "音频"));
    expect(get(kindFilter)).toBe("audio");
    expect(pressedChips(container)).toEqual(["音频"]);
  });

  it("点「全部」回到四类；从单一类直接跳到另一类也算单选", async () => {
    selectKind("text");
    const { container } = render(TypeChips);
    expect(pressedChips(container)).toEqual(["文本"]);
    await fireEvent.click(chipByText(container, "全部"));
    expect(get(kindFilter)).toBe("all");
    expect(pressedChips(container)).toEqual(["全部"]);
    await fireEvent.click(chipByText(container, "图片"));
    await fireEvent.click(chipByText(container, "视频"));
    expect(get(kindFilter)).toBe("video");
  });
});

describe("chip 的计数", () => {
  it("计数来自当前过滤条件下的四类计数，「全部」是四项之和", () => {
    const { container } = render(TypeChips);
    expect(chipByText(container, "图片").querySelector(".n")?.textContent).toBe("40");
    expect(chipByText(container, "音频").querySelector(".n")?.textContent).toBe("3");
    expect(chipByText(container, "全部").querySelector(".n")?.textContent).toBe("94");
  });

  it("只看音频时数字不缩：chips 上的数字始终是同一口径", async () => {
    const { container } = render(TypeChips);
    await fireEvent.click(chipByText(container, "音频"));
    expect(chipByText(container, "图片").querySelector(".n")?.textContent).toBe("40");
    expect(chipByText(container, "全部").querySelector(".n")?.textContent).toBe("94");
  });

  it("title 说清是「只看」而不是「显示/隐藏」", async () => {
    const { container } = render(TypeChips);
    expect(chipByText(container, "全部").title).toBe("显示全部类型");
    expect(chipByText(container, "音频").title).toBe("只看音频");
    await fireEvent.click(chipByText(container, "音频"));
    expect(chipByText(container, "音频").title).toBe("只看音频");
  });
});

describe("持久化", () => {
  it("单选值直接写进 localStorage（不再是数组）", async () => {
    const { container } = render(TypeChips);
    await fireEvent.click(chipByText(container, "视频"));
    expect(localStorage.getItem(KEY)).toBe("video");
  });

  // 冷启动读档要重新求值 store 初始值，所以每个用例都 resetModules 再动态 import。
  // 注意：只验 store 状态，不再渲染组件 —— resetModules 会让 Svelte 的模板缓存换实例。
  async function bootFilter(setup: () => void): Promise<ItemKind | "all"> {
    localStorage.clear();
    setup();
    vi.resetModules();
    const stores = await import("../lib/stores");
    return get(stores.kindFilter);
  }

  it("脏值一律回落成「全部」，不会留下空白网格", async () => {
    for (const raw of [null, "null", "[]", '["image"]', "nope", '"image"', "{"]) {
      const value = await bootFilter(() => {
        if (raw !== null) localStorage.setItem(KEY, raw);
      });
      expect(value).toBe("all");
    }
  });

  it("重进应用时读回上次单选", async () => {
    expect(await bootFilter(() => localStorage.setItem(KEY, "audio"))).toBe("audio");
  });

  it("老的多选存档：恰好一类时继承，组合选择回落到「全部」，键顺手清掉", async () => {
    expect(await bootFilter(() => localStorage.setItem(LEGACY_KEY, JSON.stringify(["audio"])))).toBe("audio");
    expect(await bootFilter(() => localStorage.setItem(LEGACY_KEY, JSON.stringify(["image", "video"])))).toBe("all");
    expect(await bootFilter(() => localStorage.setItem(LEGACY_KEY, "[]"))).toBe("all");
    // 读档路径上不留旧键，避免下次冷启再判一遍
    const after = await bootFilter(() => localStorage.setItem(LEGACY_KEY, JSON.stringify(["text"])));
    expect(after).toBe("text");
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("「全部」chip 用房子图标，与侧栏同一枚", () => {
    const screen = render(TypeChips);
    expect(innerSvg(chipByText(screen.container, "全部").querySelector("svg"))).toBe(ICON_PATHS.home);
    for (const chip of [...screen.container.querySelectorAll(".chip")]) {
      expect(innerSvg(chip.querySelector("svg"))).not.toBe(ICON_PATHS.layers);
    }
  });

  it("「全部」= 四类都发给后端；单选只发那一类（counts 口径不受影响）", async () => {
    const stores = await import("../lib/stores");
    expect(stores.kindsOfFilter("all")).toEqual(ALL);
    expect(stores.kindsOfFilter("audio")).toEqual(["audio"]);
    expect(ALL_KINDS).toEqual(ALL);
  });
});
