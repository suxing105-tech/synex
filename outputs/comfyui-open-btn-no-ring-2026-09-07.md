# ComfyUI 打开按钮去掉外圈圆框
触发来源：用户在 in-app browser 中对 thumb 上的"在 ComfyUI 中打开工作流"按钮给出反馈："不要外面这个圆框"。

## 改动
- frontend/src/components/Feed.svelte
  - .comfyui-open-btn：去掉 `rounded-full` 与 `border border-accent/70 hover:border-accent`，改为 `rounded-[6px]` + `bg-black/70`，无描边。
  - 保留 7×7 尺寸、flex 居中、hover 改 accent 色、backdrop-blur、点击热区不变。
- frontend/src/__tests__/feed-comfyui-button.test.ts
  - 新增设计锁测试：class 串中不再出现 `rounded-full` 与 `border`。
  - 保留 `w-7 h-7` / `flex items-center justify-center` 以守护点击热区。

## 验证
- vitest run src/__tests__/feed-comfyui-button.test.ts → 7 tests passed (含新增 1 个)。
- vitest run src/__tests__/icons.test.ts → 8 tests passed。
- 全量 vitest：与改动相关的全部通过；其余 12 个失败 (`ws.test / shortcuts.test / comfyui-window.test`) 在本次改动前已存在，根因是 CLI 调用 vitest 时未声明 happy-dom 环境，超出本任务范围。
