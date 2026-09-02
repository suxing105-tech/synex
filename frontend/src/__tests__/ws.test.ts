import { describe, it, expect } from "vitest";
import { copyText, formatSize, formatDate, paramsToKv, allParamsText } from "../lib/ws";

describe("工具函数", () => {
  it("formatSize 正确处理 B / KB / MB / GB", () => {
    expect(formatSize(500)).toBe("500 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(1024 * 1024 * 2.5)).toBe("2.5 MB");
    expect(formatSize(1024 * 1024 * 1024 * 1.5)).toBe("1.50 GB");
  });

  it("formatDate 返回本地化字符串", () => {
    const s = formatDate(1700000000);
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThan(0);
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
