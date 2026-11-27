// 「再次创作」里那两层弹层往哪边长、最长能多长、放不下两栏时要不要上下叠。只算盒子，不碰 DOM。
//
// 为什么单独一个不带 Svelte 的文件：这三件事全靠矩形实测，而 happy-dom 不排版、rect 全是 0，
// 组件里写死的算术一条断言都落不了地（这个项目已经为同一个坑记过一条）。所以把尺子搬出来，
// 测试直接喂矩形断言结果，组件只负责量完把值写进 CSS 变量与类名。
//
// 为什么两侧都要量：弹层钉在底部那一排某颗胶囊外面那一格上，而那颗在行里的位置随窗口变。
// 只认「胶囊右沿到面板左内沿」这一侧，胶囊一挪到行的左边就量出个小数，弹层被自己的盒子切成
// 半截字——2026-11-26 苏醒照的图就是这一档：窗口一小，云端那一屏右列整列模型名没了、「已实测」剩「已实」。

/** 只用到左右两条边，DOMRect 与测试里手写的矩形都能进来。 */
export interface PopBox {
  left: number;
  right: number;
}

/** 面板的内沿：1 描边 + 横向 24 内边距（见 .cm-panel 的 padding 与 border）。 */
export const PANEL_INSET = 25;
/** 量不到时的地板：happy-dom 里 rect 全 0，算出来是负数，宁可得小半档也别写出负值。 */
export const POP_MIN_ROOM = 240;
/** 云端那一屏两栏的设计宽，放得下就不加宽。 */
export const API_POP_WIDTH = 452;
/**
 * 两栏真放得下的下限，一块块加出来的（不是凑的整数）：
 * 弹层左右内边距加描边 34 + 左列 140 + 列距 12 + 右列那一行最少 174
 * （模型行内边距 24 + 行末补白 4 + 类型徽标 34 + 两处间隙 16 + 名字至少 40 + 那枚状态标记 56）。
 * 低于这条，右列的名字被压到零宽、行末那枚标记顶出盒子被切一半，就是照上那张图的样子。
 */
export const API_TWO_COL_MIN = 360;

/** 胶囊那一格的右沿到面板左内沿：弹层贴右往左长时真正用得上的余量。 */
export function roomLeft(panel: PopBox, wrap: PopBox): number {
  return Math.round(wrap.right - panel.left - PANEL_INSET);
}

/** 面板右内沿到胶囊那一格的左沿：弹层贴左往右长时真正用得上的余量。 */
export function roomRight(panel: PopBox, wrap: PopBox): number {
  return Math.round(panel.right - PANEL_INSET - wrap.left);
}

/**
 * 两侧各量一份，哪边宽往哪边长。相等时算左边那份——「贴右往左长」是这颗弹层用过两轮的锚点，
 * 量不到（rect 全 0）时也正好落回它，测试与真实浏览器不会分成两种摆法。
 * 返回的 room 是选定那一侧的余量，已经过地板。
 */
export function popAnchor(panel: PopBox, wrap: PopBox): { side: "left" | "right"; room: number } {
  const left = roomLeft(panel, wrap);
  const right = roomRight(panel, wrap);
  const side = right > left ? "right" : "left";
  return { side, room: Math.max(POP_MIN_ROOM, side === "right" ? right : left) };
}

/** 只许贴右往左长的那一层（「画面参数」那颗在底部那一排的最右边）：封顶只认左边那一份余量。 */
export function leftOnlyRoom(panel: PopBox, wrap: PopBox): number {
  return Math.max(POP_MIN_ROOM, roomLeft(panel, wrap));
}

/**
 * 选定那一侧最后真给出的宽度放不放得下两栏：封顶是设计宽 452，所以只看 min(452, room) 这一档。
 * 放不下时组件挂 is-one-col，两列上下叠（口径见 CloneModal 的 .cm-pop-wf.is-api.is-one-col）。
 */
export function apiPopFitsTwoCols(room: number): boolean {
  return Math.min(API_POP_WIDTH, room) >= API_TWO_COL_MIN;
}
