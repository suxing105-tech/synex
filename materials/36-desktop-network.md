# 桌面 API 地址与跨域修复

用户截图：保存监听目录时报 `Unexpected token '<'`，弹窗还提示检查 8000 端口。

本地代码确认：API 使用 fetch('/api/...')，WebSocket 使用 location.host，图片也是相对路径。Tauri 页面来源为 http://tauri.localhost，相对请求进入静态页面服务而非 127.0.0.1:8765 的 sidecar。后端 CORS 列表此前只有 Vite 来源。

处理：增加 backend-url 统一路由，桌面 API、图片及 WebSocket 连接 sidecar；浏览器同源请求保持原地址。后端精确允许 Tauri 来源，更新过时的端口提示，并对 HTML 接口响应返回清晰错误。

验证记录保存于 outputs/desktop-network-fix/。verify_import.py 使用隔离数据和样例图验证最终打包后端，不修改用户图库数据。
