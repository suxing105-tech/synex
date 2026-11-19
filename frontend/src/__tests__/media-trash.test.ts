import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

// 守护：界面上的「删除」只能意味着「移入回收站」，永久删除不许有界面入口。
//
// 病根（0.2.50 及以前）：图片/视频/音频的右键删除一路传到 Path.unlink()，一次误点就把
// 用户素材永久删掉；文本和文件夹却早就走系统回收站。同一个词在两类素材上语义不同，
// 用户只能靠运气分辨。后端已经收成默认进回收站（app/recycle.py），这份守卫钉住前端
// 不许把这条线倒回去：措辞要照实说，永久删除只留在 API 的 purge 参数上。

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".svelte") || name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

describe("媒体删除只剩「移入回收站」这一条语义", () => {
  it("api.remove 默认不 purge，两个参数都发给后端", () => {
    const api = read("lib", "api.ts");
    expect(api).toMatch(/remove\([\s\S]{0,240}?purge = false/);
    expect(api).toMatch(/remove_file=[^\n]*purge=/);
  });

  it("界面上没有任何地方请求永久删除", () => {
    const patterns = [
      /remove\([^)\n]*,\s*true\s*,\s*true/, // imagesApi.remove(id, true, true)
      /purge=true/,
      /purge:\s*true/,
    ];
    const hits: string[] = [];
    const targets = [...sourceFiles(join(srcRoot, "components")), join(srcRoot, "App.svelte")];
    for (const file of targets) {
      const text = readFileSync(file, "utf8");
      for (const re of patterns) if (re.test(text)) hits.push(file + " :: " + re.source);
    }
    expect(hits, "永久删除只能由 API 调用方显式 opt-in：" + hits.join(" | ")).toEqual([]);
  });

  it("网格里不再有「删除图片 / 批量删除」这种说法", () => {
    const feed = read("components", "Feed.svelte");
    const lightbox = read("components", "Lightbox.svelte");
    expect(feed).not.toMatch(/批量删除/);
    expect(feed).not.toMatch(/label:\s*[^,\n]*删除[^"\n]*"\s*,/);
    expect(lightbox).not.toMatch(/label:\s*"[^"\n]*删除[^"\n]*"\s*,/);
    expect(feed).toContain("移入回收站");
    expect(lightbox).toContain("移入回收站");
  });

  it("右键菜单和 Delete 键都先进确认框", () => {
    const feed = read("components", "Feed.svelte");
    // 单条 + 多选两条菜单，加键盘 Delete，三处都落在 askMediaTrash 上
    expect(feed.match(/onClick: \(\) => askMediaTrash\(items\)/g)?.length).toBe(2);
    expect(feed).toMatch(/askMediaTrash\(\$mediaItems\.filter/);
    expect(feed).toContain("确认移入回收站");
    // 唯一能调执行函数的地方是确认框的 runMediaTrash；菜单和按键都不许直接调
    expect(feed.match(/await deleteImages\(items\)/g)?.length).toBe(1); // 只有确认框里那一处
    expect(feed).not.toMatch(/onClick: \(\) => deleteImages/);
    expect(feed).not.toMatch(/void deleteImages\(/);
  });

  it("看图器里的删除也先确认，并且说清能找回", () => {
    const lightbox = read("components", "Lightbox.svelte");
    expect(lightbox).toContain("function confirmTrash(");
    expect(lightbox).toMatch(/if \(!confirmTrash\(targets\.length\)\) return;/);
    expect(lightbox).toContain("系统回收站里找回");
  });
});