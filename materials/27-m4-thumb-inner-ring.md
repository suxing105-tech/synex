# 缩略图选中态高亮改为内描边 (2026-09-03 16:49)

## 变更

`frontend\src\components\Feed.svelte` 第 562 行缩略图 button 的选中态 class：

- 之前：`ring-2 ring-accent`（外描边，box-shadow 外扩 2px）
- 现在：`ring-2 ring-inset ring-accent`（内描边，box-shadow 内陷 2px）

唯一修改 `frontend\src\components\Feed.svelte` 1 行；新增 `frontend\src\__tests__\thumb-selected-class.test.ts`（3 个用例）。

## 目的

- 选中态高亮不再"外溢"到 layout，缩略图之间的间距保持稳定。
- 与 `border border-border` 一起呈现一个"卡内"红框，与未选中态形成清晰视觉差。
- 颜色不变（`#f24e4e`，与品牌色 / 监听呼吸灯一致），宽度不变（2px）。

## 复刻式单测

新文件 `frontend\src\__tests__\thumb-selected-class.test.ts`：

- 复刻 Feed.svelte 里的 class 组合纯函数 `thumbClassFor({isSelected,isNew})`
- 断言 1：已选中 → class 同时含 `ring-2` / `ring-inset` / `ring-accent`
- 断言 2：未选中 → class 不含 `ring-accent` 也不含 `ring-inset`
- 断言 3：已选中 + 新图 → 同时含 `ring-inset` / `ring-accent` / `new-badge`

与 `feed-aspect.test.ts` 的"复刻 + 单测"模式一致；不依赖组件挂载。

## 验证

- 已有 121 个 vitest + 新增 3 个 = 124 个全过（16 个文件）。包含 ws.test.ts / api*.test.ts 内对 `127.0.0.1:3000` 的 ECONNREFUSED 警告，是现有行为，非本次引入。
- vite dev HMR 已应用改动（log 显示 `16:47:24 [vite] hmr update /src/components/Feed.svelte`）。
- 后端 8765 / 前端 5173 进程未重启；刷新浏览器即可看到内描边效果。

## 影响面

- `ring-2 ring-inset` 会让缩略图内部图片可视区域缩小 2px（缩略图本身外尺寸不变，外圈 2px 高亮变成内圈 2px 红边）。所有缩略图统一缩小，肉眼几乎不可察；列数 / 列宽 / 瀑布高度均不受影响。
- 仅影响视觉高亮，不影响选区逻辑、详情面板、Lightbox。
