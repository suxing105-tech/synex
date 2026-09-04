# ComfyUI 一键打开工作流 — 交付记录 (2026-09-04)

## 目标

缩略图右上角出现圆形按钮 → 点击后把当前图片的 ComfyUI workflow 送到本机 ComfyUI 编辑器（不执行）。

约束：
- 仅当本机 ComfyUI 在跑（探测 `system_stats` 200）才显示按钮
- 仅当图片有 workflow 才显示
- 不引入 ComfyUI 扩展/插件
- 不执行 workflow（用户明确要"打开"，不是"重跑"）

## 关键设计决策

### 「打开」具体语义

ComfyUI 没有官方「加载但不执行」的 HTTP API。本轮采用 A 方案：

- 后端把 workflow JSON 落到 `data/comfyui_temp/<id>.json`
- 后端 `webbrowser.open(comfyui_url)` 弹 ComfyUI 标签页
- toast 反馈完整文件路径 + 拖入提示

放弃的原因：
- B（POST /prompt）：会真出图、占显存，违反用户语义
- C/D（写 ComfyUI 扩展 / postMessage）：改动 ComfyUI，超出本仓库范围

### 按钮可见性

仅在 `comfyuiStatus.running && image.has_workflow && (hovered || selected || multiSelected)` 时显示。

理由：与 ♥ 同位（top-1 right-1），常驻会互相挤；hover/选中时浮起更克制。

### 嵌套 button 的坑

第一版用 `<button>` 包 `<button>`，HTML 规范禁止。Chrome 会把内层 click 上交给外层 thumb，`e.stopPropagation()` 救不回来（event delegation 行为）。

改用 `<div role="button" tabindex="-1">` 包 Icon，点击靠 `onclick` + `onmousedown` 都 `stopPropagation()`。

### 探测方式

`urllib.request` 顺序试 `/system_stats`、`/` 任一 200 即视为在跑。

标准库，零新依赖。1.5s 超时。

### 配置位置

`data/config.json` 加 `comfyui_url` / `comfyui_enabled` 两个键。`Config` dataclass 加字段，`Config.load()` 的「仅取已声明键」天然兼容旧 config。

前端 SettingsModal 加 "ComfyUI 集成" 区块：URL 输入 + 启用开关 + 重新探测 + 状态点（绿/红/灰）。

### 前端轮询

`App.svelte` `onMount`：调一次 `status()`，之后每 30s 轮询；`document.visibilitychange` 切回时立刻探一次。失败 `running=false`，不报错。

### `has_workflow` 字段下沉到 feed

之前只有 `ImageDetail`（detail API）有 `workflow` 字段，feed 不知道哪些图有 workflow。

改 `_row_to_summary` 用 `bool(row["workflow"])` 派生 `has_workflow`，feed 直接拿到，避免 hover 时再去打 detail API。

## 实施步骤（实际）

1. 后端
   - `backend/app/integrations/{__init__,comfyui}.py`：probe + write_workflow_temp
   - `backend/app/config.py`：加 `comfyui_url` / `comfyui_enabled`
   - `backend/app/models.py`：`ImageSummary.has_workflow` + ComfyuiStatus / ComfyuiConfigUpdate / OpenWorkflowResult
   - `backend/app/repository.py`：`_row_to_summary` 派生 has_workflow
   - `backend/app/routes/comfyui.py`：3 个端点 + 1 个 temp_files 调试端点
   - `backend/app/main.py`：注册路由
   - `backend/tests/test_comfyui_integration.py`：15 个测试（含 monkeypatch 替掉 `app.routes.comfyui.probe` 让测试不依赖本机 8188）
2. 前端
   - `lib/types.ts`：has_workflow + 3 个 Comfyui 类型
   - `lib/api.ts`：comfyuiApi（3 个方法）
   - `lib/stores.ts`：comfyuiStatus + comfyuiEnabled writable
   - `lib/icons.ts`：comfyui 简笔画（六边形 + 3 内部节点 + 连线）
   - `App.svelte`：onMount 启动轮询 + visibilitychange
   - `SettingsModal.svelte`：ComfyUI 集成区块
   - `Feed.svelte`：圆形按钮 + openInComfyui（注意：内层必须用 div+role 不能 button）
   - `DetailPanel.svelte`：快捷复制条追加 "在 ComfyUI 中打开" 按钮
   - 测试：api-comfyui、stores-comfyui、feed-comfyui-button 可见性矩阵、icons
3. 文档
   - `outputs/PLAN-comfyui-open.md`
   - `README.md` P0 + API 表
   - `materials/notes-2026-09-04-comfyui-open.md`（本文）

## 验证

- **后端 126 个 pytest 全过**（含 15 个新增）
- **前端 154 个 vitest 全过**（含 6 个 feed-comfyui-button 可见性矩阵 + 4 个 api-comfyui + 3 个 stores-comfyui + icons 套件）
- **手动 E2E**（在 Codex In-app Browser 里）：
  - hover 第一张 thumb → 出现红色圆形 ComfyUI 按钮（六边形 + 节点图）
  - 点击按钮 → toast 显示 "已尝试打开 ComfyUI（http://127.0.0.1:8188）；如未弹出请在 ComfyUI 中拖入 C:\...\comfyui_temp\586.json"
  - 验证 `data/comfyui_temp/586.json` 是真实 workflow JSON（含 nodes / links / groups）
  - 浏览器被 Codex In-app Browser 隔离，webbrowser.open 会失败降级，但文件路径已可用

## 影响面 & 兼容性

- DB schema 不变，无需迁移
- config.json 新增两个字段，老 config 自动用 dataclass 默认
- ImageSummary 加 has_workword 字段（默认 False），前端 `it.has_workflow` 用 `?` 可选访问，老代码路径不受影响
- Feed 列表查询 SELECT images.* 没变，has_workflow 是在 Python 侧从 row["workflow"] 派生
- 后端 webbrowser.open 在 headless CI 会失败，但前端有降级文案

## 已知问题 / 后续

- 「真·一键加载」需要 ComfyUI 端装扩展（postMessage 或自定义端点），超出本仓库范围
- 当前是单图打开；多选时只有 selected 集合内的会触发。多 workflow 批量打开是后续 P1
- 浏览器弹窗被拦时降级到 toast + 文件路径；用户要再点一下或手动开
