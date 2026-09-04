# ComfyUI 集成 — 在 ComfyUI 中打开工作流

## 背景 & 需求

苏醒图库已存有 ComfyUI 写进 PNG `tEXt` chunk 的原始 workflow JSON（`images.workflow TEXT`）。
当前用户想二次出图时，需要：
1. 找到原图
2. DetailPanel 点「复制 Workflow」
3. 切到 ComfyUI 标签页
4. Ctrl+O 选文件 / 或拖 JSON / 或粘贴

本轮目标：缩略图右上角出现一个**圆形按钮**，点击后一键把当前图片的 workflow 送到本地 ComfyUI 编辑器（不执行）。

约束：
- 仅当本机 ComfyUI 在跑（探测 `system_stats` 200）才显示按钮。
- 仅当图片有 workflow 才显示。
- 不引入 ComfyUI 扩展/插件。
- 不执行 workflow（用户明确要"打开"，不是"重跑"）。

## 「打开」具体语义

ComfyUI 没有官方「加载但不执行」的 HTTP API。可行路径：

| 方案 | 一键程度 | 依赖 | 取舍 |
|---|---|---|---|
| A. 后端存临时 `.json` + webbrowser.open ComfyUI + toast 显示路径 + 用户拖入 | 1 + 拖入 | 浏览器允许弹窗 | MVP 推荐 |
| B. 调 ComfyUI `/prompt` 提交 workflow | 1 | ComfyUI 1.0+ | 会真出图、占显存，违反用户语义 |
| C. ComfyUI 扩展监听自定义端点 | 1 | 装扩展 | 改动 ComfyUI，超出本仓库 |
| D. 跨 tab postMessage + ComfyUI 监听 | 1 | 写 ComfyUI 端代码 | 同 C |

**选 A**：保存到 `data/comfyui_temp/<image_id>.json`（同时也是「复制 Workflow」的等价物），用 Python `webbrowser.open(comfyui_url)` 在默认浏览器打开 ComfyUI，toast 显示「已生成 .../<id>.json，请在 ComfyUI 中拖入（或 Ctrl+O 打开）」。窗口被拦截就降级为只 toast 文件路径。

## 设计

### 后端

#### 新模块 `backend/app/integrations/__init__.py` & `backend/app/integrations/comfyui.py`

```python
# comfyui.py —— 探测本机 ComfyUI 是否在跑 + 临时文件落地

DEFAULT_URL = "http://127.0.0.1:8188"
PROBE_PATHS = ("/system_stats", "/")          # 任一 200 视为运行中
PROBE_TIMEOUT = 1.5                            # 秒

def probe(url: str = DEFAULT_URL) -> bool: ...
def comfyui_temp_dir() -> Path: ...            # data/comfyui_temp/
def write_workflow_temp(image_id: int, workflow_json: str) -> Path: ...
```

- `probe()` 用 `urllib.request`（避免新依赖），依次尝试 `/system_stats`、`/`，任一 200 → True；连接拒绝 / 超时 → False。
- `write_workflow_temp()`：把 workflow 字符串原样写入 `data/comfyui_temp/<image_id>.json`，同名覆盖。返回 Path。
- 写入失败抛 HTTPException(500)。

#### 新路由 `backend/app/routes/comfyui.py`

| 方法 / 路径 | 说明 |
|---|---|
| `GET /api/integrations/comfyui/status` | `{ running: bool, url: str, checked_at: float }` |
| `POST /api/integrations/comfyui/open_workflow/{image_id}` | 校验图片存在 + 有 workflow；写临时文件；尝试 `webbrowser.open(url)`；返回 `{ ok, file_path, comfyui_url, browser_opened }` |
| `PUT /api/integrations/comfyui/config` | 更新 `comfyui_url` + `comfyui_enabled`；写入 `data/config.json` |

错误：
- 图片无 workflow → 400 `no_workflow`。
- 图片不存在 → 404。
- `comfyui_enabled=false` → 403。

#### `data/config.json` 新增字段（兼容旧文件）

```jsonc
{
  "watch_dirs": [...],
  "live_enabled": true,
  "scan_workers": 4,
  "theme": "dark",
  "comfyui_url": "http://127.0.0.1:8188",      // 新
  "comfyui_enabled": true                      // 新
}
```

`Config` dataclass 同步加两个字段；`load()` 的「仅取已声明键」已天然兼容旧 config。

#### `repository.py` & `models.py`

- `ImageSummary` 新增 `has_workflow: bool`（`workflow != ''` 派生），feed 列表里就有，Feed 直接用，不用 detail API。
- `_row_to_summary` 在 SELECT 时用 `CASE WHEN workflow != '' THEN 1 ELSE 0 END AS has_workflow`。
- DB schema 不变（无迁移）。

#### main.py 注册

```python
from .routes import comfyui as comfyui_route
app.include_router(comfyui_route.router)
```

### 前端

#### `lib/types.ts`

- `ImageSummary` 加 `has_workflow: boolean`。
- 新增 `ComfyuiStatus { running: boolean; url: string; checked_at: number }`、`ComfyuiConfig { url: string; enabled: boolean }`、`OpenWorkflowResult { ok: boolean; file_path: string; comfyui_url: string; browser_opened: boolean }`。

#### `lib/api.ts`

- 新增 `comfyuiApi = { status(), updateConfig(patch), openWorkflow(id) }`。

#### `lib/stores.ts`

- 新增 writable：
  - `comfyuiStatus = writable<ComfyuiStatus>({ running: false, url: 'http://127.0.0.1:8188', checked_at: 0 })`
  - `comfyuiEnabled = writable<boolean>(true)`
- 启动探测：App.svelte `onMount` → 调一次 `status()`；之后每 30s 轮询；`document.visibilitychange` 切回时立即探一次。失败 `running=false`，不报错（ComfyUI 没启动是正常状态）。

#### `components/SettingsModal.svelte`

新增「ComfyUI 集成」区块：
- 输入框 `cfg.comfyui_url` + 保存时一起 PUT。
- 「启用」复选框 `cfg.comfyui_enabled`。
- 「重新探测」按钮 → 调 `comfyuiApi.status()`，右侧小圆点：绿=running / 红=offline / 灰=未探测。

#### `components/Feed.svelte`

`thumb` 模板里：

```svelte
<button class="thumb relative ..." ...>
  <img ... />
  <div class="absolute bottom-0 ...">{filename}</div>

  {#if it.favorite}
    <div class="absolute top-1 right-1 text-danger ...">♥</div>
  {/if}

  <!-- ComfyUI 工作流按钮 -->
  {#if $comfyuiStatus.running && it.has_workflow && (hoveredId === it.id || $selectedId === it.id || $multiSelectedIds.has(it.id))}
    <button
      type="button"
      class="comfyui-open-btn absolute top-1 right-1 ..."
      title="在 ComfyUI 中打开工作流"
      onclick={(e) => { e.stopPropagation(); openInComfyui(it); }}
    >
      <Icon name="external-link" />
    </button>
  {/if}
  ...
</button>
```

- 位置：top-1 right-1，与 ♥ 同位但条件互斥（hover/选中时显示按钮，♥ 让位或半透）。
- 视觉：32px 圆形，accent 色描边 + 半透明黑底，hover 时变实色。
- 图标：复用 `lib/icons.ts`，新增 `external-link`（箭头出框图标）。
- `openInComfyui(it)`：调 `comfyuiApi.openWorkflow(it.id)` → 成功 toast「已生成 ... 拖入 ComfyUI」；失败 toast 错误原因。`webbrowser.open` 被弹窗拦截 → `browser_opened=false`，toast 额外提示「请允许弹窗后再次点击 / 手动打开 <url>」。

#### `components/DetailPanel.svelte`

详情面板的「快捷复制条」追加一个按钮「在 ComfyUI 中打开」，条件同 Feed（runtime 派生 `$comfyuiStatus.running && detail.has_workflow`），点击同样调 `openWorkflow`。

### 图标

`frontend/src/lib/icons.ts` 新增：
- `external-link`: 箭头出框（24×24）

`__tests__/icons.test.ts` 加 key 存在断言。

### 测试

#### 后端 `backend/tests/test_comfyui_integration.py`

- `probe()` 离线返回 False（指向 `http://127.0.0.1:1` 必然失败）。
- `probe()` 用 monkeypatch fake httpd 起 200 → True。
- `POST /api/integrations/comfyui/open_workflow/<id>` 无 workflow → 400 `no_workflow`。
- `POST .../open_workflow/<id>` 有 workflow → 200，文件落盘，`browser_opened` 字段存在（不真的弹浏览器，用 monkeypatch 替掉 `webbrowser.open`）。
- `GET /api/integrations/comfyui/status` → 200，结构正确。
- `PUT /api/integrations/comfyui/config` → 更新 `data/config.json`。

#### 前端

- `__tests__/api-comfyui.test.ts`：mock fetch 校验 3 个端点。
- `__tests__/stores-comfyui.test.ts`：comfyuiStatus 初始值、update 不破坏订阅者计数。
- `__tests__/feed-comfyui-button.test.ts`：渲染断言（running=true + hovered → 按钮存在；running=false → 不存在；has_workflow=false → 不存在）。
- `__tests__/icons.test.ts`：新增 key 断言。

### 文案 & 反馈

- Toast 成功：「工作流已保存到 data\\comfyui_temp\\123.json，已尝试打开 ComfyUI；如未弹出请在 ComfyUI 中拖入该文件。」
- Toast 失败（无 workflow）：「该图片没有 ComfyUI 工作流。」
- Toast 失败（探测不到 ComfyUI）：「未检测到 ComfyUI（http://127.0.0.1:8188）。请确认 ComfyUI 已启动，或在设置中修改 URL。」
- Toast 失败（弹窗被拦）：「已生成 ...，但浏览器拦截了弹窗。请允许苏醒图库弹窗或手动打开 ComfyUI。」

## 实施步骤（按依赖顺序）

1. **后端基础**
   - `backend/app/integrations/__init__.py`（空）
   - `backend/app/integrations/comfyui.py`：`probe` + `write_workflow_temp` + `comfyui_temp_dir`
   - `backend/app/config.py`：加 `comfyui_url`、`comfyui_enabled`
   - `backend/app/models.py`：`ImageSummary.has_workflow` + 三个新 model
   - `backend/app/repository.py`：`_row_to_summary` 加 `has_workflow`
   - `backend/app/routes/comfyui.py`：3 个端点
   - `backend/app/main.py`：注册路由
   - `backend/tests/test_comfyui_integration.py`
2. **前端基础**
   - `frontend/src/lib/types.ts`：扩展
   - `frontend/src/lib/api.ts`：comfyuiApi
   - `frontend/src/lib/stores.ts`：comfyuiStatus + comfyuiEnabled + 轮询逻辑（在 App.svelte 触发）
   - `frontend/src/lib/icons.ts`：新增 external-link
3. **UI 集成**
   - `frontend/src/components/SettingsModal.svelte`：ComfyUI 区块
   - `frontend/src/components/Feed.svelte`：圆形按钮 + openInComfyui()
   - `frontend/src/components/DetailPanel.svelte`：快捷复制条加按钮
4. **测试**
   - 前端 vitest 全部
   - 后端 pytest 全部
5. **文档 & 提交**
   - `outputs/PLAN-comfyui-open.md`：本文
   - `materials/notes-2026-09-04-comfyui-open.md`：实施小结 + 决策
   - `README.md` P0 列表加「ComfyUI 工作流一键打开」
   - Git commit：建议拆 3 个
     1. `feat(backend): ComfyUI 集成：探测 + 临时文件 + open_workflow 端点`
     2. `feat(frontend): ComfyUI 状态探测 + Feed 圆形按钮 + 设置面板`
     3. `docs: ComfyUI 集成计划与说明`

## 影响面 & 兼容性

- DB schema 不变，无需迁移。
- `config.json` 新增两个字段，老用户加载时 `Config.load()` 兼容（默认 + dataclass 字段）。
- Feed 列表查询 SQL 多一列 `CASE`，影响可忽略（`images` 表已 < 1 万行常见规模）。
- 后端 `webbrowser.open` 在 headless 环境（CI）会失败，已用 monkeypatch 规避。
- 浏览器弹窗拦截是常见情况，必须降级路径清晰。
- 与现有 DetailPanel「复制 Workflow」并存，不冲突。

## 后续可选增强（不本轮做）

- ComfyUI 扩展模式（C/D 方案）：自动加载，1 键达成。
- 「提交到 ComfyUI /prompt 执行」开关（方案 B）。
- 缩略图右键菜单加「在 ComfyUI 中打开」入口（与现有菜单风格一致）。
- 多选时批量打开（多个 workflow 拼到 ComfyUI 历史队列）。
