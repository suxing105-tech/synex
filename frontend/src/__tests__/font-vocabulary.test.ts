import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 字体写法门禁（2026-11-16 · 字体规范第二批）。
 *
 * 尺度本身的数值由 type-scale.test.ts 钉死，随包字体的来源与授权由 font-bundle.test.ts 钉死。
 * 这一管的是「写法」：同一个用途有没有第二种写法。字号那一项以前做成了「档外值只降不升」的
 * 棘轮，结果 11/12/13 这些**档内**字面量照样有 194 处写在组件里——值对，真源不对，下次换档位
 * 或换字体时它们一个都不会跟着变。所以这一批直接把写法钉死，不留棘轮。
 *
 * 每条检查都点名了允许出现的例外，例外写在这里而不是藏在正则里：想加一处，先在这里说明理由。
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");

/** 只读界面源码：.ts 里那些 font-family 字符串是剪贴板白名单之类的表，不是样式。 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (/\.(svelte|css)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const FILES = sourceFiles(srcRoot);
const rel = (p: string) => p.slice(srcRoot.length + 1).replace(/\\/g, "/");

/** 注释里的示例写法不算违规，但要把行号留住，所以按行填空格而不是整段删掉。 */
function stripComments(text: string) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

const SOURCES = FILES.map((p) => ({ rel: rel(p), lines: stripComments(readFileSync(p, "utf8")).split(/\r?\n/) }));

/**
 * 扫某一种写法。lookahead 一律写成 (?!\\s*X)：只写 (?!X) 的话 \\s* 会退化成零宽，
 * 「font-size: 12px」就能从冒号后面匹配出来，把合规的行也报成违规（第一版就栽在这儿）。
 */
function findLines(prop: RegExp): { at: string; line: string }[] {
  const hits: { at: string; line: string }[] = [];
  for (const f of SOURCES) {
    f.lines.forEach((line, i) => {
      prop.lastIndex = 0;
      if (prop.test(line)) hits.push({ at: f.rel + ":" + (i + 1), line });
    });
  }
  return hits;
}

/** 只报「在哪儿 + 这一行长什么样」，比对本身一律用 findLines 拿到的原文。 */
function find(prop: RegExp) {
  return findLines(prop).map((h) => h.at + "  " + h.line.trim().slice(0, 90));
}

describe("字号只有一个写法：档位名，不是数字", () => {
  it("没有任何 text-[Npx] 任意值字号", () => {
    const hits = find(/\btext-\[\d+(?:\.\d+)?px\]/g);
    expect(hits, "任意值字号回到 " + hits.length + " 处。class 只许 text-2xs/xs/sm/base/md/lg/xl：\n" + hits.join("\n")).toEqual([]);
  });

  it("没有任何 font-size 写数字，包括档内值", () => {
    // 12px 正好等于 --fs-xs，所以「值对不上档」的棘轮永远抓不到它；这一条才是真源检查。
    const hits = find(/(?<![-\w])font-size:\s*\d+(?:\.\d+)?px/g);
    expect(hits, "字号字面量回到 " + hits.length + " 处，档位改了它们不会跟着变：<style> 里写 font-size: var(--fs-*)：\n" + hits.join("\n")).toEqual([]);
  });
});

describe("行高、字距只能写在档位上", () => {
  it("line-height 全部引用 --lh-*", () => {
    const hits = find(/line-height:\s*(?!\s*var\(--lh)(?!\s*inherit)[^;}\n]+/g);
    expect(hits, "行高脱档 " + hits.length + " 处，五档是 none/label/ui/read/prose：\n" + hits.join("\n")).toEqual([]);
  });

  it("letter-spacing 全部引用 --track-*", () => {
    // 负字距是这一批专门清掉的：随包字体的中宫按中文排，收紧只会把中英混排挤成一团。
    const hits = find(/letter-spacing:\s*(?!\s*var\(--track)(?!\s*inherit)(?!\s*normal)[^;}\n]+/g);
    expect(hits, "字距脱档 " + hits.length + " 处，三档是 label/badge/display：\n" + hits.join("\n")).toEqual([]);
  });

  it("leading-* 和 tracking-* 只许用存在的档位名", () => {
    // theme.lineHeight / theme.letterSpacing 占掉了内置名，写了内置名不报错、只是没样式——
    // 那种「看着像没人管的空行高」最难查，所以在写法层面先禁掉。
    const lh = find(/\bleading-(?!\s*(?:none|label|ui|read|prose)\b)[\w[\]/.-]+/g);
    const ls = find(/\btracking-(?!\s*(?:label|badge|display)\b)[\w[\]/.-]+/g);
    expect([...lh, ...ls], "用了已经不存在的内置档位名：\n" + [...lh, ...ls].join("\n")).toEqual([]);
  });
});

describe("字重只有四档真字面", () => {
  it("font-weight 只出现 400 / 500 / 600 / 700", () => {
    const hits = find(/(?<![-\w])font-weight:\s*(?!\s*(?:400|500|600|700)\b)(?!\s*(?:normal|bold|inherit|var\())[^;}\n]+/g);
    expect(hits, "出现了第五档字重。随包字体只有 400/500/600/700 四个真字面，而 html 上关了字重合成，"+
      "写 650 只会就近拿到 600，还多一个歧义：\n" + hits.join("\n")).toEqual([]);
  });

  /**
   * 有档位不等于能随便用。700 是这套字体里最重的一档，散到 12/13px 的正文和小控件上，
   * 整屏会变成「哪儿都粗」，层级反而没了。所以落点逐条登记：想加一处，先在这里说明它
   * 到底是主标题还是关键操作，说不出用途就不该加。
   */
  const BOLD_ALLOWED = [
    { file: "app.css", sel: "font-face", why: "声明 700 字面本身" },
    { file: "app.css", sel: ".fill-interactions button.bg-accent", why: "关键操作：品牌色实心按钮" },
    { file: "components/CloneModal.svelte", sel: ".cm-title", why: "弹窗主标题" },
    { file: "components/Feed.svelte", sel: ".text-dialog h2", why: "文本弹窗主标题" },
    { file: "components/SettingsModal.svelte", sel: ".settings-section h3", why: "设置页区块大标题" },
    { file: "components/TextAssociateModal.svelte", sel: ".text-modal h2", why: "弹窗主标题" },
    { file: "components/TextCreateModal.svelte", sel: ".text-modal h2", why: "弹窗主标题" },
    { file: "components/TextReader.svelte", sel: ".text-modal h2", why: "阅读器标题" },
    { file: "components/TextEditor.svelte", sel: ":global(h1)", why: "Markdown 文档大标题" },
  ];

  it("700 只落在登记过的主标题与关键操作上", () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      f.lines.forEach((line, i) => {
        if (!/(?<![-\w])font-weight:\s*700\b/.test(line)) return;
        // app.css 里一条规则占多行，规则名可能在上面，往前看五行再认
        const ctx = f.lines.slice(Math.max(0, i - 5), i + 1).join("\n");
        const ok = BOLD_ALLOWED.some((a) => a.file === f.rel && ctx.includes(a.sel));
        if (!ok) offenders.push(f.rel + ":" + (i + 1) + "  " + line.trim().slice(0, 70));
      });
    }
    expect(offenders, "700 又散到正文和小控件上了。它是展示档，落在小字上只会让整屏发糊：\n" + offenders.join("\n")).toEqual([]);
  });

  it("class 侧也只许 font-normal / font-medium / font-semibold", () => {
    const hits = find(/\bfont-(?:thin|extralight|light|black|extrabold|bold)\b/g);
    expect(hits, "第四档字重又从 class 进来了：\n" + hits.join("\n")).toEqual([]);
  });

  it("关掉了字重合成，并说明为什么留着斜体合成", () => {
    const css = readFileSync(join(srcRoot, "app.css"), "utf8");
    // 现在有了真的 700 字面，这条开关管的是「写了没配字面的字重也不许合成」，别再放开
    expect(css, "html 上的 font-synthesis 没了：没有字面的字重会被浏览器描边合成假粗").toMatch(/html\s*\{[^}]*font-synthesis:\s*style;/);
  });
});

describe("字族只有一个入口", () => {
  /** 允许写具体字族名的地方，逐条登记；新增要先想清楚能不能改成 var。 */
  const FAMILY_ALLOWED = [
    // @font-face 是在**声明**这颗字体本身，不是引用一个栈。
    { file: "app.css", why: "@font-face 声明 SeekX Sans 自己", re: /^"SeekX Sans"$/ },
    { file: "app.css", why: "@font-face 声明窄体自己（另一颗内部字族）", re: /^"SeekX Sans Condensed"$/ },
  ];

  it("font-family 只引用 var(--font-sans)/--font-mono/--font-condensed/inherit", () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      f.lines.forEach((line, i) => {
        const m = line.match(/(?<![-\w])font-family:\s*([^;}\n]+)/);
        if (!m) return;
        const value = m[1].trim().replace(/;$/, "");
        if (/^var\(--font-(?:sans|mono|condensed)\)$/.test(value) || value === "inherit") return;
        const ok = FAMILY_ALLOWED.some((a) => a.file === f.rel && a.re.test(value));
        if (!ok) offenders.push(f.rel + ":" + (i + 1) + "  " + value);
      });
    }
    expect(offenders, "又写了一份具体字体栈，:root 改了它不会跟着变：\n" + offenders.join("\n")).toEqual([]);
  });

  it("站内不存在指向不存在 token 的字族引用", () => {
    // 右键菜单曾经写的是 var(--font-ui, sans-serif)：--font-ui 从来没人定义过，
    // 于是那一片界面一直在用系统 sans，12.5px 也不在七档里。这类 bug 只有查引用才会红。
    const hits = find(/var\(--font-(?!sans|mono|condensed)[\w-]+/g);
    expect(hits, "引用了没定义过的字族 token：\n" + hits.join("\n")).toEqual([]);
  });
});

describe("窄体只落在整行数据读出", () => {
  /**
   * 窄体（SeekX Sans Condensed）是同一档 400 的另一套宽度，不是第五档字重，所以它按**整行**给：
   * 这个元素整段都是数字 / 尺寸 / 时长 / 大小，才换。嵌在中文里的孤立数字不许单独换字族——
   * 一个 12px 的数字挨着中文标签，省不出宽度，只会让中英两种宽度打架。
   *
   * 于是这里同时钉三件事：落点不许变多（也不许悄悄变少，少了一处就是那个读数掉回常规字族）、
   * 每处必须自己带上等宽数字（换字族不解决数字跳位，两件事必须一起来）、
   * 窄体只带 400 一档（别拿它当「小一号的字」，那是字号档位的事）。
   *
   * 故意没进来的，连同理由：滑块旁那一两位的值回显（.mp-cols-num、.me-slider b）和省不出宽度的
   * 计数（.chip .n、.pft-count、.me-count、.cm-hero-count、.queue-elapsed）；已经走 font-mono 的
   * 参数值（ParamsCard）保持等宽栈，别在同一行里混进第三种宽度。
   */
  const CONDENSED_ALLOWED = [
    { file: "app.css", sel: ".media-card-meta", why: "瀑布流卡片页脚：尺寸/时长/时间整行" },
    { file: "app.css", sel: ".viewer-zoom-readout", why: "查看器倍率读数" },
    { file: "components/CloneModal.svelte", sel: ".cm-hero-dims", why: "主图下面的尺寸/大小行" },
    { file: "components/CloneModal.svelte", sel: ".cm-stage-clock", why: "跑图阶段的已用时读数" },
    { file: "components/CloneModal.svelte", sel: ".cm-pop-size", why: "参数弹层里的大小读数" },
    { file: "components/VideoCompare.svelte", sel: ".time", why: "对比视图的播放时间" },
    { file: "components/VideoPromptPanel.svelte", sel: ".vp-progress-time", why: "反推进度的时间读数" },
    { file: "components/MaskEditor.svelte", sel: ".me-zoom", why: "蒙版编辑器的倍率读数" },
  ];

  /** 把「哪条规则在用窄体」抽出来：整块规则 + 它自己的选择器。 */
  const condensedRules = () => {
    const found: { file: string; sel: string; block: string }[] = [];
    for (const path of FILES) {
      const text = stripComments(readFileSync(path, "utf8"));
      for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
        const body = m[1];
        if (!/font-family:\s*var\(--font-condensed\)/.test(body)) continue;
        const head = text.slice(0, m.index ?? 0).split("\n").pop() || "";
        found.push({ file: rel(path), sel: head.replace(/\{/, "").trim(), block: body });
      }
    }
    return found;
  };

  it("用窄体的规则就是白名单那些，且每处自带等宽数字", () => {
    const found = condensedRules();
    const unlisted = found.filter(
      (f) => !CONDENSED_ALLOWED.some((a) => a.file === f.file && a.sel === f.sel),
    );
    expect(
      unlisted.map((f) => f.file + "  " + f.sel),
      "窄体又散到别的元素上了。它是数据档，不是「看起来挤就换一款」：\n" + unlisted.map((f) => f.file + "  " + f.sel).join("\n"),
    ).toEqual([]);
    const gone = CONDENSED_ALLOWED.filter(
      (a) => !found.some((f) => f.file === a.file && f.sel === a.sel),
    );
    expect(
      gone.map((a) => a.file + "  " + a.sel),
      "登记过的数据读出掉回了常规字族（白名单里的理由还在吗）：\n" + gone.map((a) => a.file + "  " + a.sel + "  " + a.why).join("\n"),
    ).toEqual([]);
    for (const f of found) {
      expect(
        f.block,
        f.file + "  " + f.sel + " 用窄体却没带 font-variant-numeric: tabular-nums：换了字族数字照样跳",
      ).toContain("font-variant-numeric: tabular-nums");
    }
  });

  it("窄体只带 400 一档", () => {
    const css = stripComments(readFileSync(join(srcRoot, "app.css"), "utf8"));
    const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)]
      .map((m) => m[1])
      .filter((body) => /font-family:\s*"SeekX Sans Condensed"/.test(body));
    expect(faces.length, "窄体的 @font-face 只数变了").toBe(1);
    expect(faces[0], "窄体多出了字重档：数据读出不需要加粗，多一档多 1.2MB").toMatch(/font-weight:\s*400;/);
  });
});

describe("font 简写不许再承担尺度", () => {
  const ALLOWED = [
    // 表单控件继承外层字体的标准写法，不带任何数值。
    { where: /^font:\s*inherit$/, why: "控件继承" },
    // 文本工作区空态那个装饰性的「Aa」字标：要的就是衬线对比，不属于界面字族。
    { where: /empty-symbol[^}]*font:\s*60px Georgia,serif/, why: "装饰性 Aa 字标" },
  ];

  it("除登记过的两处，不用 font 简写", () => {
    const hits = findLines(/(?<![-\w])font:\s*(?!\s*inherit)[^;}\n]+/g);
    const offenders = hits.filter((h) => !ALLOWED.some((a) => a.where.test(h.line)));
    expect(
      offenders,
      "font 简写会把字号、行高、字族三件事写在一个值里，档位扫不到：\n" + offenders.map((h) => h.at + "  " + h.line.trim().slice(0, 90)).join("\n"),
    ).toEqual([]);
    // font: inherit 已经被上面的正则排除，所以 hits 里只应当剩下登记过的那一条装饰性用法；
    // 例外本身不许悄悄变多，数量也钉住。
    expect(hits.length, "font 简写（不含 inherit）的命中数变了，登记在册的只有 TextWorkspace 那处装饰性 Aa").toBe(1);
  });
});

describe("等宽数字只有 tabular-nums 一种写法", () => {
  it("font-variant-numeric 不写别的值", () => {
    const hits = find(/font-variant-numeric:\s*(?!\s*tabular-nums)[^;}\n]+/g);
    expect(hits, "等宽数字出现了别的值：\n" + hits.join("\n")).toEqual([]);
  });

  it("数字型读数还在那儿（时间、计数、倍率一旦回退成比例数字就会跳）", () => {
    const hits = find(/font-variant-numeric:\s*tabular-nums/g);
    expect(hits.length, "用了等宽数字的位置只剩 " + hits.length + " 处，是不是有人顺手删了").toBeGreaterThanOrEqual(17);
  });
});
