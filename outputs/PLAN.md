# 拖拽导入图片 — 实施计划

## 需求
用户把本地图片（PNG/WebP）从资源管理器拖到中间缩略图区域，自动保存到当前文件夹。
设计良好的 UI 交互（覆盖层、计数、进度、结果反馈）。

## 现状
- 后端索引由 `Indexer._process_path_sync(path)` 完成（解析 + 写库 + FTS + 发事件）。
- watchdog 监听 `watch_dirs` 内的目录，但 `data/inbox/` 不在监听范围。
- 文件夹表是虚拟标签（`image_folders` M:N），不强制对应磁盘目录。
- 前端 Feed 组件无任何拖拽逻辑。

## 设计

### UX 流程
1. 拖入 Feed 区域 → 半透明遮罩 + 虚线框 + 居中图标 + 「释放以导入到 X」。
2. dragenter/leave 用计数器避免子元素冒泡引起的闪烁。
3. 释放 → 后端处理 → 进度 toast → 结果 toast。
5. NEW 徽标（已有）会在新图上闪 3 秒提示。

### 目标文件夹判定
- 当前视图是用户文件夹 → `assign_folder(image_id, folder_id)`。
- 当前是系统视图（全部图片 / 收藏 / 最近生成）→ 仅入库，不分配文件夹。
- 用户可在 Settings 里后续把新图手动指派到文件夹（已有 UI）。

### 收件箱位置
- `data/inbox/`，固定路径。
- 不加入 `watch_dirs`，避免 watchdog 重复扫描。
- 索引走直接调用 `_process_path_sync`，确定性更强、反馈更快。

## 实施步骤

### 1. 后端 — Pydantic models（models.py）
- `ImportResultItem`: id, filename, path
- `ImportSkippedItem`: filename, reason
- `ImportResponse`: saved[], skipped[], folder_id

### 2. 后端 — config.py
- `inbox_dir()` 辅助函数，返回并确保 `data/inbox/` 存在。

### 3. 后端 — 路由（routes/images.py）
- `POST /api/images/import`：multipart `files` + 可选 `folder_id`。
- 文件名校验：去掉路径分隔符 + 控制字符；空名 / `.png` 开头 → 改名。
- 扩展名过滤：仅接受 `.png` / `.webp`，其它进 skipped（reason=`unsupported_format`）。
- 同名冲突：自动追加 `_1` `_2`...
- 写盘 → `Indexer._process_path_sync` → 可选 `repository.assign_folder`。
- 错误：folder_id 不存在 → 400；无文件 → 400。

### 4. 后端 — 测试（tests/test_import.py）
- PNG 上传成功 → 返回 saved + DB 行可见。
- WebP 上传成功。
- JPG 被跳过并给出 reason。
- folder_id 分配生效（按 folder_id 查询能看到新图）。
- folder_id 不存在 → 400。
- 文件名冲突追加后缀。
- 空 filename → 自动改名。

### 5. 前端 — api.ts
- `imagesApi.import(files, folderId?)` → FormData multipart POST。

### 6. 前端 — types.ts
- `ImportResponse`, `ImportResultItem`, `ImportSkippedItem`。

### 7. 前端 — Feed.svelte
- dragenter/dragleave/dragover/drop handlers。
- dragcounter 状态机避免 leave 闪烁。
- 覆盖层 DOM：dashed border + 半透明遮罩 + 居中文字 + 文件计数 chip。
- 过滤 `dataTransfer.files` 中 type 包含 image 的项；空集时显示「仅支持 PNG/WebP」错误。
- 调 API → 进度 toast → 结果 toast → 失败兜底。
- 成功后 WS 自动触发 refreshFeed + markNew。

### 8. 前端 — App.svelte
- `<svelte:window ondragover preventDefault ondrop preventDefault>` 防止误拖到窗口非 Feed 区域时浏览器跳到 file://。

### 9. 前端 — 测试
- `__tests__/api-import.test.ts`：mock fetch 校验 FormData 与 endpoint URL。
- `__tests__/drop-zone.test.ts`：纯函数 `filterImageFiles(fileList)`。

### 10. 文档 & 提交
- `outputs/PLAN.md`：本计划。
- `materials/notes-2026-09-03-drag-import.md`：实施记录 + 决策。
- `README.md` P0 列表加「拖拽导入到当前文件夹」。
- Git commit：
  1. `feat(backend): POST /api/images/import` 多文件导入 + 文件夹自动指派
  2. `feat(frontend): Feed 拖拽导入 + 覆盖层交互`
  3. `docs: 拖拽导入计划与说明`
