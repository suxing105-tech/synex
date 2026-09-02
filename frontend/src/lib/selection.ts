// 多选行为纯函数：单选 / Ctrl 多选切换 / Shift 区间选。
// 不依赖 Svelte，方便单测和将来复用（如 Lightbox / 文件夹列表）。

export type Modifier = "none" | "ctrl" | "shift";

export interface SelectionState {
  primary: number | null;
  selected: ReadonlySet<number>;
  anchor: number | null;
}

export interface SelectionResult {
  primary: number | null;
  selected: Set<number>;
  anchor: number | null;
}

/**
 * 计算下一次选择状态。
 *
 * - modifier=none: 清空旧选择，只选中 clickId；primary = clickId；anchor = clickId。
 * - modifier=ctrl: 在当前集合里 toggle clickId：
 *     * 移除：从集合里选新 primary（优先保留原 primary，否则第一个）；anchor 不变。
 *     * 添加：primary = clickId；anchor = clickId（ctrl 也会更新锚点）。
 * - modifier=shift: 取 anchor 到 clickId 在 feedItems 里的下标闭区间，
 *   区间内全部进集合；primary = clickId（区间终点）；anchor 保持不变。
 *   若 anchor 不在 feedItems 里（已被过滤掉），回退到单选 clickId。
 */
export function nextSelection(
  feedItems: ReadonlyArray<{ id: number }>,
  current: SelectionState,
  clickId: number,
  modifier: Modifier,
): SelectionResult {
  const ids = feedItems.map((it) => it.id);

  if (modifier === "shift") {
    const anchor = current.anchor;
    const startIdx = anchor === null ? -1 : ids.indexOf(anchor);
    const endIdx = ids.indexOf(clickId);
    if (startIdx < 0 || endIdx < 0) {
      return { primary: clickId, selected: new Set([clickId]), anchor: clickId };
    }
    const lo = Math.min(startIdx, endIdx);
    const hi = Math.max(startIdx, endIdx);
    const next = new Set<number>();
    for (let i = lo; i <= hi; i++) next.add(ids[i]);
    return { primary: clickId, selected: next, anchor };
  }

  if (modifier === "ctrl") {
    const next = new Set(current.selected);
    if (next.has(clickId)) {
      next.delete(clickId);
      let primary: number | null = null;
      if (current.primary !== null && next.has(current.primary)) {
        primary = current.primary;
      } else {
        const first = next.values().next();
        primary = first.done ? null : first.value;
      }
      // anchor 保持不变：用户可能想接着 shift 扩出原区间
      return { primary, selected: next, anchor: current.anchor };
    }
    next.add(clickId);
    return { primary: clickId, selected: next, anchor: clickId };
  }

  // 单击：清空并只选这一个
  return { primary: clickId, selected: new Set([clickId]), anchor: clickId };
}
