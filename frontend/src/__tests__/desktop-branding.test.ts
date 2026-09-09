import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));

describe("桌面品牌与深色窗口", () => {
  it("浅色系统下仍使用深色原生标题栏，并保留窗口控制按钮", () => {
    const main = config.app.windows.find((w: { label: string }) => w.label === "main");
    expect(main.theme).toBe("Dark");
    expect(main.backgroundColor).toBe("#18181b");
    expect(main.decorations).toBe(true);
    expect(main.resizable).toBe(true);
  });

  it("页面使用用户指定的原始 Logo", () => {
    const logo = readFileSync(resolve(root, "public/logo.png"));
    expect(createHash("sha256").update(logo).digest("hex")).toBe(
      "1d256ba212906831a8a54785168687562475a409ade4365faac8b24e9008d075",
    );
  });

  it("桌面和安装包均使用已生成的有效多尺寸 Windows 图标", () => {
    expect(config.bundle.icon).toContain("icons/icon.ico");
    expect(config.bundle.windows.nsis.installerIcon).toBe("icons/icon.ico");
    const icon = readFileSync(resolve(root, "src-tauri/icons/icon.ico"));
    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
    expect(icon.readUInt16LE(4)).toBeGreaterThan(1);
    for (const [file, size] of [["32x32.png", 32], ["128x128.png", 128], ["128x128@2x.png", 256]] as const) {
      const png = readFileSync(resolve(root, "src-tauri/icons", file));
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
  });
});
