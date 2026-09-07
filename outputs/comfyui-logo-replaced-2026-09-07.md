# ComfyUI 按钮图标替换为指定图片
触发：用户在 in-app browser 中选中 ComfyUI 打开按钮内的 img，要求换成 `C:\Users\Administrator\Desktop\111.png`。

## 改动
- `frontend/public/comfyui-logo.png`：被 5119 bytes 的新图覆盖（旧图被覆盖），保持 PNG 格式。
- 该资源由 `Icon.svelte` 在 `name="comfyui"` 分支使用（也即 thumb 上"在 ComfyUI 中打开工作流"按钮里的图标），无需改组件代码。

## 验证
- 文件存在且 PNG magic 通过；与指定源逐字节一致。
- vitest run src/__tests__/icons.test.ts → 8/8 通过（资源存在性 + RGBA 头校验）。
- Comment 2 的反馈"不要外面的圆框"在上一提交 `4e6ee36` 已处理；本任务仅替换图标图片。
