// 复刻 Feed.svelte 里单张缩略图 button 的 class 组合：
// 已选中的缩略图必须渲染为可见的内描边。
//
// 历史：
// - v1: ring-2 ring-inset ring-accent → 被 img.thumb-img 像素完全盖住
// - v2: outline outline-2 outline-accent outline-offset-[-2px] → 可见但 2px 偏细
// - v3: outline outline-3 outline-accent outline-offset-[-3px] → 失败：Tailwind v3 默认无 outline-3，浏览器回退到 medium (≈2.67px)
// - v4: outline outline-[3px] outline-accent outline-offset-[-3px] → 当前方案
//
// 偏移量等于线宽，使内描边贴齐 border 内侧，不缩小可视图片区。
import { describe, it, expect } from "vitest";

function thumbClassFor(opts: { isSelected: boolean; isNew: boolean }): string {
  return [
    "thumb",
    "relative",
    "overflow-hidden",
    "rounded-md",
    "border",
    "border-border",
    "bg-surface-2",
    "text-left",
    opts.isSelected
      ? "outline outline-[3px] outline-accent outline-offset-[-3px]"
      : "",
    opts.isNew ? "new-badge" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

describe("Feed 缩略图选中态样式（内描边 outline-[3px]）", () => {
  it("已选中 → 3px outline 内描边，偏移等于线宽", () => {
    const cls = thumbClassFor({ isSelected: true, isNew: false });
    expect(cls).toContain("outline-[3px]");
    expect(cls).toContain("outline-accent");
    expect(cls).toContain("outline-offset-[-3px]");
  });

  it("未选中 → class 不含 outline-accent 也不含 ring-accent", () => {
    const cls = thumbClassFor({ isSelected: false, isNew: false });
    expect(cls).not.toContain("outline-accent");
    expect(cls).not.toContain("ring-accent");
  });

  it("已选中 + 新图 → 同时含 outline-accent 和 new-badge", () => {
    const cls = thumbClassFor({ isSelected: true, isNew: true });
    expect(cls).toContain("outline-accent");
    expect(cls).toContain("outline-offset-[-3px]");
    expect(cls).toContain("new-badge");
  });

  it("回归：不能是 ring-inset 形态（v1 bug：被图片完全盖住）", () => {
    const cls = thumbClassFor({ isSelected: true, isNew: false });
    expect(cls).not.toContain("ring-inset");
    expect(cls).not.toMatch(/ring-\d/);
  });

  it("回归：必须用任意值 outline-[3px]，不能用 outline-3（v3 bug：Tailwind 默认无该档位）", () => {
    const cls = thumbClassFor({ isSelected: true, isNew: false });
    expect(cls).not.toMatch(/\boutline-3\b/);
  });
});
