# 苏醒图库

## 桌面 App 快速开始（NSIS 安装包）

```powershell
# 一次性
& "frontend\scripts\build-sidecar.ps1"      # 打包 PyInstaller sidecar（~30s）
cd "frontend\src-tauri"
& cargo tauri build                             # 构建 Tauri + NSIS（约 5 min）
# 产物
#   target\release\suxing-gallery.exe              主程序 4.5 MB
#   target\release\bundle\nsis\苏醒图库_0.1.0_x64-setup.exe  NSIS 安装包 29.6 MB
# 安装 + 启动
& "target\release\bundle\nsis\苏醒图库_0.1.0_x64-setup.exe" /S
& "C:\Program Files\苏醒图库\suxing-gallery.exe"
```

实现细节、决策记录与已知问题见 `materials\29-tauri-m0-delivery.md`。

---



本仓库是面向 ComfyUI 用户的轻量级本地图库管理器 MVP。设计思路见：
- 产品设计：`outputs\mvp-product-design.md`
- 技术方案：`outputs\tech-design.md`
- UI 原型：`outputs\demo.html`
- 调研 / 决策记录：`materials\`

## 本轮交付

- Web 版 + **Tauri 桌面 App 版**（NSIS 安装包）双轨并行。
- 原方案：Tauri 2.x (Rust 壳 + Python sidecar) + Svelte 5 + SQLite/FTS5，仅 Windows。
- Web 版先于桌面版交付（M0 → M2），所有 P0 功能跑 FastAPI + Vite。
- 桌面版 M0 已跑通：NSIS 安装 + sidecar spawn + HTTP API + AppData 持久化；UI 渲染问题留 M0-f。详见 `materials\29-tauri-m0-delivery.md`。

### 已实现的产品 P0 功能

- 文件夹监听导入 + Live 模式（watchdog）
- PNG / WebP 元数据自动解析（手写 tEXt / A1111 / ComfyUI）
- 缩略图生成 + 缓存（Pillow → WebP，256px）
- 三栏布局：文件夹树 / 流式 feed / 详情面板
- 文件夹树管理（嵌套 / 重命名 / 上移下移 / 新建子 / 删除）
- 文件夹递归计数与筛选
- 流式 feed（时间倒序 + NEW 徽标 + 缩放滑块 140~360px）
- 详情面板（Header 缩略图 + 主操作 / Prompt 卡片 / 按域分组的参数 + LoRA 列表 / 元数据 / Workflow JSON；快捷键 P/N/S/Shift+C/F/T/Esc + 列宽可拖拽 + 窄屏抽屉）
- Lightbox 大图查看（双击 / 空格 / ←→）
- 全文搜索（FTS5 + 模糊双轨）
- 标签管理（覆盖式，逗号分隔，自动去重）
- 收藏（♡/♥ 切换 + 左侧系统视图快捷过滤）
- 系统视图（全部图片 / 收藏 / 最近生成）
- Onboarding 引导（首次启动扫描进度）
- 设置页（监听目录 / 缩略图参数 / Live 开关）
- 拖拽导入（拖入 PNG/WebP 到中间缩略图区域 → 自动保存到当前文件夹；不支持格式给出来因）
- ComfyUI 一键打开（hover/选中缩略图右上角出现圆形按钮 → 后端落临时 .json + 自动打开 ComfyUI 标签页）

### 已排除（明确推迟）

- Tauri 打包 / NSIS 安装包（无 Rust 工具链）
- WebView2 bootstrapper（同上）
- Grid 子图拆分入库 / 多选批量操作 / AI 自动打标签 / 相似图搜索 / 重复图检测 / 暗亮主题切换（均为 P1+）

## 目录结构

```
苏醒图库\
├── outputs\                  # 产品 / 技术文档、HTML 原型
├── materials\                # 调研、决策、交付小结
├── backend\                  # Python FastAPI 后端
│   ├── app\                  # 应用代码
│   │   ├── main.py           # FastAPI 入口 + WebSocket
│   │   ├── config.py         # 数据目录 / 配置持久化
│   │   ├── db.py             # SQLite / FTS5 schema + 连接池
│   │   ├── parser.py         # PNG/WebP 元数据解析
│   │   ├── thumbnails.py     # 缩略图生成
│   │   ├── indexer.py        # 扫描 / 监听 / 入库
│   │   ├── repository.py     # 数据查询 / 变更
│   │   ├── events.py         # WebSocket 事件总线
│   │   ├── models.py         # Pydantic 模型
│   │   └── routes\           # REST 路由
│   ├── tests\                # pytest
│   ├── pyproject.toml
│   └── data\                 # 运行时数据（git ignored）
│       ├── db.sqlite
│       ├── thumbs\
│       └── config.json
├── frontend\                 # Svelte 5 + Vite + Tailwind
│   ├── src\
│   │   ├── App.svelte
│   │   ├── main.ts
│   │   ├── app.css
│   │   ├── lib\              # API / stores / ws / types
│   │   ├── components\       # HeaderBar / FolderTree / Feed / DetailPanel / Lightbox / OnboardingModal / SettingsModal / ScanProgressBar
│   │   └── __tests__\        # vitest
│   ├── package.json
│   ├── vite.config.ts
│   └── dist\                 # 构建产物（git ignored，但已能跑）
└── data\                 # 全局数据目录（前端 FastAPI 也用 ./backend/data/）
```

## 快速开始

```powershell
# 后端
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps
pip install -e ".[dev]"

# 测试
pytest -v

# 启动
uvicorn app.main:app --host 127.0.0.1 --port 8765

# 前端（新终端）
cd ..\frontend
pnpm install        # 或 npm install
pnpm dev            # http://localhost:5173（已配置代理到 8765）
# 或构建并由 FastAPI 托管：
pnpm build          # 产物落到 frontend\dist\
                    # 后端再次启动时自动托管
# 然后访问 http://127.0.0.1:8765/
```

第一次访问会自动弹出 Onboarding 引导，输入 ComfyUI 输出目录即可。

## 已通过的测试

- 后端：27 个 pytest（parser / db / feed / api / thumbnails）
- 前端：14 个 vitest（stores / 工具函数）

## API 简表

| 方法 / 路径 | | 说明 |
|------|---|------|
| GET  | | /api/health |
| GET  | | /api/images?folder_id&view&q&tag&model&limit&offset |
| GET  | | /api/images/{id} |
| GET  | | /api/images/{id}/file |
| POST | | /api/images/{id}/favorite |
| POST | | /api/images/{id}/tags |
| POST | | /api/images/{id}/folder |
| DELETE | | /api/images/{id}?remove_file= |
| GET  | | /api/folders |
| POST | | /api/folders |
| PATCH | | /api/folders/{id} |
| POST | | /api/folders/{id}/move?direction=up\|down |
| DELETE | | /api/folders/{id} |
| GET  | | /api/tags |
| GET  | | /api/settings |
| PUT  | | /api/settings |
| POST | | /api/scan |
| GET  | | /api/scan/progress |
| GET  | | /api/stats |
| GET  | | /api/integrations/comfyui/status |
| PUT  | | /api/integrations/comfyui/config |
| POST | | /api/integrations/comfyui/open_workflow/{id} |
| GET  | | /api/integrations/comfyui/temp_files (调试) |
| WS   | | /ws/events |

## 后续路线图

详见 `outputs\tech-design.md` §12 里程碑 + `materials\01-m1-m2-delivery.md`。

