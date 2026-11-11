import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import {
  CLONE_HISTORY_LIMIT,
  applyCloneProgress,
  clearCloneBatches,
  clearCloneHistory,
  cloneHistory,
} from "../lib/clone";
import type { CloneOutput } from "../lib/clone";

/**
 * 右侧栏「队列」那一页读的那份「本次运行」（方案 3 第三批，2026-11-11）。
 *
 * 它和画布那份 cloneBatches 同一个封存点、不同寿命，所以钉四件最容易说假话的事：
 * 1) 只有真跑完才封存，跑挂/还在跑的不占位；
 * 2) 同一条 job 被 WS 重复推只留一条，时间戳记第一次（否则每推一次就冒出一个新批次）；
 * 3) 关掉弹窗清的是画布那份，右栏这份必须还在——它要回答的正是「弹窗关了以后那批去哪了」；
 * 4) 花费没实测出来是 null，不是 0。写成 0 会在界面上变成「花 0 币」，那是假话。
 */

const out = (id: number, kind = "image"): CloneOutput => ({
  id,
  kind,
  filename: "out-" + id + ".png",
  thumbnail_url: "/api/images/" + id + "/file?max=256",
});

/** 后端 public_state 的形状：只写封存要读的那几样，其余由 applyCloneProgress 兜底。 */
const done = (jobId: string, outputs: CloneOutput[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  active: true,
  job_id: jobId,
  state: "done",
  media_kind: "image",
  image_ids: outputs.map((o) => o.id),
  outputs,
  ...over,
});

beforeEach(() => {
  clearCloneHistory();
});

describe("右侧栏队列的本次运行封存", () => {
  it("跑完一批封一条，新的排在最前", () => {
    applyCloneProgress(done("j1", [out(1), out(2)]));
    applyCloneProgress(done("j2", [out(3)]));
    const list = get(cloneHistory);
    expect(list.map((h) => h.jobId)).toEqual(["j2", "j1"]);
    const newest = list[0];
    if (!newest) throw new Error("最新那条应当在");
    expect(newest.outputs.map((o) => o.id)).toEqual([3]);
    expect(newest.mediaKind).toBe("image");
    // 老后端一条云端字段都不发，封存那刻要照本机口径填好，不能留 undefined 给模板去点
    expect(newest.engine).toBe("comfyui");
    expect(newest.costCoins).toBeNull();
  });

  it("同一条 job 被 WS 重复推只留一条，时间戳记第一次", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    applyCloneProgress(done("j1", [out(1)]));
    clock.mockReturnValue(1_700_000_060_000);
    applyCloneProgress(done("j1", [out(1)]));
    expect(get(cloneHistory)).toHaveLength(1);
    const only = get(cloneHistory)[0];
    if (!only) throw new Error("应当留下一条");
    expect(only.at).toBe(1_700_000_000_000);
    clock.mockRestore();
  });

  it("产出变多时原位更新，不另起一行", () => {
    applyCloneProgress(done("j1", [out(1)]));
    applyCloneProgress(done("j1", [out(1), out(2)]));
    const list = get(cloneHistory);
    expect(list).toHaveLength(1);
    const only = list[0];
    if (!only) throw new Error("应当留下一条");
    expect(only.outputs).toHaveLength(2);
  });

  it("还在跑的、跑挂的、跑完但零产出的都不占位", () => {
    applyCloneProgress({ active: true, job_id: "r1", state: "running", outputs: [], image_ids: [] });
    applyCloneProgress({ active: true, job_id: "e1", state: "error", error: "显存不够", outputs: [], image_ids: [] });
    applyCloneProgress({ active: true, job_id: "d0", state: "done", outputs: [], image_ids: [] });
    expect(get(cloneHistory)).toEqual([]);
  });

  it("弹窗那份封存开关关掉时，右栏这份也不写（同一个封存点，不各写各的）", () => {
    applyCloneProgress(done("j1", [out(1)]), { seal: false });
    expect(get(cloneHistory)).toEqual([]);
  });

  it("关弹窗清的是画布那份，右栏这份必须还在", () => {
    applyCloneProgress(done("j1", [out(1)]));
    clearCloneBatches();
    expect(get(cloneHistory).map((h) => h.jobId)).toEqual(["j1"]);
  });

  it("只留最近 " + CLONE_HISTORY_LIMIT + " 批，多出来的从最旧那头掉", () => {
    for (let i = 1; i <= CLONE_HISTORY_LIMIT + 2; i++) {
      applyCloneProgress(done("j" + i, [out(i)]));
    }
    const list = get(cloneHistory);
    expect(list).toHaveLength(CLONE_HISTORY_LIMIT);
    expect(list[0]?.jobId).toBe("j" + (CLONE_HISTORY_LIMIT + 2));
    expect(list.map((h) => h.jobId)).not.toContain("j1");
  });

  it("云端那批记住 engine 与实付，本机那批记住本机", () => {
    applyCloneProgress(done("c1", [out(9)], { engine: "cloud", provider: "seedance", cost_coins: 12 }));
    const cloud = get(cloneHistory)[0];
    if (!cloud) throw new Error("云端那条应当在");
    expect(cloud.engine).toBe("cloud");
    expect(cloud.provider).toBe("seedance");
    expect(cloud.costCoins).toBe(12);
  });

  it("clearCloneHistory 清空（换库 / 重开这种整屏作废的场合用）", () => {
    applyCloneProgress(done("j1", [out(1)]));
    clearCloneHistory();
    expect(get(cloneHistory)).toEqual([]);
  });
});

