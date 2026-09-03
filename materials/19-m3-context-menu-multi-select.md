# M3 右键菜单支持多选

## 用户反馈

> 为什么我多选之后，鼠标右键删除图片，不能都删掉呢？那多选就没有意义了。

## 根因

右键菜单派生只盯 `menuTarget`（被右键的那一张）：

```svelte
// 旧代码
let menuTarget = $state<ImageSummary | null>(null);

function openContextMenu(e, it) {
  if (!$multiSelectedIds.has(it.id)) applySelection($feedItems, it.id, "none");
  menuTarget = it;  // 不管多选，菜单项永远只对这一张
}

let menuItems = $derived.by(() => {
  const t = menuTarget;
  return [
    { label: "删除图片", onClick: () => deleteImage(t) },  // 单图
    ...
  ];
});

右键不选中的图：单选这张 → 菜单对这张生效（合理）
右键多选集合里的图：菜单仍然对这一张生效（多选没意义）

## 修复

### 数据结构

`menuTarget`（单图）改为 `menuTargetIds: number[]`（目标 id 列表）。

右键命中多选里的图 → `menuTargetIds = [...$multiSelectedIds]`（复制快照，避免后续 selection 变化污染菜单项）。
右键命中多选外的图 → 先单选 + `menuTargetIds = [it.id]`（单图模式，保持旧行为）。

### 菜单项派生（动态）

```svelte
let items = $feedItems.filter((x) => ids.includes(x.id));
if (items.length === 1) {
  // 单图：复制图片 / 重命名 / 打开位置 / 删除
}
// 多图：复制 N 个图片地址 / 批量删除（重命名 / 打开位置对集合无意义）
```

### 批量删除 deleteImages(items: ImageSummary[])

- 串行循环 `imagesApi.remove(it.id, true)`，收集成功的 ids 和失败的 ids
- `removeIdsFromSelection(succeeded)` 把真正删成功的从多选集合里剔除（失败的保留以便重试）
- toast 三档：全成功 / 部分失败 / 全失败
- 单图也走这条，传 length=1 数组即可（旧 `deleteImage` 删除）

### 批量复制 copyImageUrls(items)

- 浏览器 Clipboard API 一次只能写一张 `ClipboardItem`（图片），多张时降级为 URL 文本（多行）
- 单图菜单仍走原 `copyImageToClipboard`（图片二进制）

## 验证

| 套件 | 之前 | 现在 |
|------|------|------|
| frontend vitest | 77/77 | **77/77** |
| vite build | OK | OK |

用户侧验证：
1. 单图右键 → 菜单：复制图片 / 重命名 / 打开位置 / 删除图片（与旧行为一致）
2. Ctrl 多选 3 张 → 右键任意一张 → 「复制 3 个图片地址」/「批量删除 3 张图片」
3. 多选 → 右键集合外的一张 → 单选这张 + 单图菜单（旧行为）
4. 多选 → 右键 → 批量删除 → toast 显示删除数 + 缩略图清理数；多选集合里只剩失败项（如果有）
5. 多选 → 右键 → 复制 3 个地址 → 剪贴板拿到 3 行 URL

## 范围外 / 后续

- 「批量移动到文件夹」「批量打标签」属于 P1 批量操作，本期未加（菜单里没有这两项）
- 「批量下载」属于另一个工程（前端 zip 打包或后端归档接口），不在范围
