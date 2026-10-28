import { describe, expect, it } from "vitest";
import { basenameOnly, footerMetaText } from "../lib/media-format";

describe("页脚第一行：保留扩展名的文件名", () => {
  it("扩展名原样留着——用户要看得出这是 .png 还是 .psd", () => {
    expect(basenameOnly("original.jpg")).toBe("original.jpg");
    expect(basenameOnly("AnimateDiff_00001.png")).toBe("AnimateDiff_00001.png");
    expect(basenameOnly("vlog.final.cut.mp4")).toBe("vlog.final.cut.mp4");
    expect(basenameOnly("山雾.PNG")).toBe("山雾.PNG");
  });

  it("只取最后一段路径，反斜杠和正斜杠都算", () => {
    expect(basenameOnly("D:/a/b.png")).toBe("b.png");
    expect(basenameOnly("D:\\a\\b.png")).toBe("b.png");
    expect(basenameOnly("无目录.psd")).toBe("无目录.psd");
  });

  it("点号开头、没有扩展名、空串都不炸", () => {
    expect(basenameOnly(".gitignore")).toBe(".gitignore");
    expect(basenameOnly("README")).toBe("README");
    expect(basenameOnly("")).toBe("");
  });
});

describe("页脚第二行：尺寸 · 大小 · 时长", () => {
  it("图片：尺寸 + 大小，不带秒数", () => {
    expect(footerMetaText({ width: 1920, height: 1080, sizeText: "5.5MB" }))
      .toBe("1920×1080 · 5.5MB");
  });

  it("视频：尺寸 + 大小 + 秒数", () => {
    expect(footerMetaText({ width: 1280, height: 720, sizeText: "12.3MB", durationSeconds: 42 }))
      .toBe("1280×720 · 12.3MB · 0:42");
  });

  it("音频：没有宽高，只剩时长", () => {
    expect(footerMetaText({ width: null, height: null, durationSeconds: 42 })).toBe("0:42");
  });

  it("缺哪个字段就整段省略，不留孤立的分隔符", () => {
    expect(footerMetaText({ width: null, height: null, sizeText: null, durationSeconds: null })).toBe("");
    expect(footerMetaText({ width: 800, height: null, sizeText: "1MB" })).toBe("1MB");
    expect(footerMetaText({ width: 800, height: 600, sizeText: null })).toBe("800×600");
  });

  it("分隔符用 × 和 ·，和 Lightbox 的读数同一口径", () => {
    const text = footerMetaText({ width: 800, height: 600, sizeText: "1MB", durationSeconds: 5 });
    expect(text).toContain("×");
    expect(text).not.toContain("*");
    expect(text.split(" · ")).toHaveLength(3);
  });
});
