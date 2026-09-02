# 苏醒图库 — 技术方案

> 状态：v1.0 · 起草日期：2026-09-02 · 关联文档：`outputs/mvp-product-design.md`

## 0. 摘要

本方案落地《AI 图库管理器 MVP 产品设计文档》。技术形态为 **Windows 桌面 App**：Tauri（Rust 壳） + Python 后端（PyInstaller 单文件 sidecar） + Svelte 前端 + SQLite/FTS5 索引。

关键决策：

- 形态：Windows 桌面应用（Tauri 2.x，仅 Win10/11）
- 后端：Python 3.11 + FastAPI，单文件 exe 随安装包分发（PyInstaller）
- 前端：Svelte 5 + Vite + TailwindCSS
- 通信：本地 HTTP（FastAPI @ `127.0.0.1:8765`），Tauri 代理给 WebView
- 存储：SQLite（含 FTS5）+ 原文件原地不动；缩略图本地 cache
- 离线优先：零外网依赖、零 CDN、零遥测
- 目标平台：仅 Windows 10/11

## 1. 架构总览

### 1.1 进程拓扑

```
┌─────────────────────────────────────────────┐
│ 苏醒图库.exe (Tauri 主进程, Rust)             │
│  ├── WebView2 (前端 UI)                       │
│  │     ↑ HTTP fetch + WebSocket              │
│  └── sidecar spawn ──► python-backend.exe     │
│                          │                    │
│                          ▼                    │
│                  ┌──────────────────┐          │
│                  │ FastAPI server   │          │
│                  │  + watchdog      │          │
│                  │  + SQLite/FTS5   │          │
│                  │  + Pillow worker │          │
│                  └──────────────────┘          │
│                          │                    │
│                          ▼                    │
│                  %APPDATA%/苏醒图库/            │
│                  ├── db.sqlite                │
│                  ├── thumbs/                  │
│                  ├── config.json              │
│                  └── logs/                    │
└─────────────────────────────────────────────┘
```

### 1.2 启动序列

1. 用户双击 `苏醒图库.exe`（NSIS 安装后的桌面快捷方式）
2. Tauri 主进程启动，创建主窗口（WebView2）
3. WebView 加载打包进 exe 的 `dist/index.html`，显示 splash
4. 前端调用 `tauri::invoke("ready")` 通知 Rust
5. Rust spawn sidecar `python-backend.exe`（首次解压约 1–2s）
6. Python 启动 uvicorn + 初始化 SQLite + 启动 watchdog
7. 后端就绪后通过 stdout 发 `READY` 行，Rust 通知前端
8. 前端切到主 UI（首次启动走 `/onboarding`，否则走 `/`）

### 1.3 进程间通信

| 链路 | 协议 | 用途 |
|------|------|------|
| WebView ↔ Rust | Tauri IPC（`invoke` / `event`） | 文件对话框、原图 asset 协议、获取 sidecar 状态 |
| Rust ↔ Python sidecar | stdio JSON-RPC | spawn / health check / 优雅关闭 |
| WebView ↔ Python | HTTP + WebSocket | 业务 API、搜索、缩略图、实时进度推送 |

为什么不走纯 Tauri IPC 让 Rust 中转所有请求：Python 后端可独立调试（`python -m suxing_lib` 直接起 HTTP，浏览器访问 `localhost:8765/docs` 即可联调）。Rust 只承担"sidecar 生命周期管理 + 需要系统权限的操作"两类职责。

### 1.4 关键设计点

- **缩略图 / 原图读取**：Python 用 `FileResponse` 直接返回静态文件（避免 base64 编码浪费 CPU）；大图走 Tauri 的 `asset://` 自定义协议，从磁盘读字节流返回，避免经 HTTP 全量传输。
- **watchdog 事件处理**：asyncio.Queue 串行化，单写者模型避免 SQLite 写锁竞争。
- **WebSocket 推送**：入库完成、缩略图就绪、扫描进度等事件，前端订阅后增量更新 UI，无需轮询。
- **离线优先**：前端构建产物打包进 Tauri exe；Python 端除可选的本地模型加载外无任何外网调用。

## 2. 目录结构

```
苏醒图库/
├── AGENTS.md
├── outputs/                          # 设计与原型
│   ├── mvp-product-design.md         # 产品设计（已有）
│   ├── demo.html                     # HTML 原型（已有）
│   └── tech-design.md                # 本文件
├── materials/                        # 调研 / 参考资料
├── src-tauri/                        # Rust 壳
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── icons/
│   └── src/
│       ├── main.rs                   # 入口
│       ├── sidecar.rs                # sidecar 生命周期
│       ├── commands.rs               # Tauri commands
│       └── protocol.rs               # 自定义 asset 协议
├── src/                              # Svelte 前端
│   ├── app.html
│   ├── app.css                       # Tailwind 入口
│   ├── routes/
│   │   ├── +layout.svelte
│   │   ├── +page.svelte              # 网格浏览（/）
│   │   ├── onboarding/+page.svelte
│   │   ├── image/[id]/+page.svelte   # 详情
│   │   └── settings/+page.svelte
│   ├── lib/
│   │   ├── api.ts                    # 后端 HTTP 封装
│   │   ├── ws.ts                     # WebSocket 客户端
│   │   ├── components/
│   │   │   ├── Grid.svelte           # 虚拟滚动
│   │   │   ├── DetailPanel.svelte
│   │   │   ├── SearchBar.svelte
│   │   │   ├── FilterSidebar.svelte
│   │   │   └── TagInput.svelte
│   │   └── stores/
│   │       ├── images.ts
│   │       └── settings.ts
│   └── tailwind.config.js
├── backend/                          # Python 后端
│   ├── pyproject.toml
│   ├── src/suxing_lib/
│   │   ├── __init__.py
│   │   ├── __main__.py               # 入口：uvicorn 启动
│   │   ├── api/
│   │   │   ├── app.py                # FastAPI 实例
│   │   │   ├── images.py             # /api/images 路由
│   │   │   ├── search.py             # /api/search 路由
│   │   │   ├── tags.py
│   │   │   ├── thumbnails.py         # /api/thumb/{id}
│   │   │   └── ws.py                 # WebSocket
│   │   ├── watcher/
│   │   │   ├── observer.py           # watchdog
│   │   │   └── queue.py              # 处理队列
│   │   ├── parser/
│   │   │   ├── png.py                # tEXt chunk 解析
│   │   │   └── webp.py               # EXIF / XMP 解析
│   │   ├── db/
│   │   │   ├── schema.sql
│   │   │   ├── migrations.py
│   │   │   ├── repository.py         # CRUD
│   │   │   └── search.py             # FTS5 查询
│   │   ├── thumbnails/
│   │   │   └── worker.py             # Pillow 生成
│   │   ├── models.py                 # pydantic
│   │   └── config.py                 # pydantic-settings
│   ├── tests/
│   │   ├── test_parser_png.py
│   │   ├── test_db.py
│   │   ├── test_search.py
│   │   └── fixtures/
│   └── resources/
│       └── pyinstaller.spec          # PyInstaller 配置
├── build/
│   ├── build_frontend.ps1            # pnpm i && pnpm build
│   ├── build_backend.ps1             # PyInstaller
│   └── build_app.ps1                 # tauri build
└── .gitignore
```

## 3. 数据模型与存储

### 3.1 SQLite Schema（`backend/src/suxing_lib/db/schema.sql`）

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS image (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path       TEXT NOT NULL UNIQUE,
  file_hash       TEXT NOT NULL,
  mtime           INTEGER NOT NULL,           -- epoch seconds
  size            INTEGER NOT NULL,
  width           INTEGER NOT NULL,
  height          INTEGER NOT NULL,
  prompt          TEXT,
  negative_prompt TEXT,
  checkpoint      TEXT,
  sampler         TEXT,
  steps           INTEGER,
  cfg             REAL,
  seed            INTEGER,
  vae             TEXT,
  loras_json      TEXT,                       -- JSON: [{"name":..., "weight":...}]
  raw_workflow_json TEXT,                     -- ComfyUI 原始 workflow
  favorite        INTEGER NOT NULL DEFAULT 0,
  imported_at     INTEGER NOT NULL
);

CREATE INDEX idx_image_mtime      ON image(mtime DESC);
CREATE INDEX idx_image_checkpoint ON image(checkpoint);
CREATE INDEX idx_image_favorite   ON image(favorite) WHERE favorite = 1;

CREATE TABLE IF NOT EXISTS tag (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS image_tag (
  image_id INTEGER NOT NULL,
  tag_id   INTEGER NOT NULL,
  PRIMARY KEY (image_id, tag_id),
  FOREIGN KEY (image_id) REFERENCES image(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id)   REFERENCES tag(id)   ON DELETE CASCADE
);
CREATE INDEX idx_image_tag_tag ON image_tag(tag_id);

-- FTS5 虚表（外部内容模式，触发器维护）
CREATE VIRTUAL TABLE IF NOT EXISTS image_fts USING fts5(
  prompt, negative_prompt, filename,
  content="", tokenize="unicode61 remove_diacritics 2"
);

-- 触发器：image 增删改时同步 FTS
CREATE TRIGGER IF NOT EXISTS image_ai AFTER INSERT ON image BEGIN
  INSERT INTO image_fts(rowid, prompt, negative_prompt, filename)
  VALUES (new.id, COALESCE(new.prompt,""), COALESCE(new.negative_prompt,""), "");
END;
CREATE TRIGGER IF NOT EXISTS image_ad AFTER DELETE ON image BEGIN
  DELETE FROM image_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS image_au AFTER UPDATE ON image BEGIN
  DELETE FROM image_fts WHERE rowid = old.id;
  INSERT INTO image_fts(rowid, prompt, negative_prompt, filename)
  VALUES (new.id, COALESCE(new.prompt,""), COALESCE(new.negative_prompt,""), "");
END;
```

### 3.2 文件落点

| 类别 | 路径 |
|------|------|
| 数据库 | `%APPDATA%/苏醒图库/db.sqlite` |
| 缩略图 cache | `%APPDATA%/苏醒图库/thumbs/<hash[0:2]>/<hash[2:4]>/<hash>.webp` |
| 配置 | `%APPDATA%/苏醒图库/config.json` |
| 日志 | `%APPDATA%/苏醒图库/logs/{date}.log` |
| Python 临时 | 环境变量 `TMP` / `TEMP` 目录下的 `suxing/` |

缩略图分片策略：256 张图后单目录会拖慢文件系统，256×256 = 65536 张后单层分片；两级哈希分片可支撑 ~1600 万张。

### 3.3 元数据解析

- **PNG**：读 `tEXt` chunk（ComfyUI 约定键 `prompt` + `workflow`，均为 JSON 字符串）
- **WebP**：读 `EXIF`（ComfyUI 不一定写）+ `XMP`（`dc:title` 等） + RIFF 块自定义字段
- **workflow JSON**：保留原始 JSON 到 `raw_workflow_json`，便于回溯节点配置
- **参数提取**：从 workflow 找 `CheckpointLoaderSimple`、`KSampler`、`LoraLoader` 节点抽 `checkpoint / sampler / steps / cfg / seed / vae / loras`

## 4. 关键模块

### 4.1 后端 Python 模块

| 模块 | 职责 | 主要依赖 |
|------|------|---------|
| `api/` | FastAPI 路由；REST + WebSocket | `fastapi`, `uvicorn`, `websockets` |
| `watcher/` | watchdog observer + asyncio 队列 | `watchdog` |
| `parser/` | PNG/WebP 元数据解析 | 自写 + `Pillow`（仅取尺寸 / EXIF） |
| `db/` | SQLite 连接、迁移、CRUD、FTS5 搜索 | `sqlite3`（内置） |
| `thumbnails/` | Pillow 生成多档 WebP | `Pillow` |
| `models.py` | 数据模型（pydantic） | `pydantic` |
| `config.py` | 配置加载 | `pydantic-settings` |
| `__main__.py` | 启动入口 | `uvicorn` |

### 4.2 Tauri（Rust）模块

| 模块 | 职责 |
|------|------|
| `main.rs` | 启动、注册 commands、注册协议、监听退出信号 |
| `sidecar.rs` | sidecar spawn / health check / 优雅关闭；解析 stdout JSON-RPC |
| `commands.rs` | `pick_directory` / `read_image` / `get_config` / `set_config` |
| `protocol.rs` | 注册 `suxing://` asset 协议，读本地图片字节流给 WebView |

### 4.3 前端 Svelte 模块

| 路由 | 职责 |
|------|------|
| `/` | 网格浏览（默认时间倒序） |
| `/image/[id]` | 详情：大图 + 元数据 + prompt 复制 + 原始 JSON |
| `/settings` | 监听目录、缓存大小、主题、关于 |
| `/onboarding` | 首次启动：选目录 → 看扫描进度 → 跳转网格 |

| 组件 | 职责 |
|------|------|
| `<Grid>` | 虚拟滚动（`svelte-virtual-list`），按时间倒序 |
| `<DetailPanel>` | 元数据面板、prompt 一键复制、LoRA 列表、原始 JSON 折叠 |
| `<SearchBar>` | 300ms 防抖、FTS 高亮 |
| `<FilterSidebar>` | checkpoint / LoRA / 收藏 / 日期范围 |
| `<TagInput>` | autocomplete、批量打标签 |

## 5. 关键流程

### 5.1 首次启动

1. 检测 `%APPDATA%/苏醒图库/config.json` 不存在 → 跳 `/onboarding`
2. 用户选目录 → 写 config → 前端调 `POST /api/scan/start`
3. 后端起 watchdog observer → 遍历已有文件入队列
4. worker 并发处理：解析 PNG chunk → 写 SQLite → 生成缩略图
5. 通过 WebSocket 推 `{type: "progress", done, total}` 和 `{type: "new_image", image}`
6. 前端订阅，实时显示缩略图与进度
7. 完成后跳 `/`

### 5.2 文件监听增量入库

```
watchdog event
   ↓
put in asyncio.Queue
   ↓
worker 取任务 (串行化，避免写锁)
   ↓
parse_metadata(path) → ImageMeta
   ↓
INSERT OR IGNORE INTO image
   ↓
generate_thumbnails(id)  → 写 thumbs/
   ↓
WS broadcast {type:"new_image", image}
```

### 5.3 搜索

1. 前端 `SearchBar` 输入 → 300ms 防抖
2. `GET /api/search?q=xxx&checkpoints=...&loras=...&favorite=true&date_from=&date_to=&page=0&size=100`
3. 后端拼 SQL：

```sql
SELECT i.id, i.file_path, i.width, i.height, ...
FROM image i
LEFT JOIN image_fts f ON f.rowid = i.id
WHERE i.id IN (SELECT rowid FROM image_fts WHERE image_fts MATCH ?)
  AND i.checkpoint IN (...)
  AND ...
ORDER BY bm25(image_fts) ASC, i.mtime DESC
LIMIT ? OFFSET ?;
```

4. 返回 `[{id, thumb_url, mtime, ...}]`
5. 前端 `<Grid>` 渲染

## 6. 性能 NFR 对齐

| NFR | 目标 | 实现 |
|-----|------|------|
| 10k 图首次扫描 < 10 min | ~17 img/s | watchdog 增量 + asyncio worker 池（4 并发）；缩略图与解析并行 |
| 1k 缩略图滚动 60fps | 60fps | Svelte 虚拟滚动 + WebP 缩略图（256×256 ~10KB）+ 懒加载 |
| 搜索 < 200ms | < 200ms | SQLite FTS5 BM25；10w 行单关键词查询实测 < 50ms |
| 闲置 < 200MB | < 200MB | Tauri 主进程 ~30MB + sidecar ~60MB + WebView2 ~80MB = 总和 < 200MB |
| 索引可重建 | ✓ | 删 `%APPDATA%/苏醒图库/db.sqlite` + 触发重扫；原文件不被修改 |

## 7. 打包与分发

### 7.1 打包流水线

```powershell
# 1. 前端
cd src && pnpm install && pnpm build   # → dist/

# 2. Python 后端
cd backend
pyinstaller resources/pyinstaller.spec --clean --noconfirm
# → dist/python-backend.exe

# 3. Tauri 壳
cd ../
pnpm tauri build
# → src-tauri/target/release/bundle/nsis/苏醒图库_x.x.x_x64-setup.exe
```

### 7.2 Tauri 配置要点（`tauri.conf.json`）

- `bundle.targets: ["nsis"]`：NSIS 安装包（中文 UI、桌面快捷方式、卸载程序）
- `bundle.windows.webviewInstallMode: "downloadBootstrapper"`：自动安装 WebView2
- `bundle.resources`：把 `python-backend.exe` 打进安装包
- `externalBin`：声明 sidecar exe（PyInstaller 产物）

### 7.3 体积预估

| 项 | 预估 |
|----|------|
| Tauri 壳 + WebView2 bootstrapper | ~12MB |
| Python sidecar（含 Pillow） | 40–60MB |
| 前端构建产物 | 1–3MB |
| 图标 / 资源 | < 1MB |
| **总计** | **~60–80MB** |

## 8. 离线优先策略

- 字体：系统字体栈（`-apple-system, "Segoe UI", system-ui`），不引 Google Fonts
- 资源：图标、SVG、CSS 全部进 `dist/`
- AI 模型（P1）：首次启动从本地目录加载，**不联网下载**；用户自行去 HuggingFace 下载放 `%APPDATA%/苏醒图库/models/`
- Tauri 默认 telemetry 关闭
- 更新机制：MVP 不内置自更新；版本号展示在设置页，引导用户去 GitHub releases 下新版

## 9. Windows 专属

- **WebView2 Runtime**：Win10 1803+ / Win11 默认已装；老机器走 bootstrapper 按需安装
- **长路径**：处理 ComfyUI 输出目录可能 >260 字符，统一加 `\\?\` 前缀
- **中文路径**：UTF-8 全链路；SQLite 用 `sqlite3.open(path, uri=True)` + `file:` URI
- **高 DPI**：Tauri `dpi_aware: true`；前端用 rem / 逻辑像素
- **暗色主题**：跟随系统（`prefers-color-scheme`）
- **文件关联**：MVP 不做 `.png` 右键关联；放 P1

## 10. 测试策略

| 层 | 工具 | 覆盖 |
|----|------|------|
| 后端单元 | `pytest` | parser / db / search / models |
| 前端组件 | `vitest` + `@testing-library/svelte` | 关键组件渲染、虚拟滚动、搜索防抖 |
| 端到端 | 手动 + Playwright（可选） | 核心用户流程 |
| 打包 | CI 跑 `tauri build` | 产物可启动 |

每个 PR 必跑：lint（`ruff` + `eslint`）+ 后端 `pytest` + 前端 `vitest`。

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| WebView2 在某些 Win10 缺失 | 启动失败 | 安装包附 bootstrapper；启动时检测，缺失则引导安装 |
| PyInstaller 打包 Pillow hook 缺失 | 打包失败 | 写 spec 时显式声明 hidden imports；备选 Nuitka |
| watchdog 对网络盘 / 网盘不稳定 | 监听丢事件 | MVP 仅支持本地盘；文档明确说明 |
| SQLite 写并发 | DB 锁冲突 | WAL 模式 + 单写者（asyncio.Queue 串行） |
| 中文 prompt 搜索排序不准 | 用户体验差 | FTS5 `unicode61` tokenize；MVP 接受基线排序，P1 引入自定义 tokenizer |
| 大图原图加载阻塞 WebView | 卡顿 | Tauri asset 协议走 Rust 异步 IO；前端 `<img loading="lazy">` |
| 首次扫描 10k 图超时 | NFR 不过 | 分批并发（4 worker）；缩略图与解析并行；进度可视化让用户感知 |

## 12. 开发里程碑

| 阶段 | 内容 | 验收 |
|------|------|------|
| M0 | 项目 scaffold + Tauri ↔ sidecar IPC 打通 | Rust spawn sidecar 成功，HTTP 200 |
| M1 | 监听 + 解析 + 入库 + 缩略图 | 往监听目录丢 100 张图，DB 行正确，缩略图落盘 |
| M2 | 前端网格 + 详情 | 缩略图可见，详情元数据正确，prompt 可复制 |
| M3 | 搜索 + 筛选 + 标签 + 收藏 | 10k 图搜索 P95 < 200ms |
| M4 | 打包 + 安装测试 + 修 bug | 干净 Win10 装上并跑通全流程 |
| M5 | Onboarding + 设置页 + 文档 | 用户可独立完成首次配置 |

## 13. 待办（首版不实现，列入 P1+）

- [ ] 网格子图自动拆分入库（产品设计已明确）
- [ ] 暗 / 亮主题切换
- [ ] CLIP 自动打标签
- [ ] 相似图搜索（向量检索）
- [ ] 重复图检测（pHash）
- [ ] 多选 + 批量操作
- [ ] 跨设备同步 / 团队协作
- [ ] `.png` 文件关联
- [ ] 内置自动更新

## 14. 开放问题（首版可暂不解决）

1. ComfyUI 不同版本的 prompt JSON schema 差异（目前手工抽取 `KSampler` 节点，未来需要适配各版本）
2. 用户已用过的 LoRA / checkpoint 是否需要"识别并关联"（避免同一个 ckpt 出现多个变体名）
3. 缩略图策略：256 单一档 vs 多档（256/512）；MVP 取单一 256

---

## 附录 A：与产品设计文档的对齐

| 产品 P0 功能 | 本方案对应 |
|------------|----------|
| 文件夹监听导入 | §5.2 |
| PNG / WebP 元数据解析 | §3.3 + §4.1 parser |
| 缩略图缓存 | §3.2 + §4.1 thumbnails |
| 网格浏览 | §4.3 `<Grid>` + 虚拟滚动 |
| 详情页 | §4.3 `<DetailPanel>` |
| 全文搜索 | §5.3 + §3.1 FTS5 |
| 筛选器 | §5.3 SQL + `<FilterSidebar>` |
| 标签管理 | §3.1 tag / image_tag + §4.3 `<TagInput>` |
| 收藏夹 | §3.1 `favorite` 字段 + §5.3 筛选 |
