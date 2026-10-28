import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import postcss from "postcss";

/**
 * 音频缩略图的频谱波形样式锁在 Feed.svelte 的 scoped style 里（只有音频卡用）。
 * 关键不是颜色好不好看——那要人眼看——而是「颜色来自 CSS、形状来自后端波形 PNG 的
 * alpha 蒙版」这件事没被写歪：一旦有人把 mask-image 弄丢，所有音频卡会糊成一条矩形渐变。
 */
const source = readFileSync("src/components/Feed.svelte", "utf8");
const styleBlock = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source)?.[1];
if (!styleBlock) throw new Error("Feed.svelte 里没有 style 块");
const css = postcss.parse(styleBlock);

type Rule = Parameters<Parameters<typeof css.walkRules>[0]>[0];
function ruleOf(selector: string): Rule | null {
  let found: Rule | null = null;
  css.walkRules((rule) => {
    const parts = rule.selector.split(",").map((p) => p.trim());
    if (parts.includes(selector) && !found) found = rule;
  });
  return found;
}
function decls(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  ruleOf(selector)?.walkDecls((d) => { out[d.prop] = d.value; });
  return out;
}
function keyframes(): string[] {
  const names: string[] = [];
  css.walkAtRules("keyframes", (a) => { names.push(a.params); });
  return names;
}

it("形状来自蒙版、颜色来自 CSS 渐变，两边都指同一个 --wave", () => {
  const wave = decls(".audio-wave");
  expect(wave["--wave-hue"]).toContain("#4ade80");   // 频谱中段
  expect(wave["--wave-hue"]).toContain("#f24e4e");   // 右端收在 accent 红
  expect(wave["pointer-events"]).toBe("none");
  expect(wave.opacity).toBe("0");                    // 波形图到达前不露
  expect(decls(".audio-wave.is-live").opacity).toBe("1");

  for (const sel of [".audio-wave-fill", ".audio-wave-sweep"]) {
    const d = decls(sel);
    expect(d["mask-image"], sel).toBe("var(--wave)");
    expect(d["-webkit-mask-image"], sel).toBe("var(--wave)");
    // 波形被刻意纵向拉长（见 --wave-size-y），蒙版尺寸跟着变量走
    expect(d["mask-size"], sel).toBe("100% var(--wave-size-y)");
    // 拉长之后必须居中，否则波形从卡片顶边开始画，跟贯穿亮线错位
    expect(d["mask-position"], sel).toBe("center");
    expect(d["-webkit-mask-position"], sel).toBe("center");
  }
  expect(decls(".audio-wave-fill")["background-image"]).toBe("var(--wave-hue)");
});

it("波形刻意纵向拉高让画面更饱满，并把 transform 让给播放中的呼吸动画", () => {
  // 后端那张 PNG 只在中间约 55% 高的一条里画波形，蒙版铺满卡片时太细。
  // 放大倍数是唯一的观感旋钮：写在 .audio-wave 上、由子层蒙版继承。
  const sizeY = decls(".audio-wave")["--wave-size-y"];
  const pct = Number.parseFloat(sizeY);
  expect(sizeY, "缺少 --wave-size-y").toContain("%");
  expect(pct).toBeGreaterThanOrEqual(150);
  expect(pct).toBeLessThanOrEqual(300);

  // 缩放不能写成静态 transform：它会盖掉 audioWaveBreath 里的 transform，
  // 播放中那一张就不再呼吸了。
  expect(decls(".audio-wave").transform).toBeUndefined();
  expect(decls(".audio-wave")["transform-origin"]).toBe("50% 50%");
  const scaleValues: number[] = [];
  css.walkAtRules("keyframes", (atRule) => {
    if (atRule.params !== "audioWaveBreath") return;
    atRule.walkDecls((d) => {
      const m = /scaleY\(([0-9.]+)\)/.exec(d.value);
      if (m) scaleValues.push(Number.parseFloat(m[1]));
    });
  });
  expect(Math.max(...scaleValues), "呼吸动画被弄丢了").toBeGreaterThan(1);

  // 波形变高之后光晕要更实一点，否则看着像一块平的渐变色
  expect(Number.parseFloat(decls(".audio-wave-halo").opacity)).toBeGreaterThanOrEqual(0.6);
});

it("光晕的 blur 套在没蒙版的父层上，否则糊不出光", () => {
  // filter 在 mask 之后作用于元素自身的话，实心渐变矩形 blur 完还是矩形
  expect(decls(".audio-wave-halo").filter).toContain("blur(");
  expect(decls(".audio-wave-halo")["mask-image"]).toBeUndefined();
});

it("播放控件坐在页脚右端，尺寸跟着页脚高度走", () => {
  const btn = decls(".audio-play-btn");
  expect(btn.cursor).toBe("pointer");
  expect(btn.position).toBe("absolute");
  // 曾经是 inset-0 铺满整张卡压在波形中间，出现 inset 就是退回去了
  expect(btn.inset).toBeUndefined();
  expect(btn.right).toBe("8px");
  // 垂直位置靠 --card-footer-h 居中在页脚那一格里（Feed 内联，与 footerHeightFor 同源）
  expect(btn.bottom).toContain("--card-footer-h");

  const clamp = decls(".media-card.is-audio")["--audio-btn"];
  expect(clamp, "角标尺寸要由页脚高度派生").toMatch(
    /^clamp\([0-9.]+px, calc\(var\(--card-footer-h, 0px\) - [0-9.]+px\), [0-9.]+px\)$/
  );
  // 上限是被否过的 22px 之外重新定的，太小他还要再说一轮；下限保证没有页脚时仍点得到
  const upper = Number.parseFloat(/, ([0-9.]+)px\)$/.exec(clamp)?.[1] ?? "0");
  const lower = Number.parseFloat(/^clamp\(([0-9.]+)px/.exec(clamp)?.[1] ?? "0");
  expect(upper).toBeGreaterThanOrEqual(30);
  expect(lower).toBeGreaterThanOrEqual(18);

  // 文件名要让开角标，否则长名字会伸到按钮底下
  expect(decls(".media-card.is-audio .media-card-footer")["padding-right"]).toContain("var(--audio-btn)");
  expect(decls(".audio-play-icon")["pointer-events"]).toBe("auto");
  expect(decls(".audio-play-btn:hover .audio-play-icon").transform).toContain("scale(");
});

it("贯穿亮线 + 常态静止：动画只给 hover 与正在播放那一张", () => {
  const line = decls(".audio-wave-line");
  expect(line.height).toBe("1px");
  expect(line.background).toContain("linear-gradient");
  expect(decls(".audio-wave").animation).toBeUndefined();
  expect(decls(".media-card:hover .audio-wave-sweep").animation).toContain("audioWaveSweep");
  const playing = decls(".media-card.is-playing .audio-wave");
  expect(playing.animation).toContain("audioWaveBreath");
  expect(playing.animation).toContain("infinite alternate");
  const names = keyframes();
  expect(names).toContain("audioWaveSweep");
  expect(names).toContain("audioWaveBreath");
});

it("后端 PNG 退成加载探针，不再直接显示", () => {
  // 探针还要负责 onload/onerror，所以是 opacity 而不是 display:none
  expect(decls(".media-card.is-audio .media-card-img").opacity).toBe("0");
});

it("进度条在波形下面，带一个走带光点", () => {
  const track = decls(".audio-track");
  expect(track.bottom).toBe("8px");
  expect(track.top).toBeUndefined();
  expect(track.position).toBe("absolute");
  // 角标挪进页脚之后，进度轨恢复铺满图区宽度
  expect(track.right).toBe("10px");
  // 不再是压在图区顶部的那条实心红线
  const bar = decls(".audio-progress");
  expect(bar.background).toContain("linear-gradient");
  expect(bar.background).not.toBe("#f24e4e");
  const knob = decls(".audio-progress-knob");
  expect(knob["border-radius"]).toBe("50%");
  expect(knob["box-shadow"]).toContain("rgba(255, 214, 170");
});
