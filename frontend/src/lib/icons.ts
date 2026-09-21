/**
 * 扁平图标 inner-SVG 路径集合。
 *
 * 为什么不直接写在 Icon.svelte 里：方便纯函数测试 + 跨组件复用。
 * 约定：
 *   - 24×24 viewBox；stroke-width=2；stroke-linecap=round；stroke-linejoin=round
 *   - fill=none；stroke=currentColor（在 Icon.svelte 的 <svg> 上设）
 *   - 每个 key 对应一段完整的 inner SVG（不含 <svg> 包裹），可直接 v-html 或 {@html} 注入。
 */

export const ICON_PATHS: Record<string, string> = {
  // 图库缩略图：矩形 + 圆点 + 山形折线
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
    '<circle cx="9" cy="9" r="2"/>' +
    '<path d="m21 15-5-5L5 21"/>',

  // 五角星
  star:
    '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',

  // 时钟
  clock:
    '<circle cx="12" cy="12" r="10"/>' +
    '<polyline points="12 6 12 12 16 14"/>',

  // 视频：播放器矩形 + 播放三角
  video:
    '<rect x="3" y="5" width="18" height="14" rx="2"/>' +
    '<path d="m10 9 5 3-5 3z"/>',

  // 文件夹
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',

  // 加号
  plus:
    '<line x1="12" y1="5" x2="12" y2="19"/>' +
    '<line x1="5" y1="12" x2="19" y2="12"/>',

  // 垂直三点菜单
  "more-vertical":
    '<circle cx="12" cy="5" r="1"/>' +
    '<circle cx="12" cy="12" r="1"/>' +
    '<circle cx="12" cy="19" r="1"/>',

  // 向左箭头
  "arrow-left":
    '<line x1="19" y1="12" x2="5" y2="12"/>' +
    '<polyline points="12 19 5 12 12 5"/>',

  // 圆形加斜线：表示"无 / 取消"
  "circle-slash":
    '<circle cx="12" cy="12" r="10"/>' +
    '<line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',

  // 心（线）
  heart:
    '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',

  // 心（实心，favorite 用）
  "heart-fill":
    '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" fill="currentColor" stroke="none"/>',

  // 复制
  copy:
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',

  // 外部链接（在新窗口打开）
  "external-link":
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
    '<polyline points="15 3 21 3 21 9"/>' +
    '<line x1="10" y1="14" x2="21" y2="3"/>',

  // 标签
  tag:
    '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>' +
    '<line x1="7" y1="7" x2="7.01" y2="7"/>',

  // 下载
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<polyline points="7 10 12 15 17 10"/>' +
    '<line x1="12" y1="15" x2="12" y2="3"/>',

  // 右箭头（展开/详情）
  "chevron-right":
    '<polyline points="9 18 15 12 9 6"/>',

  // 下箭头（展开）
  "chevron-down":
    '<polyline points="6 9 12 15 18 9"/>',

  // 上箭头（收起）
  "chevron-up":
    '<polyline points="18 15 12 9 6 15"/>',

  // 代码 <>
  code:
    '<polyline points="16 18 22 12 16 6"/>' +
    '<polyline points="8 6 2 12 8 18"/>',

  // 井号（seed 标识）
  hash:
    '<line x1="4" y1="9" x2="20" y2="9"/>' +
    '<line x1="4" y1="15" x2="20" y2="15"/>' +
    '<line x1="10" y1="3" x2="8" y2="21"/>' +
    '<line x1="16" y1="3" x2="14" y2="21"/>',

  // 关闭 ×
  x:
    '<line x1="18" y1="6" x2="6" y2="18"/>' +
    '<line x1="6" y1="6" x2="18" y2="18"/>',

  // comfyui 走 PNG 真 logo（品牌识别强），见 Icon.svelte 的 special case；
  // PNG 在 frontend/public/comfyui-logo.png，由 vite 静态托管。
};

/** 列出所有支持图标名（用于代码生成 / 测试 / 帮助页）。 */
export const ICON_NAMES = Object.keys(ICON_PATHS);
