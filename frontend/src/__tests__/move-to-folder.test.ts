import { describe, it, expect } from "vitest";
import { moveStats, moveSummary, type MoveResult } from "../lib/move-result";

const moved = (id: number, filename = "a.png"): MoveResult["moved"][number] => ({
  id,
  filename,
  path: `C:/SeekX-Data/folders/HOF/${filename}`,
  renamed: false,
});

describe("moveStats", () => {
  it("后端字段缺失时退化为 0，不抛错", () => {
    expect(moveStats({ ids: [1], folder_id: 3 } as unknown as MoveResult)).toEqual({
      moved: 0,
      kept: 0,
      failed: [],
    });
  });

  it("统计 moved / kept / failed", () => {
    const stats = moveStats({
      ids: [1, 2],
      folder_id: 3,
      moved: [moved(1)],
      kept: [2],
      failed: [{ id: 3, filename: "c.png", error: "文件被其它程序占用或没有写入权限" }],
    });
    expect(stats).toEqual({ moved: 1, kept: 1, failed: [{ id: 3, filename: "c.png", error: "文件被其它程序占用或没有写入权限" }] });
  });
});

describe("moveSummary 文案", () => {
  it("移动到文件夹成功时说明文件真的换了目录", () => {
    expect(moveSummary({ moved: 2, kept: 0, failed: [] }, "HOF")).toBe("已真实移动 2 个文件到「HOF」");
  });

  it("文件本来就在目标目录时不谎称搬动", () => {
    expect(moveSummary({ moved: 0, kept: 1, failed: [] }, "HOF")).toBe("已归入「HOF」（文件已在该目录，未改动）");
  });

  it("移出文件夹：应用自己目录里的文件回到收件箱", () => {
    expect(moveSummary({ moved: 3, kept: 0, failed: [] }, null)).toBe("已移出文件夹，3 个文件已回到收件箱");
  });

  it("移出文件夹：用户自己的目录里的文件保持原位", () => {
    expect(moveSummary({ moved: 0, kept: 2, failed: [] }, null)).toBe("已移出文件夹（你自己的目录里的文件保持原位）");
  });

  it("部分失败时把原因写进提示", () => {
    const text = moveSummary(
      { moved: 1, kept: 0, failed: [{ id: 9, filename: "busy.mp4", error: "文件被其它程序占用或没有写入权限" }] },
      "影驰",
    );
    expect(text).toBe("已真实移动 1 个文件到「影驰」，1 个失败（busy.mp4：文件被其它程序占用或没有写入权限）");
  });

  it("全军覆没时不报成功", () => {
    expect(moveSummary({ moved: 0, kept: 0, failed: [{ id: 1, filename: "", error: "原文件不存在，未更新位置" }] }, "HOF"))
      .toBe("未能移动到「HOF」，1 个失败（原文件不存在，未更新位置）");
  });
});
