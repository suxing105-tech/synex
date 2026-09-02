# 苏醒图库

本目录是一个面向 ComfyUI 用户的轻量级本地图库管理器 MVP。
- 产品设计：`outputs/mvp-product-design.md`
- 技术方案：`outputs/tech-design.md`
- UI 原型：`outputs/demo.html`
- 调研记录：`materials/`

## 本轮实现范围

技术方案原定形态为 Windows 桌面 App（Tauri 2.x + Python sidecar + Svelte）。
当前环境的 Rust 工具链未安装，因此本轮先交付一个**可直接本地运行的 Web 版**
（FastAPI 静态托管 Svelte 构建产物），实现产品设计 P0 全部功能。
后续只要把 `frontend/dist/` 通过 Tauri 的 `distDir` 引用即可完成桌面化打包。

## 目录结构

```
苏醒图库/
├── outputs/                # 设计与原型（产品/技术文档、demo）
├── materials/              # 调研、对比、决策记录
├── backend/                # Python FastAPI 后端
│   ├── app/                # 应用代码
│   ├── tests/              # 单元测试（pytest）
│   └── pyproject.toml
├── frontend/               # Svelte 5 + Vite + Tailwind 前端
│   ├── src/                # 源码
│   └── package.json
└── data/                   # 运行时数据（git ignored）
    ├── db.sqlite
    └── thumbs/
```

## 快速开始

```powershell
# 后端
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
uvicorn app.main:app --reload --host 127.0.0.1 --port 8765

# 前端（另一个终端）
cd frontend
pnpm install
pnpm dev          # 开发模式
# 或构建生产版本供 FastAPI 托管
pnpm build
```
