import { expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 名字守着：这个功能以前叫「一键同款」，那三个字是对结果的承诺（点一下出同一张），
 * 而它实际做的是「拿当初那套配方再抽一次」——所以改名「再次创作」。
 * 守住两件事：界面上不许再长出旧名字；随包工作流的历史名字不能被顺手删掉。
 */
const OLD = "一键同款";
const NEW = "再次创作";

/** 旧名仍允许出现在这两个地方，各有一个不能动的原因。 */
const ALLOWED = [
  // 设置页的搜索关键词：按旧名搜的人仍要能搜到这一屏
  { why: "keywords", re: /keywords:/ },
  // 图库里那个真实文件夹的**名字本身**（历史数据，改了就对不上号）
  { why: "文件夹名", re: /文件夹/ },
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...sources(p));
    } else if (/\.(svelte|ts|css)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

it("src 里除搜索别名与历史文件夹名，不再出现旧名字", () => {
  const hits: string[] = [];
  for (const file of sources("src")) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (!line.includes(OLD)) return;
      if (ALLOWED.some((a) => a.re.test(line))) return;
      hits.push(file + ":" + (i + 1) + " " + line.trim());
    });
  }
  expect(hits).toEqual([]);
});

it("三处入口说的是新名字，弹窗的可访问名跟着换", () => {
  const feed = readFileSync("src/components/Feed.svelte", "utf8");
  expect(feed).toContain("{ label: \"" + NEW + "\", onClick: () => openClone(t) }");
  expect(feed).toContain("title=\"" + NEW + "\"");

  const modal = readFileSync("src/components/CloneModal.svelte", "utf8");
  expect(modal).toContain("aria-label=\"" + NEW + "\"");
  expect(modal).toContain("aria-label=\"关闭" + NEW + "\"");
  expect(modal).toContain("<span class=\"cm-kicker\">" + NEW + "</span>");

  const settings = readFileSync("src/lib/clone.ts", "utf8");
  expect(settings).toContain("export const CLONE_SETTINGS_TAB = \"" + NEW + "\";");
});

/**
 * 第二次改名（2026-11-04 苏醒）：那颗胶囊与设置页那一屏叫「同款工作流」，可它给的是
 * 「这一族当前挂着的那份工作流」，不是「和这张图一模一样的那份」——「同款」两字同样是多余的承诺。
 * 统一说「工作流」。守两件事：那四个字不再出现在 src 里；两处可访问名就是「工作流」。
 */
it("第二次的改名：「同款工作流」不再出现，胶囊与设置页那屏都只说「工作流」", () => {
  const HALF_OLD = "同款工作流";
  const hits: string[] = [];
  for (const file of sources("src")) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (line.includes(HALF_OLD)) hits.push(file + ":" + (i + 1) + " " + line.trim());
    });
  }
  expect(hits).toEqual([]);

  const modal = readFileSync("src/components/CloneModal.svelte", "utf8");
  expect(modal).toContain('aria-label="工作流" aria-haspopup="menu"');   // 那颗胶囊
  expect(modal).toContain('role="menu" aria-label="工作流"');             // 它展开的那层菜单

  const settings = readFileSync("src/components/CloneTemplates.svelte", "utf8");
  expect(settings).toContain('<SettingsRow title="工作流"');              // 设置页那一屏的标题

  const feed = readFileSync("src/components/Feed.svelte", "utf8");
  expect(feed).toContain("用当前工作流再生成");                            // 角标的可访问名
});

it("设置页那屏的标题与分区名同步换了，但搜索仍收旧名字", () => {
  const settings = readFileSync("src/components/SettingsModal.svelte", "utf8");
  expect(settings).toContain("<h3 id=\"settings-clone-title\">" + NEW + "</h3>");
  expect(settings).toContain("label: \"" + NEW + "\"");
  const kw = settings.split("\n").find((l) => l.includes("id: \"clone\"")) ?? "";
  expect(kw).toContain(NEW);      // 新名字要能被搜到
  expect(kw).toContain(OLD);      // 兼容别名：按旧名搜的人仍要命中这一屏
});
