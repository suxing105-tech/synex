# M3 Lightbox Esc 后保留 feed 滚动位置

## 用户反馈

> 很好，我希望空格放大之后，按了ESC，也不要自动到最上面。

## 根因

Lightbox 是 `<div class="fixed inset-0 z-[80]">` 全屏遮罩，关闭后从 DOM 移除。
关闭瞬间浏览器可能因为：
- 焦点从 Lightbox 元素转移到 body / feed 的 thumbnail；
- Lightbox 卸载导致 layout 重排；
- body 滚动条出现 / 消失让 viewport 高度变化；

把 feed scroller 的 scrollTop 重置到 0。

## 修复

在 Feed.svelte 监听 `lightboxOpen` 变化：

- 开（false → true）：记录当前 `scrollerEl.scrollTop` 到 `savedScrollTop`
- 关（true → false）：`queueMicrotask` 等下一帧把 `scrollerEl.scrollTop` 设回 `savedScrollTop`

```svelte
let scrollerEl: HTMLDivElement | null = $state(null);
let prevLightboxOpen = false;
let savedScrollTop = 0;

// scroller div 加 bind:this={scrollerEl}

$effect(() => {
  const nowOpen = lightboxOpen;
  const wasOpen = prevLightboxOpen;
  prevLightboxOpen = nowOpen;
  if (nowOpen && !wasOpen) {
    if (scrollerEl) savedScrollTop = scrollerEl.scrollTop;
  } else if (!nowOpen && wasOpen) {
    const st = savedScrollTop;
    queueMicrotask(() => {
      if (scrollerEl) scrollerEl.scrollTop = st;
    });
  }
});

// 防回环：分支执行后 prevLightboxOpen 被改写，下一轮 effect 不会再进同一分支。
```

## 边角场景

- 顶部打开/关闭 Lightbox：scrollTop=0 → 0，无变化
- 用户滚到中间 → 开 Lightbox → Esc 关闭：滚回中间位置
- 用户滚到中间 → 开 Lightbox → Lightbox 内 ←/→ 翻页（不影响 feed scrollTop） → Esc：滚回中间位置
- Lightbox 内删图（应该不会发生，Lightbox 没暴露删除菜单）：如果发生，乐观更新删除后位置也保留（上一轮修复 + 这轮恢复同时生效）
- 用户滚动 feed 时 effect 会跑，但因为分支条件不成立，savedScrollTop 不会被覆盖

## 验证

| 套件 | 之前 | 现在 |
|------|------|------|
| frontend vitest | 77/77 | **77/77** |
| vite build | OK | OK |

用户侧验证：
1. 滚到中间 → 鼠标移到某张图 → 按空格 → 显示 Lightbox
2. Lightbox 里按 Esc → 关闭 → 滚回原位置 ✓
3. Lightbox 里按 ←/→ → 翻页 → Esc 关闭 → 滚回原位置 ✓
4. 在 Lightbox 里看图 → 顶部打开浏览器 devtools → Esc 关闭 → 滚回原位置 ✓
