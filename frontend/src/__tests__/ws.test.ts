import { describe, it, expect } from "vitest";
import { copyText, formatSize, formatDate, paramsToKv, allParamsText } from "../lib/ws";

describe("工具函数", () => {
  it("formatSize 正确处理 B / KB / MB / GB", () => {
    expect(formatSize(500)).toBe("500 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(1024 * 1024 * 2.5)).toBe("2.5 MB");
    expect(formatSize(1024 * 1024 * 1024 * 1.5)).toBe("1.50 GB");
  });

  // 第三刀 T14：输出锁死成 YYYY-MM-DD HH:mm:ss。原来只断言「是个非空字符串」，那种写法连 Invalid Date 都放过。
  it("formatDate 输出固定形状且各段补零", () => {
    expect(formatDate(new Date(2026, 10, 9, 8, 5, 3).getTime() / 1000)).toBe("2026-11-09 08:05:03");
    expect(formatDate(1700000000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("paramsToKv 转换为 [k, v][]", () => {
    const out = paramsToKv({ seed: 42, sampler: "euler" });
    expect(out).toContainEqual(["seed", "42"]);
    expect(out).toContainEqual(["sampler", "euler"]);
  });

  it("allParamsText 组合所有信息", () => {
    const txt = allParamsText({
      positive_prompt: "a cat",
      negative_prompt: "blurry",
      parameters: { steps: 20 },
      seed: 1234,
      model: "sd_xl",
      sampler: "euler",
      steps: 20,
      cfg: 7.0,
    });
    expect(txt).toContain("a cat");
    expect(txt).toContain("Negative prompt: blurry");
    expect(txt).toContain("Seed: 1234");
    expect(txt).toContain("Sampler: euler");
    expect(txt).toContain("Model: sd_xl");
    expect(txt).toContain("steps: 20");
  });

  it("copyText 在没有 clipboard API 时仍返回 boolean", async () => {
    // happy-dom 没有真实 clipboard，这里只验证返回类型
    const r = await copyText("hello");
    expect(typeof r).toBe("boolean");
  });
});
