import { describe, expect, it } from "vitest";
import {
  MAX_LOCATION_CHARS,
  displayPath,
  lastSegment,
  nativePath,
  parentDirectory,
} from "../lib/file-location";

describe("parentDirectory：从文件路径推出所在目录", () => {
  it("去掉最后一段文件名", () => {
    expect(parentDirectory("C:/SeekX-Data/folders/影驰/image.png")).toBe(
      "C:/SeekX-Data/folders/影驰",
    );
  });

  it("POSIX 路径同样成立，根目录下的文件回到 /", () => {
    expect(parentDirectory("/Users/suxing/a.png")).toBe("/Users/suxing");
    expect(parentDirectory("/a.png")).toBe("/");
  });

  it("目录结尾的斜杠不算文件名", () => {
    expect(parentDirectory("C:/SeekX-Data/folders/影驰/")).toBe("C:/SeekX-Data/folders");
  });

  it("没有目录分隔符 / 空路径 → 空串（交给兜底显示）", () => {
    expect(parentDirectory("image.png")).toBe("");
    expect(parentDirectory("")).toBe("");
  });
});

describe("lastSegment", () => {
  it("取末段", () => {
    expect(lastSegment("C:/SeekX-Data/folders/影驰/image.png")).toBe("image.png");
    expect(lastSegment("C:\\a\\b\\")).toBe("b");
  });
});

describe("nativePath：Windows 路径按反斜杠展示", () => {
  it("盘符路径把正斜杠换成反斜杠", () => {
    expect(nativePath("C:/SeekX-Data/folders/影驰")).toBe("C:\\SeekX-Data\\folders\\影驰");
  });

  it("POSIX 路径保持原样", () => {
    expect(nativePath("/Users/suxing/a")).toBe("/Users/suxing/a");
  });
});

describe("displayPath：详情面板宽度有限，超长路径中间省略", () => {
  it("不长的路径原样显示", () => {
    expect(displayPath("C:/SeekX-Data/folders/影驰")).toBe("C:\\SeekX-Data\\folders\\影驰");
  });

  it("超长路径保留头和末两级，中间用省略号", () => {
    const long =
      "C:/Users/Administrator/Documents/ChatGPT/产品广告宣传片/materials/tvc-director-worktree/references";
    const shown = displayPath(long);
    expect(shown.startsWith("C:\\Users")).toBe(true);
    expect(shown.endsWith("references")).toBe(true);
    expect(shown).toContain("…");
    expect(shown.length).toBeLessThan(long.length);
  });

  it("层级太少时无处可省，直接尾部截断", () => {
    const wide = "C:/" + "x".repeat(80);
    const shown = displayPath(wide);
    expect(shown.endsWith("…")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(MAX_LOCATION_CHARS);
  });
});