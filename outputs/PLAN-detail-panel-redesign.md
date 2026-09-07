# 详情面板（DetailPanel）UI 改造 — 实施计划

## 目标
把 `frontend/src/components/DetailPanel.svelte` 从「平铺信息 + 重复按钮条」重做为：
- 信息分层（Header / 摘要 / Prompt / 参数 / 元数据 / 高级）
- 动作归位（复制按钮下沉到 Prompt 卡片内；顶部只留 1–2 个高优先级主操作）
- 长内容可读性（折叠、字数统计、关键词搜索、悬停复制）
- 参数按域分组并对常用字段做视觉强调
- 键盘可达 + 快捷键 + 响应式分隔条

## 现状问题（截图 + 源码定位）

1. **顶部信息单薄**：`DetailPanel.svelte:99–106` 只显示文件名 + 一行尺寸/大小/时间，右侧大量留白；与 Feed 选中态视觉重复。
2. **快捷复制条拥挤**：`:108–113` 把 `＋ Prompt / － Prompt / # Seed / 所有参数 / Workflow / 在 ComfyUI 中打开` 平铺成 6 个 11px 按钮，容易换行且与 Feed 选中态功能重叠（feed 已经支持快捷键复制）。
3. **Prompt 没有分组标题**：`Reverse prompt` 块没有独立标题或 tab，视觉上与正向 prompt 串在一起，长 prompt 时滚动条难定位；没有「复制整段」「字数 / 行数」统计。
4. **生成参数无分组**：`paramsToKv` 是平铺键值对，sampler / steps / cfg / scheduler / seed / latent 等十几行混在一起，看不出「采样器」「模型」「LoRA」三组语义；`seed` 在 `parameters` 里 + 单独 `seed` 行重复显示（`:155–162`）。
5. **长值无保护**：lora 路径、负向 prompt 长文本容易撑爆列宽；只有 `break-all`，没有 ellipsis + tooltip。
6. **标签与文件夹交互散**：标签 chip 删除要 hover 看到 ×；切换文件夹要展开整棵文件夹树（`:189–212`），目录深时不直观，且无当前路径面包屑。
7. **Workflow JSON 折叠后只显示 pre**：没有复制按钮、格式化按钮，行高过密时不可读。
8. **Toast 视觉粗糙**：`.toast` 固定左下角，无图标无进度条；多次连续操作会堆叠。
9. **响应式缺失**：详情面板宽度写死，窄屏无降级。

## 设计原则

1. **分层而非平铺**：Header（标题 + 主操作） / 摘要（缩略图 + 关键元数据） / Prompt 卡片 / 参数卡片 / 元数据卡片 / Workflow 高级。
2. **动作归位**：复制按钮下沉到内容卡片内 hover 显示；顶部只留 1–2 个高频主操作（收藏 + ComfyUI 打开）。
3. **渐进展示**：默认展开 Prompt 与「常用参数」，折叠其余参数组、LoRA 列表、Workflow JSON。
4. **可读性优先**：长文本 ellipsis + tooltip；参数按域分组；常用 seed/cfg/steps/sampler 高亮。
5. **键盘可达**：所有按钮 `aria-label`；快捷键 P/N/S 复制、Shift+C ComfyUI、F 收藏、T 标签、Esc 关闭弹层。

## 新版结构（自上而下）

```
┌──────────────────────────────────────────────────────────┐
│ ▣二采_00021_.png          [♡] [↗ ComfyUI]            ⋯  │  ← Header (sticky)
│ 1152×2064 · 3.0 MB · 12:17:16                             │
├──────────────────────────────────────────────────────────┤
│ ┌──────────┐  ┌─ 正向 Prompt ────── 197 字  [复制] ┐    │  ← Prompt 卡片
│ │  缩略图   │  │ <lora:Krea2/...                       │    │
│ │  点击放大  │  │ <lora:Krea2/detail_slider_...>        │    │
│ └──────────┘  └──────────────────────────────────────┘    │
│                                                          │
│           ┌─ 反向 Prompt ────── 12 字   [复制] ┐        │
│           │ lowres, blurry                       │        │
│           └─────────────────────────────────────┘        │
│                                                          │
│ ┌─ 采样 ─────────────────────────────────────┐           │
│ │ sampler: er_sde · scheduler: simple        │           │
│ │ steps: 8 · cfg: 1 · seed: 1959…886         │           │  ← 分组卡片
│ │ noise_seed: 256,0 · start_at_step: 5        │           │
│ └────────────────────────────────────────────┘           │
│                                                          │
│ ┌─ 模型 / LoRA ──────────────────────────────┐           │
│ │ • Krea2/krea2_wukong_sytle_c1     [w:0.80]│           │
│ │ • Krea2/detail_slider_krea2_…     [w:0.6] │           │
│ │ • …                                       │           │
│ └────────────────────────────────────────────┘           │
│                                                          │
│ ┌─ 元数据 ───────────────────────────────────┐           │
│ │ #krea2  #product  +                       │           │
│ │ 📁 监听 / krea2                            │           │
│ └────────────────────────────────────────────┘           │
│                                                          │
│ [▸ Workflow JSON]                                        │
└──────────────────────────────────────────────────────────┘
```

### Header（sticky）
- 左侧：缩略图小图标 32×32（点击触发 Lightbox）+ 文件名（truncate + tooltip）。
- 中部元数据：分辨率 · 大小 · mtime（12px muted，可 hover 显示绝对路径 + hash）。
- 右侧主操作：
  - `♡/♥` 收藏切换（图标按钮，favorited 时填充红）。
  - `↗` 在 ComfyUI 中打开（图标按钮，hover 显示「ComfyUI 中打开」）。
  - `⋯` 更多菜单：复制正向 prompt、复制反向 prompt、复制 seed、复制全部参数、显示绝对路径、显示 Finder/资源管理器。
- 顶部不再有「复制按钮条」。

### Prompt 卡片
- 标题：「正向 Prompt」/「反向 Prompt」 + 字数 + 行数（muted）。
- 右上角 hover/always：`[复制]` 按钮；长按时复制为分段格式（带行号）。
- 内容：等宽字体 12px，`line-height: 1.55`；折叠高度 `max-h-40`，展开后 `max-h-96`，溢出滚动条。
- 工具栏：查找框（`Ctrl+F` 聚焦，关键词高亮）、`</>` 切换代码视图。
- 双击 prompt 卡片 → 复制并 toast「已复制 正向 Prompt」。

### 参数卡片（按域分组）
- 分组规则（在 `lib/params.ts` 新增 `groupParams(params, model, loras, sampler, steps, cfg, seed)`）：
  - **采样**：sampler_name / scheduler / steps / cfg / start_at_step / end_at_step / return_with_leftover_noise / add_noise / noise_seed / latent_image / seed。
  - **模型 / LoRA**：解析 `parameters.loras`（如有）或扫 prompt 中的 `<lora:...>`；每条显示名称 + 权重 chip，点击权重复制权重数值。
  - **尺寸 / 其他**：width / height / size / 其余键。
- 默认展开「采样」组；其他折叠。
- 长值处理：截断到 24 字符 + hover tooltip 显示完整值 + 单击复制。
- `seed` 单独高亮（等宽 + 复制按钮），同时显示在 Header 一行方便快速识别。

### 元数据卡片
- 标签：chip 形式，hover 显示「×」删除按钮，**chip 可点击**触发全局搜索 `?tag=xxx`。
- 文件夹：路径面包屑（监听根 / 子 / 当前），「切换」按钮打开紧凑弹层（仅 1 层深度的扁平列表 + 搜索框，替代当前递归树）。
- 收藏：与 Header 同步，仅保留可视化展示。

### Workflow JSON（高级）
- 折叠后显示：`{ … 4.2 KB · 128 节点 }` 摘要。
- 展开后：行号 + 语法高亮（轻量自实现，不用 CodeMirror 减体积）+ 复制 + 格式化 + 「保存到文件」（触发浏览器下载 .json）。
- 默认折叠，避免污染视觉。

### 弹层与状态
- 「复制标签」输入：改为 popover（与 chip 同区域，非 modal）。
- 「切换文件夹」：替换为 `FolderPickerModal` 复用组件，搜索 + 树状 + Esc 关闭。
- Toast：右下角堆叠卡片（最多 3 个），进度型（导入中、扫描中）显示 spinner，自动消失 1.5–2s；错误型保留 4s 并带关闭按钮。

### 响应式
- 引入 `App.svelte` 中可拖拽的列分隔条，详情面板 `min-width: 320px`，`max-width: 560px`。
- 窄屏（< 1024px）：详情面板转为底部抽屉（`translate-y` 切换），Feed 与详情二选一显示。

### 快捷键（在 DetailPanel 内监听 window）
| 键 | 行为 |
|---|---|
| `P` | 复制正向 Prompt |
| `N` | 复制反向 Prompt |
| `S` | 复制 Seed |
| `Shift+C` | 在 ComfyUI 中打开 |
| `F` | 切换收藏 |
| `T` | 聚焦标签输入 |
| `Esc` | 关闭文件夹选择 / 标签输入 / popover |
| `Ctrl/Cmd+F` | 在 Prompt 卡片内查找 |

## 文件改动

| 文件 | 性质 | 内容 |
|---|---|---|
| `frontend/src/components/DetailPanel.svelte` | 重写 | 上述新结构 |
| `frontend/src/lib/params.ts` | 新增 | `groupParams()`、`extractLoras()`、`highlightMatch()` |
| `frontend/src/components/PromptCard.svelte` | 新增 | 卡片组件（封装正/反向） |
| `frontend/src/components/ParamsCard.svelte` | 新增 | 参数分组组件 |
| `frontend/src/components/MetadataCard.svelte` | 新增 | 标签 + 文件夹面包屑 |
| `frontend/src/components/FolderPickerModal.svelte` | 改造 | 改为搜索 + 树状 + Esc（复用） |
| `frontend/src/components/Toast.svelte` | 新增 | 堆叠 + 进度 + 关闭 |
| `frontend/src/lib/shortcuts.ts` | 新增 | 快捷键 hook（DetailPanel scoped） |
| `frontend/src/app.css` | 增补 | toast 卡片样式、chip 动画、参数域分隔线 |
| `frontend/src/App.svelte` | 微调 | 列分隔条 + 窄屏抽屉 |

## 实施步骤（按提交粒度）

### PR 1 — 抽取与分组（无视觉变化）
1. 新增 `lib/params.ts`：`groupParams` 纯函数 + 单测 `__tests__/params.test.ts`。
2. 新增 `PromptCard.svelte`、`ParamsCard.svelte`、`MetadataCard.svelte` 占位（不接 DetailPanel），保证可独立渲染。
3. 跑 vitest 确认 `__tests__/feed-aspect.test.ts` 等不受影响。

### PR 2 — 重写 DetailPanel 接入新结构
1. 替换 `DetailPanel.svelte`，保留 props / store 接口。
2. Header 主操作改图标按钮；移除顶部「复制按钮条」。
3. Prompt 卡片接入复制 + 字数统计。
4. 参数分组接入 `groupParams`，seed 在 Header 高亮同步。
5. 验证现有 `__tests__/api-images.test.ts` 等不依赖 DOM 结构变化。
6. 手动验证（截图存档到 `outputs/hover-state-*.png`）。

### PR 3 — 标签 / 文件夹 / Toast
1. chip 点击 → 搜索；删除按钮 hover 显示。
2. 文件夹面包屑 + 复用 FolderPickerModal（搜索 + Esc）。
3. Toast 改成堆叠卡片组件（`Toast.svelte` + `lib/toast.ts` store）。
4. 替换 `DetailPanel` 与 `App` 中硬编码的 `.toast` 使用点。

### PR 4 — 快捷键 + 响应式
1. `lib/shortcuts.ts` + DetailPanel 内 `onMount/onDestroy` 注册 window listener。
2. App.svelte 增加可拖拽分隔条（pointer events 实现 min/max 限制）。
3. 窄屏 < 1024px 走抽屉模式（CSS `@media` + `transition`）。

### PR 5 — 文档与示例
1. `outputs/demo.html` 增加新版详情面板截图与交互说明。
2. `README.md` P0 列表里把「详情面板 + 快捷复制条」改为「详情面板（分组 + 快捷键）」。
3. `materials/NN-detail-panel-redesign.md` 实施记录。

## 测试策略

- **单测**：
  - `params.test.ts`：`groupParams` 分组逻辑 / `extractLoras` 解析 lora 行 / 空参数 / 含未知键。
  - `shortcuts.test.ts`：mock window keydown，验证注册与清理。
  - `toast.test.ts`：store push/dismiss/limit。
  - 现有 `__tests__/main.test.ts`、`__tests__/feed-aspect.test.ts` 必须仍然通过（不依赖具体样式）。
- **手工验证**：
  - Feed 选中 → 详情面板无闪烁更新。
  - 复制正向 Prompt → 剪贴板正确 → toast 显示。
  - Workflow JSON 折叠 / 展开滚动无卡顿。
  - 拖窄屏至 1024px 以下 → 抽屉切换。
- **回归**：跑 `pytest -v`（后端无改动）+ `pnpm test`（前端 14+ → 19 用例）。

## 兼容性 / 风险

- **API 不变**：仅消费 `ImageDetail` 既有字段；不新增后端端点。
- **store 不变**：`selectedDetail`、`comfyuiStatus`、`folders` 读写方式保持。
- **拖拽分隔条**：用 pointer events 自实现，不引入新依赖。
- **快捷键冲突**：监听 `keydown` 时检查 `event.target` 是否在 `<input>/<textarea>`，是则跳过全局快捷键（P/N/S/F/T）。
- **键盘用户**：所有点击型操作支持 `Tab` 焦点 + `Enter`/`Space` 触发，按钮 `aria-label` 写明。
- **降低视觉疲劳**：所有分隔线 1px border-border；hover 反馈不超过 100ms transition。

## 不做（明确推迟）

- Prompt 翻译 / 自动改写 / 提取正向反问标签（P1+）。
- 参数可视化（如直方图、CFG 曲线，P1+）。
- Workflow 节点图渲染（P2）。
- 跨图片对比（P1+）。

## 交付清单

- 4–5 个前端 commit（按 PR 粒度）。
- `outputs/PLAN-detail-panel-redesign.md`（本文件）。
- `materials/NN-detail-panel-redesign.md` 实施记录 + 截图。
- `outputs/demo.html` 详情面板 mock 同步更新。
- README P0 列表同步更新。
- 全量测试通过。
