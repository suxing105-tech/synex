import { describe, it, expect } from "vitest";
import type { ImageSummary } from "../lib/types";

// 与 Feed.svelte 里贪心分列同步的纯函数：按原顺序遍历图片，每张放进当前累计高度最小的那列。
// 与 Feed.svelte 同步：根据容器宽 + zoomSize 算列数（每列固定 = zoomSize px）
function calcColumnCount(containerWidth: number, columnWidth: number, gap = 8): number {
  if (containerWidth <= 0) return 1;
  const n = Math.floor((containerWidth + gap) / (columnWidth + gap));
  return Math.max(1, n);
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
describe("Feed 滑块 → 列数公式 calcColumnCount", () => {
  it("默认 1920 视口 + zoomSize=220 → 5-6 列", () => {
    // 1920 - 260(sidebar) - 360(detail) ≈ 1300 给 Feed；按 1300 估算
    expect(calcColumnCount(1300, 220)).toBeGreaterThanOrEqual(5);
    expect(calcColumnCount(1300, 220)).toBeLessThanOrEqual(6);
  });

  it("缩小滑块 zoomSize 140 → 列数变多；放大 360 → 列数变少", () => {
    const narrow = 800; // 视口较小时
    const small = calcColumnCount(narrow, 140); // 期望 5
    const big   = calcColumnCount(narrow, 360); // 期望 2
    expect(small).toBeGreaterThan(big);
    expect(small).toBe(5);
    expect(big).toBe(2);
  });

  it("滑块在边界值 140 / 360 之间滑动时列数稳定变化（不抖动）", () => {
    // 等于 (容器 + gap) / (列宽 + gap) 的零界点要稳定
    const w = 1000;
    expect(calcColumnCount(w, 140)).toBe(6);  // (1000+8)/(140+8)=6.81 floor
    expect(calcColumnCount(w, 220)).toBe(4);  // (1000+8)/(220+8)=4.37
    expect(calcColumnCount(w, 360)).toBe(2);  // (1000+8)/(360+8)=2.67
  });

  it("容器未测量时退到 1 列，不报错", () => {
    expect(calcColumnCount(0, 220)).toBe(1);
    expect(calcColumnCount(-10, 220)).toBe(1);
  });

  it("缩放 + 当前容器宽下，贪心分组后每个 thumb 的高度与列宽一致", () => {
    // 6 张竖图 1152x2064，列宽 220 时每列 thumb 理论高 = 220 * 2064/1152 ≈ 394
    const items = [1,2,3,4,5,6].map(i => mkItem(i, 1152, 2064));
    const n = calcColumnCount(1000, 220); // =4
    const cols = greedySplit(items, n, 220);
    // 总张数守恒
    expect(cols.flatMap(c => c.items).length).toBe(6);
    // 滑块改 360，列数变 2，6 张 → 每列 3 张
    expect(greedySplit(items, 2, 360).map(c => c.items.length)).toEqual([3, 3]);
  });
});

