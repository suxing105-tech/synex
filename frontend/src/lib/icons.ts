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
};

/** 列出所有支持的图标名（用于代码生成 / 测试 / 帮助页）。 */
export const ICON_NAMES = Object.keys(ICON_PATHS);