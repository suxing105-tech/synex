# 缩略图选中态高亮改为内描边 (2026-09-03 16:49, 修订 16:55)

## 最终方案

`frontend\src\components\Feed.svelte` 第 562 行缩略图 button 的选中态 class：

- 第一版：`ring-2 ring-inset ring-accent`（不可见，下面解释原因）
- 最终版：`outline outline-2 outline-accent outline-offset-[-2px]`

## 关键 bug 复盘

第一版按直觉把 `ring-2 ring-accent` 加 `ring-inset`，以为"内描边"就是把 box-shadow 从外圈换到内圈。但实际 Playwright 抓取 + 截图验证发现：

- 计算 box-shadow 是对的：`rgb(255,255,255) 0 0 0 0 inset, rgb(242,78,78) 0 0 0 2px inset, rgba(0,0,0,0) 0 0 0 0`
- 但按钮内部有 `<img class="thumb-img w-full h-full object-cover">`，图片像素**完整覆盖**按钮内部
- Tailwind 的 `ring-*` 走 `box-shadow` 通道，inset box-shadow 渲染在 background 之上、content（图片）之下 → 被图片完全盖住
- 结果：DOM 看到 ring-inset 应用了，computed style 看起来都对，但视觉上完全消失

## 改用 outline + 负偏移

CSS `outline` 走另一条渲染通道：默认画在 box border 外面，但 `outline-offset: -2px` 把它拉回 box 内部 2px，并且 outline 渲染在所有 content 之上（规范约定），所以会透过图片显示一条 2px 红线。

实测 computed style：

```
className:   "thumb ... outline outline-2 outline-accent outline-offset-[-2px]"
outline:     rgb(242, 78, 78) solid 2px
outlineWidth:2px
outlineOffset:-2px
```

截屏：选中后第一张图四周可见 2px 红边内描边；其它图未选时无高亮。截图存档在 `outputs\thumb-inner-ring-selected-2026-09-03.png`。

## 改动文件

- `frontend\src\components\Feed.svelte` — 第 562 行选中态 class 改为 outline 系列
- `frontend\src\__tests__\thumb-selected-class.test.ts` — 3 个用例，已同步更新断言（用 outline，不再用 ring-inset），并显式断言 `not.toContain("ring-inset")` 作为回归保护
- `materials\27-m4-thumb-inner-ring.md` — 本文件
- `outputs\thumb-inner-ring-selected-2026-09-03.png` — 截图证据

## 验证

- vitest：16 个文件 / 124 个用例全过（含 3 个新增 outline 内描边用例）
- Playwright 抓 DOM + 截图：第一张图选中后明显可见 2px 红边内描边
- 后端 8765 / 前端 5173 进程未重启，HMR 已应用

## 影响面

- 选中态高亮由"外 2px 红圈" → "内 2px 红线（盖在图片像素之上）"
- 缩略图外尺寸不变（outline 不占布局空间，不像 `p-px` 那样让图片缩 4px）
- 与 `.new-badge`（绿色 box-shadow 动画）共存：outline 在 box-shadow 之上，两者不冲突
- 选中态 + hover 缩放（`.thumb:hover .thumb-img { transform: scale(1.04) }`）依然可用，outline 位置不动
- 多选（多张都加 outline-accent）行为不变
