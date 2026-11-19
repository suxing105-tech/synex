import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 破坏性动作只许有一套红（2026-11-13 oil-ui 评审第三刀 T10）。
 *
 * 项目自己早就有 --danger 这一档语义色（再次创作的删除按钮、CloneQueuePanel、PromptSkillModal
 * 都在用），但评审量出六处破坏性动作还在借 Tailwind 的 cool red 或手挑的暗红：
 * ContextMenu 菜单项 #f07178、文本弹窗两颗确认按钮 #5b2723/#7d3a34（Feed 与阅读层各一份）、
 * 反推面板与视频面板的删除按钮 #f87171/#7f1d1d/#2a1414、抽帧错误文字 #f87171。
 * 这两条规则随 2026-11-18 撤掉的「确认移入回收站」一起退掉了，理由记在下面逐条钉住那一节。
 * 品牌朱红 #f24e4e 是「选中 · 进行中 · 主动作」，破坏性动作借它反而把三件事混成一件，
 * 所以这一族并回 --danger，不是换成朱红。
 *
 * 只扫 <style> 里的规则块：JS 里的 `danger: true` 是菜单项配置，不是颜色。
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collect(p, out);
    else if (/\.(svelte|css)$/.test(entry.name)) out.push(p);
  }
  return out;
}
/** 只取样式来源：.svelte 的 <style> 块 + app.css 全文。 */
function styleText(file: string): string {
  const src = readFileSync(file, "utf8");
  const raw = file.endsWith(".svelte")
    ? [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
    : src;
  // 注释先剥掉：选择器前面常挂着说明注释，不剥会把它当成选择器的一部分
  return raw.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 平铺规则块；选择器带 danger 的才是本闸管的对象。 */
function dangerRules(text: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (/danger/i.test(selector)) out.push({ selector, body: m[2] });
  }
  return out;
}

const COOL_RED = /#f07178|#f87171|#7f1d1d|#2a1414|#5b2723|#7d3a34|#934747|(?:text|border|bg)-red-\d{2,3}/i;


describe("破坏性动作的红色只有一个真源 --danger（第三刀 T10）", () => {
  const files = collect(srcRoot);

  it("凡是选择器带 danger 的样式规则，只许引用 --danger，不许留第二套红", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const f of files) {
      for (const rule of dangerRules(styleText(f))) {
        checked += 1;
        const where = f.slice(srcRoot.length + 1) + " ▸ " + rule.selector;
        if (!/--danger/.test(rule.body)) offenders.push(where + " 没有引用 --danger");
        const hit = rule.body.match(COOL_RED);
        if (hit) offenders.push(where + " 还留着第二套红 " + hit[0]);
      }
    }
    // 现存七条（app.css 的 .dock-btn.is-danger、ContextMenu、PromptSkillModal 两条、
    // 反推面板、抽帧、视频面板）。少于这个数就是有规则被整条删掉或改了名，闸门本身失效了；
    // 2026-11-18 撤掉「确认移入回收站」时退了 Feed 与 TextReader 各一条，其余七条是新的底。
    expect(checked, "带 danger 的样式规则条数比预期少，检查是不是有人新写了不带 danger 的破坏性样式绕开闸").toBeGreaterThanOrEqual(7);
  });

  it("并回来的破坏性红逐条钉住，别再漂回去", () => {
    const at = (rel: string) => styleText(join(srcRoot, rel));
    expect(at("components/ContextMenu.svelte")).toMatch(/\.danger\s*\{\s*color:\s*var\(--danger\);/);
    expect(at("components/VideoFrameThumb.svelte")).toMatch(/\.vt-danger\s*\{\s*color:\s*var\(--danger\);/);
    // Feed 的 .dialog-actions .danger 与 TextReader 的 .text-modal .danger 曾经在
    // 「确认移入回收站」那颗按钮上（2026-11-13 并回 --danger）。2026-11-18 那颗按钮连着
    // 确认框一起撤了（可逆动作不设卡），两条规则跟着退掉，不是被改了名绕开闸。
    // 谁要再把那颗确认按钮加回来，先过 __tests__/media-trash.test.ts 那道「不许二次确认」的闸。
    for (const [rel, selector] of [
      ["components/ReversePromptPanel.svelte", "button.danger"],
      ["components/VideoPromptPanel.svelte", ".vp-danger"],
    ] as const) {
      const body = dangerRules(at(rel)).find((r) => r.selector === selector);
      if (!body) throw new Error(rel + " 里找不到 " + selector);
      expect(body.body, rel + " 的删除按钮不再是描边+淡底").toMatch(/border-color:\s*rgb\(var\(--danger-rgb\) \/ 45%\)/);
      expect(body.body, rel + " 的删除按钮缺淡底").toMatch(/background:\s*rgb\(var\(--danger-rgb\) \/ 8%\)/);
    }
  });

  it("--danger 与 --danger-rgb 各自只定义一次", () => {
    const css = readFileSync(join(srcRoot, "app.css"), "utf8");
    expect(css.match(/--danger:\s*[^;]+;/g)?.length ?? 0).toBe(1);
    expect(css.match(/--danger-rgb:\s*[^;]+;/g)?.length ?? 0).toBe(1);
  });

  it("详情栏那颗「移入回收站」继续走共用语义红，不自己挑红", () => {
    const src = readFileSync(join(srcRoot, "components/TextDetailPanel.svelte"), "utf8");
    // 2026-11-18 起那颗直接就是 ⋯ 菜单里的一项（点一下就走，没有确认按钮了），
    // 所以钉的是菜单项这一行还在用 text-danger，而不是弹窗里那颗 .dock-btn.is-danger。
    const item = src.split(/\r?\n/).find((l) => l.includes("移入回收站") && l.includes('role="menuitem"'));
    expect(item, "详情栏的移入回收站菜单项不见了").toBeTruthy();
    expect(item!, "那颗菜单项不再走共用语义红").toContain("text-danger");
    expect(src).not.toMatch(/class="[^"]*\b(?:text|border|bg)-red-\d/);
  });
});