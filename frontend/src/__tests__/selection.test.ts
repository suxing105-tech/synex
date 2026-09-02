import { describe, it, expect } from "vitest";
import { nextSelection, type SelectionState } from "../lib/selection";

interface Item { id: number; filename: string; }

const items: Item[] = [
  { id: 1, filename: "a.png" },
  { id: 2, filename: "b.png" },
  { id: 3, filename: "c.png" },
  { id: 4, filename: "d.png" },
  { id: 5, filename: "e.png" },
  { id: 6, filename: "f.png" },
  { id: 7, filename: "g.png" },
];

function empty(): SelectionState {
  return { primary: null, selected: new Set(), anchor: null };
}

describe("多选 nextSelection 纯函数", () => {
  describe("单选（无修饰键）", () => {
    it("空状态点击 id=3 → 只选 3，primary=3，anchor=3", () => {
      const r = nextSelection(items, empty(), 3, "none");
      expect(r.primary).toBe(3);
      expect(r.anchor).toBe(3);
      expect([...r.selected]).toEqual([3]);
    });
    it("已有选区 → 单击 id=5 清空旧选，只剩 5", () => {
      const cur: SelectionState = { primary: 2, selected: new Set([2, 3]), anchor: 2 };
      const r = nextSelection(items, cur, 5, "none");
      expect(r.primary).toBe(5);
      expect(r.anchor).toBe(5);
      expect([...r.selected]).toEqual([5]);
    });
  });

  describe("Ctrl 多选切换", () => {
    it("点 id=2 → 集合加入 2，primary=2，anchor=2", () => {
      const r = nextSelection(items, empty(), 2, "ctrl");
      expect(r.primary).toBe(2);
      expect(r.anchor).toBe(2);
      expect([...r.selected].sort()).toEqual([2]);
    });
    it("已有 [2]，再 ctrl 点 3 → 集合 [2,3]，primary=3", () => {
      const cur: SelectionState = { primary: 2, selected: new Set([2]), anchor: 2 };
      const r = nextSelection(items, cur, 3, "ctrl");
      expect(r.primary).toBe(3);
      expect(r.anchor).toBe(3);
      expect([...r.selected].sort()).toEqual([2, 3]);
    });
    it("ctrl 点已在集合里的 2 → 移除，primary 退到集合剩余第一个", () => {
      const cur: SelectionState = { primary: 2, selected: new Set([2, 3, 4]), anchor: 2 };
      const r = nextSelection(items, cur, 2, "ctrl");
      expect(r.primary).not.toBe(2);
      expect([...r.selected].sort()).toEqual([3, 4]);
    });
    it("ctrl 点已选中且是唯一一项 → 集合空，primary=null", () => {
      const cur: SelectionState = { primary: 3, selected: new Set([3]), anchor: 3 };
      const r = nextSelection(items, cur, 3, "ctrl");
      expect(r.primary).toBeNull();
      expect(r.selected.size).toBe(0);
    });
    it("ctrl 移除后 anchor 保持不变（用户可能想接着 shift 扩区间）", () => {
      const cur: SelectionState = { primary: 5, selected: new Set([3, 5]), anchor: 3 };
      const r = nextSelection(items, cur, 5, "ctrl");
      expect(r.anchor).toBe(3);
      expect([...r.selected]).toEqual([3]);
      expect(r.primary).toBe(3);
    });
  });

  describe("Shift 区间选", () => {
    it("无 anchor → 回退到单选 clickId", () => {
      const r = nextSelection(items, empty(), 4, "shift");
      expect(r.primary).toBe(4);
      expect(r.anchor).toBe(4);
      expect([...r.selected]).toEqual([4]);
    });
    it("anchor=2 + shift 点 5 → 区间 [2..5] = {2,3,4,5}，primary=5，anchor 保持 2", () => {
      const cur: SelectionState = { primary: 2, selected: new Set([2]), anchor: 2 };
      const r = nextSelection(items, cur, 5, "shift");
      expect(r.primary).toBe(5);
      expect(r.anchor).toBe(2);
      expect([...r.selected].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
    });
    it("anchor=5 + shift 点 2 → 区间 [2..5] = {2,3,4,5}（反向也按闭区间）", () => {
      const cur: SelectionState = { primary: 5, selected: new Set([5]), anchor: 5 };
      const r = nextSelection(items, cur, 2, "shift");
      expect(r.primary).toBe(2);
      expect(r.anchor).toBe(5);
      expect([...r.selected].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
    });
    it("anchor=4 + shift 点 4 → 只选 4，集合 = {4}", () => {
      const cur: SelectionState = { primary: 4, selected: new Set([4]), anchor: 4 };
      const r = nextSelection(items, cur, 4, "shift");
      expect([...r.selected]).toEqual([4]);
      expect(r.primary).toBe(4);
      expect(r.anchor).toBe(4);
    });
    it("anchor 已不在 feedItems（比如被过滤掉）→ 回退单选", () => {
      const cur: SelectionState = { primary: 99, selected: new Set([99]), anchor: 99 };
      const r = nextSelection(items, cur, 3, "shift");
      expect(r.primary).toBe(3);
      expect(r.anchor).toBe(3);
      expect([...r.selected]).toEqual([3]);
    });
    it("shift 不影响 ctrl 集合：从 [2,5] + anchor=5 shift 点 2 → 仍是 {2,3,4,5}（区间替换集合）", () => {
      // 这是设计选择：shift 区间选直接 = anchor..click 的闭区间，
      // 不合并旧 ctrl 集合。和 Windows 资源管理器一致。
      const cur: SelectionState = { primary: 5, selected: new Set([2, 5]), anchor: 5 };
      const r = nextSelection(items, cur, 2, "shift");
      expect([...r.selected].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
      expect(r.anchor).toBe(5);
    });
  });

  describe("anchor 更新规则", () => {
    it("单击更新 anchor 到被点的 id", () => {
      const r = nextSelection(items, empty(), 6, "none");
      expect(r.anchor).toBe(6);
    });
    it("ctrl 添加更新 anchor 到被点的 id", () => {
      const r = nextSelection(items, empty(), 6, "ctrl");
      expect(r.anchor).toBe(6);
    });
    it("ctrl 移除不动 anchor", () => {
      const cur: SelectionState = { primary: 6, selected: new Set([3, 6]), anchor: 3 };
      const r = nextSelection(items, cur, 6, "ctrl");
      expect(r.anchor).toBe(3);
    });
    it("shift 不动 anchor", () => {
      const cur: SelectionState = { primary: 3, selected: new Set([3]), anchor: 3 };
      const r = nextSelection(items, cur, 5, "shift");
      expect(r.anchor).toBe(3);
    });
  });

  describe("异常输入", () => {
    it("clickId 不在 feedItems 里，shift → 回退到单选 clickId（仍可触发）", () => {
      const cur: SelectionState = { primary: 3, selected: new Set([3]), anchor: 3 };
      const r = nextSelection(items, cur, 999, "shift");
      expect(r.primary).toBe(999);
      expect([...r.selected]).toEqual([999]);
    });
    it("clickId 不在 feedItems 里，none/ctrl → 集合里塞 clickId（行为由调用方保证合法性）", () => {
      // 这条记录 nextSelection 的宽容行为：函数不校验 clickId 是否在 feedItems 里；
      // 调用方（Feed.svelte）已经从当前可见的 $feedItems 里取 clickId。
      const r1 = nextSelection(items, empty(), 999, "none");
      expect(r1.primary).toBe(999);
      expect([...r1.selected]).toEqual([999]);
      const r2 = nextSelection(items, empty(), 999, "ctrl");
      expect(r2.primary).toBe(999);
      expect([...r2.selected]).toEqual([999]);
    });
  });
});
