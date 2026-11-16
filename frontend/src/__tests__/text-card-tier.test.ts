import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FOOTER_TIER_ONE_LINE_MIN_WIDTH,
  FOOTER_TIER_TWO_LINE_MIN_WIDTH,
  TEXT_CARD_HEIGHTS_BY_TIER,
  TEXT_CARD_LINES_BY_TIER,
  footerTierFor,
  textCardHeightFor,
  textCardLinesFor,
} from "../lib/media-format";

/**
 * 2026-11-13 oil-ui 只读评审第二刀（T1 + T3 + T6）的钉子。
 *
 * T1 与 T6 是同一件事的两面：文本卡原先按 21/9 定高，窄列里内容比卡高 —— 12 列时整卡只有约 36px，
 * 徽标 + 文件名 + 摘录装不下，被 overflow:hidden 砍成「只剩一颗徽标」；而 157px 列宽时卡 67px 高，
 * 摘录只剩 13px 可用、一行却要 15.4px，clamp 的省略号永远落在被切掉的那一行里。
 * 现在卡高与摘录行数由 lib/media-format.ts 一把给（复用媒体页脚那同一套档位）。这里钉三件事：
 * ① 那几个数确实等于 3.1 尺度的加和，不是又挑了一个；② Feed 只从这一颗取值，两处不许各写一份；
 * ③ 文本详情栏的操作带与媒体 tab 行同尺，四类右栏正文起点因此在一条线上（T3）。
 */

const feed = readFileSync("src/components/Feed.svelte", "utf8");
const detailPanel = readFileSync("src/components/DetailPanel.svelte", "utf8");
const textPanel = readFileSync("src/components/TextDetailPanel.svelte", "utf8");
const appCss = readFileSync("src/app.css", "utf8");

/** 从 :root 里现取一颗数值 token，卡高的账不许靠手抄数字。 */
function tokenNum(name: string): number {
  const m = new RegExp("(^|\\s)" + name + ":\\s*([\\d.]+)", "m").exec(appCss);
  if (!m) throw new Error("app.css 里找不到 " + name);
  return Number.parseFloat(m[2]);
}

/** 抠出某条规则的声明块：选择器整串匹配，不许误配它的派生类或伪类。 */
function ruleBody(src: string, selector: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp("(^|[^\\w.-])" + esc + "\\s*\\{([^}]*)\\}").exec(src);
  return m ? m[2] : null;
}

describe("文本卡的高度与降级：一个真源、三档形态", () => {
  it("卡高就是 3.1 尺度的加和，不是又挑的一个数", () => {
       // 上下 padding 8+8 + 徽标（--fs-2xs 走 label 轨 + 上下各 1px） + 一条 2px 行距 + 文件名（--fs-sm × label 轨）
    // 数值全从 :root 现取：换了字号档位，这里跟着动，不许再手抄一份
    const lhLabel = tokenNum("--lh-label");
    const badge = Math.ceil(tokenNum("--fs-2xs") * lhLabel) + 2;
    const name = Math.ceil(tokenNum("--fs-sm") * lhLabel);
    const excerptLine = tokenNum("--fs-xs") * tokenNum("--lh-read");
    const base = 8 + 8 + badge + 2 + name;
    for (let tier = 0; tier <= 2; tier++) {
      const lines = TEXT_CARD_LINES_BY_TIER[tier];
      // 有摘录时还要再加一条 2px 行距 + 每行走 read 轨
      const want = Math.ceil(base + (lines > 0 ? 2 + excerptLine * lines : 0));
      expect(TEXT_CARD_HEIGHTS_BY_TIER[tier], "档位 " + tier + " 的卡高").toBe(want);
    }
    // 上面那笔账成立的前提：三段真的各挂在自己那一轨上，换了轨就得先在这儿红
    expect(ruleBody(feed, ".text-format")).toContain("line-height: var(--lh-label)");
    expect(ruleBody(feed, ".text-name")).toContain("line-height: var(--lh-label)");
    expect(ruleBody(feed, ".text-excerpt")).toContain("line-height: var(--lh-read)");
  });

  it("降级复用页脚那同一套档位，不给文本卡另立门槛", () => {
    expect(textCardLinesFor(FOOTER_TIER_ONE_LINE_MIN_WIDTH - 1)).toBe(0);
    expect(textCardLinesFor(FOOTER_TIER_ONE_LINE_MIN_WIDTH)).toBe(1);
    expect(textCardLinesFor(FOOTER_TIER_TWO_LINE_MIN_WIDTH - 1)).toBe(1);
    expect(textCardLinesFor(FOOTER_TIER_TWO_LINE_MIN_WIDTH)).toBe(2);
    for (const w of [60, 84, 119, 120, 169, 170, 320]) {
      expect(textCardHeightFor(w), "列宽 " + w + " 的卡高" ).toBe(TEXT_CARD_HEIGHTS_BY_TIER[footerTierFor(w)]);
    }
    // 越窄越矮，最矮那一档仍装得下「徽标 + 文件名」这一行
    expect(textCardHeightFor(84)).toBeLessThan(textCardHeightFor(140));
    expect(textCardHeightFor(140)).toBeLessThan(textCardHeightFor(320));
    expect(textCardHeightFor(84)).toBeGreaterThanOrEqual(TEXT_CARD_HEIGHTS_BY_TIER[0]);
  });

  it("摘录行数不再写死在 CSS 里；卡高行内来自同源（T1）", () => {
    const base = ruleBody(feed, ".text-excerpt") || "";

    expect(base).toContain("font-size: var(--fs-xs)");
    expect(base).not.toContain("-webkit-line-clamp");
    expect(ruleBody(feed, ".text-card--t2 .text-excerpt")).toContain("-webkit-line-clamp: 2");
    expect(ruleBody(feed, ".text-card--t1 .text-excerpt")).toContain("-webkit-line-clamp: 1");
    expect(ruleBody(feed, ".text-card--t0 .text-excerpt")).toContain("display: none");
    // 高写在行内、值来自同源；CSS 里 .text-card 不许自己再写一个 height
    expect(feed).toContain('style="height: {textCardHeightFor(columnWidth)}px; width: 100%;"');
    expect(ruleBody(feed, ".text-card")).not.toMatch(/(^|[^\n-])height:/);
  });

  it("贪心分列按同源高度算文本卡，不再替它预留一份页脚高度（T6）", () => {
    expect(feed).toMatch(/it\.item_type === "text" \? textCardHeightFor\(w\)/);
    expect(feed).toMatch(/footerHeightFor\(w\)\) \+ COL_GAP/);
    expect(feed).not.toContain("TEXT_CARD_ASPECT");
    expect(feed).not.toContain("TEXT_CARD_RATIO_H");
  });
});

describe("文本详情栏的操作带：与媒体 tab 行同尺，标题拿回整条宽度", () => {
  it("操作带的高 / 内边距 / 下沿 hairline 还在 3.1 那把尺子上（页签取消后仍按档位钉死）", () => {
    // 2026-11-13 定这条时，比的是「与媒体那一行的 .detail-tabs 同尺」。fork 的 0.2.35 把右栏页签
    // 取消了（改成一条纵向工作台 + .detail-header），媒体侧不再有可对照的那一行，所以对照对象撤掉，
    // 但操作带自己那三个数照钉：高度走 --ctl-lg、左右 16px、下沿一条 hairline，谁都不许顺手改掉。
    const band = ruleBody(appCss, ".detail-text-actions") || "";
    expect(band).not.toBe("");
    expect(band).toContain("height: var(--ctl-lg)");
    expect(band).toContain("padding: 0 var(--sp-4)");
    expect(band).toContain("border-bottom: 1px solid var(--line)");
    // 页签那一行确实没了：留着这条，是为了防止哪天又冒出一份第二套 tab 尺
    expect(detailPanel).not.toContain('class="detail-tabs"');
  });

  it("阅读 / 编辑 / ⋯ 在操作带里而不是标题那一行；标题 tooltip 挂文件名而不是路径（T3）", () => {
    const navStart = textPanel.indexOf('<nav class="detail-text-actions"');
    const navEnd = textPanel.indexOf("</nav>");
    expect(navStart).toBeGreaterThan(-1);
    const navBlock = textPanel.slice(navStart, navEnd);
    for (const label of ["打开阅读", "就地编辑", "更多操作"]) {
      expect(navBlock, "操作带里应该找到 " + label).toContain(label);
    }
    const headerBlock = textPanel.slice(textPanel.indexOf("<header"), textPanel.indexOf("</header>"));
    expect(headerBlock).not.toContain("dock-btn");
    expect(textPanel).toContain("title={it.filename}>{it.filename}");
    expect(textPanel).not.toContain("title={it.path}");
  });
});
