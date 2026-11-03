import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import FeedSkeleton from "../components/FeedSkeleton.svelte";
import { targetColumns } from "../lib/stores";
import { THUMB_GAP } from "../lib/media-format";

// 「画廊成形」的中间层：骨架网格必须长在真正的 Feed 容器里，用 Feed 自己那一份
// 列数与 gap。遮罩层里另画一张永远对不齐，而交接那一帧用户看得最清楚。

afterEach(cleanup);

const feedSrc = readFileSync(resolve("src/components/Feed.svelte"), "utf8");
const skeletonSrc = readFileSync(resolve("src/components/FeedSkeleton.svelte"), "utf8");

describe("FeedSkeleton", () => {
  it("列数跟 $targetColumns，间距跟 THUMB_GAP，不是自己拍脑袋", () => {
    targetColumns.set(7);
    const ui = render(FeedSkeleton);
    const grid = ui.container.querySelector<HTMLElement>(".feed-skeleton");
    expect(grid).toBeTruthy();
    expect(grid!.getAttribute("style")).toContain("repeat(7, minmax(0, 1fr))");
    expect(grid!.getAttribute("style")).toContain(`gap: ${THUMB_GAP}px`);
    expect(ui.container.querySelectorAll(".sk-col")).toHaveLength(7);
    targetColumns.set(5);
  });

  it("宽高比序列确定（不用随机），并按列错开", () => {
    targetColumns.set(3);
    const ui = render(FeedSkeleton);
    const cols = Array.from(ui.container.querySelectorAll(".sk-col"));
    const ratios = cols.map((col) =>
      Array.from(col.querySelectorAll<HTMLElement>(".sk-tile")).map((el) =>
        el.getAttribute("style")?.match(/aspect-ratio:\s*([^;]+)/)?.[1].trim(),
      ),
    );
    // 同一列每次都一样
    expect(ratios[0].slice(0, 3)).toEqual(["1 / 1", "4 / 5", "3 / 4"]);
    // 列与列错开，否则铺出来是整齐的方格，真瀑布流不长这样
    expect(ratios[1]).not.toEqual(ratios[0]);
    targetColumns.set(5);
  });

  it("形状语言共用缩略图变量，圆角与底色不各写一份", () => {
    expect(skeletonSrc).toContain("var(--thumb-radius");
    expect(skeletonSrc).toContain("var(--thumb-media-bg");
    // 但骨架本身要看得见：光靠 #1a1a1d 贴在 #0e0e10 上基本隐形
    expect(skeletonSrc).toMatch(/background:\s*linear-gradient\([^)]*#ffffff0a[^)]*\),\s*\n?\s*var\(--thumb-media-bg/);
    expect(skeletonSrc).toMatch(/\.sk-tile \{[\s\S]*?box-shadow: inset 0 0 0 1px/);
    // 微光只有一条：整块网格一个动画层
    expect(skeletonSrc.match(/sk-shine/g)!.length).toBeGreaterThan(0);
    expect(skeletonSrc).toContain("prefers-reduced-motion: reduce");
  });

  it("对读屏器是一句状态说明，不是一堆空格子", () => {
    const ui = render(FeedSkeleton);
    expect(ui.getByRole("status").getAttribute("aria-label")).toBe("图库正在载入");
    expect(ui.container.querySelector(".sk-shine")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Feed 接入骨架", () => {
  it("载入分支换成骨架，启动期无条件铺（不再闪一行灰字和空文件夹提示）", () => {
    expect(feedSrc).toContain("<FeedSkeleton />");
    expect(feedSrc).not.toContain(">加载中…<");
    expect(feedSrc).toMatch(/let gridSkeleton = \$derived\(\s*\$appBooting \|\| \(\$feedLoading && \$feedItems\.length === 0\)\s*\)/);
  });

  it("骨架换成真卡那一次材质化，且只在刚从骨架出来时演", () => {
    expect(feedSrc).toMatch(/class:is-materializing=\{materializing\}/);
    expect(feedSrc).toMatch(/if \(gridSkeleton\) \{\s*wasSkeleton = true;/);
    expect(feedSrc).toMatch(/\.masonry-grid\.is-materializing/);
  });
});
