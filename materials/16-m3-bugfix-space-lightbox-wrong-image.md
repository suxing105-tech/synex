# M3 bugfix: 空格开 Lightbox 显示的不是当前选中图

## 用户反馈

> 帮我看一下，为什么我选中了图片，按空格键，放大展示的图片不是选中的这张？

## 根因

`Feed.svelte` 的 `selectedId` 来自 `bind:selectedId={selectedIdValue}`（App 传下来的 prop）。
点击缩略图时走 `applySelection` → `selectedId.set(...)`（写 store），但 `bind:` 的反向同步只对「prop 赋值」生效，对 `store.set` 不会反向写回 prop。

App.svelte 只有一个 `$effect(() => selectedId.set(selectedIdValue))`，**单向** prop → store；缺反向 store → prop。

时序：
1. 用户 Ctrl/Shift 多选 → `selectedId.set(X)` → store 已是 X
2. 但 `Feed.selectedId` prop 和 `App.selectedIdValue` 还都是旧值 Y
3. 按空格 → `Feed.handleKey` 读 `selectedId` prop（= Y）→ `findIndex(it.id === Y)` → 打开错的图

`openLightbox()`（双击）写 `selectedId = it.id` 是直接 prop 赋值，所以那条路径正常。这就是为什么**单击 + 双击**没 bug，但**Ctrl/Shift 选中后再空格**有 bug。

## 修复

在 `Feed.svelte` 加一个反向同步 $effect：

```svelte
// 反向同步：applySelection 写 store.selectedId 但不会反向写到这里的 prop，
// 导致 handleKey（空格开 Lightbox）读到旧 prop。
// 这里把 store 反向写到 prop，比较相等时跳过，避免 prop→store→prop 回环。
$effect(() => {
  const v = $selectedIdStore;
  if (selectedId !== v) selectedId = v;
});

// import：
selectedId as selectedIdStore,
```

- 用 alias 是因为 prop 也叫 `selectedId`，会和 store import 冲突。
- `if (selectedId !== v) selectedId = v` 这一行的相等比较就是回环 guard：
  - store 变 → 写 prop
  - 通过 `bind:` 写父 selectedIdValue
  - App.$effect → store.set 同值（store 还是触发 subscriber 但 effect dedupe 同值）
  - Feed.$effect 重跑 → `selectedId === v` → 跳过
- 同样的逻辑对 `clearSelection` / `removeIdsFromSelection` / `feedItems` 剔除也适用，它们也走 store 路径。

## 验证

| 套件 | 之前 | 现在 |
|------|------|------|
| frontend vitest | 77/77 | **77/77** |
| vite build | OK | OK |

手工验证步骤（用户浏览器）：
1. 单击 A → 按空格 → 应该显示 A
2. Ctrl+点击 B → 选中 A、B（B 是 primary）→ 按空格 → 应该显示 B（修复前会显示 A）
3. Shift+点击 C（A→C 区间）→ 选中 {A,B,C}（C 是 primary）→ 按空格 → 应该显示 C
4. 按 Esc 清空 → header "已选 N 张" 消失 → 再按空格不会开 Lightbox（因为 primary === null）

## 测试覆盖说明

仓库惯例是纯函数 + store 单测，没有组件 mount 测试。这次 bug 在组件层的 prop↔store 同步逻辑，加组件 mount 测试覆盖成本高于价值（需要 mock imagesApi / ContextMenu / 整个 feedItems 子树）。所以用 $effect 的去重条件 + 注释做防御。

## 范围外 / 后续

- 长期更稳的方案：把 `selectedId` 完全交给 store，App.svelte / Feed / Lightbox 都从 `$selectedId` 读。改 `selectedId` 不再是 prop，而是直接 `selectedId.set(...)`。这样可以干掉这个回环 $effect。本次保留 bindable prop 是因为改动面更大，未必划算。
- Lightbox 内 ←→ 翻页：当前走 `index = (index ± 1 + len) % len`，无视多选集合。如果用户想"在多选集合里跳"，需要 M4+ 加；不在本 bug 修复范围。
