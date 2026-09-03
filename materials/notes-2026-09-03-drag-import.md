# 拖拽导入图片 - 实施记录

## 日期
2026-09-03

## 目标
用户从资源管理器拖图片到中间缩略图区域，自动保存到当前文件夹。

## 设计要点

### UX
- Feed 区域是 drop target。拖入时显示半透明遮罩 + 虚线框 + 文件计数。
- 用 dragCounter 解决子元素 dragenter/leave 冒泡闪烁。
- 释放后：进度 toast → 结果 toast；WS 触发 feed 自动刷新 + NEW 徽标。

### 目标文件夹语义
- 当前视图是用户文件夹 → 自动指派到该文件夹。
- 当前是系统视图（全部图片/收藏/最近） → 仅入库收件箱。
- 物理存储固定在 `data/inbox/`，不加入 watch_dirs（避免 watchdog 重复扫描）。

### 不支持的格式
- 仅 .png / .webp（与 indexer 的 SUPPORTED_EXTS 对齐）。
- 其它进 skipped 列表，附 reason 字段，前端按 reason 给出本地化反馈。

## 关键决策

1. **物理位置 vs 虚拟文件夹分离**
   - 文件夹表是虚拟标签，磁盘路径来自收件箱 `data/inbox/`。
   - 拖入图片 → 物理写入收件箱 → 直接调 `_process_path_sync` 索引（不走 watchdog）→ 可选 `repository.assign_folder` 归到指定虚拟文件夹。
   - 用户后续可在 DetailPanel 重新指派。

2. **同名冲突**
   - `_ensure_unique` 自动追加 `_1` `_2`...直到不冲突；上限 9999 防死循环。

3. **空 filename 边界**
   - multipart 边界层（Starlette）拒绝空 filename → 422。
   - 我们自己的 `_sanitize_filename` 把 `...`.png 这类清洗后为空的兜底改成 image.png，但 `ext` 检查在前面所以实际触发不到。

4. **路径分隔符**
   - 用户文件名的 `..` 等路径分隔符被清洗掉；后端写入目录固定为 `inbox`，不可能写出 inbox 之外的文件。

5. **窗口级 drag 兜底**
   - 拖到非 Feed 区域（文件夹树 / 详情面板 / 空白）时，App.svelte 根 div 拦截 dragover/drop，浏览器不会导航到 file://。

## 测试

### 后端
`backend/tests/test_import.py` — 10 个用例：
- PNG / WebP 成功
- JPG 等 unsupported_format 跳过
- 文件夹自动指派
- 文件夹 id 不存在 → 400
- 文件名冲突追加 `_1`
- multipart 空 filename → 422（边界保护）
- 路径穿越被 sanitize
- inbox_dir 字段返回

### 前端
- `__tests__/api-import.test.ts` — 5 个用例：FormData + folder_id、FormData 头部不覆盖、ImportResponse 结构
- `__tests__/drop-zone.test.ts` — 4 个用例：pickImageFiles 纯函数（items / files / 空 / 非 file kind）

## 改动清单

### 后端
- `backend/app/config.py` — 新增 `inbox_dir()` helper
- `backend/app/models.py` — 新增 `ImportResultItem` / `ImportSkippedItem` / `ImportResponse`
- `backend/app/routes/images.py` — 新增 `POST /api/images/import` + 工具函数
- `backend/pyproject.toml` — 加 `python-multipart>=0.0.9` 依赖
- `backend/tests/test_import.py` — 新建

### 前端
- `frontend/src/lib/types.ts` — 新增 `Import*` 接口
- `frontend/src/lib/api.ts` — `imagesApi.import()` + http helper 修自动加 Content-Type 当 body 是 FormData 时
- `frontend/src/components/Feed.svelte` — 拖拽状态机 + drag handlers + 覆盖层 DOM + 结果 toast
- `frontend/src/App.svelte` — 根 div 拦截 dragover/drop 防浏览器导航
- `frontend/src/__tests__/api-import.test.ts` — 新建
- `frontend/src/__tests__/drop-zone.test.ts` — 新建

## 验证

- `cd backend && .venv/Scripts/python -m pytest tests/` → 91 passed
- `cd frontend && npx vitest run` → 109 passed
- `cd frontend && npx vite build` → success
- `cd frontend && npx svelte-check` → 19 errors (全部 pre-existing，未引入新错误)

## 后续

- 多文件并发上传（当前串行）
- 文件夹直接拖到文件夹树上（分配到指定文件夹，无需先选目标）
- 拖入历史回看面板
