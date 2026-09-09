# 项目梳理依据

日期：2026-09-09；基线 d564492。

已读取 README、Git 状态和近期提交、frontend/package.json、vite.config.ts、Tauri 配置、api.ts、backend-url.ts、tauri.ts、Rust lib.rs/sidecar.rs、PyInstaller spec、后端 config.py/db.py/图片路由、demo.html 和最近交付说明及日志。

核心证据：Tauri 配置 frontendDist=../dist 且构建调用 pnpm build；PyInstaller ENTRY=backend/run_server.py；backend-url.ts 按 isTauri 区分 API 地址；demo 使用 makeSvg/makeImg 和页面 state。由此判断正式 Web/APP 共享业务源码，独立 HTML 原型不在此构建链中。

核对 outputs/folder-picker-v1 文件列表：安装包及 .sig 存在。历史日志为 189 个后端、304 个前端测试通过。交付说明记载未上传 GitHub、未覆盖安装；本次未查询线上和已安装状态。

本次仅新增梳理文档和对应证据校验脚本。验证范围为报告依赖的路径、版本及共享构建入口，不代表重新验证全部业务。既存未跟踪文件不纳入提交。
