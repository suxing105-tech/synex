# M3 vite proxy 默认端口修正

## 用户反馈

浏览器 devtools console 报一堆 500：
```
GET http://localhost:5173/api/settings 500
GET http://localhost:5173/api/folders 500
GET http://localhost:5173/api/stats 500
GET http://localhost:5173/api/scan/progress 500
GET http://localhost:5173/api/images?limit=1000 500
```
App.svelte init failed: Error: /api/folders → 500

## 根因

- `frontend/vite.config.ts` 的 proxy 默认指向 **8000**，但 README 与所有 uvicorn 命令都用 **8765**。
- vite 启动时读 `process.env.VITE_BACKEND_PORT || "8000"`，用户没设环境变量 → proxy 到 8000 → 8000 没监听 → vite 上游抛 ECONNREFUSED，浏览器看到 500。
- 这是文档/代码不一致的历史 bug，不影响多选功能本身。

## 修复

`frontend/vite.config.ts`：

```diff
       proxy: {
-        // uvicorn 后端默认 8000 端口。
+        // uvicorn 后端默认 8765 端口（与 README quick-start 一致）。
         // 用环境变量 VITE_BACKEND_PORT 覆盖，便于开发时启用多 uvicorn 实例。
         "/api":    "http://127.0.0.1:" + (process.env.VITE_BACKEND_PORT || "8765"),
         "/thumbs": "http://127.0.0.1:" + (process.env.VITE_BACKEND_PORT || "8765"),
         "/ws":     { target: "ws://127.0.0.1:" + (process.env.VITE_BACKEND_PORT || "8765"), ws: true },
       },
```

3 处都改了（`/api`、`/thumbs`、`/ws`）。

## 验证

- 启动后端：`uvicorn app.main:app --port 8765`（cwd=`backend/`），健康检查 200。
- 用 5174 起一个新 vite 实例验证 proxy → 后端：`GET http://localhost:5174/api/settings` 返回 200。
- 关闭验证用 vite，保留后端 8765 跑着。

## 用户侧还需要做的一步

用户当前的 vite 进程 41732 是在**旧** vite.config.ts（8000）下启动的。要让浏览器不再 500，需要：

```powershell
# 在 frontend/ 目录
Ctrl+C    # 停掉现有 pnpm dev / vite
pnpm dev  # 重启，会读新的 vite.config.ts 默认 8765
```

或者用 `VITE_BACKEND_PORT=8765 pnpm dev` 显式指定。

## 测试

| 套件 | 之前 | 现在 |
|------|------|------|
| frontend vitest | 77/77 | **77/77** |
| vite build | OK | OK |
| proxy → backend (5174 → 8765) | – | 200 |
