# 详情面板 UI 改造 - 实施记录

对应计划：`outputs/PLAN-detail-panel-redesign.md`

## 范围
把详情面板（`frontend/src/components/DetailPanel.svelte`）从平铺信息 + 重复按钮条重做为分层卡片：Header / Prompt / Params / Metadata / Workflow。

## 提交链

| PR | commit | 主题 |
|----|--------|------|
| 1 | `99f09c4` | feat(frontend): 详情面板参数分组 + LoRA 抽取（纯函数层） |
| 2 | `7e5f07e` | feat(frontend): 详情面板重写 - Header + Prompt/Params/Metadata 卡片 + ⋯ 菜单 |
| 3 | `c2d828a` | feat(frontend): 全局 Toast 堆叠 + FolderPickerModal 搜索过滤 |
| 4 | `3c3cdcd` | feat(frontend): 详情面板快捷键 + 详情列宽可拖拽 + 窄屏底部抽屉 |
| 5 | 本文件 | 文档与 README 同步 |

## 实现要点

### PR1 - 纯函数层
- `lib/params.ts` 抽出 `extractLoras()` + `groupParams()` + `truncateValue()`
- LoRA 抽取支持三种 sources：
  - prompt 中 `<lora:name:weight>` 标记（支持负权重）
  - `parameters.loras` 数组 / 对象 / 字符串
  - name 去重，权重取绝对值最大
- 参数分组：sampler / model / lora / size / other 五域
- detail 顶层字段（sampler/steps/cfg/seed/model/...）优先于 parameters 同名键（避免 seed 等重复显示）
- 单测 17 个全过

### PR2 - 详情面板重写
- 新增 `components/PromptCard.svelte`：正向 / 反向 prompt 通用容器，支持折叠、字数 + 行数统计、复制、双击复制
- 新增 `components/ParamsCard.svelte`：按域分组 + LoRA 列表 + seed 高亮 + 长值 ellipsis
- 新增 `components/MetadataCard.svelte`：标签 chips（点击触发搜索、hover 显示 × 删除） + 文件夹面包屑
- `DetailPanel.svelte` 重写：
  - Header：缩略图（点击触发 open-lightbox 事件）+ 文件名 + 分辨率 / 大小 / mtime / seed 摘要 + 三枚主操作按钮（♥ 收藏、↗ ComfyUI、⋯ 更多）
  - ⋯ 菜单：复制正向 / 反向 Prompt、复制 Seed、复制全部参数、复制绝对路径、编辑标签
  - Body：PromptCard × 2 + ParamsCard（LoRA 从 prompt + parameters.loras 合并去重）+ MetadataCard + Workflow JSON（默认折叠 + 复制 / 格式化 / 下载）
- `App.svelte` 监听 `open-lightbox`（打开 Lightbox 跳到当前选中图片的 index）和 `open-tag-search`（清除 folderId/view/query 然后 set tag）事件
- 新增图标：heart / heart-fill / copy / external-link / tag / download / chevron-* / code / hash / x
- `stores.ts` 新增 `tag` writable，refreshFeed 透传 tag → `/api/images?tag=`
- 单测无回归：22 文件 / 179 用例

### PR3 - Toast 堆叠 + 文件夹搜索
- 新增 `lib/toast.ts`：`pushToast / updateToast / dismissToast / clearToasts` + 4 种 kind（info / success / error / progress），最多堆叠 4 个 + LRU 丢弃
- 新增 `components/Toast.svelte`：右下角垂直堆叠，error 带 × 按钮，progress 带 spinner + 进度条，`aria-live="polite"` 屏幕阅读器友好
- `App.svelte` 全局挂载 `<Toast />`
- `FolderPickerModal.svelte` 增强：顶部搜索框（按 name 模糊过滤）+ 空匹配提示 + 内联搜索图标 SVG
- `DetailPanel.svelte` 移除本地 toast 状态，全部走 `pushToast`
- 单测 9 个 toast 用例全过

### PR4 - 快捷键 + 列宽可拖拽 + 抽屉
- 新增 `lib/shortcuts.ts`：`registerShortcuts(bindings, scope=window)`，cleanup 时移除；`allowInInput=false` 时不在 input / textarea / contenteditable 触发；`describeKey()` 输出可读标签
- `DetailPanel.svelte` 接入：P / N / S / Shift+C / F / T / Esc（按优先级关闭弹层）
- `App.svelte` 重写布局：
  - 列宽 `detailWidth` state + 6px 可拖拽 `splitter` div（pointer events 同时支持鼠标 + 触屏）
  - 窄屏（innerWidth < 1024）走底部抽屉模式
  - 选中变化时窄屏自动展开抽屉；关闭时显示右下角浮起按钮
  - 1100px 以下自动缩窄文件栏
- 单测 12 个 shortcuts 用例全过

## 测试
全量 vitest 24 文件 / 201 用例无回归；build 成功。

## 不做的事（明确推迟）
- Prompt 翻译 / 自动改写 / 提取正向反问标签
- 参数可视化（CFG 曲线 / 直方图）
- Workflow 节点图渲染
- 跨图片对比
- 亮色主题
- 多选批量操作

## 兼容性 / 风险
- API 不变：仅消费 `ImageDetail` 既有字段
- store 接口保持：`selectedDetail` / `folders` / `comfyuiStatus`
- 拖拽分隔条：pointer events 自实现，无新依赖
- 快捷键冲突：input / textarea 焦点时全局快捷键自动跳过
- 键盘可达：所有按钮 `aria-label`、焦点环用 outline-accent
