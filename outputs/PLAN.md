# 右键菜单功能 - 实施计划

## 需求
为图片缩略图增加鼠标右击菜单，包含 4 项：
- 复制图片
- 重命名
- 打开图片所在位置
- 删除图片

## 现状调研

### 前端
- `frontend/src/components/Feed.svelte`：图片瀑布流渲染，缩略图是 <button> 触发 onclick/ondblclick 选中或开 Lightbox。无右键处理。
- `frontend/src/lib/api.ts`：定义 `imagesApi.remove(id, removeFile)`，包含 DELETE 接口，无 rename/reveal API。
- `frontend/src/components/Lightbox.svelte`：独立的大图查看，无右键菜单。

### 后端
- `backend/app/routes/images.py`：存在 `DELETE /api/images/{id}`，无 rename/reveal 路由。
- `backend/app/repository.py`：仅读/写，没有重命名实现。
- `backend/app/models.py`：Pydantic schema 定义处。
- 平台打开文件管理器：Windows 用 `explorer /select,path`，macOS 用 `open -R path`，Linux 通用 `xdg-open dir`。

### 数据模型
- `images.path` UNIQUE，存绝对路径。
- `images.filename` 仅为文件名字符串。
- 重命名要同步改 `path` + `filename`，并 bump `mtime` 让前端 cache bust。

## 实施步骤

### 1. 后端：新增 repository 函数
- `rename_image(image_id, new_filename)`：
  - 校验新文件名不为空、不含路径分隔符、不与已有文件冲突
  - 重命名磁盘文件
  - 写新 `path` + `filename`，`mtime` 取新 `stat.st_mtime`
  - FTS 重同步
  - 返回更新后的 summary
- `reveal_image_path(image_id)`：返回绝对路径字符串或 None。

### 2. 后端：新增路由
- `PATCH /api/images/{image_id}/filename`，body {filename} → 200 + summary
- `POST /api/images/{image_id}/reveal` → 在 OS 文件管理器打开该图片（Win `explorer /select`，mac `open -R`，Linux `xdg-open dir`）

### 3. 后端：测试（backend/tests/test_api.py）
- rename 成功
- rename 重复文件名 → 409
- rename 含路径分隔符 → 400
- rename 不存在的 id → 404
- reveal 成功
- reveal 不存在的 id → 404

### 4. 前端：新增 API 调用（api.ts）
- `imagesApi.rename(id, filename)`
- `imagesApi.reveal(id)`

### 5. 前端：新增组件 ContextMenu.svelte
- 通用弹出菜单，接受 items、x、y、open
- 支持 Esc / 外部点击关闭
- 含分隔符支持

### 6. 前端：Feed 集成右键
- oncontextmenu={e => { e.preventDefault(); openMenu(it, e.clientX, e.clientY) }}
- 4 项点击回调：
  - 复制图片：fetch 原图 → blob → navigator.clipboard.write([ClipboardItem])，降级复制 URL
  - 重命名：prompt 弹窗（含扩展名校验）→ API
  - 打开位置：API
  - 删除图片：confirm 弹窗 + 二选（仅删索引 / 同时删文件）→ API → refreshFeed()
- 任意变更后调用 refreshFeed() / refreshStats()

### 7. 前端：Lightbox 集成右键（顺手做，体验一致）

### 8. 前端：测试
- __tests__/api.test.ts：mock fetch 校验 rename/reveal 入参
- __tests__/context-menu.test.ts：vitest 校验 items/坐标/关闭逻辑的纯函数

### 9. 验证
- 后端：pytest backend/tests -q
- 前端：pnpm test + pnpm build

### 10. Git commit
按改动分 2 个 commit：
1. feat(backend): 右键菜单 API - 重命名 + 打开位置
2. feat(frontend): 右键菜单组件 + Feed/Lightbox 集成
