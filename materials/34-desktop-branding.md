# 桌面品牌调整依据

- 用户提供 Logo：`C:\Users\Administrator\Desktop\苏醒logo\suxing-logo.png`。
- 原文件 SHA256：`1d256ba212906831a8a54785168687562475a409ade4365faac8b24e9008d075`。
- 原图直接复制为 `frontend/public/logo.png`，使用项目已安装的 `cargo tauri icon` 生成桌面和安装图标。
- 本地 Tauri 2.11.5 / tauri-utils 2.9.3 支持窗口 `theme` 与 `backgroundColor` 配置。固定 Dark 主题，让 Windows 原生标题栏使用系统深灰色；保留原生窗口控制和拖动行为。
- Tauri 官方窗口参考：https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html
- 生成图标及构建、测试记录：`outputs/desktop-branding/`。
