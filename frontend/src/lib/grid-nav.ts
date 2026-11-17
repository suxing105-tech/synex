/**
 * 网格里「上下左右」该走到哪一张：只认画面上的位置，不认列表下标。
 *
 * 为什么不能按 feedItems 的下标 ±1：这一片是贪心 masonry（见 Feed.svelte 的 columns），
 * 一列里横竖图混排，同一屏里「左右相邻」的两张在下标上可能差着整列的高度，
 * 「正下方」的那张更不知道在下标第几位。按序号走箭头，屏幕上的光标会乱跳。
 *
 * 所以判据只有一条：在按下的那个方向上，找交叉轴压得住、主轴最近的那一张。
 * 交叉轴重叠这一条替我们把「同列」和「别列」分开了——瀑布流里同列的卡 x 完全重叠，
 * 别列的卡 x 完全不重叠，于是「下」自然落在同一列的下一张，不会斜着跳到邻列。
 */

export type GridDirection = "left" | "right" | "up" | "down";

/** 一张卡在滚动容器里的位置（容器坐标，像素）。 */
export interface GridBox {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 允许 1px 的舍入误差：布局是算出来的，边界上常常差这么点。 */
const EPS = 1;

function crossAxis(box: GridBox, horizontal: boolean) {
  return horizontal
    ? { start: box.top, end: box.top + box.height }
    : { start: box.left, end: box.left + box.width };
}

function overlap(a: { start: number; end: number }, b: { start: number; end: number }) {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

/**
 * 从 fromId 沿 dir 走一格，返回目标 id；那一侧没有卡就返回 null。
 *
 * 取法：先要交叉轴压得住（重叠 > 0）且主轴方向在前，其中取主轴间距最小的；
 * 打平时（同列两张卡的上沿齐平）再比交叉轴中心偏移，谁更正对上门牌就归谁。
 * 那一侧压根没有压得住的候选，就放宽到「不压也算」，按主轴最近 + 交叉偏移最小兜一张，
 * 别让箭头键撞墙——键盘导航卡住比跳到隔壁列更难解释。
 */
export function nearestInDirection(
  boxes: readonly GridBox[],
  fromId: string,
  dir: GridDirection,
): string | null {
  const from = boxes.find((b) => b.id === fromId);
  if (!from) return null;
  const horizontal = dir === "left" || dir === "right";
  const forward = dir === "right" || dir === "down";

  type Candidate = { id: string; gap: number; crossDrift: number; crossOverlap: number };
  const strict: Candidate[] = [];
  const loose: Candidate[] = [];

  for (const box of boxes) {
    if (box.id === fromId) continue;
    // 主轴：卡片前沿与起点后沿的距离；负得越多说明它其实还在后面
    const gap = forward
      ? (horizontal ? box.left : box.top) - (horizontal ? from.left + from.width : from.top + from.height)
      : (horizontal ? from.left : from.top) - (horizontal ? box.left + box.width : box.top + box.height);
    if (gap < -EPS) continue;
    const cross = crossAxis(box, horizontal);
    const fromCross = crossAxis(from, horizontal);
    const drift = Math.abs((cross.start + cross.end) / 2 - (fromCross.start + fromCross.end) / 2);
    const hit = overlap(cross, fromCross);
    const candidate: Candidate = { id: box.id, gap, crossDrift: drift, crossOverlap: hit };
    if (hit > 0) strict.push(candidate);
    else loose.push(candidate);
  }

  const best = (list: Candidate[]) =>
    list.sort((a, b) => a.gap - b.gap || a.crossDrift - b.crossDrift)[0] ?? null;
  return (best(strict) ?? best(loose))?.id ?? null;
}

/**
 * 空格放大该开哪一张：先认「当前那一张」——鼠标左键点的、方向键走的都是它；
 * 一张都没选中，才退回鼠标滑过的那张（纯鼠标那套手势：压在谁身上就开谁）。
 *
 * 顺序不许倒回悬停优先：方向键走的也是选中，鼠标停在别的卡上时，悬停优先会把
 * 刚走到的那一张挤掉，按空格开出来的成了鼠标底下那张
 * （2026-11-16 苏醒：鼠标滑过缩略图按空格键不再放大了，冲突）。
 *
 * 正好选中两张是图片对比那一手：开的是先选上的那一张（Set 的迭代顺序就是选中的先后）。
 */
export function previewTargetId(
  multi: readonly number[],
  selected: number | null,
  hovered: number | null,
): number | null {
  if (multi.length === 2) return multi[0] ?? null;
  return selected ?? hovered;
}

/**
 * 还没有任何选中时的落点：整片网格里最靠上、然后最靠左的那一张。
 * 读键盘的人第一次按方向键，也该落在一个看得见、可解释的位置上。
 */
export function firstBox(boxes: readonly GridBox[]): string | null {
  if (!boxes.length) return null;
  return [...boxes]
    .sort((a, b) => a.top - b.top || a.left - b.left)
    [0].id;
}
