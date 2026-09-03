# 缩略图选中态高亮改为内描边 (2026-09-03 16:49, 修订 17:00)

## 当前方案

`frontend\src\components\Feed.svelte` 第 562 行缩略图 button 的选中态 class：

```
outline outline-[3px] outline-accent outline-offset-[-3px]
```

- 线宽 3px（用 `outline-[3px]` 任意值；不能用 `outline-3`，因为 Tailwind v3 默认只有 0/1/2/4/8 档位）
- `outline-offset-[-3px]` 让线贴齐 border 内侧，不缩小图片可视区
- 颜色 `#f24e4e`（accent），与品牌色一致

## 历史迭代

- **v1** `ring-2 ring-inset ring-accent`：inset box-shadow 被 `img.thumb-img (object-cover w-full h-full)` 完全盖住，视觉消失。
- **v2** `outline outline-2 outline-accent outline-offset-[-2px]`：可见但 2px 偏细。
- **v3** `outline outline-3 outline-accent outline-offset-[-3px]`：**失败**。Tailwind v3 默认没有 `outline-3` 档位（只有 0/1/2/4/8），浏览器回退到默认 `medium` ≈ 2.67px。
- **v4** `outline outline-[3px] outline-accent outline-offset-[-3px]`：**当前**。任意值语法，强制 3px。

## 验证

- vitest：16 个文件 / 126 个用例全过（5 个新加的 outline 内描边用例，含回归保护断言）
- Playwright 抓 DOM + 截图：
  - 选中后 `getComputedStyle().outline = "rgb(242, 78, 78) solid 2.66667px"`，`-2.66667px` offset
  - 注：devicePixelRatio=1.5 让 getComputedStyle 的像素读数带 1.5x scale；CSS 实际 3px 在屏幕上显示为 ~4.5 物理像素，肉眼可见比 2px 粗一档
  - 截图证据：
    - `outputs\thumb-inner-ring-selected-2026-09-03.png`（2px 版本，参考对比）
    - `outputs\thumb-inner-ring-3px-2026-09-03.png`（3px 全页）
    - `outputs\thumb-inner-ring-3px-zoom-2026-09-03.png`（3px 选中缩略图裁切，红边清晰可见）
- 后端 8765 / 前端 5173 进程未重启，HMR 已应用

## 影响面

- 选中态高亮由"外 2px 红圈" → "内 3px 红线（盖在图片像素之上）"
- 缩略图外尺寸不变（outline 不占布局空间）
- 与 `.new-badge`（绿色 box-shadow 动画）共存：outline 在 box-shadow 之上，两者不冲突
- 选中态 + hover 缩放（`.thumb:hover .thumb-img { transform: scale(1.04) }`）依然可用，outline 位置不动
- 多选（多张都加 outline-accent）行为不变

## 改动文件

- `frontend\src\components\Feed.svelte` — 第 562 行选中态 class
- `frontend\src\__tests__\thumb-selected-class.test.ts` — 5 个用例（已加 `outline-3` 不能再用的回归断言）
- `materials\27-m4-thumb-inner-ring.md` — 本文件
- `outputs\thumb-inner-ring-3px-2026-09-03.png` — 全页截图
- `outputs\thumb-inner-ring-3px-zoom-2026-09-03.png` — 选中缩略图裁切
