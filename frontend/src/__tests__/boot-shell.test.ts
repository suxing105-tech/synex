import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 首帧预挂载壳：窗口亮起到 Svelte 挂载之间那段「只有标题栏的空窗口」由它补。
//
// 三条必须钉住的约束：
// 1) 不能有内联脚本 —— CSP 是 script-src 'self'，写了就是静默失效（壳永远留在页面上），
//    所以移除动作在 bundle 里的 main.ts 做。
// 2) 底色三处同值（预挂载壳 / SplashOverlay / tauri 窗口 backgroundColor），
//    不同色就在交接那一帧闪一下。
// 3) 移除必须发生在 mount() 之后：mount 是同步的，同帧交接才不留空白。

const html = readFileSync(resolve("index.html"), "utf8");
const main = readFileSync(resolve("src/main.ts"), "utf8");
const overlay = readFileSync(resolve("src/components/SplashOverlay.svelte"), "utf8");
const conf = JSON.parse(readFileSync(resolve("src-tauri/tauri.conf.json"), "utf8"));

describe("首帧预挂载壳", () => {
  it("index.html 提供 #boot-shell，且只有外链脚本", () => {
    expect(html).toContain('id="boot-shell"');
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html).toMatch(/<script type="module" src="\/src\/main\.ts"><\/script>/);
  });

  it("壳在 #app 之外，不会被 Svelte 挂载吃掉", () => {
    expect(html.indexOf('id="app"')).toBeLessThan(html.indexOf('id="boot-shell"'));
  });

  it("底色三处同值，交接不闪色", () => {
    const base = "#0e0e10";
    expect(conf.app.windows[0].backgroundColor).toBe(base);
    const shellBlock = html.match(/#boot-shell \{[\s\S]*?\}/);
    expect(shellBlock, "找不到 #boot-shell 样式块").toBeTruthy();
    expect(shellBlock![0]).toContain(base);
    const overlayBlock = overlay.match(/\.splash-overlay \{[\s\S]*?\}/);
    expect(overlayBlock, "找不到 .splash-overlay 样式块").toBeTruthy();
    expect(overlayBlock![0]).toContain(base);
  });

  it("main.ts 在 mount(App) 之后同步移除壳", () => {
    expect(main).toMatch(/mount\(\s*App\s*,[\s\S]*?getElementById\("boot-shell"\)\?\.remove\(\)/);
  });
});
