import { describe, expect, it } from 'vitest';
import {
  API_POP_WIDTH, API_TWO_COL_MIN, leftOnlyRoom, popAnchor, POP_MIN_ROOM, roomLeft, roomRight,
} from '../lib/clone-pop-anchor';

/**
 * 这两层弹层的余量算式（见 lib/clone-pop-anchor.ts）。之所以在组件外面单测：
 * happy-dom 不排版、rect 全是 0，组件里那句 measurePops 只能验到兜底那一档，
 * 「哪边宽往哪边长」这条判断必须自己喂矩形才验得动。
 */
describe('弹层往哪边长：两侧各量一份', () => {
  it('本轮那张图那一档：胶囊落到行首，左边只剩 265 而右边有 463 → 往右长', () => {
    // 1304 宽的窗口、侧栏与详情栏都开着：面板 291..948（657 宽，已经收回上下结构），
    // 那颗胶囊落在底部那一排的行首 460..581。旧算式只量左边 → 452 的两栏被压成 265，
    // 右列整列模型名没了、「已实测」剩「已实」——就是苏醒照的那张图。
    const panel = { left: 291, right: 948 };
    const wrap = { left: 460, right: 581 };
    expect(roomLeft(panel, wrap)).toBe(265);
    expect(roomRight(panel, wrap)).toBe(463);
    expect(popAnchor(panel, wrap)).toEqual({ side: 'right', room: 463 });
    // 往右长就有 452 的设计宽，两栏放得下，不该再上下叠
    expect(Math.min(API_POP_WIDTH, 463)).toBe(API_POP_WIDTH);
  });

  it('2026-11-11 那一档没被改坏：那颗贴着行的右边 → 照旧往左长', () => {
    // 两栏那一档，底部那一排在右列里，这颗的右沿快到面板右内沿（1881 宽的窗口实测过）
    const panel = { left: 351, right: 1127 };
    const wrap = { left: 940, right: 1049 };
    expect(popAnchor(panel, wrap)).toEqual({ side: 'left', room: 673 });
  });

  it('量不到（rect 全 0）时落回贴左那一侧，并且从地板起、不写负数', () => {
    const zero = { left: 0, right: 0 };
    expect(popAnchor(zero, zero)).toEqual({ side: 'left', room: POP_MIN_ROOM });
    expect(POP_MIN_ROOM).toBe(240);
  });

  it('两侧一样宽也算左边那份：锚点只认一个来源，别一半窗口一种摆法', () => {
    const panel = { left: 0, right: 600 };
    const wrap = { left: 200, right: 400 };
    expect(roomLeft(panel, wrap)).toBe(roomRight(panel, wrap));
    expect(popAnchor(panel, wrap).side).toBe('left');
  });
});

describe('两栏放不放得下', () => {
  it('360 是加出来的下限：差一档就宁上下叠', () => {
    // 34 = 弹层左右内边距加描边，140 = 左列，12 = 列距，174 = 右列那一行的最低开销
    expect(API_TWO_COL_MIN).toBe(34 + 140 + 12 + 174);
    expect(Math.min(API_POP_WIDTH, 463)).toBeGreaterThanOrEqual(API_TWO_COL_MIN);
    // 538 的窗口那一档：右边只剩 341，两栏放不下，必须走上下叠
    expect(Math.min(API_POP_WIDTH, 341)).toBeLessThan(API_TWO_COL_MIN);
  });
});

describe('只许贴左往右长的那一层', () => {
  it('画面参数那颗在行的最右边：封顶只认左边，右边再宽也不算进来', () => {
    const panel = { left: 0, right: 1000 };
    const wrap = { left: 700, right: 900 };
    expect(roomRight(panel, wrap)).toBe(275);
    expect(leftOnlyRoom(panel, wrap)).toBe(875);
    // 左边窄到不够时同样落在地板，不给负数
    expect(leftOnlyRoom(panel, { left: 10, right: 110 })).toBe(POP_MIN_ROOM);
  });
});
