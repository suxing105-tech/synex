# M3 slider 语义换：zoomSize（列宽 px）→ targetColumns（列数）

## 用户反馈

Task 1（拆 thumb 管道）做完之后，slider 还是用 px 控制列宽。但用户的思考模型是「我想一行显示 N 张」而不是「列宽 X px」。
px 控制还有另一个坑：临界点（容器宽刚好被列数除不尽）会突然少一列，slider 拖到中间整排会跳。

> 用户最新一句：slider 改成控制列数，4-12，默认 7。

## 实现

### `frontend/src/lib/stores.ts`

- `export const zoomSize = writable<number>(220);` → `export const targetColumns = writable<number>(7);`

### `frontend/src/components/Feed.svelte`

- import `targetColumns`（不再 import `zoomSize`）
- Slider:
  - `min="4" max="12" step="1"`（之前 140-480 step=10）
  - `value={$targetColumns}` / `targetColumns.set(...)`
  - 标签「🔍 zoomSize px」→「列数 N 列」
- `columnCount` 不再从容器宽反推，直接 = `Math.max(1, $targetColumns)`
- 新增 `columnWidth = (containerWidth - (n-1)*COL_GAP) / n`（容器宽 ÷ 列数，分配给贪心分组用）
- Grid template: `repeat(n, minmax(0, 1fr))`（让 grid 平分容器宽，不再固定 px）
- 注释同步更新（解释列数 vs 列宽的关系）

### 测试

- `stores.test.ts`: `zoomSize` → `targetColumns`，默认值 220 → 7，范围 140-360 → 4-12
- `store-template-usage.test.ts`: STORE_NAMES 列表 `zoomSize` → `targetColumns`（否则模板守卫会漏掉）
- `masonry-greedy.test.ts`:
  - helper 重命名 `calcColumnCount(containerWidth, columnWidth)` → `calcColumnWidth(containerWidth, columnCount)`
  - 5 个测试用例的语义对应改写：
    - 「zoomSize=220 → 5-6 列」→「targetColumns=7 → 列宽 ≈ 179」
    - 「zoomSize 140 vs 360 → 列数 5 vs 2」→「targetColumns 4 vs 10 → 列宽 大 vs 小」
    - 「边界值 140/220/360 列数 6/4/2」→「边界值 4/7/12 列宽均分」
    - 「容器 0 → 1 列」→「容器 0 / 列数 0 → 列宽 0」
    - 「calcColumnCount(1000, 220)=4 → 2 列时 3+3」→「calcColumnWidth(1000, 4) → 列数 2 时 3+3」
- `feed-aspect.test.ts`：不动（测的是 aspect-ratio / renderedHeight 纯函数，跟列数无关）

## 顺带修一个旁路 bug

启动 backend 时 watchdog 报：
```
WARNING app.indexer | event handler failed: ... (name 'conn' is not defined)
```
溯源：`indexer.py::_process_path_sync` 的 `if remove:` 分支直接用裸 `conn.execute(...)`，但 `conn` 没定义（应该是 `get_pool().main()`）。
这是更早一轮删 thumb 代码时遗留的，因为 pytest 没覆盖到 `remove=True` 这条路径。
修法：
```python
if remove:
    conn = get_pool().main()
    row = conn.execute(...).fetchone()
    ...
```
也顺手删掉了 `return None\n            return None` 这两个连续的 return（一个就够）。

## 验证

| 套件 | 之前 | 现在 |
|------|------|------|
| backend pytest | 49/49 | **49/49** |
| frontend vitest | 40/40 | **40/40** |
| vite build | OK | OK |

API curl 一切如常：
- feed 200
- /api/images/{id}/file 200
- /api/images/{id}/file?max=1024 200
- /api/thumbnails/rebuild 405（端点已删）
- 启动 watchdog 不再报 `name 'conn' is not defined`

## 范围外

- 没有改 Feed 的「缩放范围推荐」（UI 已经不再展示 px 值，所以推荐文案也下线了）
- 没有动 `containerWidth <= 0` 时的 fallback（仍退到 columnWidth=0 → 空 columns → empty state 显示）