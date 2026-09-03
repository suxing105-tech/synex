import { describe, it, expect } from "vitest";

// 复刻 HeaderBar 里的 splitPath（保持独立，方便纯函数测试）。
function splitPath(p: string): { parent: string; base: string } {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  if (idx < 0) return { parent: "", base: norm };
  return { parent: norm.slice(0, idx), base: norm.slice(idx + 1) };
}

describe("HeaderBar splitPath", () => {
  it("切 Windows 反斜杠路径", () => {
    const r = splitPath("D:\\AI\\ComfyUI\\output");
    expect(r).toEqual({ parent: "D:/AI/ComfyUI", base: "output" });
  });

  it("切 POSIX 正斜杠路径", () => {
    const r = splitPath("/home/user/Pictures");
    expect(r).toEqual({ parent: "/home/user", base: "Pictures" });
  });

  it("混用反斜杠 + 正斜杠（少见但兜底）", () => {
    const r = splitPath("D:/AI\\ComfyUI\\output");
    expect(r).toEqual({ parent: "D:/AI/ComfyUI", base: "output" });
  });

  it("单段无分隔符 → parent 空", () => {
    expect(splitPath("output")).toEqual({ parent: "", base: "output" });
  });

  it("尾段含点（文件名）正常切分", () => {
    expect(splitPath("C:/Pics/img.png")).toEqual({ parent: "C:/Pics", base: "img.png" });
  });

  it("尾段含空格 / 中文 / Unicode", () => {
    expect(splitPath("C:/AI 工具/输出/场景图")).toEqual({
      parent: "C:/AI 工具/输出",
      base: "场景图",
    });
  });
});
