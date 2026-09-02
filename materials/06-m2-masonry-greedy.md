# M2 修复：JS 贪心 masonry + 滑块真正生效

## 上两版的两个问题

1. **CSS columns 一列全竖图**：流式 column-width 是按列优先（自上而下再下一列）填充，
   用户前 10 张图全是竖图 → 全堆到 col 1，第 11-20 张才到 col 2。
   用户原话：「不希望一列都固定用竖图或横图，而是根据顺序，每一列可以随机横图或竖图」。
2. **网格版滑块无效果**：上一版用 `grid-template-columns: repeat(n, minmax(0, 1fr))`，
   列宽被容器均分；`$zoomSize` 只控列数，根本不控单张缩略图大小 → 拖滑块几乎看不到变化。

## 改动

### Feed.svelte：JS 贪心分列 + 列宽 = $zoomSize px

```svelte
const COL_GAP = 8;
let containerWidth = $state(0);

let columnCount = $derived.by(() => {
  if (containerWidth <= 0) return 1;
  const n = Math.floor((containerWidth + COL_GAP) / ($zoomSize + COL_GAP));
  return Math.max(1, n);
});

let columns = $derived.by(() => {
  const n = columnCount;
  const cols = Array.from({ length: n }, () => ({ items: [], height: 0 }));
  for (const it of $feedItems) {
    const ratio = it.width && it.height ? it.height / it.width : 1;
    const h = $zoomSize * ratio + COL_GAP;
    let target = cols[0];
    for (let i = 1; i < n; i++) if (cols[i].height < target.height) target = cols[i];
    target.items.push(it);
    target.height += h;
  }
  return cols;
});
```

模板：

```svelte
<div class="masonry-scroller" bind:clientWidth={containerWidth}>
  <div
    class="masonry-grid"
    style="grid-template-columns: repeat({columnCount}, {$zoomSize}px); gap: {COL_GAP}px;"
  >
    {#each columns as col}
      <div class="masonry-col" style="gap: {COL_GAP}px;">
        {#each col.items as it (it.id)}
          <button class="thumb ..." style="aspect-ratio: {aspectFor(it)}; width: 100%;" ...>
```

样式：

```css
.masonry-scroller {
  overflow-x: auto;   /* 列宽固定 = zoomSize 时可能溢出，横向滚动兜底 */
  overflow-y: visible;
}
.masonry-grid {
  display: grid;
  align-items: start; /* 列高按内容，不被 grid 拉伸 */
  width: max-content; /* 让 grid 按列数 × zoomSize 撑开 */
}
.masonry-col { display: flex; flex-direction: column; }
```

### 关键设计点

- **列宽 = $zoomSize px**：grid track 直接写死 px → 滑块拖动时单张缩略图宽度实时变化。
  240×360 范围内可以真切看到「缩略图变大变小」。
- **JS 贪心算法代替 CSS columns**：每张图放进当前累计高度最小的列。
  同方向连续 10 张竖图不会堆到同一列；每列内自然横竖混合（保持 mtime 顺序）。
- **容器宽度自适应**：`bind:clientWidth={containerWidth}` 跟随浏览器窗口 / 侧边栏 resize，
  列数自动重算，缩略图位置自动重排。
- **overflow-x: auto 兜底**：极窄屏 / 缩放滑到很大值时，列总宽溢出 → 用户可横向滚动。

## 测试

`frontend/src/__tests__/masonry-greedy.test.ts` 新增 5 个 case（+6 个原有 = 11 个全绿）：

1. `默认 1920 视口 + zoomSize=220 → 5-6 列`：calcColumnCount(1300, 220) ∈ [5,6]
2. `滑块缩放对列数的影响`：800px 容器下 140 → 5 列，360 → 2 列
3. `滑块 140 / 220 / 360 切换稳定性`：1000px 容器下分别给出 6 / 4 / 2 列（不抖动）
4. `容器未测量时退到 1 列`：calcColumnCount(0, 220) === 1
5. `贪心守恒 + 列宽变化`：6 张竖图，220→列数 4 守恒 6 张；360→2 列均分 [3, 3]

测试结果：`Tests 40 passed (40)`（frontend）

## 文件变更

```
frontend/src/components/Feed.svelte
frontend/src/__tests__/masonry-greedy.test.ts        ← 新增 calcColumnCount + 5 slider cases
materials/06-m2-masonry-greedy.md                   ← 本记录
```

## 验证

- 前端 vitest：**40 / 40**
- 后端 pytest：**33 / 33**
- `npm run build`：124 modules transformed，无错误（仅 a11y warnings，是历史遗留）
- 后端 SPA bundle 已自动更新为 `index-CWMIPi1K.js`
- DB 维度：292 张图中 280 张带尺寸；12 张缺尺寸全是早期测试 fixture
  (`backend/data/sample_images/*` + 一个已删除的孤儿文件 `AnimateDiff_00001.png`)，
  **watch_dirs 没纳入，因此不会出现在用户视图**

## 关于「流式瀑布 + 每列随机横竖」

- 流式 = 贪心按列数 × 列宽排，容器自适应
- 每列随机横竖 = 贪心按当前最短列分配，自然穿插
- 顺序保持 = 遍历 $feedItems（mtime 排序） push，不 shuffle
