// 复刻 Feed.svelte 里单张缩略图 button 的 class 组合：
// 已选中的缩略图必须渲染为可见的内描边。早期用 ring-2 ring-inset ring-accent
// 时，box-shadow 被 img.thumb-img (object-cover, w-full h-full) 完整覆盖，
// 选中的高亮在视觉上消失；改为 outline + 负偏移后，outline 画在内容之上，
// 透过图片像素可见。
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
    opts.isSelected
      ? "outline outline-2 outline-accent outline-offset-[-2px]"
      : "",
    opts.isNew ? "new-badge" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

describe("Feed 缩略图选中态样式（内描边）", () => {
  it("已选中 → class 用 outline + 负偏移画内描边，不使用 ring-inset", () => {
    const cls = thumbClassFor({ isSelected: true, isNew: false });
    expect(cls).toContain("outline-2");
    expect(cls).toContain("outline-accent");
    expect(cls).toContain("outline-offset-[-2px]");
    // 回归：不能是 ring-inset 形态（之前会导致高亮被图片像素完全盖住）
    expect(cls).not.toContain("ring-inset");
  });

  it("未选中 → class 不含 outline-accent 也不含 ring-accent", () => {
    const cls = thumbClassFor({ isSelected: false, isNew: false });
    expect(cls).not.toContain("outline-accent");
    expect(cls).not.toContain("ring-accent");
  });

  it("已选中 + 新图 → 同时含 outline-accent 和 new-badge", () => {
    const cls = thumbClassFor({ isSelected: true, isNew: true });
    expect(cls).toContain("outline-accent");
    expect(cls).toContain("outline-offset-[-2px]");
    expect(cls).toContain("new-badge");
  });
});
