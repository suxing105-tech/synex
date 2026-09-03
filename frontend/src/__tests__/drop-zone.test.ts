import { describe, it, expect } from "vitest";

// 测纯函数：pickImageFiles
// 实际函数在 Feed.svelte 里；这里复刻一份保持测试独立。
function pickImageFilesFrom(dt: { items?: ArrayLike<{ kind: string; getAsFile(): File | null }>; files?: ArrayLike<File> } | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items && dt.items.length) {
    for (let i = 0; i < dt.items.length; i++) {
      const it = dt.items[i];
      if (it.kind !== "file") continue;
      const f = it.getAsFile();
      if (f && f.type.startsWith("image/")) out.push(f);
    }
  } else if (dt.files) {
    for (let i = 0; i < dt.files.length; i++) {
      const f = dt.files[i];
      if (f.type.startsWith("image/") || /\.(png|webp)$/i.test(f.name)) {
        out.push(f);
      }
    }
  }
  return out;
}

class FakeFile {
  constructor(public name: string, public type: string = "") {}
}
class FakeDataTransferItem {
  constructor(public kind: string, public file: FakeFile | null) {}
  getAsFile(): File | null {
    return this.file as unknown as File;
  }
}

describe("pickImageFiles", () => {
  it("从 items 中挑出图片", () => {
    const dt = {
      items: [
        new FakeDataTransferItem("file", new FakeFile("a.png", "image/png")),
        new FakeDataTransferItem("file", new FakeFile("b.jpg", "image/jpeg")),
        new FakeDataTransferItem("file", new FakeFile("c.webp", "image/webp")),
        new FakeDataTransferItem("string", null),
      ],
    };
    const out = pickImageFilesFrom(dt);
    expect(out).toHaveLength(3);
  });

  it("从 files fallback（无 mime 但有 png/webp 扩展名）", () => {
    const dt = {
      files: [
        new FakeFile("a.png", "") as unknown as File,
        new FakeFile("b.PNG", "") as unknown as File,
        new FakeFile("c.webp", "") as unknown as File,
        new FakeFile("d.jpg", "") as unknown as File,  // 没扩展名匹配 → 跳过
      ],
    };
    const out = pickImageFilesFrom(dt);
    // 应当挑出 png / PNG / webp（不包含 d.jpg）
    expect(out.map((f: any) => f.name).sort()).toEqual(["a.png", "b.PNG", "c.webp"]);
  });

  it("空 DataTransfer 返回空数组", () => {
    expect(pickImageFilesFrom(null)).toEqual([]);
    expect(pickImageFilesFrom({ items: [], files: [] })).toEqual([]);
  });

  it("非 file kind 一律忽略", () => {
    const dt = {
      items: [
        new FakeDataTransferItem("string", null),
        new FakeDataTransferItem("directory", null),
      ],
    };
    expect(pickImageFilesFrom(dt)).toEqual([]);
  });
});
