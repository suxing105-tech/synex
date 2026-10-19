import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

vi.mock("../lib/api", () => ({ http: vi.fn() }));

import { http } from "../lib/api";
import {
  expandSegments, frameUsage, generatePlan, generateSegments, planKey, secondText, secondsInputToMs,
  secondsRangeText, segmentKey, segmentQueue, translatePrompt, translationJobs, translationKey,
  translationOf, unitFrameAt, videoPromptApi, videoPromptJobs, wholeSecond,
} from "../lib/video-prompts";
import type { PromptRun, PromptTranslation, SegmentRecord } from "../lib/video-prompts";

const call = vi.mocked(http);

function record(id: number, index: number, target: "seedance2" | "h3"): SegmentRecord {
  return {
    id, segment_index: index, target, h3_mode: target === "h3" ? "t2va" : null, prompt: `正文 ${id}`,
    risk_terms: [], raw_text: "", status: "complete", source: "generated", parent_id: null,
    model_name: "视觉", model: "vision", created_at: "2026-10-19T01:00:00Z", video_changed: false,
    translation: null,
  };
}

const run: PromptRun = {
  id: 7, status: "planned", error: null, created_at: "2026-10-19T01:00:00Z", model_name: "视觉",
  model: "vision", range_start_ms: 0, range_end_ms: 30000, anchors_text: "锚点", sound_note: "",
  max_unit_seconds: 15, risk_terms: [], video_changed: false, versions: { seedance2: 0, h3: 0 },
  units: [
    { index: 1, start_ms: 0, end_ms: 15000, shots: [], role: "开场", warn: null, current: {} },
    { index: 2, start_ms: 15000, end_ms: 30000, shots: [], role: "收尾", warn: null, current: {} },
  ],
};

beforeEach(() => {
  call.mockReset();
  videoPromptJobs.set({});
  translationJobs.set({});
  segmentQueue.set(null);
});

describe("参考帧", () => {
  it("按段与边取参考帧，URL 带 which", async () => {
    call.mockResolvedValue({ edge: "last", at: 14.75, requested_at: 14.75, source: "cache", data_url: "data:image/jpeg;base64,QUJD" });
    const frame = await videoPromptApi.referenceFrame(5, 7, 1, "last");
    expect(call.mock.calls[0][0]).toBe("/api/videos/5/video-prompts/runs/7/segments/1/frame?which=last");
    expect(frame.source).toBe("cache");
  });

  it("秒数优先用后端落盘的值，缺失时按段边界兜底", () => {
    const unit = { ...run.units[0], frames: { first: { at: 0.0 }, last: { at: 14.72 } } };
    expect(unitFrameAt(unit, "first")).toBe(0);
    expect(unitFrameAt(unit, "last")).toBe(14.72);
    expect(unitFrameAt(run.units[1], "first")).toBe(15);
    expect(unitFrameAt(run.units[1], "last")).toBeCloseTo(29.75, 2);
  });

  it("说清这张图在提示词里是谁", () => {
    expect(frameUsage("seedance2", "t2va", 1, "first")).toContain("@图片 1");
    expect(frameUsage("seedance2", "t2va", 2, "first")).toContain("备用首帧");
    expect(frameUsage("h3", "i2va", 1, "first")).toContain("视频真实首帧");
    expect(frameUsage("h3", "i2va", 2, "first")).toContain("仅作对照");
    expect(frameUsage("h3", "fl2va", 1, "last")).toContain("Picture 2");
    expect(frameUsage("h3", "t2va", 1, "first")).toContain("不引用图片");
  });
});

describe("视频反推接口", () => {
  it("按约定路径与请求体调用后端", async () => {
    call.mockResolvedValue({});
    await videoPromptApi.plan(5, { model_config_id: 3, sound_note: "女声", start_ms: 1000, end_ms: 2000 });
    expect(call.mock.calls[0][0]).toBe("/api/videos/5/video-prompts/plans");
    expect(JSON.parse(call.mock.calls[0][1]!.body as string))
      .toEqual({ model_config_id: 3, sound_note: "女声", start_ms: 1000, end_ms: 2000 });
    await videoPromptApi.segment(5, 7, 2, { target: "h3", h3_mode: "fl2va", model_config_id: 3 });
    expect(call.mock.calls[1][0]).toBe("/api/videos/5/video-prompts/runs/7/segments/2");
    await videoPromptApi.edit(5, 7, 2, { target: "seedance2", prompt: "正文" });
    expect(call.mock.calls[2][0]).toBe("/api/videos/5/video-prompts/runs/7/segments/2/edits");
    await videoPromptApi.versions(5, 7, 2, "h3");
    expect(call.mock.calls[3][0]).toBe("/api/videos/5/video-prompts/runs/7/segments/2/records?target=h3");
    await videoPromptApi.frame(5, 12.5);
    expect(call.mock.calls[4][0]).toBe("/api/videos/5/frame?at=12.5");
    await videoPromptApi.history(5, 10, 20);
    expect(call.mock.calls[5][0]).toBe("/api/videos/5/video-prompts?limit=10&offset=20");
  });
});

describe("分段生成队列", () => {
  it("先按段、再按格式展开", () => {
    expect(expandSegments([1, 2], ["seedance2", "h3"]))
      .toEqual([{ index: 1, target: "seedance2" }, { index: 1, target: "h3" },
                { index: 2, target: "seedance2" }, { index: 2, target: "h3" }]);
    expect(expandSegments([3], ["h3"])).toEqual([{ index: 3, target: "h3" }]);
  });

  it("串行执行并逐段更新进度", async () => {
    const order: string[] = [];
    const progress: string[] = [];
    call.mockImplementation(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { target: "seedance2" | "h3" };
      order.push(body.target);
      progress.push(String(get(segmentQueue)?.done));
      return record(order.length, 1, body.target);
    });
    const failures = await generateSegments(5, 7, [1, 2], ["seedance2", "h3"], { h3_mode: "i2va" });
    expect(order).toEqual(["seedance2", "h3", "seedance2", "h3"]);
    expect(progress).toEqual(["0", "1", "2", "3"]);
    expect(failures).toEqual([]);
    expect(get(segmentQueue)).toBeNull();
    const bodies = call.mock.calls.map(c => JSON.parse(String(c[1]?.body)));
    expect(bodies.map(b => b.h3_mode)).toEqual([null, "i2va", null, "i2va"]);
    expect(get(videoPromptJobs)[segmentKey(7, 1, "h3")].result?.target).toBe("h3");
  });

  it("某段失败后续段继续，失败段可单独重试", async () => {
    const done: number[] = [];
    call.mockImplementation(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { target: "seedance2" | "h3" };
      if (body.target === "seedance2") throw { detail: "模型超时" };
      done.push(1);
      return record(9, 1, "h3");
    });
    const failures = await generateSegments(5, 7, [1], ["seedance2", "h3"]);
    expect(failures).toEqual([segmentKey(7, 1, "seedance2")]);
    expect(get(videoPromptJobs)[segmentKey(7, 1, "seedance2")].error).toBe("模型超时");
    expect(get(videoPromptJobs)[segmentKey(7, 1, "h3")].result?.id).toBe(9);
    expect(done).toEqual([1]);
  });

  it("已在跑的段不会重复提交", async () => {
    let finish!: (value: SegmentRecord) => void;
    call.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = generateSegments(5, 7, [1], ["h3"]);
    await Promise.resolve();
    const second = await generateSegments(5, 7, [1], ["h3"]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(second).toEqual([]);
    finish(record(1, 1, "h3"));
    await first;
    expect(get(videoPromptJobs)[segmentKey(7, 1, "h3")].running).toBe(false);
  });
});

describe("分镜方案请求", () => {
  it("去重并把结果放进 plan key", async () => {
    let finish!: (value: PromptRun) => void;
    call.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = generatePlan(5, { model_config_id: 1 });
    await Promise.resolve();
    expect(await generatePlan(5, { model_config_id: 1 })).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
    expect(get(videoPromptJobs)[planKey(5)].running).toBe(true);
    finish(run);
    await pending;
    expect(get(videoPromptJobs)[planKey(5)].run?.units).toHaveLength(2);
  });

  it("失败时保留中文错误", async () => {
    call.mockRejectedValue({ detail: "需要 14 段，超过上限 12" });
    expect(await generatePlan(5, {})).toBeNull();
    expect(get(videoPromptJobs)[planKey(5)].error).toBe("需要 14 段，超过上限 12");
  });
});

describe("整数秒口径", () => {
  it("秒数一律四舍五入成整数", () => {
    expect(secondText(15116)).toBe("15");
    expect(secondText(14750)).toBe("15");
    expect(secondText(11300)).toBe("11");
    expect(secondsRangeText(0, 15116)).toBe("0–15 秒");
    expect(wholeSecond(14.75)).toBe(15);
  });

  it("区间输入只认整数秒", () => {
    expect(secondsInputToMs("12")).toBe(12000);
    expect(secondsInputToMs("12.6")).toBe(13000);
    expect(secondsInputToMs("0")).toBe(0);
    expect(secondsInputToMs("  ")).toBeNull();
    expect(secondsInputToMs("abc")).toBeNull();
  });
});

describe("译文", () => {
  const zh: PromptTranslation = { record_id: 11, language: "zh", text: "中文译文",
    model_name: "视觉", model: "vision", created_at: "2026-10-19T02:00:00Z" };

  it("按版本 POST 到 translations 并写进 job", async () => {
    call.mockResolvedValue({ ...zh, source: "model" });
    const value = await translatePrompt(5, 7, 2, "h3", { model_config_id: 4 });
    expect(call.mock.calls[0][0]).toBe("/api/videos/5/video-prompts/runs/7/segments/2/translations");
    expect(JSON.parse(call.mock.calls[0][1]!.body as string)).toEqual({ target: "h3", model_config_id: 4 });
    expect(value?.language).toBe("zh");
    expect(get(translationJobs)[translationKey(7, 2, "h3")].value?.text).toBe("中文译文");
  });

  it("优先用本次翻出来的，其次用服务端随版本带回来的", () => {
    const key = translationKey(7, 1, "h3");
    const stored: SegmentRecord = { ...record(11, 1, "h3"), translation: zh };
    expect(translationOf(stored, key, {})?.text).toBe("中文译文");
    expect(translationOf(stored, key, { [key]: { running: false, value: { ...zh, text: "本次" } } })?.text).toBe("本次");
    expect(translationOf(record(2, 1, "h3"), key, {})).toBeNull();
  });

  it("重跑出新版本后不再沿用上一版的译文", () => {
    const key = translationKey(7, 1, "h3");
    const rerolled = record(21, 1, "h3");  // 新版本，服务端没带译文
    const stale = { [key]: { running: false, value: zh } };  // 老版本（id 11）的译文还留在内存里
    expect(translationOf(rerolled, key, stale)).toBeNull();
  });

  it("失败留下中文错误，同一个版本不重复提交", async () => {
    let finish!: (value: unknown) => void;
    call.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = translatePrompt(5, 7, 1, "h3");
    await Promise.resolve();
    expect(await translatePrompt(5, 7, 1, "h3")).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
    expect(get(translationJobs)[translationKey(7, 1, "h3")].running).toBe(true);
    finish({ ...zh, source: "model" });
    await pending;
    call.mockRejectedValue({ detail: "模型请求超时" });
    expect(await translatePrompt(5, 7, 2, "h3")).toBeNull();
    expect(get(translationJobs)[translationKey(7, 2, "h3")].error).toBe("模型请求超时");
  });
});
