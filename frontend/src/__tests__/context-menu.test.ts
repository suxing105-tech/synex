import { describe, it, expect } from "vitest";
import type { ImageSummary } from "../lib/types";

// 复刻 Feed/Lightbox 里的 sanitize 逻辑：保留原扩展名，强制剥离用户给的错误扩展名。
// 这是右键菜单 "重命名" 的输入校验纯函数部分。
function sanitizeFilename(input: string, currentFilename: string): string {
  const oldExt = (currentFilename.match(/\.[^.]+$/) ?? [""])[0];
  const trimmed = input.trim();
  if (!trimmed) return "";
  let stem = trimmed;
  const givenExt = (stem.match(/\.[^.]+$/) ?? [""])[0];
  if (givenExt && givenExt.toLowerCase() !== oldExt.toLowerCase()) {
    stem = stem.slice(0, stem.length - givenExt.length);
  }
  if (oldExt && !stem.toLowerCase().endsWith(oldExt.toLowerCase())) {
    stem = stem + oldExt;
  }
  return stem;
}

function isForbiddenFilename(name: string): boolean {
  if (!name || !name.trim()) return true;
  if (name === "." || name === "..") return true;
  if (/[\\\/\:*?"<>|]/.test(name)) return true;
  return false;
}

describe("右键菜单 重命名 输入清洗", () => {
  it("用户输入无扩展名 → 自动补回原扩展名", () => {
    expect(sanitizeFilename("foo", "x.png")).toBe("foo.png");
    expect(sanitizeFilename("  foo  ", "x.png")).toBe("foo.png");
  });

  it("用户输入扩展名一致 → 保留", () => {
    expect(sanitizeFilename("foo.png", "x.png")).toBe("foo.png");
    expect(sanitizeFilename("foo.PNG", "x.png")).toBe("foo.PNG"); // 大小写容忍
  });

  it("用户输入扩展名不一致 → 强制用原扩展名", () => {
    expect(sanitizeFilename("foo.jpg", "x.png")).toBe("foo.png");
    expect(sanitizeFilename("foo.tar.gz", "x.png")).toBe("foo.tar.png");
  });

  it("空 / 空白 → 返回空串（视为无效）", () => {
    expect(sanitizeFilename("", "x.png")).toBe("");
    expect(sanitizeFilename("   ", "x.png")).toBe("");
  });
});

describe("右键菜单 重命名 安全校验", () => {
  it("拒绝空、. / ..", () => {
    expect(isForbiddenFilename("")).toBe(true);
    expect(isForbiddenFilename("   ")).toBe(true);
    expect(isForbiddenFilename(".")).toBe(true);
    expect(isForbiddenFilename("..")).toBe(true);
  });

  it("拒绝路径分隔符与 Windows 非法字符", () => {
    for (const bad of ["a/b.png", "../etc/passwd", "a:b.png", "a*b.png", "a?b.png", "a|b.png", 'a"b.png', "a<b.png"]) {
      expect(isForbiddenFilename(bad)).toBe(true);
    }
  });

  it("正常文件名允许", () => {
    for (const ok of ["foo.png", "a.b.c.png", "中文 名字.png", "p (1).png"]) {
      expect(isForbiddenFilename(ok)).toBe(false);
    }
  });
});

describe("ImageSummary 构造样本（菜单测试用）", () => {
  it("构造 + 校验", () => {
    const sample: ImageSummary = {
      id: 1,
      filename: "p (1).png",
      path: "x.png",
      original_url: "/api/images/1/file?max=1024",
      kind: "image",
      thumbnail_url: "/api/images/1/file?max=1024",
      play_url: null,
      playable: null,
      duration_seconds: null,
      video_codec: null,
      audio_codec: null,
      fps: null,
      width: 1024,
      height: 1024,
      mtime: 1,
      size_bytes: 100,
      favorite: false,
      folder_ids: [],
      tags: [],
      model: null,
      seed: 1,
    };
    expect(sample.filename).toBe("p (1).png");
    expect(isForbiddenFilename(sample.filename)).toBe(false);
  });
});
