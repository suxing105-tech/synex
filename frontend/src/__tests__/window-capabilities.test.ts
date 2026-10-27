import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * F 键的窗口三步（最大化 / 全屏 / 还原）走的是 Tauri 命令，命令必须在能力清单里逐条放行。
 *
 * 上一版就是这么翻车的：`toggleMaximize`（标题栏在用）有权限，`maximize` / `setFullscreen`
 * 没有，于是按第二下 F 就弹「窗口操作失败，请重试」。逻辑没写错，权限漏了 —— 单测照样全绿。
 * 所以这里把 window-focus.ts 真正 await 的方法名和能力清单钉在一起，少一条就直接红。
 */
const capability = JSON.parse(
  readFileSync(resolve(process.cwd(), "src-tauri/capabilities/default.json"), "utf8"),
) as { windows: string[]; permissions: string[] };
const source = readFileSync(resolve(process.cwd(), "src/lib/window-focus.ts"), "utf8");

const commands = [...source.matchAll(/await win\??\.([A-Za-z]+)\(/g)].map((m) => m[1]);
const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

describe("窗口命令的 Tauri 权限", () => {
  it("window-focus 真的调用了最大化、取消最大化、全屏、查最大化状态", () => {
    expect([...new Set(commands)].sort()).toEqual(["isMaximized", "maximize", "setFullscreen", "unmaximize"]);
  });

  it("每一条窗口命令都在能力清单里显式放行", () => {
    for (const command of commands) {
      expect(capability.permissions, `缺 ${command} 的权限：按 F 会弹「窗口操作失败」`).toContain(
        `core:window:allow-${kebab(command)}`,
      );
    }
  });

  it("能力清单作用在 main 窗口上，否则权限根本不生效", () => {
    expect(capability.windows).toContain("main");
  });

  it("标题栏原有的最小化 / 切换最大化 / 关闭权限没有被这次补权限挤掉", () => {
    for (const p of ["core:window:allow-minimize", "core:window:allow-toggle-maximize", "core:window:allow-close"]) {
      expect(capability.permissions).toContain(p);
    }
  });
});
