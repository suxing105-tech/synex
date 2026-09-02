# 实施决策记录（M0 落地）

> 与 `outputs/tech-design.md` 同步更新。本文件只记录**本轮实际落地**的关键决策与原方案的差异。

## M0 — 2026-09-02

### 1. 形态取舍：先 Web 后桌面

- 原方案：Tauri 2.x（Rust 壳 + Python sidecar）+ Svelte，仅 Windows。
- 本环境：未安装 Rust / Cargo，无法 `cargo tauri build`。
- 决策：**本轮先交付 Web 版**（FastAPI 静态托管 Svelte 构建产物）。
  - 所有 P0 功能均可在 Web 版中验证。
  - 后续切桌面版只需把 `frontend/dist/` 喂给 Tauri 的 `distDir`，sidecar 用同一份 Python 代码（PyInstaller 打包即可）。
- 影响：
  - 失去：原生窗口、原生文件对话框、原图 asset 协议、NSIS 安装包。
  - 仍保留：所有数据层能力（SQLite/FTS5/watchdog/thumbnails）、所有前端交互、所有 P0 功能。

### 2. Python 版本：3.14

- 环境为 Python 3.14.6（较新）。
- `sqlite3`、`watchdog`、`Pillow`、`fastapi`、`uvicorn`、`websockets` 全部支持 3.14。
- 决策：最低支持版本定 `>=3.11`（与原方案一致），本地用 3.14 跑。

### 3. SQLite / FTS5

- Python 3.14 自带 `sqlite3`，且 `compile_options` 通常包含 `FTS5`。
- 决策：直接用内置 sqlite3 + `FTS5` 虚拟表，零额外依赖。
- 验证：启动时打印 `sqlite_version()` 与 `enable_fts5` 标志到启动日志。

### 4. 缩略图实现

- 原方案：`libvips` 或 `Pillow`。
- 决策：用 **Pillow**。Python 生态更友好、ComfyUI 用户本就熟悉，且 wheel 体积可控。

### 5. 前端构建工具

- Vite 5 + Svelte 5 + TailwindCSS 3。
- 选 pnpm（环境已有）作为包管理器。
- 静态构建产物直接由 FastAPI 的 `StaticFiles` 托管到 `/`。

### 6. WebSocket 推送

- 后端用 `websockets`（已合并进 FastAPI 生态）做实时事件：扫描进度、新图入库、缩略图就绪、文件变更。
- 前端用原生 `WebSocket` 订阅，避免再引入 `socket.io` 这类客户端。

### 7. 监听实现

- 用 `watchdog.observers.Observer` 起后台线程。
- 事件统一进 `asyncio.Queue` 串行处理，写库单线程避免 SQLite 写锁争用。
- 首次扫描用 `Path.rglob` + `concurrent.futures.ThreadPoolExecutor`（4 worker）批量解析。

### 8. 元数据解析

- PNG：手写 `tEXt` chunk 解码器（PNG spec 简单），不依赖 PIL。
- WebP：手写 RIFF + EXIF/XMP 解析最小集。
- ComfyUI 的 prompt JSON 统一从 `tEXt` chunk（key=`prompt`）抽正向反向，参数从 `prompt` JSON 的 `KSampler` 节点 + `workflow` chunk 抽。
- 后续可替换为更鲁棒的解析器（PIL/Pillow 已有 `Image.info`），但 MVP 走零依赖方案以便单文件打包。

### 9. 数据目录

- 运行时数据统一放 `<cwd>/data/`（git ignored），由后端启动时创建。
- 配置（监听目录、缩略图尺寸）持久化为 `data/config.json`。

### 10. 暂不做的事

- Tauri 打包 / NSIS 安装包（环境无 Rust）。
- WebView2 bootstrapper（同上）。
- 相似图搜索 / 重复图检测 / 自动打标签（P1+）。
- 暗 / 亮主题切换（P1，仅暗色）。
- 多选 / 批量操作（P1）。
- 文件夹拖拽排序（P1，目前用上 / 下移按钮）。

