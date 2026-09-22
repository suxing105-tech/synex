// 闪寻空间 Seek-X — Tauri 主进程入口
//
// 仅承担：
//   - spawn PyInstaller sidecar（python-backend.exe）
//   - 把 sidecar 的生命周期事件透传给前端 WebView
//   - 暴露若干 Tauri command 给前端 invoke
//
// 业务 HTTP（/api/*、/thumbs/*、/ws）由 sidecar 在 127.0.0.1:8765 提供，
// 前端继续走 HTTP，与 Web 版（FastAPI 静态托管）一致。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    suxing_gallery_lib::run();
}
