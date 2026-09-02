# M2 修复：Feed 流式瀑布 + 滑块恢复

## 上一版的两个 bug

1. `grid-auto-rows: 220px` 把每行高度锁死，竖图（ratio 0.56）按 aspect-ratio 算出的高度被 grid 截掉；
2. 滑块控的是 `minmax(220px, 1fr)` 的基础值，因为高度锁死 + 所有列等宽，滑块拉大时图本身没变 → 没效果。

## 改用 CSS columns 流式瀑布

```svelte
<div class="masonry" style="column-width: {$zoomSize}px;">
  {#each $feedItems as it, idx}
    <button
      class="thumb ..."
      style="aspect-ratio: {aspectFor(it)};"
      ...
    >
      <img class="w-full h-full object-cover" ... />
      ...
    </button>
  {/each}
</div>
```

```css
.masonry { column-gap: 8px; }
.thumb {
  width: 100%;
  display: inline-block;
  break-inside: avoid;
  -webkit-column-break-inside: avoid;
  page-break-inside: avoid;
}
```

行为：

- `column-width` 是「列最小宽度」。浏览器按容器宽度自动算列数与最终列宽；
- 每张 thumb `width: 100%` 撑满所在列，`aspect-ratio` 决定高度 → 竖图竖、横图横；
- `break-inside: avoid` 三处声明防被列边界切断；
- 缩放滑块直接绑 `column-width`：拉大 → 列宽变大 → 每张图同比放大。

## 测试

- `feed-aspect.test.ts`：测 aspect 字符串 + 给定 column-width 算实际渲染高度。
  - 横图（16:9，300px 列）→ 169px 高
  - 竖图（1152×2064，300px 列）→ 538px 高
  - 滑块 140→220→360 时竖图高度同比放大，比例 ≈ 列宽比
- 端到端 probe：dispatch slider input 后 `getComputedStyle(masonry).columnWidth` 同步更新。

## 文件变更

```
frontend/src/components/Feed.svelte                 ← grid → CSS columns
frontend/src/__tests__/feed-aspect.test.ts         ← gridMin 改成 renderedHeight
materials/05-m2-masonry-fix.md                     ← 本记录
```

## 验证

- 前端 vitest：29 / 29（feed-aspect 5 + 其他 24）
- 后端 pytest：31 / 31
- 端到端：滑块 220→360 后 column-width 实时更新
