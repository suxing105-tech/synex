# 图片复制、JPG 与原图拖出修复

## 发现与处理

- 上轮文件传入接口执行真实移动。本轮改为复制，保留来源文件及来源图片 ID、归属、收藏、标签；副本独立入库。同名采用 _1、_2 后缀，旧 /move-files 接口也兼容为仅复制，防止旧客户端删除来源。
- JPG/JPEG 被 PNG/WebP 白名单排除。现统一扩展 parser、索引监听、上传接口、原生拖入与界面格式提示。
- 实际运行库中最近两张导入图片（111.png、comfyuilogo.png）的尺寸都为 274×274；该数据本身为正方形，不能据此认定非方图被裁方。本轮仍补充 EXIF 方向尺寸、图片加载后的自然宽高校正，并让预览图绝对定位且 object-contain，避免内容撑开卡片或被裁切。
- 原来的 img 默认浏览器拖动会输出 max=1024 的预览链接。现在禁用 img 默认拖动，越过 6px 手势阈值后调用 Windows 原生文件拖放，载荷为 ImageSummary.path 原始文件路径，DROPEFFECT_COPY。不把预览 URL 或缩略图当文件导出。
- 原生拖出的过程中屏蔽应用内拖入回调，避免误触发重复导入；支持当前多选图片一起拖出。

## 参考

原生拖出使用 drag 2.1.1，参考维护方 [drag-rs](https://github.com/crabnebula-dev/drag-rs) 和 [Windows 实现](https://github.com/crabnebula-dev/drag-rs/blob/main/crates/drag/src/platform_impl/windows/mod.rs)。其 Files 类型向 Windows Shell 提供本地文件路径；Options.mode 设置 Copy。

## 验证

- 前端 351 项通过，包括真实 Feed 渲染的横竖比例、缺失尺寸校正、拖出手势及原路径参数。
- 后端 244 项通过，包括复制源文件保留、源记录不变、碰撞后缀、JPG/JPEG、EXIF 旋转比例和原图接口字节一致性。
- Rust 拖出模块 2 项通过；cargo check 通过；svelte-check 0 errors（15 个既有警告）。
- 独立打包后台通过横图 JPG、竖图 JPEG、旋转 JPG、宽幅 PNG 的复制保留、尺寸、预览比例、原图 SHA256 与字节验证。

桌面检查：新 image-copy-v4 程序已启动，实际窗口可见横竖比例图片。现场原生拖出验证准备阶段用户按物理 Esc 停止 Computer Use，已停止全部界面自动操作；不声称跨窗口拖出实测成功。
