# 调研记录

## 文件结构
- frontend/src/components/Feed.svelte: 瀑布流 + 缩略图按钮（onclick 选中，ondblclick 开 Lightbox）
- frontend/src/components/Lightbox.svelte: 大图查看，左右切换
- frontend/src/components/DetailPanel.svelte: 右侧详情面板
- frontend/src/lib/api.ts: 集中 fetch 封装
- frontend/src/lib/ws.ts: 工具 + WS

## 现有 API
- DELETE /api/images/{id}?remove_file=true|false (frontend: imagesApi.remove)
- 已有 PATCH /api/images/{id}/favorite, /tags, /folder

## images 表 schema (relevant columns)
- id INTEGER PK
- path TEXT NOT NULL UNIQUE   <- 绝对路径
- filename TEXT NOT NULL      <- 仅文件名
- mtime REAL                  <- 用于 cache bust

## 重命名策略
- 仅允许改 filename（不含路径分隔符 / 盘符）
- 保留扩展名（用户可改，但必须保留原扩展名以保持 MIME）
  -> 简化：保留后缀不变，只改 stem；或允许改整名但扩展名被剥离后强制还原
  -> 决策：保留后缀，新文件名可任意（带不带后缀都行，最终都规范化为带原后缀）
- path = parent_dir / new_filename, mtime = stat.st_mtime

## 打开文件管理器
- Windows: explorer.exe /select,"C:pathile.png"
- macOS:   open -R "/path/file.png"
- Linux:   xdg-open /path/to/dir/  (无 select 文件的标准 API，部分 FM 支持 --select)

使用 subprocess.run 异步 + 错误兜底（失败不抛 500，返回 ok=false 让前端提示）。
