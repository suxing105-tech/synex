// 复刻 Feed.svelte 里单张缩略图 button 的 class 组合：
// 已选中的缩略图必须渲染为内描边（ring-inset），确保选中态高亮不"外溢"到布局里。
// 与 feed-aspect.test.ts 同模式：测试里复刻一份纯函数，单测覆盖关键 class 组合。
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
    opts.isSelected ? "ring-2 ring-inset ring-accent" : "",
    opts.isNew ? "new-badge" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

describe("Feed 缩略图选中态样式（内描边）", () => {
  it("已选中 → class 包含 ring-inset + ring-accent（内圈高亮）", () => {
    const cls = thumbClassFor({ isSelected: true, isNew: false });
    expect(cls).toContain("ring-2");
    expect(cls).toContain("ring-inset");
    expect(cls).toContain("ring-accent");
  });

  it("未选中 → class 不含 ring-accent", () => {
    const cls = thumbClassFor({ isSelected: false, isNew: false });
    expect(cls).not.toContain("ring-accent");
    expect(cls).not.toContain("ring-inset");
  });

  it("已选中 + 新图 → 同时含 ring-inset 和 new-badge", () => {
    const cls = thumbClassFor({ isSelected: true, isNew: true });
    expect(cls).toContain("ring-inset");
    expect(cls).toContain("ring-accent");
    expect(cls).toContain("new-badge");
  });
});
