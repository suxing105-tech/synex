# ComfyUI、跨层级目录与收藏

问题确认：原按钮只打开网页并导出临时 JSON，没有调用 ComfyUI 画布加载；桌面启动分支还跳过了 ComfyUI 状态轮询。收藏接口原来从 query 取值，前端却发送 JSON，导致取消收藏无效。

实现：
- 桌面版建立独立 ComfyUI 工作流窗口，等待前端初始化完成，调用 app.loadGraphData(workflow,true,true,图片名+'.json')。窗口回传成功或失败后才提示结果，不提交生成队列。
- 将图片原始 workflow 结构提供给桌面桥接，图片没有完整画布工作流时给出错误；状态检测覆盖桌面版。
- 持续按住左键后，文件夹行上/下四分之一为前/后排序，中部为移入；拖到所属分区标题移回根层级。来源目录与我的文件夹各自在其区域内支持跨级移动。
- 物理目录及后代图片路径一同变更，拒绝循环嵌套、同名合并覆盖；异常回滚目录移动。目录监听回调与移动使用同一锁。
- 重命名下新增收藏/取消收藏，修复 JSON favorite 接口，标记放在 ComfyUI 按钮左侧。

参考的 ComfyUI 官方加载接口：
https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/scripts/app.ts
https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/platform/workflow/core/services/workflowService.ts
本机状态端点：ComfyUI 0.36.0，required_frontend_version 1.52.7（只读检查）。

验证：前端 373 项、后端 252 项、类型检查无错误（15 项已有 warnings）、cargo check 通过。

实际窗口回归中发现：全局 CloseRequested 处理会在关闭 ComfyUI 子窗口时杀死图库后端；已限制为 main 主窗口处理。最终包需要验证关闭子窗口后图库仍可用。

最终包实机检查：图库正常加载 135 张图片；ComfyUI 独立窗口及内部工作流标签均为角色资产_00069_，画布节点已加载。随后用户在该窗口开始运行工作流，因此保留窗口，没有继续关闭测试；图库后端 stats 返回 HTTP 200。关闭子窗口的 main 标签保护已编译进最终包。
