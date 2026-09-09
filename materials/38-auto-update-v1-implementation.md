# 自动更新第一版实现记录

日期：2026-09-09

用户确认先完成本地版本，随后指定 GitHub 仓库 `https://github.com/suxing105-tech/synex.git`。已添加本地 origin；未推送代码、创建 Release 或上传安装包。

## 依据

- Tauri Updater：https://v2.tauri.app/plugin/updater/
- Tauri Single Instance：https://v2.tauri.app/plugin/single-instance/
- 实际依赖源码：tauri-plugin-updater 2.11.0、tauri-plugin-single-instance 2.4.4。
- Updater 的 download 在下载完成后校验 minisign 签名；只有整个调用成功才能进入可安装状态。
- Windows install 在启动 NSIS 后退出当前进程。因此图库必须事先完成备份、退出自有后台并检查端口释放。
- Updater 默认退出钩子会隐藏窗口；本实现自行处理后台退出，并覆盖该钩子，以便启动安装程序失败时保留图库窗口。
- NSIS 安装位置记录在 HKLM/HKCU 的 `Software\Microsoft\Windows\CurrentVersion\Uninstall\苏醒图库`。必须唯一且匹配当前程序位置，才允许应用内安装。

## 本地验证结论

- 前端 298 项通过，后端 177 项通过。
- Rust 单元测试 5 项、真实更新客户端下载测试 1 项通过。
- 独立安装包验签测试 1 项通过：最终安装包与内置公钥匹配；修改文件内容后验签失败。
- 实际打包后台：版本握手、SQLite 一致备份、冻结写入、取消恢复、正常退出、释放端口均通过。
- 实际桌面窗口：加载图库，设置显示 v0.2.0 软件更新；未发布仓库时显示检查失败提示，图库继续可用。
- 重复启动测试：第二次启动退出，主程序数量仍为 1，后台正常。

## 验证范围

本次未向 GitHub 发布，未执行真实 NSIS 覆盖安装、UAC 取消或完整 0.2.0→后续版本升级演练。签名网络路径使用本地隔离发布源验证，安装包使用实际产物验签；不得将这些描述为已经完成线上升级。
