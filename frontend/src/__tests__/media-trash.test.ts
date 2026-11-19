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

  it("移入回收站一次点击就走：菜单、Delete 键、看图器都直接执行", () => {
    const feed = read("components", "Feed.svelte");
    const lightbox = read("components", "Lightbox.svelte");
    // 单条 + 多选两条菜单，加键盘 Delete，三处都直接落到执行函数上
    expect(feed.match(/onClick: \(\) => void trashMedia\(items\)/g)?.length).toBe(2);
    expect(feed).toMatch(/void trashMedia\(\$mediaItems\.filter/);
    // 文本卡那颗也一样，不再先进 textDialog
    expect(feed).toContain("onClick: () => void trashText(it)");
    expect(lightbox).toContain("void deleteImage(it);");
  });

  // 苏醒 2026-11-18：可逆动作不设卡。原文件在系统回收站里能找回，
  // 再问一遍只是把一次点击变成两次。这条闸负责拦住「顺手加个确认框」的回潮。
  it("界面上没有「移入回收站」的二次确认", () => {
    const sources: Array<[string, string]> = [
      ["Feed", read("components", "Feed.svelte")],
      ["Lightbox", read("components", "Lightbox.svelte")],
      ["TextReader", read("components", "TextReader.svelte")],
      ["TextDetailPanel", read("components", "TextDetailPanel.svelte")],
    ];
    for (const [name, src] of sources) {
      expect(src, name + " 里又冒出了确认按钮").not.toContain("确认移入");
      expect(src, name + " 里又用了原生确认框").not.toMatch(/window\.confirm|\bconfirm\s*\(/);
    }
  });

  // 确认框没了，toast 就是唯一的回执：要点名动了哪一张，而且要留够时间读。
  it("回执点名动了哪一张，并且留够时间读", () => {
    const feed = read("components", "Feed.svelte");
    const lightbox = read("components", "Lightbox.svelte");
    expect(feed).toContain("已移入系统回收站：${succeeded[0].filename}");
    expect(feed).toContain("已移入系统回收站 ${okCount} 项");
    expect(feed).toContain("notify(done, 4000)");
    expect(lightbox).toContain("已移入系统回收站：${it.filename}");
  });
});