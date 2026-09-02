import { describe, it, expect } from "vitest";
import type { ImageSummary } from "../lib/types";

// Feed.svelte 里 aspectFor 的等效纯函数。新布局走 CSS columns + aspect-ratio，
// 列宽由 column-width 控制，浏览器自动按容器宽度算列数与列宽，缩放滑块接到 column-width。
function aspectFor(it: Pick<ImageSummary, "width" | "height">): string {
  if (it.width && it.height && it.height > 0) return `${it.width} / ${it.height}`;
  return "1 / 1";
}

// 给定 column-width 和原图比例，计算这张图的实际渲染高度（用于测试布局预期）
function renderedHeight(it: Pick<ImageSummary, "width" | "height">, columnWidth: number): number {
  if (it.width && it.height && it.height > 0) {
    return Math.round(columnWidth * (it.height / it.width));
  }
  return columnWidth;
}

describe("Feed 流式瀑布（CSS columns + 原图比例）", () => {
  it("横图（16:9）→ 实际高 < 列宽", () => {
    expect(aspectFor({ width: 1920, height: 1080 })).toBe("1920 / 1080");
    expect(renderedHeight({ width: 1920, height: 1080 }, 300)).toBe(169); // 300 × 9/16
  });

  it("竖图（3:4）→ 实际高 > 列宽", () => {
    expect(aspectFor({ width: 1152, height: 2064 })).toBe("1152 / 2064");
    expect(renderedHeight({ width: 1152, height: 2064 }, 300)).toBe(538); // 300 × 2064/1152
  });

  it("正方形 → 列宽 = 高", () => {
    expect(aspectFor({ width: 1024, height: 1024 })).toBe("1024 / 1024");
    expect(renderedHeight({ width: 1024, height: 1024 }, 300)).toBe(300);
  });

  it("缺尺寸退到 1:1，高度 = 列宽（不塌）", () => {
    expect(aspectFor({ width: null, height: null })).toBe("1 / 1");
    expect(aspectFor({ width: 0, height: 0 })).toBe("1 / 1");
    expect(renderedHeight({ width: null, height: null }, 300)).toBe(300);
  });

  it("缩放滑块 140→360 时列宽同步变化，竖图高度同比放大", () => {
    const it = { width: 1152, height: 2064 };
    const at140 = renderedHeight(it, 140);
    const at220 = renderedHeight(it, 220);
    const at360 = renderedHeight(it, 360);
    // 高度应当随列宽线性放大
    expect(at220).toBe(Math.round(220 * 2064 / 1152));
    expect(at140).toBeLessThan(at220);
    expect(at360).toBeGreaterThan(at220);
    // 比例一致
    expect(at360 / at140).toBeCloseTo(360 / 140, 2);
  });
});
