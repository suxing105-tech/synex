import { describe, it, expect } from "vitest";
import type { ImageSummary } from "../lib/types";

// Feed.svelte 里 aspectFor / gridMin 的等效纯函数（前端测试不挂 DOM，直接覆盖比例逻辑）
function aspectFor(it: Pick<ImageSummary, "width" | "height">): string {
  if (it.width && it.height && it.height > 0) return `${it.width} / ${it.height}`;
  return "1 / 1";
}

function gridMin(it: Pick<ImageSummary, "width" | "height">, zoom: number): string {
  if (it.width && it.height && it.height > 0) {
    const ratio = it.width / it.height;
    return `${Math.round(zoom * ratio)}px`;
  }
  return `${zoom}px`;
}

describe("Feed 缩略图比例", () => {
  it("横图（16:9）→ 宽于高", () => {
    expect(aspectFor({ width: 1920, height: 1080 })).toBe("1920 / 1080");
    expect(gridMin({ width: 1920, height: 1080 }, 220)).toBe("391px"); // 220 × 1.78
  });

  it("竖图（3:4）→ 高于宽", () => {
    expect(aspectFor({ width: 1152, height: 2064 })).toBe("1152 / 2064");
    expect(gridMin({ width: 1152, height: 2064 }, 220)).toBe("123px"); // 220 × 0.56
  });

  it("正方形 → 1:1", () => {
    expect(aspectFor({ width: 1024, height: 1024 })).toBe("1024 / 1024");
    expect(gridMin({ width: 1024, height: 1024 }, 220)).toBe("220px");
  });

  it("缺尺寸退到 1:1，避免布局塌陷", () => {
    expect(aspectFor({ width: null, height: null })).toBe("1 / 1");
    expect(aspectFor({ width: 0, height: 0 })).toBe("1 / 1");
    expect(gridMin({ width: null, height: null }, 220)).toBe("220px");
  });

  it("缩放滑块放大时 grid 列宽同比缩放", () => {
    expect(gridMin({ width: 1920, height: 1080 }, 140)).toBe("249px");
    expect(gridMin({ width: 1920, height: 1080 }, 360)).toBe("640px");
  });
});
