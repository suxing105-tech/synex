# 重启会话记录 (2026-09-03 16:30)

## 操作范围

仅重启开发服务，未改动任何代码 / 数据 / 配置。AGENTS.md 明确不要删除用户没要求删除的内容，因此 backend\data\ 下的 SQLite 数据库 / 缩略图缓存 / config.json 全量保留。

## 操作前状态

- 端口 8765 (uvicorn) 空闲
- 端口 5173 (vite) 空闲
- uvicorn / vite 进程已退出，最后活跃时间约 16:29
- backend\data\db.sqlite 约 57 MB，最近写入 16:23
- config.json 保持：
  ```json
  { "watch_dirs": ["D:\\AI\\ComfyUI_windows_313_v0.16.4\\ComfyUI\\output"],
    "theme": "dark", "live_enabled": true, "scan_workers": 4 }
  ```

## 拉起步骤

1. 后端：直接调用 backend\.venv\Scripts\uvicorn.exe，独立进程，避免依赖 shell PATH。
   - WorkingDirectory: backend
   - RedirOut: uvicorn-out.log    RedirErr: uvicorn-err.log
   - args: app.main:app --host 127.0.0.1 --port 8765 --log-level info
2. 前端：调用 frontend\node_modules\.bin\vite.cmd。首次默认只绑 ::1 导致 127.0.0.1 主动拒绝；改用 --host 127.0.0.1 --port 5173 后正常。
   - WorkingDirectory: frontend
   - RedirOut: vite.log    RedirErr: vite.err
   - args: --host 127.0.0.1 --port 5173

## 验证

| 检查项 | 结果 |
|---|---|
| GET http://127.0.0.1:8765/api/health | 200 {"status":"ok"} |
| GET http://127.0.0.1:5173/ | 200 (433 字节 HTML) |
| GET http://127.0.0.1:5173/api/health (走 vite proxy → uvicorn) | 200 {"status":"ok"} |
| python -c "import app.main" | OK (启动前静态导入校验) |

端口最终占用：

- 127.0.0.1:8765 -> uvicorn
- 127.0.0.1:5173 -> vite (cmd PID 45548, node PID 40812)

## 后续

- 监听目录 D:\AI\ComfyUI_windows_313_v0.16.4\ComfyUI\output 仍在被 watchdog 监控，live_enabled=true 时新增文件会自动入库。
- 用户访问 http://127.0.0.1:5173/ 时仍可能弹出 Onboarding（视会话与 Onboarding 完成标志位而定）。
- vite dev 与 FastAPI 静态托管 frontend\dist\ 同时可用：5173 是 dev 模式（含 HMR），8765 直接访问会看到上一次生产构建。

## 未做（避免越权）

- 未删除任何数据库 / 缩略图 / config。
- 未重跑后端 27 个 pytest / 前端 14 个 vitest（无代码改动）。
- 未创建 git commit（无文件级改动）。
