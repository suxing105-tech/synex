# 24 — Lightbox 大横图变形修复（safeOrientedSize 防御方案）

## 用户反馈

- `场景_00002_.png`（2880×1616）双击进 100% zoom 之后变形
- `场景_00079_.png`（2064×1152）完全正常

## 现状

`frontend/src/components/Lightbox.svelte` 既读取 `visualW/H`（来自
`createImageBitmap(blob, { imageOrientation: 'from-image' })`，跨浏览器权威的
视觉尺寸），又通过 `bind:naturalWidth` 读取 `imgNaturalW/H`（来自
`naturalWidth/Height` 绑定，存储/视觉像素取决于浏览器实现）。

两套尺寸理论上应该一致，但 `visualW/H` 走的是异步链：`$effect`
读取 `originalUrl + imgNaturalW/H`、起 fetch、走 `createImageBitmap`、
再写回 state。期间 `<img>` 已经在浏览器内部解码完了，`naturalWidth`
已经被新图的像素更新。

## 根因分析

切图瞬间会出现这样的状态窗口：

  - `<img>` 已经显示新图，`imgNaturalW/H` 已是新图（例如 2880×1616）
  - `visualW/H` 还是上一张图的旧值（例如 2064×1152）
  - `fitRatio` / `displayW` / `displayH` 用旧值算出，会把 2880×1616 的新图
    拉伸/挤压到 2064×1152 算出来的 box 里，aspect 失配 → 视觉变形

之前几次 fix（commit e062469/e3bd471/c2da254）只保证了几何上
`displayW/displayH` 用同一个 `fitRatio` —— 但仍然假设 `visualW/H` 是真值。
问题不在数学，在于 `visualW/H` 异步回不来那几十毫秒。

## 修复方案

在 `frontend/src/lib/image-dims.ts` 加 `safeOrientedSize(natural, oriented)`：

- 保守优先用 `natural`（来自 `bind:naturalWidth`，是浏览器解码出来的真实像素）
- 只有在 EXIF 旋转被**明确证明**时才用 `oriented`：
  1. `natural.w === oriented.h && natural.h === oriented.w`
     → w/h 互换 = iPhone 90°/270° 类 EXIF
  2. aspect 差异 > 20%
     → 罕见 orientation 的兜底

`Lightbox.svelte` 引入两个 derived:

```ts
let safeVisualW = $derived(
  safeOrientedSize({ w: imgNaturalW, h: imgNaturalH }, { w: visualW, h: visualH }).w,
);
let safeVisualH = $derived(
  safeOrientedSize({ w: imgNaturalW, h: imgNaturalH }, { w: visualW, h: visualH }).h,
);
```

把 `fitRatio` / `displayW` / `displayH` / `onImgPointerMove` 里的
`clampPan(...)` 都改成读 `safeVisualW/H`。`visualW/H` 仍由原 effect
异步写回（不要破 EXIF 真值来源），但所有「下游消费者」读 `safeVisual`。

## 改动文件

- `frontend/src/lib/image-dims.ts` — 新增 `safeOrientedSize`（保留 `getOrientedImageSize`）
- `frontend/src/components/Lightbox.svelte` — 5 处 surgical：
  1. 导入加 `safeOrientedSize`
  2. 新增 `safeVisualW` / `safeVisualH` derived
  3. `fitRatio` 改读 `safeVisualW/H`
  4. `displayW` / `displayH` 改读 `safeVisualW/H`
  5. `onImgPointerMove` 里 `clampPan` 改传 `safeVisualW/H`
- `frontend/src/__tests__/image-dims.test.ts` — 11 个新测试覆盖
  safeOrientedSize 的所有决策分支

## 验证

```bash
cd frontend && npm test
# Test Files  11 passed (11)
# Tests       100 passed (100)
```

包括：
- 大横图切图瞬间：`natural={2880,1616}, oriented={2064,1152}` → 用 natural
- 90° EXIF 旋转：`natural={4000,3000}, oriented={3000,4000}` → 用 oriented
- 270° EXIF 旋转：`natural={3000,4000}, oriented={4000,3000}` → 用 oriented
- 跨图小差异：`{2880,1616}` vs `{2064,1152}`（aspect ~0.56% 差） → 用 natural

`svelte-check` 没有新增错误（项目原本 19 errors / 21 warnings 都是历史遗留）。

## 为什么不直接把 visualW/H 删掉

- 真值来源不能丢：手机 EXIF 旋转的 JPEG 必须用 createImageBitmap 校正后的尺寸
  才能正确显示，`imgNaturalW/H` 单独不够（在 Chrome 是存储像素）
- `safeVisual` 既能挡住 "异步回不来把新图挤变形" 这条 path，
  又能在真有 EXIF 时把 oriented 兜回来

## 不做的事

- 不重写 Lightbox —— 只在 aspect-lock 那段加了 4 行防御
- 不动 getOrientedImageSize（仍是跨浏览器 EXIF 真值来源）
- 不为了"修复"动 image-dims 的测试基础设施（用现有的 vitest 即可）
