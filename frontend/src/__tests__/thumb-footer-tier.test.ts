import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import {
  FOOTER_HEIGHT_ONE_LINE,
  FOOTER_HEIGHT_TWO_LINES,
  FOOTER_TIER_ONE_LINE_MIN_WIDTH,
  FOOTER_TIER_TWO_LINE_MIN_WIDTH,
  THUMB_GAP,
  footerHeightFor,
  footerTierFor,
} from "../lib/media-format";

/**
 * 页脚档位是瀑布流的承重墙：贪心分列用 footerHeightFor 预留高度，
 * 渲染用 footerTierFor 决定挂哪个 class，真实高度由 app.css 写死。
 * 三者任意一个跑偏，卡片就会互相重叠或留出一条大缝。
 */

function declsOf(selector: string, file = "src/app.css"): Record<string, string> {
  const css = postcss.parse(readFileSync(file, "utf8"));
  const out: Record<string, string> = {};
  css.walkRules((rule) => {
    const parts = rule.selector.split(",").map((s) => s.trim());
    if (parts.includes(selector)) {
      rule.walkDecls((decl) => { out[decl.prop] = decl.value; });
    }
  });
  return out;
}

describe("页脚档位边界", () => {
  it("刚好 120 才给单行页脚，119 整条不渲染", () => {
    expect(FOOTER_TIER_ONE_LINE_MIN_WIDTH).toBe(120);
    expect(footerTierFor(119)).toBe(0);
    expect(footerTierFor(120)).toBe(1);
  });

  it("169 还是单行，170 起才升到两行", () => {
    expect(FOOTER_TIER_TWO_LINE_MIN_WIDTH).toBe(170);
    expect(footerTierFor(169)).toBe(1);
    expect(footerTierFor(170)).toBe(2);
  });

  it("非法宽度退到 0 档，不炸", () => {
    expect(footerTierFor(Number.NaN)).toBe(0);
    expect(footerTierFor(-50)).toBe(0);
  });

  it("档位对应的高度：0 / 26 / 44", () => {
    expect(footerHeightFor(119)).toBe(0);
    expect(footerHeightFor(120)).toBe(FOOTER_HEIGHT_ONE_LINE);
    expect(footerHeightFor(170)).toBe(FOOTER_HEIGHT_TWO_LINES);
    expect([FOOTER_HEIGHT_ONE_LINE, FOOTER_HEIGHT_TWO_LINES]).toEqual([26, 44]);
  });
});

describe("页脚常量与实际 CSS 一致", () => {
  it("app.css 的两档页脚高度等于贪心分列用的常量", () => {
    expect(declsOf(".media-card-footer--1l").height).toBe(FOOTER_HEIGHT_ONE_LINE + "px");
    expect(declsOf(".media-card-footer--2l").height).toBe(FOOTER_HEIGHT_TWO_LINES + "px");
  });

  it("app.css 的 --thumb-gap 等于 THUMB_GAP，Feed 的列间距不会各说各话", () => {
    const root = declsOf(":root");
    expect(Number.parseInt(root["--thumb-gap"], 10)).toBe(THUMB_GAP);
    expect(declsOf(".media-pick-grid").gap).toBe("var(--thumb-gap)");
  });

  it("圆角走 token：整网 10px，窄卡降到 8px", () => {
    expect(declsOf(":root")["--thumb-radius"]).toBe("10px");
    expect(declsOf(".media-card")["border-radius"]).toBe("var(--thumb-radius)");
    expect(declsOf(".media-card--compact")["--thumb-radius"]).toBe("8px");
  });
});
