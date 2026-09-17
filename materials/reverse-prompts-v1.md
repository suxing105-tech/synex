# 图片反推调研记录

日期：2026-09-17。

- 项目实际结构：Svelte 5 / Vite 前端，FastAPI 后端，SQLite 本地图库，Tauri + PyInstaller Windows 桌面包。
- 原有 SettingsModal 提供监听目录、Live、ComfyUI、更新；原有 DetailPanel 提供正向/反向 Prompt、生成参数与元数据。
- 决策：OpenAI 兼容 Chat Completions，用户手动配置服务，不读取开发机凭据，不创建供应商密钥。
- 图片输入协议来源：https://developers.openai.com/api/docs/guides/images-vision 。使用文本和 image_url / Base64 data URL，避免供应商访问本地文件路径。
- 密钥：Windows CurrentUser DPAPI；其他平台使用进程内字典；接口查询不返回明文。请求参数校验错误不回显请求体。
- 验证使用合成图片、虚构测试密钥和本地 Mock 服务，不调用付费模型，不读写用户图库数据。
- 现有工作区包含多个无关未跟踪文件，本次提交仅列举新增功能相关路径。
