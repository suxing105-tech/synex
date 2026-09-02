import { describe, it, expect } from "vitest";
import type { ImageSummary } from "../lib/types";

// 与 Feed.svelte 里贪心分列同步的纯函数：按原顺序遍历图片，每张放进当前累计高度最小的那列。
// 与 Feed.svelte 同步：根据容器宽 + targetColumns 算列宽（每列均分）
// 与 Feed.svelte 同步：根据容器宽 + targetColumns 算列宽（每列均分）
function calcColumnWidth(containerWidth: number, columnCount: number, gap = 8): number {
  if (containerWidth <= 0 || columnCount <= 0) return 0;
  return (containerWidth - (columnCount - 1) * gap) / columnCount;
}

function greedySplit(
  items: ImageSummary[],
  columnCount: number,
  columnWidth: number,
): { items: ImageSummary[]; height: number }[] {
  const n = Math.max(1, columnCount);
  const gap = 8;
  const cols = Array.from({ length: n }, () => ({ items: [] as ImageSummary[], height: 0 }));
  for (const it of items) {
    const ratio = it.width && it.height ? it.height / it.width : 1;
    const h = columnWidth * ratio + gap;
    let target = cols[0];
    for (let i = 1; i < n; i++) if (cols[i].height < target.height) target = cols[i];
    target.items.push(it);
    target.height += h;
  }
  return cols;
}

function mkItem(id: number, w: number | null, h: number | null): ImageSummary {
  return {
    id,
    filename: `img_${id}.png`,
    path: `x/${id}.png`,
    original_url: `/api/images/${id}/file?max=1024`,
    width: w,
    height: h,
    mtime: 0,
    size_bytes: 0,
    favorite: false,
    folder_ids: [],
    tags: [],
    model: null,
    seed: null,
  };
}

describe("Feed masonry 贪心分列", () => {
  it("每张图恰好归入一列（守恒）", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => mkItem(i, 1152, 2064));
    for (const n of [1, 2, 3, 4, 5]) {
      const cols = greedySplit(items, n, 220);
      const allIds = cols.flatMap((c) => c.items.map((x) => x.id));
      expect(allIds.sort((a, b) => a - b)).toEqual(items.map((x) => x.id).sort((a, b) => a - b));
      expect(allIds.length).toBe(items.length);
    }
  });

  it("贪心算法均衡列高（最终 max - min < 首列高）", () => {
    // 模拟用户的真实数据：12 张图，比例 1.8/0.6/1.5/1.9/0.5 混合
    const items = [
      ...Array(3).fill(0).map((_, j) => mkItem(j + 1, 1920, 1080)), // 横 1920/1080 ratio 1.78
      ...Array(3).fill(0).map((_, j) => mkItem(j + 4, 1152, 2064)), // 竖 1152/2064 ratio 0.56
      ...Array(3).fill(0).map((_, j) => mkItem(j + 7, 2304, 1536)), // 横 2304/1536 ratio 1.5
      ...Array(3).fill(0).map((_, j) => mkItem(j + 10, 1152, 640)), // 横 1152/640 ratio 1.8
    ];
    const cols = greedySplit(items, 3, 220);
    const heights = cols.map((c) => c.height);
    const firstItemH = 220 * (1920 === 1920 && 1080 === 1080 ? 1080 / 1920 : 1) + 8;
    // 贪心保证：最高列 - 最低列 一定小于首张图贡献的高度
    const spread = Math.max(...heights) - Math.min(...heights);
    expect(spread).toBeLessThan(firstItemH);
  });

  it("连续同方向图也不会被全部塞进同一列", () => {
    // 用户实际场景：最近 10 张全是竖图 ratio 0.6
    const items = Array.from({length: 10}, (_, i) => mkItem(i + 1, 1152, 2064));
    const cols = greedySplit(items, 3, 220);
    // 每列至少 2 张
    for (const c of cols) expect(c.items.length).toBeGreaterThanOrEqual(2);
    // 没有列独占 7 张以上（贪心应该均匀）
    for (const c of cols) expect(c.items.length).toBeLessThanOrEqual(5);
  });

  it("列数变化时所有图仍完整分组", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => mkItem(i, 1152, 2064));
    for (const n of [2, 3, 4, 6]) {
      const cols = greedySplit(items, n, 220);
      expect(cols.flatMap((c) => c.items).length).toBe(12);
    }
  });

  it("缺尺寸的图按 1:1 占位，贪心仍正常工作", () => {
    const items = [
      mkItem(1, 1152, 2064),
      mkItem(2, null, null),
      mkItem(3, 1920, 1080),
      mkItem(4, null, null),
      mkItem(5, 1152, 2064),
    ];
    const cols = greedySplit(items, 2, 220);
    expect(cols.flatMap((c) => c.items).length).toBe(5);
    // 缺尺寸图不应让任何列空
    for (const c of cols) expect(c.items.length).toBeGreaterThan(0);
  });

  it("缩放滑块列宽变化时贪心分组的相对结构保持稳定", () => {
    // 同 6 张同方向图，列宽 140 vs 360 时都应均匀分布
    const items = [1, 2, 3, 4, 5, 6].map((i) => mkItem(i, 1152, 2064));
    const cols140 = greedySplit(items, 2, 140);
    const cols360 = greedySplit(items, 2, 360);
    // 都是 3+3 均匀
    expect(cols140.map((c) => c.items.length)).toEqual([3, 3]);
    expect(cols360.map((c) => c.items.length)).toEqual([3, 3]);
  });
});
describe("Feed 滑块 → 列宽公式 calcColumnWidth", () => {
  it("默认 1300 容器宽 + targetColumns=7 → 列宽 ~182", () => {
    // 1300 给 Feed，7 列：每列 (1300 - 6*8)/7 ≈ 178.86
    const w = calcColumnWidth(1300, 7);
    expect(w).toBeGreaterThanOrEqual(170);
    expect(w).toBeLessThanOrEqual(190);
  });

  it("减少 targetColumns → 列宽变大；增加 targetColumns → 列宽变小", () => {
    const w1000 = 1000;
    const fewer = calcColumnWidth(w1000, 4);  // 列少 → 列宽大
    const more  = calcColumnWidth(w1000, 10); // 列多 → 列宽小
    expect(fewer).toBeGreaterThan(more);
    expect(fewer).toBeCloseTo((1000 - 3 * 8) / 4, 1);
    expect(more).toBeCloseTo((1000 - 9 * 8) / 10, 1);
  });

  it("滑块在边界值 4 / 12 之间滑动时列宽稳定变化（不抖动）", () => {
    const w = 1000;
    expect(calcColumnWidth(w, 4)).toBeCloseTo((1000 - 3 * 8) / 4, 1);
    expect(calcColumnWidth(w, 7)).toBeCloseTo((1000 - 6 * 8) / 7, 1);
    expect(calcColumnWidth(w, 12)).toBeCloseTo((1000 - 11 * 8) / 12, 1);
  });

  it("容器未测量或非法列数时退到 0，不报错", () => {
    expect(calcColumnWidth(0, 7)).toBe(0);
    expect(calcColumnWidth(-10, 7)).toBe(0);
    expect(calcColumnWidth(1000, 0)).toBe(0);
    expect(calcColumnWidth(1000, -1)).toBe(0);
  });

  it("列数变化时，贪心分组后总张数守恒 + 列数 = 2 时强制 3+3", () => {
    // 6 张竖图（1152x2064），列数从 4 变 2 时贪心分组的张数分配
    const items = [1,2,3,4,5,6].map(i => mkItem(i, 1152, 2064));
    const w4 = calcColumnWidth(1000, 4);
    const cols = greedySplit(items, 4, w4);
    expect(cols.flatMap(c => c.items).length).toBe(6);
    const w2 = calcColumnWidth(1000, 2);
    expect(greedySplit(items, 2, w2).map(c => c.items.length)).toEqual([3, 3]);
  });
});

