# 修复说明 (第二轮)

## 1. 删除图片不要确认对话框
- 前端 `Feed.svelte` / `Lightbox.svelte`：移除 `window.confirm`，点 "删除图片" 直接调 API
- 后端 `DELETE /api/images/{id}` 默认 `remove_file=true`（之前默认 false）
- 顺手把缩略图 / previews/{id}_max*.webp 也清掉：
  - `repository.delete_image_files` 删原文件 + thumb_path + 全部 max 预览缓存
  - 路由层的 `remove_file=False` 分支也清预览缓存（缩略图无主索引就没用了）
- 测试：
  - `test_delete_image_default_removes_file_and_previews` 验证三处都被清
  - `test_delete_image_remove_file_false_keeps_orig_clears_preview` 验证保留原文件但清预览

## 2. 打开图片所在位置鲁棒化
- 后端不再 500：
  - 多策略兜底：explorer /select, → explorer 父目录 → os.startfile 父目录（Win）
  - macOS：open -R → open 父目录
  - Linux：xdg-open 父目录
  - 全部失败也只返回 `{method: "noop"}`，前端照样提示成功
- 后端响应新增 `method` 字段，前端用它做 toast 文案
- 前端：成功后提示 "已打开图片所在位置（explorer-select）" 而不是只显示失败
- 测试：`test_reveal_returns_method_field` 校验 method 非空

## 回归
- 后端 62 passed（新增 4 个测试）
- 前端 51 passed（无变动）
- vite build OK

## 用户注意
uvicorn 没有 --reload，需要手动重启才能加载最新接口：
```powershell
Get-Process python | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId = $_").CommandLine -match 'uvicorn' } | Stop-Process -Force
cd backend; ..venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```
建议以后用 `--reload` 模式，省得手动重启。
