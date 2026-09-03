# M3 修复：删除图片后不要跳回顶部

## 用户反馈

> 能不能不要删除图片之后，自动跳到最上面。

## 根因

删除图片后调用 `refreshFeed()` → 后端重查整个 feed → `feedItems.set(newArr)` → masonry 贪心分组用新数组重算 → 浏览器重排 → scrollTop 落回 0。

另外：后端会通过 WS 推送 `image_removed` 事件，ws.ts 旧实现也是调 `refreshFeed()`，相当于删除一次触发了两次「整个 feed 重建」，滚动条必然跳顶。

## 修复

改为「**乐观更新**」本地 `feedItems`：删除成功后直接从数组里 filter 掉已删 id，不重新拉后端。

`{#each columns as col}{#each col.items as it (it.id)}` 是 keyed each，Svelte 会复用 DOM 节点，scroll 位置自然保持。masonry 列高变化时，浏览器会自动「上提」剩余内容，scroll 相对位置不变（除非删的是当前视口里的列）。

### Feed.svelte

deleteImages 末尾改为：

```svelte
// 不调 refreshFeed() —— 整个数组替换会让 masonry 贪心分组重算，滚动条跳回顶部。
// feedItems 用 (it.id) keyed each，Svelte 会复用 DOM，scroll 位置自然保持。
if (okCount > 0) {
  const removed = new Set(succeeded);
  feedItems.update((items) => items.filter((it) => !removed.has(it.id)));
  feedTotal.update((n) => Math.max(0, n - okCount));
}
await refreshStats();  // stats 是单独 store，不影响 feed 渲染
```

### ws.ts

image_removed 路径同样改为乐观更新：

```ts
} else if (payload.type === "image_removed") {
  const id = payload.id;
  let removed = false;
  feedItems.update((items) => {
    const next = items.filter((it) => it.id !== id);
    removed = next.length !== items.length;
    return next;
  });
  if (removed) feedTotal.update((n) => Math.max(0, n - 1));
  await refreshStats();
}
```

注意：
- feedTotal 也跟着减，避免 header 「N 张」文案和实际不一致
- refreshStats() 仍然调，stats 是单独 store（总数 / 收藏数 / 文件夹数）需要从后端拿权威值
- 失败项不 filter（保留以便用户重试）

## 不动的部分

- image_indexed 仍然走 refreshFeed()：新图入库时让浏览器重新排版是必要的（新图位置是 mtime desc，新图要插到顶部）
- 用户手动切文件夹 / 切视图 / 搜索 → 走 refreshFeed()（这些场景期望重排）

## 验证

| 套件 | 之前 | 现在 |
|------|------|------|
| frontend vitest | 77/77 | **77/77** |
| vite build | OK | OK |

用户侧验证：
1. 滚到中间 → 单图右键删除 → 滚动位置保持
2. 滚到中间 → Ctrl 多选 5 张 → 右键批量删除 → 滚动位置保持
3. 删除 → header 「N 张」数字减 1 / 减 5
4. 删除 → 后端 ws 推送 image_removed → ws handler 也走乐观更新（不再重排）
5. 监听目录新文件 → ws image_indexed → 走 refreshFeed()（顶部出现新图，预期行为）
