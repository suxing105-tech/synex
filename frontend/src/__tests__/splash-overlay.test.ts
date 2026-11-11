import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import SplashOverlay from "../components/SplashOverlay.svelte";

// 启动引导页（展示层）回归：三段编排 + 错误态 + 无障碍。
//
// 这一轮守的是「别让它看起来慢」。
// 上一版把滑块头钉在 18% 不动，换来的是「一条卡住的进度条」——那正是本轮要修的观感。
// 现在：字标 240ms 点亮 → 地标滑块装配 → 扫描头沿轨来回扫（诚实的 indeterminacy：
// 来回的东西读不出百分比，但一定读得出「还在干活」）→ 220ms 淡出收场。
// 字标用 /logo.png 的透明通道当 CSS mask，所以不需要另画一份矢量。

afterEach(cleanup);

const src = readFileSync(resolve("src/components/SplashOverlay.svelte"), "utf8");

describe("启动引导页（画廊成形 · 品牌段）", () => {
  it("boot 段：字标 + 地标线 + 文案，旋转环和假进度条都已删除", () => {
    const ui = render(SplashOverlay, { phase: "boot", error: null });
    expect(ui.getByRole("img", { name: "闪寻空间" })).toBeTruthy();
    expect(ui.getByText("正在唤醒本地引擎")).toBeTruthy();
    expect(ui.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(ui.container.querySelector(".splash-rule")).toBeTruthy();
    expect(ui.container.querySelector(".splash-orbit")).toBeNull();
    expect(ui.container.querySelector(".splash-track")).toBeNull();
  });

  it("index 段换文案，且不出现品牌中文名（首屏品牌只保留 LOGO）", () => {
    const ui = render(SplashOverlay, { phase: "index", error: null });
    expect(ui.getByText("正在整理图库")).toBeTruthy();
    expect(ui.queryByText("苏醒图库")).toBeNull();
  });

  it("光带靠 mask 只走字形，不再贴一张会露白底的 logo 图", () => {
    expect(src).toMatch(/mask:\s*url\("?\ \/ ?logo\.png\)?|mask:\s*url\(\/logo\.png\)/);
    expect(src).not.toMatch(/class="splash-logo"/);
    // 地标线必须在字标外面：mask 裁的是整棵子树，放进去就一起被裁掉
    expect(src).toMatch(/<div class="splash-mark"[^>]*><\/div>\s*\n\s*<span class="splash-rule"/);
  });

  it("地标就是主界面那枚缩略图滑块：几何与色值共用一份，不另拍一套", () => {
    const feed = readFileSync(resolve("src/components/Feed.svelte"), "utf8");
    const rule = src.match(/\.splash-rule \{[\s\S]*?\}/);
    expect(rule, "找不到 .splash-rule 样式块").toBeTruthy();
    expect(rule![0]).toMatch(/position:\s*relative/);
    expect(rule![0]).toMatch(/height:\s*14px/);
    // 细轨 4px / 静止色 / 圆头 14px + 2px 底色内环：四条都跟 Feed 那枚滑块同值
    expect(feed).toMatch(/\.columns-slider \{[\s\S]*?height: 4px;[\s\S]*?rgb\(50 50 55\)/);
    expect(feed).toMatch(/::-webkit-slider-thumb \{[\s\S]*?width: 14px;[\s\S]*?border: 2px solid rgb\(24 24 27\)/);
    const track = src.match(/\.rule-track \{[\s\S]*?\}/);
    expect(track![0]).toContain("#323237");
    expect(src).toMatch(/height:\s*4px;\n\s*border-radius:\s*2px;/);
    const thumb = src.match(/\.rule-thumb \{[\s\S]*?\}/);
    expect(thumb![0]).toContain("width: 14px");
    expect(thumb![0]).toContain("border: 2px solid #18181b");
  });

  it("扫描头一直在动：不许再出现「停在某个百分比不动」的进度条", () => {
    // 圆头停在 18% 读出来就是「进度 18%，然后卡住了」——本轮要修的正是这个。
    // 来回扫不报百分比（仍然诚实），但一秒钟两趟，谁都读得出它没死。
    const runner = src.match(/\.rule-runner \{[\s\S]*?\}/);
    expect(runner, "找不到 .rule-runner（扫描头外层）").toBeTruthy();
    expect(runner![0]).toMatch(/animation: splash-scan \d+ms[\s\S]*?infinite alternate both/);
    // 光带与圆头必须共用同一条 keyframes + 同一套时长，否则扫到中途就不同心
    const glow = src.match(/\.rule-glow \{[\s\S]*?\}/);
    expect(glow, "找不到 .rule-glow（扫描头的光带）").toBeTruthy();
    expect(glow![0]).toMatch(/animation: splash-scan[\s\S]*?infinite alternate both/);
    const dur = (blk: string) => blk.match(/animation: splash-scan (\d+)ms/)![1];
    expect(dur(glow![0])).toBe(dur(runner![0]));
    expect(glow![0]).toMatch(/linear-gradient\(90deg, transparent/);
    // 行程 = 轨宽 - 圆头宽：两头正好贴轨，和主页那枚滑块的可达范围一模一样
    const scan = src.match(/@keyframes splash-scan \{[\s\S]*?\n  \}/);
    expect(scan, "找不到 splash-scan keyframes").toBeTruthy();
    const ruleW = Number(src.match(/\.splash-rule \{[\s\S]*?width: (\d+)px/)![1]);
    const thumbW = Number(src.match(/\.rule-thumb \{[\s\S]*?width: (\d+)px/)![1]);
    expect(Number(scan![0].match(/translateX\((\d+)px\)/)![1])).toBe(ruleW - thumbW);
    // 光带由轨道框 overflow:hidden 裁两端：启动页不许逐帧重画 clip-path
    expect(src).not.toMatch(/clip-path\s*:/);
    expect(src).toMatch(/\.rule-scan \{[\s\S]*?overflow: hidden;/);
    // 收场不再补「滑到最右」：淡出期间任何抢戏的位移都会被读成「还没完」
    expect(src).not.toMatch(/splash-thumb-run|splash-rule-done|splash-rule-fill/);
  });

  it("就绪闪光与滑块收场真的会走：mask 与 position 两个坑各钉一条", () => {
    // 光带是 mask 子树里的元素：transform 停在 box 外时，只动 opacity 等于什么都没演
    const flash = src.match(/\.is-leaving \.splash-mark::after \{[\s\S]*?\}/);
    expect(flash, "找不到就绪闪光规则").toBeTruthy();
    expect(flash![0]).not.toMatch(/transform:\s*translateX\(340%\)/);
    const kf = src.match(/@keyframes splash-ready-flash \{[\s\S]*?\n  \}/);
    expect(kf, "找不到就绪闪光 keyframes").toBeTruthy();
    expect(kf![0]).toMatch(/translateX\(-180%\)/);
    expect(kf![0]).toMatch(/translateX\(340%\)/);
  });

  it("收场时长三处同值：卸载计时 / splash-fade-out / card-materialize", () => {
    const js = Number(src.match(/const LEAVE_MS = (\d+);/)![1]);
    const css = Number(src.match(/animation: splash-fade-out (\d+)ms/)![1]);
    const feed = readFileSync(resolve("src/components/Feed.svelte"), "utf8");
    const mat = Number(feed.match(/animation: card-materialize (\d+)ms/)![1]);
    // 220ms 是「快机器上遮罩最多压多久」的一部分，别把它悄悄加回去
    expect(js).toBe(220);
    expect(css).toBe(js);
    expect(mat).toBe(js);
  });

  it("ready 先演淡出再卸载，不是硬切", async () => {
    vi.useFakeTimers();
    try {
      const ui = render(SplashOverlay, { phase: "index", error: null });
      await ui.rerender({ phase: "ready", error: null });
      const el = ui.container.querySelector(".splash-overlay");
      expect(el, "收场要先留一段淡出").toBeTruthy();
      expect(el!.classList.contains("is-leaving")).toBe(true);
      expect(el!.getAttribute("aria-busy")).toBe("false");
      await vi.advanceTimersByTimeAsync(220);
      await tick();
      expect(ui.container.querySelector(".splash-overlay")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("以 ready 创建时根本不渲染：浏览器 dev 不该闪一下启动页", () => {
    const ui = render(SplashOverlay, { phase: "ready", error: null });
    expect(ui.container.querySelector(".splash-overlay")).toBeNull();
  });

  it("启动失败：停动画、给具体原因、并留一条重试出口", () => {
    const ui = render(SplashOverlay, { phase: "error", error: "连接失败" });
    expect(ui.getByRole("alert").textContent).toContain("连接失败");
    expect(ui.getByText(/请关闭应用后重新打开/)).toBeTruthy();
    expect(ui.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(ui.getByRole("status").getAttribute("aria-busy")).toBe("false");
    expect(src).toMatch(/\.has-error,[\s\S]{0,320}animation:\s*none;/);
    // 扫描头与圆头都是「动画负责从隐藏走到可见」，所以停动画必须把终态补回来，
    // 否则地标整条消失；红也要收掉——错误态什么都没在往前推
    // 选择器列表里那行 .has-error .rule-thumb { animation: none; } 也算一次命中，
    // 所以只认真正带声明的那一块：要求块里出现 background
    const errThumb = src.match(/\.has-error \.rule-thumb \{[^}]*background[^}]*\}/);
    expect(errThumb, "找不到错误态滑块头规则").toBeTruthy();
    expect(errThumb![0]).toMatch(/transform:\s*scale\(1\)/);
    expect(errThumb![0]).toMatch(/background:\s*#5a5a5f/);
    expect(errThumb![0]).not.toMatch(/242, 78, 78/);
    // 光带是「在扫」这件事本身，报错时它必须消失
    const errGlow = src.match(/\.has-error \.rule-glow \{[^}]*\}/);
    expect(errGlow, "找不到错误态光带规则").toBeTruthy();
    expect(errGlow![0]).toMatch(/opacity:\s*0/);
    // 扫描头停在轨左端，不是停在中间某个像坏掉的位置
    expect(src).toMatch(/\.has-error \.rule-runner \{\s*transform: translateX\(0\);/);
  });

  it("全屏无卡片、支持减少动画偏好，主界面品牌只保留 LOGO", () => {
    expect(src).toContain("position: fixed");
    expect(src).toContain("inset: 0");
    expect(src).not.toContain("splash-card");
    expect(src).toContain("prefers-reduced-motion: reduce");
    // 不扫了也要摆成一枚正常滑块：停在轨中，而不是缩在角上像缺了个零件
    expect(src).toMatch(/\.rule-runner \{ transform: translateX\(77px\); \}/);
    expect(src).toMatch(/\.rule-glow \{ opacity: 0; \}/);
    // 全屏遮罩不吃点击：淡出那 340ms 底下已经是可用界面
    expect(src).toMatch(/\.is-leaving\s*\{[\s\S]{0,80}pointer-events:\s*none/);
    // 品牌只在真顶栏上（桌面标题栏）：LOGO + 现名，不再写死旧产品名。
    // 旧的 components/HeaderBar.svelte 已经整块删掉（真顶栏是它 + Feed 的 .gallery-toolbar），
    // 所以这条断言改指 DesktopTitlebar，别对着不存在的文件空转。
    const titlebar = readFileSync(resolve("src/components/DesktopTitlebar.svelte"), "utf8");
    expect(titlebar).toContain('src="/logo.png"');
    expect(titlebar).not.toContain("<span>苏醒图库</span>");
  });
});
