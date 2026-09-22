# MEMORY.md

## 项目
- 项目名：闪寻空间 (Seek-X)（目录名仍为 苏醒图库）
- 定位：面向 ComfyUI 用户的本地图片 + 视频媒体管理器
- 技术栈：Tauri 2 (Rust 壳) + Python FastAPI sidecar + Svelte 5 + SQLite/FTS5；Windows；视频用本地 ffmpeg/ffprobe

## 关键决策 / 踩坑
- 应用已从「苏醒图库」更名「闪寻空间 (Seek-X)」，但保留 `com.suxing.gallery` 标识，保证数据目录与自动更新通道不变。
- 图片与视频共用 `images` 表，WebView 内可播 `mp4/mov/m4v/webm`，其余走系统播放器。
- 发布流程：`frontend/scripts/build-update.ps1` 用签名私钥产出签名安装包 + `.sig` + `latest.json`，再上传 GitHub Release `v<version>`。
- 更新签名私钥位置：`outputs/auto-update-v1/private/updater.key`（不要读取/上传其内容）。
- 发布脚本用 `git credential fill` 取 GitHub 凭据（不打印）。
- README 配图存放于 `docs/images/`（仓库内），主图 `main.png` 为用户提供。

## 资源位置
- 远程仓库：https://github.com/suxing105-tech/synex
- 主要分支：`codex/tauri-app`（工作分支），`main`（正式）
- 版本号：0.2.6