import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 间距与字号尺度护栏（2026-11-11 无障碍那一轮收尾）。
 *
 * AGENTS.md §3.1 写给后面每一轮看的，就是这里钉住的数。文档最容易烂在「写了但没人对齐」，
 * 所以尺度的真源只认两处：src/app.css 的 :root token 块、tailwind.config.js 的 theme.extend。
 * 两边任何一处挪了，这条先红，免得文档和代码各说各话。
 *
 * 字号以前是「定了档、存量没迁完」，所以跟裸 hex 一样做成棘轮只降不升；
 * 2026-11-16 换成整数七档之后存量清零，棘轮因此钉在 0 —— 它现在的作用不是「别涨」，
 * 是「一个档外值都不许再出现」：要新档位，先改 AGENTS.md §3.1 和这颗数，别顺手写 text-[12px]。
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");
const appCss = readFileSync(join(srcRoot, "app.css"), "utf8");
const tailwindConfig = readFileSync(resolve(srcRoot, "..", "tailwind.config.js"), "utf8");

const TOKEN_START = appCss.indexOf(":root {");
const TOKEN_END = appCss.indexOf("\nhtml,");
if (TOKEN_START < 0 || TOKEN_END < 0) {
  throw new Error("app.css 里找不到 token 定义块的边界（:root 到 html, 之间）");
}

function tokenDeclarations(): Map<string, string> {
  const out = new Map<string, string>();
  const block = appCss.slice(TOKEN_START, TOKEN_END);
  for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    if (out.has(m[1])) throw new Error(m[1] + " 在 token 块里定义了两次");
    out.set(m[1], m[2].trim());
  }
  return out;
}

const TOKENS = tokenDeclarations();
const px = (name: string) => {
  const value = TOKENS.get(name);
  if (!value) throw new Error("token 块里找不到 " + name);
  return value;
};

/** token 名按尺度分组读出来，别在断言里再抄一份数字。 */
function tokensWithPrefix(prefix: string) {
  return [...TOKENS.keys()].filter((k) => k.startsWith(prefix)).sort();
}

function collectSourceFiles(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(p, out);
    else if (/\.(svelte|css|ts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** 取出 `key: {` 对应的对象块（到匹配的右括号），用来判断某个键到底写在 theme 的哪一层。 */
function objectBlock(src: string, key: string): string {
  const at = src.indexOf(key);
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(key + " 的对象块没有闭合");
}

describe("字号尺度：七档整数，真源在 :root", () => {
  it("只有 7 个 --fs-* 档位，整数、值定死、严格递增", () => {
    const names = tokensWithPrefix("--fs-");
    expect(names).toEqual([
      "--fs-2xs",
      "--fs-base",
      "--fs-lg",
      "--fs-md",
      "--fs-sm",
      "--fs-xl",
      "--fs-xs",
    ]);
    expect(px("--fs-2xs")).toBe("11px");
    expect(px("--fs-xs")).toBe("12px");
    expect(px("--fs-sm")).toBe("13px");
    expect(px("--fs-base")).toBe("14px");
    expect(px("--fs-md")).toBe("16px");
    expect(px("--fs-lg")).toBe("19px");
    expect(px("--fs-xl")).toBe("24px");
    const sizes = ["--fs-2xs", "--fs-xs", "--fs-sm", "--fs-base", "--fs-md", "--fs-lg", "--fs-xl"].map(
      (n) => parseFloat(px(n)),
    );
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i], sizes[i - 1] + " → " + sizes[i] + " 没有递增").toBeGreaterThan(sizes[i - 1]);
    }
    // 半像素档不许复活：10.5 那一套就是这么把「六档」变成「每次都要判断档外值」的
    for (const n of names) {
      expect(Number.isInteger(parseFloat(px(n))), n + " 必须是整数 px").toBe(true);
    }
  });

  it("行高只有三轨，值定死", () => {
    expect(tokensWithPrefix("--lh-")).toEqual(["--lh-label", "--lh-read", "--lh-title"]);
    expect(px("--lh-label")).toBe("1.35");
    expect(px("--lh-read")).toBe("1.6");
    expect(px("--lh-title")).toBe("1.25");
    expect(parseFloat(px("--lh-title"))).toBeLessThan(parseFloat(px("--lh-label")));
    expect(parseFloat(px("--lh-read"))).toBeGreaterThan(parseFloat(px("--lh-label")));
  });

  it("七个字号档位各有一个 class，且都挂在 label 行高轨上", () => {
    const from = tailwindConfig.indexOf("fontSize: {");
    expect(from, "tailwind.config.js 里找不到 fontSize 块").toBeGreaterThan(0);
    const block = objectBlock(tailwindConfig.slice(from), "fontSize: {");
    const expectRows: [string, string][] = [
      ["2xs", "--fs-2xs"],
      ["xs", "--fs-xs"],
      ["sm", "--fs-sm"],
      ["base", "--fs-base"],
      ["md", "--fs-md"],
      ["lg", "--fs-lg"],
      ["xl", "--fs-xl"],
    ];
    const parsed = new Map<string, string>();
    for (const m of block.matchAll(
      /"?([\w-]+)"?:\s*\[\s*"var\((--[\w-]+)\)"\s*,\s*\{\s*lineHeight:\s*"([^"]+)"\s*\}\s*\]/g,
    )) {
      if (parsed.has(m[1])) throw new Error("档位 " + m[1] + " 写了两遍");
      expect(m[3], "text-" + m[1] + " 的行高没走三轨，写的是 " + m[3]).toBe("var(--lh-label)");
      parsed.set(m[1], m[2]);
    }
    // 档位数量正好 7：多一个是绕过 :root 自己造档，少一个是有人删了档却没迁干净
    expect([...parsed.keys()].sort()).toEqual(expectRows.map((r) => r[0]).sort());
    for (const [cls, token] of expectRows) {
      expect(parsed.get(cls), "缺 class text-" + cls).toBe(token);
    }
    // 这个块里不许出现裸 px，否则又多一个真源
    expect(block.match(/\b\d+(?:\.\d+)?px\b/g) || [], "fontSize 块里出现了裸 px").toEqual([]);
  });

  it("字号表定义在 theme.fontSize，不是 theme.extend（要占掉 Tailwind 内置的那几个名字）", () => {
    // 放在 extend 里就只能叫 text-xs2 / text-sm2 这种第二套名字，全站同时存在
    // 「text-sm = 14px」和「text-sm2 = 13px」两种说法，谁写都对，于是谁都在写错的。
    const theme = objectBlock(tailwindConfig, "theme: {");
    expect(theme).toContain("fontSize:");
    expect(objectBlock(tailwindConfig, "extend:")).not.toContain("fontSize:");
    // 旧的六档别名整套取消，不许有人为了少改几处把它们加回 extend
    expect(tailwindConfig).not.toMatch(/\b(?:xs2|sm2|base2|md2|lg2)\s*:/);
  });
});

describe("控件与圆角尺度", () => {
  it("控件高三档，最矮一档不低于 24px（WCAG 2.5.8 目标尺寸）", () => {
    expect(tokensWithPrefix("--ctl-")).toEqual(["--ctl-lg", "--ctl-md", "--ctl-sm"]);
    expect(px("--ctl-sm")).toBe("26px");
    expect(px("--ctl-md")).toBe("32px");
    expect(px("--ctl-lg")).toBe("38px");
    expect(parseFloat(px("--ctl-sm"))).toBeGreaterThanOrEqual(24);
  });

  it("圆角四档，pill 是唯一的「完全圆」", () => {
    expect(tokensWithPrefix("--r-")).toEqual(["--r-1", "--r-2", "--r-3", "--r-pill"]);
    expect(px("--r-1")).toBe("6px");
    expect(px("--r-2")).toBe("10px");
    expect(px("--r-3")).toBe("14px");
    expect(px("--r-pill")).toBe("999px");
  });

  it("间距沿用 tailwind 默认 4px 网格，没在 theme 里另造一套", () => {
    // 一旦有人往 extend.spacing 里塞东西，AGENTS.md §3.1 的「p-N × 4px」口径就失效了
    expect(tailwindConfig).not.toMatch(/\bspacing\s*:/);
    expect(tailwindConfig).not.toMatch(/\bextend:\s*\{[^}]*\bspacing\s*:/s);
  });
});

describe("脱档字号棘轮：只许降，不许升", () => {
  /** 六档的 px 数值，从 token 现取，token 改了棘轮跟着走。 */
  const tierValues = new Set(
    tokensWithPrefix("--fs-").map((n) => parseFloat(px(n)).toString()),
  );

  /** 两种写法：class 里的 text-[12px]，和 <style>/app.css 里的 font-size: 12px。 */
  const CLASS = /\btext-\[(\d+(?:\.\d+)?)px\]/g;
  const DECL = /(?<![-\w])font-size:\s*(\d+(?:\.\d+)?)px/g;

  function countOffScale() {
    let total = 0;
    const offenders = new Map<string, number>();
    for (const file of collectSourceFiles(srcRoot)) {
      const src = readFileSync(file, "utf8");
      for (const re of [CLASS, DECL]) {
        re.lastIndex = 0;
        for (const m of src.matchAll(re)) {
          if (tierValues.has(m[1])) continue;
          total += 1;
          const key = m[1] + "px";
          offenders.set(key, (offenders.get(key) || 0) + 1);
        }
      }
    }
    return { total, offenders: [...offenders.entries()].sort((a, b) => b[1] - a[1]) };
  }

  // 棘轮史：2026-11-11 定档时存量 280，之后 oil-ui 评审几刀一路往下压（270 → 264 → 248 → 247）。
  // 2026-11-16 字号换成整数七档，把剩下的 247 一次清干净：档位值就是站内本来在用的那些整数，
  // 所以 11/12/13/14/16 这些字面量自动落档，剩下的半像素档和 10/9/17/18/21/23/25/32 全部改引用 token。
  // 从此这里是 0，不是「再少一点」：想写档外值，先加档位（要改 AGENTS.md §3.1 和这颗棘轮），
  // 别在这儿把数调大。
  const BASELINE = 0;

  it("全站写在七档之外的字号不超过基线", () => {
    const { total, offenders } = countOffScale();
    expect(
      total,
      "脱档字号从基线 " + BASELINE + " 涨到 " + total + "。字号只有六档：" +
        "class 用 text-2xs/xs/sm/base/md/lg/xl，<style> 用 font-size: var(--fs-*)。" +
        " 现存分布：" + offenders.map(([k, v]) => k + "×" + v).join(" "),
    ).toBeLessThanOrEqual(BASELINE);
  });
});

describe("详情栏共用一把尺子（2026-11-13 oil-ui 评审第一刀 T4 + T9）", () => {
  const read = (rel: string) => readFileSync(join(srcRoot, rel), "utf8");
  /** 抠某条规则块里的一个声明；抠不到就报错，不许放宽成 toBeTruthy。 */
  function declOf(css: string, selector: string, prop: string) {
    const at = css.indexOf(selector + " {");
    if (at < 0) throw new Error("找不到规则块 " + selector);
    const block = css.slice(at, css.indexOf("}", at));
    const hit = block.match(new RegExp("(?<![-\\w])" + prop + ":\\s*([^;]+);"));
    if (!hit) throw new Error(selector + " 里没有 " + prop);
    return hit[1].trim();
  }

  it("右栏的次要按钮只有一档高度：--ctl-md，文本面板不再自己撑出 38px", () => {
    // 定稿前实测：文本头那三颗（阅读 / 编辑 / ⋯）38px，同面板那颗「复制」29px，
    // 媒体的主动作倒是老实的 32px —— 次要动作比人家的主动作还大一号，主次是反的。
    expect(declOf(appCss, ".dock-btn", "height"), "详情栏的按钮必须落在控件三档上")
      .toBe("var(--ctl-md)");

    // 定义只许有一份：搬进 app.css 之后组件里再留一份私有的，尺寸迟早又分叉
    expect(read("components/DetailPanel.svelte"), ".dock-btn 又变回 DetailPanel 私有定义")
      .not.toMatch(/\.dock-btn\s*\{/);

    // 文本面板不许再拿 padding 凑控件高度：凑出来的数落不进 26 / 32 / 38 任何一档
    const textPanel = read("components/TextDetailPanel.svelte");
    expect(textPanel, "文本详情栏还有拿 padding 凑高度的按钮")
      .not.toMatch(/class="[^"]*(?:p-1\.5|py-1) rounded/);
    expect(textPanel.match(/class="dock-btn/g) || []).toHaveLength(8);
  });

  it("右栏标题只有一套语言：加粗 + --text-1，两级只差字号（2026-11-15 定稿）", () => {
    // 苏醒的口径：右栏统一一种标题长相，以 0.2.35 工作台那一套为准。定稿前三套并存——
    // DetailPanel 私有的 .section-heading（12px / 10px 档外）、app.css 的 .detail-section-title
    // （--fs-xs + uppercase + 字距）、卡片里各写各的 text-[11px] / text-[13px]。现在只剩一套：
    // 标题一律 .section-title（小节 --fs-sm，卡片 .is-card 降一档到 --fs-xs），副标题 .section-subtitle。
    const sectionTitle = ["components/DetailPanel.svelte", "components/TextDetailPanel.svelte"];
    const cardTitle = [
        "components/ParamsCard.svelte",
        "components/PromptCard.svelte",
        "components/ReversePromptPanel.svelte",
        "components/VideoPromptPanel.svelte",
      ];
    const noTitle = ["components/WorkflowCard.svelte", "App.svelte"];
    for (const rel of [...sectionTitle, ...cardTitle, ...noTitle]) {
      const src = read(rel);
      expect(src, rel + " 还在用旧的 uppercase 微标签").not.toContain("detail-section-title");
      expect(src, rel + " 的小节标题还自己挑档外字号").not.toMatch(/<h[34] class="text-\[/);
      expect(src, rel + " 又拿 uppercase 当标题").not.toMatch(/<h[34][^>]*uppercase|tracking-wider uppercase/);
    }
    for (const rel of sectionTitle) {
      expect(read(rel), rel + " 的小节标题缺共用类").toContain("class=\"section-title");
    }
    for (const rel of cardTitle) {
      expect(read(rel), rel + " 的卡片标题缺共用类").toContain("section-title is-card");
    }
    for (const rel of noTitle) {
      expect(read(rel), rel + " 不该有右栏小节标题").not.toContain("section-title");
    }

    expect(declOf(appCss, ".section-title", "font-size")).toBe("var(--fs-sm)");
    expect(declOf(appCss, ".section-title", "font-weight")).toBe("650");
    expect(declOf(appCss, ".section-title", "color")).toBe("var(--text-1)");
    expect(declOf(appCss, ".section-title.is-card", "font-size")).toBe("var(--fs-xs)");
    expect(declOf(appCss, ".section-subtitle", "font-size")).toBe("var(--fs-2xs)");
    expect(declOf(appCss, ".section-heading", "gap")).toBe("8px");
    // 旧的那套不许复活，也不许有人再在组件里留一份私有定义（对照 .dock-btn 那条）
    expect(appCss, ".detail-section-title 又回来了").not.toContain(".detail-section-title {");
    expect(read("components/DetailPanel.svelte"), ".section-heading 又变回 DetailPanel 私有定义")
      .not.toMatch(/\.section-heading\s*\{/);
    expect(read("components/DetailPanel.svelte"), ".section-icon 又变回私有定义")
      .not.toMatch(/\.section-icon\s*\{/);
  });
  it("右栏那族微标签全站只剩一套写法（第三刀 T9）", () => {
    // OnboardingModal 那一处是弹窗里的表单标签，不是详情栏小节，登记在评审总账里没动
    const hits = collectSourceFiles(srcRoot)
      .filter((f) => f.endsWith(".svelte"))
      .filter((f) => /text-\[11px\][^"]*uppercase|uppercase[^"]*text-\[11px\]/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(srcRoot.length + 1).replace(/\\/g, "/"));
    expect(hits, "又长出第二套微标签写法：" + hits.join("、")).toEqual(["components/OnboardingModal.svelte"]);
  });

  it("文本卡三段字号全在七档上（这张卡以前整张自己挑档外值）", () => {
    const feed = read("components/Feed.svelte");
    expect(declOf(feed, ".text-format", "font-size")).toBe("var(--fs-2xs)");
    expect(declOf(feed, ".text-name", "font-size")).toBe("var(--fs-sm)");
    expect(declOf(feed, ".text-excerpt", "font-size")).toBe("var(--fs-xs)");
  });
});
