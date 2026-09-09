# 自动更新规划依据

日期：2026-09-09。

## 项目证据

已读 tauri.conf.json、Cargo.toml、lib.rs、sidecar.rs、commands.rs、capabilities/default.json、backend/app/config.py、frontend/package.json。

当前版本 0.1.0；产品标识 com.suxing.gallery；NSIS perMachine；固定 8765；无 updater/single-instance 依赖；restart_sidecar 仅停止后端；生产数据使用 app_data_dir()/data。

此前已实际观察到 C:\Program Files 下孤儿后端与 D:\苏醒图库主程序冲突，因此计划把旧安装识别与可靠停止列为先决任务。此次规划未改变运行进程或安装状态。

## 官方资料

- https://v2.tauri.app/plugin/updater/ ：签名验证、更新产物、HTTPS 入口、静态清单、Windows 安装模式。当前文档要求 Rust 至少 1.77.2，实施时应与锁定插件版本核对。
- https://v2.tauri.app/distribute/pipelines/github/ ：GitHub Actions 发行流程。
- https://v2.tauri.app/plugin/single-instance/ ：单实例插件需先于其他插件注册，可唤起已运行窗口。
- https://v2.tauri.app/distribute/windows-installer/ ：Windows 安装与分发方式。

方案内的更新检查周期、状态机、发布阶段、备份恢复策略属于针对本项目的设计建议，不代表框架自动提供这些行为。仓库、更新域名、密钥和测试机尚未确定。
