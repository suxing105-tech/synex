# 文件夹选择规划依据

日期：2026-09-09。用户要求为导入 ComfyUI 输出目录增加选文件夹功能，当前阶段为规划。

已读取的实际文件：

- frontend/src/components/OnboardingModal.svelte：仅输入路径；startImport 先 PUT 设置，再 POST 扫描；watch_dirs 被设置为单元素数组；chooseSample 填入相对路径。
- frontend/src-tauri/Cargo.toml：Tauri 2，尚未直接依赖 tauri-plugin-dialog。
- frontend/src/lib/tauri.ts：通过 isTauri 和 window.__TAURI__.core.invoke 提供桌面适配。
- backend/app/routes/settings.py：扫描接口检查路径是否存在及是否为目录；设置更新与扫描是分开的调用。
- frontend/src/components/SettingsModal.svelte：已有多个监听目录的维护界面，适合后续复用同一选择器。

官方文档：https://v2.tauri.app/plugin/dialog/

确认：Dialog 提供原生文件系统选择窗口；Windows 支持；文件选择 API 在 Windows 返回文件系统路径；插件支持 Rust 和 JavaScript 使用。建议用 Rust 封装单目录选择，匹配项目现有调用方式。

方案中的新增命令、统一导入接口、校验和测试均为拟实施内容，并非已存在的功能。
