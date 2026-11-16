import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 随包字体门禁（2026-11-16 · 字体规范第一批）。
 *
 * 这只字体有三件事是「仓库里看不见、错了也没人知道」的，所以全部做成断言：
 *
 * 1. 来源可追。woff2 是子集化产物，看不出是谁的 derivative。manifest 里记了上游名字、
 *    版本、原件 sha256，这里核对文件确实在、字节数和 manifest 一字不差——
 *    有人手工换了一只字体而没跑脚本，第一时间红在这里。
 * 2. 改名是授权义务。字体的版权声明写着 Reserved Font Name 'ChillDINGothic'，
 *    OFL 1.1 不许子集沿用保留字族名。所以「内部名字必须已改」和「任何 font-family
 *    声明都不许出现保留名」两条都要钉住，同时授权原文必须在安装包里、且设置·关于看得见。
 * 3. 字族只有一个入口。改之前 tailwind preflight 往 html 上塞的是系统栈，
 *    而 app.css 里根本没有 --font-* token，甚至有地方在引用没定义过的 var(--font-mono)。
 *    现在 tailwind 的 fontFamily 只许指回 :root 的 var，出现第二份字体栈就是分叉的开始。
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");
const repoRoot = resolve(srcRoot, "..", "..");
const fontDir = join(srcRoot, "assets", "fonts");
const appCss = readFileSync(join(srcRoot, "app.css"), "utf8");
const tailwindConfig = readFileSync(resolve(srcRoot, "..", "tailwind.config.js"), "utf8");

const manifest = JSON.parse(
  readFileSync(join(fontDir, "fonts-manifest.json"), "utf8"),
) as {
  family: string;
  /** 内部字族的全部名字：常规档 + 窄体（窄体不是字重，是另一颗字族）。 */
  families: string[];
  upstream: { name: string; familyNames: string[]; version: string; archiveSha256: string };
  renamedBecause: string;
  codepoints: number;
  charsetGroups: Record<string, number>;
  totalBytes: number;
  licenseFile: string;
  files: { file: string; family: string; subfamily: string; weight: number; bytes: number; sha256: string }[];
};

/**
 * 四档 UI 字重。加字重得先在这里加，逼着人想清楚体积代价：子集化之后一档约 1.2 MB。
 * 700 是 2026-11-16 补的展示档（主标题 + 关键操作）。html 上关了字重合，所以在它进来之前，
 * 「要 700」只能拿 600 顶着，弹窗标题和加粗的按钮文字其实是同一个重量——这一档买的是真层级。
 */
const WEIGHTS = [400, 500, 600, 700];
/** 五只字面合计约 5.7 MB，预算 12 MB；超了就是安装包变胖，得先讨论。 */
const BUDGET_BYTES = 12 * 1024 * 1024;

/**
 * 内部字族只有这两颗。窄体（上游 ConRegular）不是第五档字重，是同一档 400 的另一套宽度，
 * CSS 靠 font-family 选它，所以它必须有自己的名字，也只能自己出现在这份清单里。
 */
const FAMILIES = ["SeekX Sans", "SeekX Sans Condensed"];

const tokenBlock = (() => {
  const start = appCss.indexOf(":root {");
  const end = appCss.indexOf("\nhtml,", start);
  if (start < 0 || end < 0) throw new Error("app.css 里找不到 :root token 块的边界");
  return appCss.slice(start, end);
})();

const tokenOf = (name: string) => {
  const hit = tokenBlock.match(new RegExp("--" + name.slice(2) + ":\\s*([^;]+);"));
  if (!hit) throw new Error("token 块里找不到 " + name);
  return hit[1].trim();
};

describe("随包字体：来源可追", () => {
  it("manifest 记全了上游身份，字面清单逐条对得上", () => {
    expect(manifest.family).toBe("SeekX Sans");
    expect(manifest.upstream.version).toMatch(/^v\d+\.\d+$/);
    expect(manifest.upstream.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    // 上游自报的字族名（含中文）由脚本从字体 name 表里读，不靠人抄
    expect(manifest.upstream.familyNames.length).toBeGreaterThan(0);
    expect(manifest.families).toEqual(FAMILIES);
    // 逐条钉住「谁家的哪一档」：加一只字面得先在这里说清楚，再去看体积代价。
    expect(manifest.files.map((f) => f.family + " " + f.weight)).toEqual([
      "SeekX Sans 400",
      "SeekX Sans 500",
      "SeekX Sans 600",
      "SeekX Sans 700",
      "SeekX Sans Condensed 400",
    ]);
  });

  it("woff2 都在，字节数和 manifest 一致（手塞一只进来会红在这里）", () => {
    let total = 0;
    for (const face of manifest.files) {
      const p = join(fontDir, face.file);
      expect(existsSync(p), "缺文件 " + face.file).toBe(true);
      const size = statSync(p).size;
      expect(size, face.file + " 的字节数和 manifest 不符，重新跑 fetch-fonts.ps1").toBe(face.bytes);
      // woff2 的签名是 wOF2；不是就说明拿错了格式
      const head = readFileSync(p).subarray(0, 4).toString("latin1");
      expect(head, face.file + " 不是 woff2").toBe("wOF2");
      total += size;
    }
    expect(total, "totalBytes 与逐档之和不符").toBe(manifest.totalBytes);
    expect(total, "随包字体超出体积预算").toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it("码位覆盖是有意为之的口径，不是随手切的子集", () => {
    // 9674 是当前的量级：拉丁标点 + GB2312 常用汉字 + 源码里出现过的字。
    // 掉到 8000 以下意味着常用中文被砍了，界面上会出现「掉字」。
    expect(manifest.codepoints).toBeGreaterThan(8000);
    expect(manifest.charsetGroups.gb2312, "子集必须含 GB2312 常用汉字").toBeGreaterThan(6000);
  });
});

describe("随包字体：SIL OFL 义务履行到位", () => {
  it("内部字族名已按 Reserved Font Name 条款改掉", () => {
    expect(manifest.renamedBecause).toContain("Reserved Font Name");
    // 上游的保留名（manifest 里从字体 name 表读来的那一个）不许当内部名用
    for (const internal of manifest.families) {
      for (const upstream of manifest.upstream.familyNames) {
        expect(internal, "内部字族名沿用了上游保留名：" + internal).not.toBe(upstream);
      }
    }
  });

  it("任何 font-family 声明都不使用保留字族名", () => {
    const reserved = manifest.upstream.familyNames;
    const offenders: string[] = [];
    const scan = (file: string, text: string) => {
      for (const m of text.matchAll(/font-family:\s*([^;]+);/g)) {
        const value = m[1].toLowerCase();
        for (const name of reserved) {
          if (value.includes(name.toLowerCase())) offenders.push(file + " → " + m[1].trim());
        }
      }
    };
    scan("src/app.css", appCss);
    scan("tailwind.config.js", tailwindConfig);
    expect(offenders, "保留字族名出现在了 font-family 上：" + offenders.join("；")).toEqual([]);
  });

  it("授权原文随安装包分发，且被 tauri 的 bundle.resources 带走", () => {
    const licensePath = resolve(repoRoot, manifest.licenseFile);
    expect(existsSync(licensePath), "缺授权原文：" + manifest.licenseFile).toBe(true);
    const text = readFileSync(licensePath, "utf8");
    expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(text).toContain("Reserved Font Name");
    // 版权声明必须跟着字体走，这里是上游自己的那句话
    expect(text).toContain("ChillType");
    const conf = JSON.parse(
      readFileSync(resolve(repoRoot, "frontend/src-tauri/tauri.conf.json"), "utf8"),
    ) as { bundle: { resources: string[] } };
    const wanted = manifest.licenseFile.replace(/^frontend\/src-tauri\//, "");
    expect(conf.bundle.resources, "安装包没带上授权原文").toContain(wanted);
  });

  it("设置·关于里有看得见的授权入口（只塞进安装包等于没交代）", () => {
    const settings = readFileSync(join(srcRoot, "components", "SettingsModal.svelte"), "utf8");
    expect(settings).toContain("内置字体");
    expect(settings).toContain("OFL");
  });
});

describe("字族只有一个入口", () => {
  it("--font-sans 第一档是随包字体，且后面还留着中文字体兜底", () => {
    const stack = tokenOf("--font-sans");
    expect(stack.startsWith('"' + manifest.family + '"'), "--font-sans 第一档不是随包字体").toBe(true);
    // 子集没覆盖的字（全角字母数字、生僻人名用字）要有中文兜底，不许直接掉到 sans-serif
    expect(stack).toContain("Microsoft YaHei");
  });

  it("--font-condensed 第一档是窄体，缺字先回常规字族，最后才轮到中文兜底", () => {
    const stack = tokenOf("--font-condensed");
    expect(stack.startsWith('"' + FAMILIES[1] + '"'), "--font-condensed 第一档不是窄体").toBe(true);
    // 窄体和常规档切的是同一套码位，但它是另一颗字族：真掉字时必须先回到 SeekX Sans，
    // 直接掉到雅黑会让同一行换一种骨架，那比缺字还显眼。
    expect(stack.indexOf('"SeekX Sans"'), "--font-condensed 没把常规字族放在第二档").toBeGreaterThan(0);
    expect(stack).toContain("Microsoft YaHei");
  });

  it("--font-mono 真的被定义了（改之前有人引用它，但全站没定义过）", () => {
    expect(tokenOf("--font-mono")).toContain("ui-monospace");
    const detailPanel = readFileSync(join(srcRoot, "components", "DetailPanel.svelte"), "utf8");
    if (detailPanel.includes("var(--font-mono)")) {
      expect(tokenBlock).toContain("--font-mono:");
    }
  });

  it("tailwind 的 fontFamily 只指回 var，不许出现第二份字体栈", () => {
    const at = tailwindConfig.indexOf("fontFamily: {");
    expect(at, "tailwind.config.js 里找不到 fontFamily 块").toBeGreaterThan(0);
    const block = tailwindConfig.slice(at, tailwindConfig.indexOf("},", at));
    expect(block).toContain('sans: ["var(--font-sans)"]');
    expect(block).toContain('mono: ["var(--font-mono)"]');
    expect(block).toContain('condensed: ["var(--font-condensed)"]');
    // 出现具体字族名就是第二份真源，:root 改了它不会跟着改
    expect(block.match(/"(?:Segoe|PingFang|Microsoft|Consolas|monospace|sans-serif)/g) || [],
      "fontFamily 里又写了一份具体字体栈").toEqual([]);
  });

  it("@font-face 与 manifest 一一对应（按字族+字重配对，400 会出现两次）", () => {
    const faces = [...appCss.matchAll(
      /@font-face\s*\{([^}]+)\}/g,
    )].map((m) => {
      const body = m[1];
      const pick = (prop: string) => (body.match(new RegExp(prop + ":\\s*([^;]+);")) || [])[1]?.trim();
      return {
        family: pick("font-family"),
        weight: Number(pick("font-weight")),
        src: pick("src"),
      };
    });
    expect(faces.length, "@font-face 的只数和 manifest 不一致").toBe(manifest.files.length);
    for (const fam of FAMILIES) {
      expect(faces.some((f) => f.family === '"' + fam + '"'), "app.css 里没有 " + fam + " 的 @font-face").toBe(true);
    }
    // 常规字族四档必须齐；窄体只带 400，想多一档先谈体积（一只约 1.2MB）。
    expect(
      faces.filter((f) => f.family === '"' + manifest.family + '"').map((f) => f.weight).sort((a, b) => a - b),
      "常规字族的字重档变了",
    ).toEqual(WEIGHTS);
    for (const face of faces) {
      expect(face.src, "缺 format(\"woff2\")").toContain('format("woff2")');
      const declared = manifest.files.find(
        (f) => '"' + f.family + '"' === face.family && f.weight === face.weight,
      );
      expect(declared, "字面 " + face.family + " " + face.weight + " 在 manifest 里没有对应文件").toBeTruthy();
      expect(face.src).toContain("./assets/fonts/" + declared!.file);
    }
  });
});