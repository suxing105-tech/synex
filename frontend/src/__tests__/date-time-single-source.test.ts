import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dateTimeLabel, formatDate } from "../lib/ws";

/**
 * 日期时间全站一支笔（2026-11-13 oil-ui 评审第三刀 T14）。
 *
 * 动手前三套写法并存，且都不锁输出：
 * - 详情栏 formatDate() = toLocaleString("zh-CN") → 单日不补零（2026-11-9），产物还随 ICU 版本变；
 * - 卡片页脚 footerTimeLabel() → 相对时间优先，露日期时是补零斜杠的 MM/DD（卡片窄，那是刻意降级，保留）；
 * - 反推面板、视频面板、阅读层历史列表共 7 处裸 toLocaleString() → 连 locale 都不给，
 *   跟着宿主 UI locale 走，非中文系统上同一份数据变成 "11/9/2026, 6:49:39 PM"。
 * 现在详情栏和这些面板全部走 dateTimeLabel()，输出锁成 YYYY-MM-DD HH:mm:ss。
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collect(p, out);
    else if (/\.(svelte|ts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const BANNED: Array<{ re: RegExp; why: string }> = [
  { re: /\.toLocaleString\(\s*\)/, why: "不带 locale 的 toLocaleString() 跟随宿主 UI locale，同一份数据在不同机器上写法不同" },
  { re: /new Date\([^)]*\)\.toLocaleString\(\s*"[^"]+"\s*\)/, why: "日期时间不许各自 toLocaleString，统一走 dateTimeLabel()" },
];

describe("日期时间只有一支笔 dateTimeLabel（第三刀 T14）", () => {
  it("源码里不许再出现自拼的日期时间（数字千分位的 toLocaleString 不在此列）", () => {
    // TextWorkspace 已下线（icon-unification.test.ts 的豁免名单），里面那处是死代码
    const files = collect(srcRoot).filter((f) => !f.endsWith("TextWorkspace.svelte"));
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith("*")) return; // 注释里点名问题不是违规
        for (const b of BANNED) if (b.re.test(line)) offenders.push(`${f.slice(srcRoot.length + 1)}:${i + 1} ${b.why}`);
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("月/日/时/分/秒一律补零，形状固定 19 位", () => {
    const at = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
      new Date(y, mo - 1, d, h, mi, s).getTime() / 1000; // 秒级本地时间戳，和 mtime 同口径
    expect(dateTimeLabel(at(2026, 11, 9, 8, 5, 3))).toBe("2026-11-09 08:05:03");
    expect(dateTimeLabel(at(2026, 11, 13, 14, 3, 52))).toBe("2026-11-13 14:03:52");
    expect(dateTimeLabel(at(2026, 1, 1, 0, 0, 0))).toBe("2026-01-01 00:00:00");
  });

  it("后端 ISO 串与秒级时间戳两种入参都收", () => {
    expect(dateTimeLabel("2026-11-09T08:05:03")).toBe("2026-11-09 08:05:03"); // 无 Z：按本地解析
    expect(dateTimeLabel("2026-11-09T08:05:03Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("空值与坏值给空串，不再渲染 Invalid Date", () => {
    expect(dateTimeLabel(null)).toBe("");
    expect(dateTimeLabel(undefined)).toBe("");
    expect(dateTimeLabel("")).toBe("");
    expect(dateTimeLabel("not-a-date")).toBe("");
    expect(dateTimeLabel(Number.NaN)).toBe("");
  });

  it("formatDate 只是 dateTimeLabel 的别名，不留第二份实现", () => {
    const seconds = new Date(2026, 10, 9, 8, 5, 3).getTime() / 1000;
    expect(formatDate(seconds)).toBe(dateTimeLabel(seconds));
  });
});