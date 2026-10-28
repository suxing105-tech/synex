import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import postcss from "postcss";

/**
 * 全站缩略图的形状语言钉在这里：常态无框、hover 只放大画面、选中才有那一圈描边。
 * 这条测试读 app.css 而不是截图，是因为「无框」这件事在 jsdom 里量不出来，
 * 但代码写歪（比如有人手滑把 hover 描边加回来）能被它当场抓住。
 */

const css = postcss.parse(readFileSync("src/app.css", "utf8"));
const source = readFileSync("src/app.css", "utf8");

type ThumbRule = Parameters<Parameters<typeof css.walkRules>[0]>[0];

function ruleOf(selector: string): ThumbRule | null {
  let found: ThumbRule | null = null;
  css.walkRules((rule) => {
    const parts = rule.selector.split(",").map((s) => s.trim());
    if (parts.includes(selector) && !found) found = rule;
  });
  return found;
}

function decls(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  ruleOf(selector)?.walkDecls((decl) => { out[decl.prop] = decl.value; });
  return out;
}

function keyframes(): string[] {
  const names: string[] = [];
  css.walkAtRules("keyframes", (atRule) => { names.push(atRule.params); });
  return names;
}

it("卡片常态无框无阴影，圆角和底色走 token", () => {
  const card = decls(".media-card");
  expect(card.border).toBe("0");
  expect(card["box-shadow"]).toBeUndefined();
  expect(card["border-radius"]).toBe("var(--thumb-radius)");
  expect(card["overflow"]).toBe("hidden");
  expect(card.background).toBe("var(--thumb-bg)");
});

it("hover 什么都不加：描边只留给选中态，反馈全在画面放大", () => {
  // 卡片本体在 hover 时不画描边也不画阴影 —— 选中是唯一的描边状态，才有意义
  const hover = decls(".media-card:hover");
  expect(hover["box-shadow"]).toBeUndefined();
  expect(hover.outline).toBeUndefined();
  // hover 描边这个概念整体废掉了，token 也不该留下尸体
  expect(source).not.toContain("--thumb-hover-ring");
});

it("唯一的 hover 反馈是画面推近，图片与 hover 播放的视频同一档", () => {
  expect(decls(".media-card:hover .media-card-img").transform).toContain("scale(1.09)");
  expect(decls(".media-card:hover .media-card-video").transform).toContain("scale(1.09)");
});

it("选中态是 1px 贴合描边 + 外阴影，不用 outline 免得显粗", () => {
  const selected = decls(".media-card.is-selected");
  expect(selected.outline).toBeUndefined();
  expect(selected["outline-offset"]).toBeUndefined();
  // 0 扩散 + 1px 的 box-shadow 等价于贴外沿画一圈，不占布局、不会撑开卡片
  expect(selected["box-shadow"]).toMatch(/^0 0 0 1px var\(--thumb-ring\)/);
  expect(selected["box-shadow"]).toContain("rgba(0, 0, 0, 0.45)");
});

it("图区独立裁剪，放大不会溢到页脚上", () => {
  expect(decls(".media-card-media").overflow).toBe("hidden");
  const img = decls(".media-card-img");
  expect(img.position).toBe("absolute");
  expect(img.opacity).toBe("0");
  expect(decls(".media-card-img.is-loaded").opacity).toBe("1");
});

it("hover 播放层铺满图区，淡入压掉海报到首帧的硬切", () => {
  const video = decls(".media-card-video");
  expect(video.position).toBe("absolute");
  expect(video.inset).toBe("0");
  expect(video.animation).toContain("thumbVideoFade");
  expect(keyframes()).toContain("thumbVideoFade");
});

it("图未到达时有扫光占位，页脚不依赖它", () => {
  expect(keyframes()).toContain("thumbShimmer");
  const skeleton = decls(".media-card-skeleton");
  expect(skeleton.animation).toContain("thumbShimmer");
  expect(skeleton["pointer-events"]).toBe("none");
  // 页脚是实体底，必须是不透明色，不能半透明压在图上
  expect(decls(".media-card-footer").background).toBe("var(--thumb-bg)");
});

it("NEW 从呼吸角标退成名字前的红点，动画已删干净", () => {
  const dot = decls(".media-card-name.has-new::before");
  expect(dot["border-radius"]).toBe("50%");
  expect(dot.background).toBe("var(--thumb-accent)");
  expect(source).not.toContain("newGlow");
  expect(source).not.toContain(".new-badge");
});

it("页脚底色是压暗的那一档，不能悄悄漂回亮灰", () => {
  // 用户反馈 #27272a 太亮，文字条压不住画面；定在 #1c1c20，比图区底色 #1a1a1d 略亮一档，
  // letterbox 与页脚还分得开。改值必须同时改这里。
  const root: Record<string, string> = {};
  css.walkRules(":root", (rule) => { rule.walkDecls((d) => { root[d.prop] = d.value; }); });
  expect(root["--thumb-bg"]).toBe("#1c1c20");
  expect(root["--thumb-media-bg"]).toBe("#1a1a1d");
});
