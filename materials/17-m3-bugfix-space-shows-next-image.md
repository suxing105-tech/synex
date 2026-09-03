# M3 bugfix: 空格开 Lightbox 显示的是选中图的下一张

## 用户反馈

> 但是我现在空格放大的是选中后面的那张。之前也是，我想选中哪张，按空格放大的就是哪张。

## 根因

`Feed.svelte` 和 `Lightbox.svelte` 各自用 `<svelte:window onkeydown={handleKey} />` 在 window 上挂了 keydown 监听，按空格时**两个都会触发**：

时序（Feed 先 mount / 先注册）：

1. 用户在 feed 视图单击 A（feedItems 索引 5）
2. 按空格 → window keydown 事件
3. `Feed.handleKey` 跑：`lightboxIndex = 5`，`lightboxOpen = true`
4. Svelte 5 的 `bind:` 同步让 Lightbox 的 prop `open = true`（**立即同步**）
5. `Lightbox.handleKey` 跑：`if (!open) return;` 里的 `open` 已经是 `true`，进入 `else if (e.key === ' ') next()`
6. `next()`：`index = (5 + 1) % len = 6` → 显示 B（用户看到的"选中后面的那张"）

## 修复

`Feed.handleKey` 调整：

```svelte
if (e.key === " " || e.code === "Space") {
  // Lightbox 已开时让位给 Lightbox 自己的 handler（按空格翻下一张）。
  // 否则两个 svelte:window handler 都触发：Feed 先把 lightboxOpen 改成 true，
  // Lightbox 的 handler 看到 open=true 紧接着调 next()，结果展示的是选中图的下一张。
  if (lightboxOpen) return;
  if (selectedId !== null) {
    e.preventDefault();
    // 阻止 Lightbox 的 window keydown 也响应本次空格。
    e.stopImmediatePropagation();
    const idx = $feedItems.findIndex((it) => it.id === selectedId);
    if (idx >= 0) {
      lightboxIndex = idx;
      lightboxOpen = true;
    }
  }
}
```

两层保护：
- `if (lightboxOpen) return`：lightbox 已开着时让位给 Lightbox 接管翻页（用户期望行为）
- `e.stopImmediatePropagation()`：从 Feed 视图打开时阻止 Lightbox 跟着 `next()`

## 验证

| 套件 | 之前 | 现在 |
|------|------|------|
| frontend vitest | 77/77 | **77/77** |
| vite build | OK | OK |

手工验证步骤（用户浏览器）：
1. 单击 A → 按空格 → 显示 A ✓
2. 在 Lightbox 里按空格 → 跳到下一张 B ✓
3. 在 Lightbox 里按 ←/→ → 翻页 ✓
4. Esc 关 Lightbox → 单击 D → 按空格 → 显示 D ✓
5. Ctrl 点多张 → 按空格 → 显示最后一次点的那张 ✓
