# M3 多选（Ctrl / Shift）

## 用户反馈

> 我希望增加多选功能，鼠标左键先选一个，然后按ctrl，点其他的可以多选。按shift,可以选两个缩略图之间的所有图片。

## 行为约定（与文件管理器 / Finder 一致）

- 左键单击：单选（清空旧选，只选当前），更新 anchor。
- Ctrl/Cmd + 左键：在多选集合里 toggle 当前 id；anchor 跟着被点的 id 移动。
- Shift + 左键：取 anchor → 当前点击 在 `$feedItems` 里的下标闭区间，集合替换为区间内全部 id，primary 落到被点的 id，anchor 保持不变。
- 右键：若当前右键的图不在集合内，先单选这张；右键菜单只对 primary 生效。
- Esc / 点击空白区域 / "清空"按钮 → 清空选区。
- 切换文件夹 / 视图 / 搜索词 → 自动清空选区（旧选中的 id 可能已经不在当前 feed）。
- feed 中删除某张图 / 新入库 → 多选集合里剔除不存在的 id；primary 若被剔，自动退到集合里另一个，集合空才清 null。

## 实现

### `frontend/src/lib/selection.ts`（新增，纯函数）

- `Modifier = "none" | "ctrl" | "shift"`
- `SelectionState = { primary, selected, anchor }`
- `nextSelection(feedItems, current, clickId, modifier): SelectionResult` — 单测打满

### `frontend/src/lib/stores.ts`

- 新增 `multiSelectedIds: writable<Set<number>>` 与 `selectionAnchorId: writable<number | null>`
- 新增 `applySelection(feedItemsSnap, clickId, modifier)` 封装读 current → nextSelection → set stores
- 新增 `clearSelection()` 与 `removeIdsFromSelection(ids)`（删除图时用，后者带 primary fallback 语义）
- 订阅 `folderId` / `view` / `query` → `clearSelection()`
- 订阅 `feedItems` → 把不在新 feed 的 id 剔出多选 + primary fallback
- 保留 `selectedId` 不变：DetailPanel / Lightbox 仍由它驱动（向后兼容 + 单独一条路径）

### `frontend/src/components/Feed.svelte`

- import：`multiSelectedIds`, `applySelection`, `clearSelection`
- `onThumbClick(e, it)`：根据 `e.shiftKey / e.ctrlKey || e.metaKey` 转 modifier，调 `applySelection`
- 双击（开 Lightbox）保持不变：只动 `selectedId`（primary），不影响多选集合
- 缩略图 ring 类：`$multiSelectedIds.has(it.id) ? 'ring-2 ring-accent' : ''`
- 缩略图左上加 `✓` 角标（选中时显示，与 `♥` 收藏 / `NEW` 不再冲突：NEW 移到文件名条上方）
- header 新增 `已选 N 张` + 清空按钮（selectedCount 派生自 `$multiSelectedIds.size`）
- `<div class="masonry-scroller" onclick={onScrollerClick}>`：点击空白区域时清空选区
- `handleKey` 全局键：
  - Esc 且有选区 → 清空选区
  - Space 且 primary !== null → 开 Lightbox（保持旧））
  - input / textarea / contentEditable 聚焦时让原生处理

### 测试

新增 `frontend/src/__tests__/selection.test.ts`：19 个测试覆盖
- 单击：空状态点击 / 替换旧选
- Ctrl：加入 / 切换移除 / 移除唯一项 → primary=null / 移除后 anchor 保持
- Shift：无 anchor 回退 / 正向区间 / 反向区间 / 区间单点 / anchor 失效回退 / 区间不合并旧 ctrl 集合（与 Windows 资源管理器一致）
- anchor 更新规则：单击 / ctrl 加 / ctrl 移除 / shift 全部不动 anchor
- 异常输入：clickId 不在 feedItems 时各种 modifier 的行为

`frontend/src/__tests__/stores.test.ts`：新增 7 个测试覆盖 `applySelection` / `clearSelection` / `removeIdsFromSelection` / `feedItems` 剔除

`frontend/src/__tests__/store-template-usage.test.ts`：`STORE_NAMES` 加入 `multiSelectedIds` 和 `selectionAnchorId`，否则模板守卫会漏掉这两条

## 验证

| 套件 | 之前 | 现在 |
|------|------|------|
| backend pytest | 63/63 | **63/63** |
| frontend vitest | 51/51 | **77/77**（+19 selection + 7 stores）|
| vite build | OK | OK |

## 范围外 / 后续

- Ctrl+A 全选快捷键：本期未加，留到批量操作一起做（参考 `01-m1-m2-delivery.md` 的 P1 TODO）。
- 批量操作（删除 / 移动 / 打标签）：本期未加，留到 M4。
- Lightbox 内多选导航（←→ 跳到下一个选中项）：本期未加，Lightbox 仍按 primary 单图导航。
- 拖拽框选（marquee）：本期未加，标准点击多选已能覆盖 95% 场景。
