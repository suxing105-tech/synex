import { describe, expect, it } from "vitest";
import {
  asCounts,
  countBreakdown,
  countFor,
  formatCount,
  mediaSummary,
  scopeCaption,
  selectionSummary,
  totalOf,
  unitFor,
} from "../lib/counts";
import type { FolderCounts, Scope } from "../lib/types";

const counts: FolderCounts = { image: 40, video: 11, audio: 3, text: 40 };

describe("countFor · 一行只有一个口径", () => {
  it("单一 scope 只取该类型的数量，不是四类之和", () => {
    expect(countFor(counts, "image")).toBe(40);
    expect(countFor(counts, "video")).toBe(11);
    expect(countFor(counts, "audio")).toBe(3);
    expect(countFor(counts, "text")).toBe(40);
  });

  it("all 是四类之和", () => {
    expect(countFor(counts, "all")).toBe(94);
    expect(totalOf(counts)).toBe(94);
  });

  it("缺字段按 0 处理，不产生 NaN", () => {
    expect(countFor({ image: 5 } as Partial<FolderCounts>, "all")).toBe(5);
    expect(countFor({}, "audio")).toBe(0);
    expect(countFor({ video: Number.NaN } as Partial<FolderCounts>, "video")).toBe(0);
  });

  it("同一行在不同 scope 下就是不同的数字（老库的三种口径混用是这次要修的病根）", () => {
    const node = { counts: { image: 12, video: 0, audio: 0, text: 7 } };
    expect(countFor(node, "image")).toBe(12);
    expect(countFor(node, "text")).toBe(7);
    expect(countFor(node, "all")).toBe(19);
  });
});

describe("formatCount", () => {
  it("一万以内用千分位", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1000)).toBe("1,000");
    expect(formatCount(9999)).toBe("9,999");
  });

  it("一万以上折成「万」，侧栏宽度容不下长数字", () => {
    expect(formatCount(10000)).toBe("1万");
    expect(formatCount(12345)).toBe("1.2万");
    expect(formatCount(123456)).toBe("12.3万");
    expect(formatCount(1500000)).toBe("150万");
  });

  it("脏输入不炸", () => {
    expect(formatCount(-3)).toBe("0");
    expect(formatCount(Number.NaN)).toBe("0");
    expect(formatCount(12.9)).toBe("12");
  });
});

describe("countBreakdown · hover 明细", () => {
  it("四类全列，0 也列出来（「没有音频」本身就是信息）", () => {
    expect(countBreakdown({ image: 12, video: 0, audio: 2, text: 0 })).toBe(
      "12 张图片 · 0 个视频 · 2 条音频 · 0 篇文本",
    );
  });

  it("空节点也有完整四项", () => {
    expect(countBreakdown({})).toBe("0 张图片 · 0 个视频 · 0 条音频 · 0 篇文本");
  });
});

describe("mediaSummary · 工具栏计数行", () => {
  it("只列非零项，并带上量词", () => {
    expect(mediaSummary(counts)).toBe("40 张图片 · 11 个视频 · 3 条音频 · 40 篇文本");
    expect(mediaSummary({ image: 5, video: 0, audio: 0, text: 0 })).toBe("5 张图片");
    expect(mediaSummary({ image: 0, video: 2, audio: 0, text: 0 })).toBe("2 个视频");
    expect(mediaSummary({ image: 0, video: 0, audio: 1, text: 0 })).toBe("1 条音频");
    expect(mediaSummary({ image: 0, video: 0, audio: 0, text: 12 }))
      .toBe("12 篇文本");
  });

  it("全空时给中性量词，不显示空字符串", () => {
    expect(mediaSummary({ image: 0, video: 0, audio: 0, text: 0 })).toBe("0 项");
  });

  it("大数字同样走「万」", () => {
    expect(mediaSummary({ image: 12345, video: 0, audio: 0, text: 0 })).toBe("1.2万 张图片");
  });
});

describe("selectionSummary · 混合选区文案", () => {
  it("单一类型用专属量词", () => {
    expect(selectionSummary(4, ["image"])).toBe("已选 4 张图片");
    expect(selectionSummary(1, ["audio"])).toBe("已选 1 条音频");
  });

  it("跨类型用中性「项」", () => {
    expect(selectionSummary(3, ["image", "text"])).toBe("已选 3 项");
    expect(selectionSummary(3, [])).toBe("已选 3 项");
  });

  it("空选区不占位", () => {
    expect(selectionSummary(0, ["image"])).toBe("");
  });
});

describe("scopeCaption / unitFor", () => {
  it("口径小字随 scope 变化", () => {
    const expected: Record<Scope, string> = {
      all: "计数 · 全部素材",
      image: "计数 · 图片",
      video: "计数 · 视频",
      audio: "计数 · 音频",
      text: "计数 · 文本",
    };
    for (const scope of Object.keys(expected) as Scope[]) {
      expect(scopeCaption(scope)).toBe(expected[scope]);
    }
  });

  it("量词表覆盖四种类型，未知值回落中性", () => {
    expect(unitFor("image")).toBe("张图片");
    expect(unitFor("video")).toBe("个视频");
    expect(unitFor("audio")).toBe("条音频");
    expect(unitFor("text")).toBe("篇文本");
    expect(unitFor("all")).toBe("项");
  });
});

describe("asCounts", () => {
  it("只认四个已知字段，脏值丢弃", () => {
    const result = asCounts({ image: 3, video: "x", audio: null, text: 4 } as never);
    expect(result).toEqual({ image: 3, video: 0, audio: 0, text: 4 });
  });
});

describe("两种计数形状都要认（侧栏传的是 FolderNode）", () => {
  const folder = {
    id: 3,
    parent_id: null,
    name: "摄影",
    order: 0,
    counts: { image: 12, video: 2, audio: 1, text: 5 },
    total: 20,
    children: [],
  };

  it("FolderNode 走嵌套 counts，不是扁平字段", () => {
    expect(countFor(folder, "image")).toBe(12);
    expect(countFor(folder, "audio")).toBe(1);
    expect(countFor(folder, "all")).toBe(20);
    expect(countBreakdown(folder)).toBe("12 张图片 · 2 个视频 · 1 条音频 · 5 篇文本");
  });

  it("扁平 stats 仍然能用", () => {
    expect(countFor({ image: 40, video: 11, audio: 3, text: 40 }, "video")).toBe(11);
  });

  it("脏输入（null / 空 counts）不炸", () => {
    expect(countFor(null, "all")).toBe(0);
    expect(countFor({ counts: {} }, "text")).toBe(0);
    expect(countBreakdown({ counts: { image: 1 } })).toBe("1 张图片 · 0 个视频 · 0 条音频 · 0 篇文本");
  });
});
