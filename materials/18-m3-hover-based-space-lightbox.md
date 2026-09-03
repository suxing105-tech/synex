# M3 空格键：左键点击 → 鼠标滑过

## 用户反馈

> 现在是鼠标左键点击按空格键放大，改为鼠标滑过缩略图按空格就放大。

## 行为变化

之前：`onThumbClick`（左键）设置 `selectedId` → `handleKey` 看 `selectedId` 决定开 lightbox。
之后：鼠标在缩略图上 → 按空格 → 开 lightbox（与左键选中 / 多选解耦）。

`selectedId` 仍然负责：
- 缩略图 ring 高亮（`$multiSelectedIds.has`）
- 多选集合（`multiSelectedIds` / `selectionAnchorId`）
- DetailPanel 详情（`selectedDetail` 订阅）
- Esc 清空选区
- 右键菜单 / 复制 / 重命名 / 删除

`selectedId` 不再管：
- 空格键开 lightbox（改为读 `hoveredId`）

## 实现

### `Feed.svelte`

```svelte
// 当前鼠标滑过的缩略图 id（空格键放大这张；不受 selectedId 影响）
let hoveredId = $state<number | null>(null);

// 缩略图按钮：
<button
  ...
  onmouseenter={() => (hoveredId = it.id)}
  onmouseleave={() => { if (hoveredId === it.id) hoveredId = null; }}
  ...
/>

// handleKey 空格分支：
if (hoveredId !== null) {
  e.preventDefault();
  e.stopImmediatePropagation();
  const idx = $feedItems.findIndex((it) => it.id === hoveredId);
  if (idx >= 0) {
    lightboxIndex = idx;
    lightboxOpen = true;
  }
}
```

### mouseleave 守卫

`if (hoveredId === it.id)` 这一行的作用：
- A → B 快速切换时，浏览器按顺序触发 A mouseleave → B mouseenter；
  - 如果 A leave 时 B enter 已先跑，hoveredId 已是 B，`=== A.id` 不成立，不清，hoveredId 保持 B；
  - 反之先 A leave 再 B enter，hoveredId 清成 null，然后 B enter 设为 B。最终都是 B。
- 鼠标从 A 移到 detail panel（不经其他缩略图）：A leave → hoveredId === A.id 成立 → 清 null。

### 鼠标完全离开 feed 区域

hoveredId 可能残留为最后一张缩略图的 id。无所谓：
- 下次鼠标 enter 任意缩略图会被刷新；
- 用户在 feed 区域外按空格，浏览器事件 target 不在缩略图上，`isTypingTarget` / 后续逻辑不命中（除非焦点在 input，但 input 会让 `isTypingTarget` return）。

更激进的方案是给 scroller 加 `onmouseleave={() => (hoveredId = null)}`，但 scroller 的 leave 也会在缩略图之间间隙触发，会闪烁。本期不动。

## 验证

| 套件 | 之前 | 现在 |
|------|------|------|
| frontend vitest | 77/77 | **77/77** |
| vite build | OK | OK |

用户侧验证：
1. 鼠标移到 A → 按空格 → 显示 A
2. 鼠标移到 A → 移到 B（不点）→ 按空格 → 显示 B
3. Ctrl 点 A、B → 鼠标移到 C → 按空格 → 显示 C（多选集合不变，B 的 ring 还在）
4. 鼠标在空白区（不在缩略图上）→ 按空格 → 不开 lightbox
5. 打开 lightbox 后鼠标移开 → 按空格 → Lightbox 自己接管翻下一页
