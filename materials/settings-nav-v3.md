# 设置导航调整记录

移除 App 侧栏底部设置容器，保留 HeaderBar 右上入口。设置标题区与导航区使用相同 bg-surface，宽度均为 240px；窄屏均为 144px。

分类使用 18px、currentColor、1.7px 描边 SVG：通用为调节杆，模型与反推为图片，快捷键为键盘，ComfyUI 为节点连接，关于与更新为信息圆环。

右上返回入口使用左箭头和「返回图库」无障碍名称。专用 CSS 选择器覆盖通用 hover 样式，悬停与 focus-visible 使用品牌色 #f24e4e 背景，不改变边框。
