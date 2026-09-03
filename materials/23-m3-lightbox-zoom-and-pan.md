# M3 Lightbox 100% 放大 + 抓手拖动平移

## 用户反馈

> 我希望增加功能：选中了图片，空格放大图片后，我希望，"鼠标双击图片能 100% 看原图，变抓手，能移动看图片细节。"

## 行为约定

- **fit 模式**（默认）：原行为，图片按 `max-w-[92vw] max-h-[84vh] object-contain` 缩进视口。
- **zoom 模式**：图片渲染成 `naturalWidth × naturalHeight` 像素（100% 原图），可超出视口。
- **双击图片** 在两种模式间切换。
- **zoom 模式下**：
  - 鼠标光标自动变 `grab`（未拖）/ `grabbing`（拖动中）。
  - 鼠标左键拖动 = 平移图像。
  - 平移 clamp 到合理范围：小图不能移出视口外，大图至少保留 margin 像素可见。
- **Esc**：zoom 模式下先退出 zoom，再按一次才关 Lightbox（避免误关）。
- **切换图片 / 关闭 / 重新打开**：缩放状态重置为 fit + pan=0。
- **底部提示文本** 跟随模式切换：
  - fit：`双击图片 100% 放大 · 双击空白关闭`
  - zoom：`双击图片返回 · 拖动查看细节`

## 实现

### `frontend/src/lib/lightbox-zoom.ts`（新增，纯函数）

- `Size` / `PanOffset` 类型
- `clampPan(pan, image, viewport, margin=80)`：
  - 图像 <= 视口：`bound = ±(viewport - image) / 2`，图像完全留在视口内。
  - 图像 > 视口：`bound = ±(image - viewport) / 2 - margin`，保留 margin 像素贴住视口边缘。
  - `+ 0` 把 `-0` 归一为 `+0`，避免 JSON 序列化和 deepEqual 踩坑。
- `panFromDrag(mouseX, mouseY, dragStartMouseX, dragStartMouseY, dragStartPan)`：
  - `newPan = (currentMouse - dragStartMouse) + dragStartPan`
  - 图像上「鼠标按下的那个像素」会一直跟着鼠标走。
- `nextZoomMode(current)`：fit → zoom / zoom → fit，pan 都重置为 0。

### `frontend/src/components/Lightbox.svelte`（改）

- 状态：`zoomMode` (`"fit" | "zoom"`)、`pan` (`{x, y}`)、`isDragging`、`dragStart*`、`imgNaturalW/H`。
- `bind:naturalWidth={imgNaturalW} bind:naturalHeight={imgNaturalH}` 拿原图尺寸。
- 事件：
  - `<img ondblclick={onImgDblClick}>` → 切换模式 + `e.stopPropagation()`（避免冒泡到外层 close）。
  - `<img onmousedown={onImgMouseDown}>` → zoom + 左键时进入拖动状态。
  - `<svelte:window onmouseup={onImgMouseUp}>` → 拖动结束（即便在图片外松开也能正确收尾）。
  - $effect 监听 `imgNaturalW/H` 变化，zoom 模式下自动 clamp 到新范围（首次加载完成 / 切换图片后）。
  - $effect 监听 `index` 变化重置 zoom 状态（避免上张图的缩放模式窜到下张）。
- CSS：用 `style:cursor` 切换 grab/grabbing，`style:transform: translate(panX, panY)` 平移。
- `class:max-w-[92vw] / max-h-[84vh] / object-contain` 仅在 fit 模式生效；zoom 模式下取消这些 max 限制，让图像按 natural 尺寸渲染。
- `style:width / height = naturalW px / naturalH px` 在 zoom 模式强制固定尺寸，否则浏览器会按原 max-w/max-h 缩放。

### `frontend/src/__tests__/lightbox-zoom.test.ts`（新增，12 个测试）

- `clampPan`（6 个）：
  - 小图：pan 范围 = ±(viewport - image)/2
  - 小图刚好填满视口：pan 必须为 0
  - 大图：保留 margin 像素
  - 自定义 margin 生效
  - X 和 Y 独立 clamp（横长/竖长）
  - 已在范围内就原样返回
- `panFromDrag`（4 个）：
  - 鼠标没动：pan 不变
  - 鼠标移动 (dx, dy)：pan 跟着移动
  - 负方向拖动（向左上）
  - dragStartPan 为 {0,0}：pan 直接等于鼠标偏移
- `nextZoomMode`（2 个）：
  - fit → zoom：pan 重置为 0
  - zoom → fit：pan 重置为 0

## 验证

| 套件 | 之前 | 现在 |
|------|------|------|
| frontend vitest | 77/77 | **89/89**（+12 lightbox-zoom）|
| vite build | OK | OK |

## 范围外 / 后续

- **Ctrl/Cmd + 滚轮缩放**（任意比例缩放，不只是 100%）：本期未加，留到 P1。
- **滚轮平移**（zoom 模式下用滚轮代替拖动）：本期未加，拖动已能覆盖 90% 场景。
- **双击非中心位置 → 缩放到点击点**：本期未加，先做最简单的「居中 100%」。
- **缩放过渡动画**（transform 加 transition）：本期未加，直接跳变更直观。
- **多张图时的 zoom 模式持续**：本期选择切图时重置 fit，避免误操作。
