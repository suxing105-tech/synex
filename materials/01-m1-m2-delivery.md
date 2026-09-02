# M0 → M2 交付小结（2026-09-02）

## 已完成

### 后端（`backend/`）

- **栈**：Python 3.14 · FastAPI 0.141 · SQLite 3.50 (含 FTS5) · watchdog 6 · Pillow 12 · pytest 9
- **关键模块**：
  - `parser.py` — PNG tEXt / iTXt / zTXt + A1111 `parameters` + ComfyUI `prompt` JSON 全自研
  - `db.py` — WAL + 隔离 main / worker 连接池 + 幂等 DDL
  - `indexer.py` — ThreadPoolExecutor 并行解析 + watchdog 异步防抖 + FTS5 同步
  - `repository.py` — feed 查询（FTS + 模糊 + 文件夹递归 + 系统视图 + 标签）
  - `events.py` — asyncio 事件总线
  - `routes/` — images / folders / tags / settings / scan + 原图 `GET /api/images/{id}/file`
  - `thumbnails.py` — Pillow → WebP，单图单文件 `<id>.webp`
- **测试**：27 个 pytest，全部通过
  - parser：PNG tEXt / A1111 parameters / 损坏文件 / 不支持的扩展名
  - db & feed：schema 幂等、UPSERT、文件夹递归计数、FTS5 同步、收藏、标签、文件夹排序
  - api：health / feed / search / favorite / folder / settings / scan / tags
  - thumbnails：WebP 生成 / 缺失文件容错

### 前端（`frontend/`）

- **栈**：Svelte 5 (runes) · Vite 5 · TailwindCSS 3 · TypeScript 5 · Vitest 2 + happy-dom
- **关键组件**：
  - `App.svelte` — 顶栏 + 三栏 + 全局弹窗
  - `HeaderBar.svelte` — 搜索 / 设置 / 导入入口
  - `FolderTree.svelte` — 系统视图 + 嵌套文件夹 + 重命名 / 上移下移 / 新建 / 删除
  - `Feed.svelte` — CSS Grid auto-fill 缩放 + NEW 徽标 + 双击 lightbox
  - `DetailPanel.svelte` — 文件信息头 + 快捷复制条 + 正反向 prompt + 参数 + 标签 / 收藏 / 文件夹指派 + workflow
  - `Lightbox.svelte` — 全屏大图 + ←/→/Space/Esc 快捷键
  - `OnboardingModal.svelte` — 首次启动引导 + 扫描进度
  - `SettingsModal.svelte` — 监听目录 / 缩略图参数 / Live 开关
  - `ScanProgressBar.svelte` — 顶栏下方的扫描进度条
- **stores.ts**：可观察的 selectedId / folderId / view / query / zoom / / newIds，触发自动刷新
- **ws.ts**：WebSocket 自动重连 + 复制工具 + KV 拼接 + 格式化
- **测试**：14 个 Vitest 通过（stores / 工具函数）

### 端到端验证

- 启动 `uvicorn app.main:app --port 8765`，sqlite + FTS5 加载正常
- 往监听目录丢 11 张合成 PNG，5 秒内全部入库（5 张 ComfyUI prompt、6 张 live 测试）
- 缩略图生成：合法 PNG 全部 ready；损坏 PNG（如缺 IDAT）thumb_status='failed' 但仍入库
- FTS5 搜索：q=cat → 命中 1 张；q=cyberpunk → 命中 1 张
- 文件夹递归：把图片分配给「人物」子文件夹，筛「灵感」父文件夹可见
- WebSocket 推送：客户端连接 /ws/events，往监听目录丢新文件 → 客户端立即收到 `image_indexed` 事件
- FastAPI 同时托管 Svelte 构建产物（`frontend/dist/`），访问 `/` 返回 SPA index.html

## 与原技术方案的差异

1. **未实现 Tauri / PyInstaller 打包**：当前环境无 Rust 工具链。
   当前为 Web 版（FastAPI 静态托管 Svelte）。打包步骤只需把 `frontend/dist/` 通过 Tauri 的 `distDir` 引用即可，无需改动业务代码。
2. **新增 `GET /api/images/{id}/file`**：原方案用 Tauri 的 `asset://` 自定义协议；Web 版改为 FastAPI `FileResponse`。
3. **WebSocket 路径**：`/ws/events` 替代原方案中的 Tauri IPC 事件流。
4. **缩略图路径**：单一 256px，与原方案 §14 一致。
5. **首版排除项（保持与原方案一致）**：
   - Grid 子图自动拆分（P1）
   - 多选 + 批量操作（P1）
   - AI 自动打标签（P1）
   - 相似图搜索 / 重复图检测（P1）
   - 文件拖拽排序（P2）
   - 暗 / 亮主题切换（P1）
   - 跨设备同步 / 团队协作（P2+）

## 已知限制

- 解析器目前只抽取 ComfyUI `KSampler` 的 `sampler_name`，新版 ComfyUI 出现 `KSamplerAdvanced` / `SamplerCustom` 时启发式可能漏字段。
- WebP 元数据仅支持 EXIF UserComment 路径，XMP `dc:description` 仅作 fallback。
- 数据库在 `data/db.sqlite`（项目根 / backend 下的 `data/`），首次启动会自动建表 + 启用 WAL + FTS5。
- 监听目录变化依赖 watchdog，事件经 300ms 防抖后入库；批量丢图会被合并。

## 后续 TODO（首版不动）

- Tauri 包装（生成 `苏醒图-X.Y.Z_x64-setup.exe`）
- WebView2 bootstrapper 检测
- 多选 / 批量打标签 / 批量移动
- 暗色 / 亮色主题切换
- 缩略图多档（256/512）
- 与 ComfyUI API 双向打通（"找到 → 改参 → 重跑"）
