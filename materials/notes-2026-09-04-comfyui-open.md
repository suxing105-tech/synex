# ComfyUI 一键打开工作流 — 交付记录 (2026-09-04)

## 目标

缩略图右上角出现圆形按钮 → 点击后把当前图片的 ComfyUI workflow 送到本机
ComfyUI 编辑器（不执行），并复用已打开的 ComfyUI 标签页，不每次新开。

约束：
- 仅当本机 ComfyUI 在跑（探测 `system_stats` 200）才显示按钮
- 仅当图片有 workflow 才显示
- 不引入 ComfyUI 扩展 / 插件
- 不执行 workflow（用户明确要「打开」，不是「重跑」）

## 关键设计决策

### 「打开」具体语义

ComfyUI 没有官方「加载但不执行」的 HTTP API。本轮采用 A 方案：

- 后端把 workflow JSON 落到 `data/comfyui_temp/<sanitized>.json`
- 前端用固定窗口名 `suxing_comfyui` 调 `window.open(url, name)`，
  浏览器自动复用同一标签页（不再每次新开）
- toast 反馈文件名 + 路径 + 拖入提示

放弃的原因：
- B（POST /prompt）：会真出图、占显存，违反用户语义
- C / D（写 ComfyUI 扩展 / postMessage）：改动 ComfyUI，超出本仓库范围
- E（webbrowser.open 的 new=0）：跨平台行为不一致（macOS 不复用 Windows 进程），
  而且没指定窗口名无法跨 tab 复用

### 复用标签页的实现

- `frontend/src/lib/comfyui-window.ts`：`openOrReuseComfyuiTab(url)`
  持模块级 `comfyuiWindow: Window | null`，统一用固定 `WINDOW_NAME = "suxing_comfyui"`
  调 `window.open`；跨源 focus() 失败用 try/catch 吞掉
- **关键约束**：`window.open` 必须在用户手势（点击事件）同步执行段调用，
  一旦 `await` 再调用就会被弹窗拦截。所以按钮处理函数的顺序是：
  1. 同步：拿 URL → `openOrReuseComfyuiTab(url)`（这一步必须在 await 之前）
  2. 异步：`await comfyuiApi.openWorkflow(id)` 落盘

### 文件名取自图片

旧版用 `<image_id>.json` 命名 → 用户每次都看到 `586.json`、`587.json` 这种无意义编号。
新版用图片原始 filename 命名：

- `sanitize_filename(raw)`：先按正则把 `\` `/` `:` `*` `?` `"` `<` `>` `|` 和控制字符替成 `_`，
  再按最后一个 `.` 剥扩展名，最后 `strip(" ._")` 防尾部下划线 / 纯符号
- 不直接用 `Path(raw).name` / `.stem`：Windows 上 `:` 是盘符分隔符，
  `Path("a:b.png").name` 会变成 `"b.png"` 把前缀吞掉
- 冲突：`dup.png` 第二次落盘为 `dup_1.json`、第三次 `dup_2.json`，永不覆盖

### 图标：极简节点图

旧版「六边形外框 + 3 个内部节点 + 3 条连线」7 个 SVG 元素，stroke-width=2
渲染到 15px 圆形按钮里显得拥挤 / 丑。

新版换成 Lucide `share-2` 同款的 Y 形节点图：
- 3 个小圆（r=1.8）排成三角形（左上、右上、下方各一个）
- 2 条细线（stroke-width=2）从上方两节点分别连到下方节点
- 无外框 / 无 polygon
- 共 5 个 SVG 元素，渲染到 15px 仍干净清晰

测试里锁住元素数量，避免又被改回六边形。

### 探测方式

`urllib.request` 顺序试 `/system_stats`、`/` 任一 200 即视为在跑。
标准库，零新依赖。1.5s 超时。

### 配置位置

`data/config.json` 加 `comfyui_url` / `comfyui_enabled` 两个键。`Config` dataclass 加字段，
`Config.load()` 的「仅取已声明键」天然兼容旧 config。

前端 SettingsModal 加 "ComfyUI 集成" 区块：URL 输入 + 启用开关 + 重新探测 +
状态点（绿 / 红 / 灰）。

### has_workflow 字段下沉

`ImageSummary` 加 `has_workflow: bool`，feed 列表直接用，避免 hover 触发 detail API。
`repository._row_to_summary` 用 `bool(row["workflow"])` 派生，无 schema 变更。

### 按钮可见性条件

`$comfyuiStatus.running && it.has_workflow && (hoveredId === it.id || $selectedIdStore === it.id || $multiSelectedIds.has(it.id))`

### 按钮位置与 ♥ 互斥

`top-1 right-1`，hover / 选中时浮起覆盖 ♥。

### 嵌套 button 坑（重要！）

HTML 规范禁止 `<button>` 包 `<button>`。Chrome 会把内层 click 上交给外层 thumb，
`e.stopPropagation()` 救不回来（event delegation 行为）。
Feed.svelte 必须用 `<div role="button" tabindex="-1">` 而不是 `<button>`，
内层通过 `onclick` + `onmousedown` 都 `stopPropagation()`。

## 实施步骤（实际）

### 第一轮：基础集成（已 commit `3ccd212`）
- 后端 `app/integrations/comfyui.py`：probe + write_workflow_temp（用 image_id 命名）
- 后端 `app/{config,models,repository,main}.py`：has_workflow 字段下沉
- 后端 `app/routes/comfyui.py`：3 个端点 + temp_files 调试
- 后端 `tests/test_comfyui_integration.py`：15 个测试
- 前端 types / api / stores / icons（丑图标版）/ App.svelte / SettingsModal /
  Feed.svelte / DetailPanel.svelte
- 前端 6 个 feed-comfyui-button 可见性矩阵 + 4 个 api-comfyui + 3 个 stores-comfyui + icons

### 第二轮：图标细化 + 标签页复用 + 文件名取自图片（本轮）
- 后端 `app/integrations/comfyui.py`：
  - 导出 `sanitize_filename(raw)` 函数（独立可测）
  - `write_workflow_temp` 改接 `image_filename`，先 sanitize 再 `_unique_path` 自动加 `_1` / `_2`
  - 删 `Path(raw).name` 用法（防 Windows 盘符吞前缀），自己按 `\` / `/` 切
- 后端 `app/routes/comfyui.py`：
  - DB 查询加 `filename` 列
  - **删除 `webbrowser.open` 调用**（后端不再负责弹窗；`new=2` 总是新开，无法复用标签页）
  - 返回 `OpenWorkflowResult.workflow_name`，`browser_opened` 恒为 False
- 后端 `app/models.py`：`OpenWorkflowResult` 加 `workflow_name: str`
- 后端 `tests/test_comfyui_integration.py`：补 4 个 sanitize 测试 + 2 个 write_workflow_temp 测试 +
  collision 测试 + 移除依赖 webbrowser.open 的测试
- 前端 `lib/icons.ts`：comfyui 改 Y 形节点图（3 圆 + 2 线，无外框）
- 前端 `lib/comfyui-window.ts`：新增工具模块，统一 `window.open(url, 'suxing_comfyui')`
- 前端 `lib/types.ts`：`OpenWorkflowResult` 加 `workflow_name`
- 前端 `components/Feed.svelte`：`openInComfyui` 改"同步开窗 → await 落盘"
- 前端 `components/DetailPanel.svelte`：同上
- 前端 `__tests__/comfyui-window.test.ts`：3 个新用例
- 前端 `__tests__/api-comfyui.test.ts`：补 workflow_name 断言
- 前端 `__tests__/icons.test.ts`：锁住"3 圆 + 2 线，无 polygon"

## 验证

- **后端 134 个 pytest 全过**（含 23 个新增 comfyui 用例 + sanitize + collision + filename）
- **前端 158 个 vitest 全过**（含 3 个新增 comfyui-window + 1 个 icons 设计锁 + 1 个 api workflow_name 字段）
- **手动 E2E**（在 Codex In-app Browser 里）：
  - hover 第一张 thumb → 出现 Y 形节点图按钮（精致简洁）
  - 点击按钮 → 同步触发 `window.open(comfyui_url, 'suxing_comfyui')` 打开 / 复用标签页
  - 后端落 `data/comfyui_temp/<image_filename>.json`（如 `my_cool_image.json`）
  - 重复点击同名图 → 自动追加 `_1.json`、`_2.json`，永不覆盖
  - 浏览器被 Codex In-app Browser 隔离，弹窗可能失败；但即便失败，文件路径也已落盘可用

## 影响面 & 兼容性

- DB schema 不变，无需迁移
- config.json 新增两个字段，老 config 自动用 dataclass 默认
- `OpenWorkflowResult` 加 `workflow_name: str`（必填字段）；前端类型已同步加，
  老代码若有直接构造 `OpenWorkflowResult(...)` 会缺字段报错（应当没有这样的代码）
- 后端 `browser_opened` 字段保留但恒为 False；前端若读这个字段只会拿到 False，不会误解为成功
- 后端 `webbrowser.open` 已完全移除；如果有依赖 `webbrowser` 行为的外部调用，会拿不到 ComfyUI 标签页
- Feed / DetailPanel 行为对齐：都先同步开窗，再 await 落盘

## 已知问题 / 后续

- 「真·一键加载」需要 ComfyUI 端装扩展（postMessage 或自定义端点），
  超出本仓库范围。当前只能「落盘 + 用户在 ComfyUI 中 File → Load 加载」
- 多选时只有 selected 集合内的会触发；多 workflow 批量打开是后续 P1
- Codex In-app Browser 隔离环境会拦弹窗；toast + 文件路径降级已生效
- 窗口复用依赖浏览器对 `window.open(url, name)` 的语义支持，所有现代浏览器都支持