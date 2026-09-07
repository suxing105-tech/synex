import { describe, it, expect } from "vitest";
import { extractLoras, formatWeight, groupParams, truncateValue } from "../lib/params";

describe("formatWeight（LoRA 强度 2 位小数对齐）", () => {
  it("整数 → '2.00' 形式（保留 .00 让列宽统一）", () => {
    expect(formatWeight(2)).toBe("2.00");
    expect(formatWeight(1)).toBe("1.00");
    expect(formatWeight(0)).toBe("0.00");
  });

  it("一位小数 → '0.80'", () => {
    expect(formatWeight(0.8)).toBe("0.80");
    expect(formatWeight(1.5)).toBe("1.50");
  });

  it("两位小数原样保留", () => {
    expect(formatWeight(0.88)).toBe("0.88");
    expect(formatWeight(1.45)).toBe("1.45");
  });

  it("三位小数四舍五入", () => {
    expect(formatWeight(0.123)).toBe("0.12");
    expect(formatWeight(0.456)).toBe("0.46");
  });

  it("负权重（抑制 LoRA）保留负号", () => {
    expect(formatWeight(-0.9)).toBe("-0.90");
    expect(formatWeight(-1.0)).toBe("-1.00");
  });

  it("正数输出统一 4 字符，列表右对齐", () => {
    const samples = [2, 1, 0.9, 0.88, 0.6, 0.3];
    const formatted = samples.map(formatWeight);
    expect(new Set(formatted.map((s) => s.length)).size).toBe(1);
  });
});

