import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";
import VideoPromptPanel from "../components/VideoPromptPanel.svelte";
import ModelSettings from "../components/ModelSettings.svelte";
import { modelConfigs, reverseApi, reverseSettings } from "../lib/reverse-prompts";
import { segmentQueue, translationJobs, videoPromptApi, videoPromptJobs, videoPromptSettings } from "../lib/video-prompts";
import type { PromptRun, SegmentRecord, VideoPromptHistory, VideoPromptSettings } from "../lib/video-prompts";
import { copyText } from "../lib/ws";

vi.mock("../lib/ws", () => ({ copyText: vi.fn().mockResolvedValue(true) }));
vi.mock("../lib/toast", () => ({ pushToast: vi.fn() }));
vi.mock("../lib/image-clipboard", () => ({
  copyDataUrlImage: vi.fn().mockResolvedValue(undefined),
  dataUrlToBlob: vi.fn(() => new Blob(["x"], { type: "image/jpeg" })),
  downloadBlob: vi.fn(),
}));
import { copyDataUrlImage, downloadBlob } from "../lib/image-clipboard";

const model = {
  id: 1, name: "视觉模型", base_url: "https://example.com/v1", model: "vision", timeout: 120,
  provider: null, has_api_key: true, key_persistence: "encrypted" as const,
};
const prefs: VideoPromptSettings = {
  id: 1, default_model_id: 1, instruction_plan: "拆分镜", instruction_seedance: "写 Seedance",
  instruction_h3: "write H3", default_h3_mode: "t2va", frame_limit: 12, max_unit_seconds: 15, max_units: 12,
  defaults: { instruction_plan: "默认拆分镜", instruction_seedance: "默认 Seedance", instruction_h3: "default H3",
    default_h3_mode: "t2va", frame_limit: 12, max_unit_seconds: 15, max_units: 12 },
};

function seg(id: number, index: number, target: "seedance2" | "h3", prompt: string): SegmentRecord {
  return {
    id, segment_index: index, target, h3_mode: target === "h3" ? "t2va" : null, prompt,
    risk_terms: ["真人 → 写实风格"], raw_text: "", status: "complete", source: "generated", parent_id: null,
    model_name: "视觉模型", model: "vision", created_at: "2026-10-19T01:00:00Z", video_changed: false,
    translation: null,
  };
}

function makeRun(overrides: Partial<PromptRun> = {}): PromptRun {
  return {
    id: 7, status: "planned", error: null, created_at: "2026-10-19T01:00:00Z", model_name: "视觉模型",
    model: "vision", range_start_ms: 0, range_end_ms: 30000, anchors_text: "写实风格，16:9，同一女主播",
    sound_note: "", max_unit_seconds: 15, risk_terms: ["裸露 → 低领"], video_changed: false,
    versions: { seedance2: 1, h3: 1 },
    units: [
      { index: 1, start_ms: 0, end_ms: 15000, shots: [{ start_ms: 0, end_ms: 8000, synthetic: false },
        { start_ms: 8000, end_ms: 15000, synthetic: false }], role: "女主播走进画面", warn: null,
        frames: { first: { at: 0 }, last: { at: 14.75 } },
        current: { seedance2: seg(11, 1, "seedance2", "【风格】写实，15 秒，16:9"), h3: seg(12, 1, "h3", "integrated_multimodal_description: a host") } },
      { index: 2, start_ms: 15000, end_ms: 22000, shots: [], role: "产品特写收尾", warn: "短于 4 秒",
        frames: { first: { at: 15 }, last: { at: 21.75 } },
        current: { seedance2: seg(13, 2, "seedance2", "将@视频 1 延长 7 秒"), h3: seg(14, 2, "h3", "integrated_multimodal_description: close-up") } },
    ],
    ...overrides,
  };
}

function history(runs: PromptRun[], extra: Partial<VideoPromptHistory> = {}): VideoPromptHistory {
  return { runs, total: runs.length, limit: 10, offset: 0, running: false, running_plan: false,
    running_segments: [], ...extra };
}

beforeEach(() => {
  videoPromptJobs.set({}); translationJobs.set({}); segmentQueue.set(null); videoPromptSettings.set(prefs);
  modelConfigs.set([model]);
  reverseSettings.set({ default_model_id: 1, instruction: "", default_instruction: "" });
  vi.spyOn(reverseApi, "models").mockResolvedValue([model]);
  vi.spyOn(reverseApi, "settings").mockResolvedValue({ default_model_id: 1, instruction: "", default_instruction: "" });
  vi.spyOn(videoPromptApi, "settings").mockResolvedValue(prefs);
  vi.spyOn(videoPromptApi, "history").mockResolvedValue(history([makeRun()]));
  vi.spyOn(videoPromptApi, "versions").mockResolvedValue({ records: [], total: 0, limit: 50, offset: 0 });
  vi.spyOn(videoPromptApi, "referenceFrame").mockImplementation(async (_v, _r, index, edge) => ({
    edge, at: edge === "first" ? index * 10 : index * 10 + 9, requested_at: 0, source: "cache",
    data_url: "data:image/jpeg;base64,QUJD",
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("视频反推面板", () => {
  it("未配置模型时给出配置入口", async () => {
    modelConfigs.set([]);
    vi.mocked(reverseApi.models).mockResolvedValue([]);
    const listener = vi.fn();
    window.addEventListener("open-model-settings", listener);
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await fireEvent.click(panel.getByText("配置模型"));
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener("open-model-settings", listener);
  });

  it("渲染分镜方案：锚点、单元列表与每段按钮", async () => {
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText(/P01｜15 秒｜原片 0–15 秒/)).toBeTruthy());
    expect(panel.getByText(/P02｜7 秒｜原片 15–22 秒/)).toBeTruthy();
    expect(panel.getByText("女主播走进画面")).toBeTruthy();
    expect(panel.getByText("写实风格，16:9，同一女主播")).toBeTruthy();
    expect(panel.getByText("短于 4 秒")).toBeTruthy();
    expect(panel.getByText("2 个镜头")).toBeTruthy();
    expect(panel.getAllByText("两种都要")).toHaveLength(2);
    expect(panel.getByText("声音为画面推测")).toBeTruthy();
    await fireEvent.click(panel.getByText("复制锚点"));
    expect(copyText).toHaveBeenLastCalledWith("写实风格，16:9，同一女主播");
  });

  it("两种格式各自成页，切换互不覆盖", async () => {
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("【风格】写实，15 秒，16:9")).toBeTruthy());
    expect(panel.queryByText(/integrated_multimodal_description/)).toBeNull();
    await fireEvent.click(panel.getByText("MiniMax H3"));
    await waitFor(() => expect(panel.getByText(/integrated_multimodal_description: a host/)).toBeTruthy());
    expect(panel.queryByText("【风格】写实，15 秒，16:9")).toBeNull();
    expect(panel.queryAllByText("将@视频 1 延长 7 秒")).toHaveLength(0);
    await fireEvent.click(panel.getByText("Seedance 2.0"));
    await waitFor(() => expect(panel.getAllByText("将@视频 1 延长 7 秒")).toHaveLength(1));
    expect(panel.getByText("【风格】写实，15 秒，16:9")).toBeTruthy();
  });

  it("每段显示参考帧缩略图，可复制图片与存盘", async () => {
    const ref = vi.mocked(videoPromptApi.referenceFrame);
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByLabelText("复制P01 首帧")).toBeTruthy());
    expect(panel.getByText(/参考帧 · 首帧 @0 秒 ｜ 末帧 @15 秒/)).toBeTruthy();
    expect(panel.getByText(/参考帧 · 首帧 @15 秒 ｜ 末帧 @22 秒/)).toBeTruthy();
    expect(panel.getAllByText("复制图")).toHaveLength(4);
    expect(panel.getByText(/@0 秒 · @图片 1 作为首帧上传/)).toBeTruthy();
    expect(panel.getAllByText(/本段末帧，用作下一段衔接的对照/)).toHaveLength(2);
    expect(ref).toHaveBeenCalledWith(5, 7, 1, "first");
    await fireEvent.click(panel.getByLabelText("复制P02 末帧"));
    expect(copyDataUrlImage).toHaveBeenLastCalledWith("data:image/jpeg;base64,QUJD");
    await fireEvent.click(panel.getByLabelText("下载P02 末帧"));
    expect(downloadBlob).toHaveBeenLastCalledWith(expect.any(Blob), "clip-P02-last.jpg");
  });

  it("H3 链式模式说清 Picture 1 该用上一段生成结果的末帧", async () => {
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("MiniMax H3")).toBeTruthy());
    await fireEvent.click(panel.getByText("MiniMax H3"));
    await waitFor(() => expect(panel.getAllByText(/参考帧（T2VA 正文不引用图片）/)).toHaveLength(4));
    const mode = panel.container.querySelector<HTMLSelectElement>('select[aria-label="H3 模式"]')!;
    mode.value = "i2va";
    await fireEvent.change(mode, { target: { value: "i2va" } });
    await waitFor(() => expect(panel.getByText(/第 2 段起用上一段生成结果的末帧/)).toBeTruthy());
    expect(panel.getByText(/<Picture 1> = 视频真实首帧/)).toBeTruthy();
    expect(panel.getByText(/<Picture 1> 请改用上一段生成结果的末帧（此帧仅作对照）/)).toBeTruthy();
    expect(panel.getAllByText(/本段末帧，即下一段的 <Picture 1>/)).toHaveLength(2);
    expect(panel.getAllByText(/只是原片对照帧/)).toHaveLength(1);
  });

  it("逐段生成失败标红，可单独重试并刷新列表", async () => {
    const base = makeRun().units;
    const emptyRun = makeRun({ units: base.map(u => (u.index === 2 ? { ...u, current: {} } : u)) });
    const filledRun = makeRun({ units: base.map(u => (u.index === 2
      ? { ...u, current: { seedance2: seg(21, 2, "seedance2", "【风格】新生成的第 2 段") } } : u)) });
    let calls = 0;
    vi.mocked(videoPromptApi.history).mockImplementation(async () => {
      calls += 1;
      return history([calls <= 2 ? emptyRun : filledRun]);
    });
    const segment = vi.spyOn(videoPromptApi, "segment")
      .mockRejectedValueOnce({ detail: "模型请求超时" })
      .mockResolvedValue(seg(21, 2, "seedance2", "【风格】新生成的第 2 段"));
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText(/P02/)).toBeTruthy());
    expect(panel.queryAllByText("重试本段")).toHaveLength(0);
    expect(panel.getByText("该段还没有 Seedance 2.0 正文。")).toBeTruthy();
    await fireEvent.click(panel.getAllByText("Seedance")[1]);
    await waitFor(() => expect(segment).toHaveBeenCalledTimes(1));
    expect(segment.mock.calls[0][3]).toMatchObject({ target: "seedance2", h3_mode: null, model_config_id: 1 });
    await waitFor(() => expect(panel.getByText("模型请求超时")).toBeTruthy());
    const retry = panel.getAllByText("重试本段");
    expect(retry).toHaveLength(1);
    await fireEvent.click(retry[0]);
    await waitFor(() => expect(segment).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(panel.getByText("【风格】新生成的第 2 段")).toBeTruthy());
  });

  it("服务端在跑时禁用生成按钮", async () => {
    vi.mocked(videoPromptApi.history).mockResolvedValue(history([makeRun()], { running: true }));
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText(/P01/)).toBeTruthy());
    for (const button of panel.getAllByText("两种都要")) expect(button.hasAttribute("disabled")).toBe(true);
    expect(panel.getByText("全部生成（两种）").hasAttribute("disabled")).toBe(true);
  });

  it("设置页恢复默认指令并保存视频反推偏好", async () => {
    modelConfigs.set([model]);
    vi.spyOn(reverseApi, "providers").mockResolvedValue([]);
    const save = vi.spyOn(videoPromptApi, "saveSettings").mockImplementation(async value => {
      videoPromptSettings.set({ ...prefs, ...value });
      return { ...prefs, ...value };
    });
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("视频反推默认模型")).toBeTruthy());
    expect((panel.getByLabelText("分镜方案指令") as HTMLTextAreaElement).value).toBe("拆分镜");
    await fireEvent.click(panel.getByText("恢复默认（分镜方案）"));
    expect((panel.getByLabelText("分镜方案指令") as HTMLTextAreaElement).value).toBe("默认拆分镜");
    await fireEvent.click(panel.getByText("恢复默认（Seedance）"));
    await fireEvent.click(panel.getByText("恢复默认（H3）"));
    expect((panel.getByLabelText("Seedance 指令") as HTMLTextAreaElement).value).toBe("默认 Seedance");
    expect((panel.getByLabelText("H3 指令") as HTMLTextAreaElement).value).toBe("default H3");
    const frameLimit = panel.getByLabelText("视频帧数上限") as HTMLInputElement;
    frameLimit.value = "8";
    await fireEvent.input(frameLimit);
    await fireEvent.click(panel.getByText("保存视频反推偏好"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({
      default_model_id: 1, default_h3_mode: "t2va", frame_limit: 8,
      max_unit_seconds: 15, max_units: 12, instruction_plan: "默认拆分镜",
    });
  });

  it("编辑保存为新版本", async () => {
    const edit = vi.spyOn(videoPromptApi, "edit").mockResolvedValue({ ...seg(31, 1, "seedance2", "改过"),
      source: "edited", parent_id: 11 });
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("【风格】写实，15 秒，16:9")).toBeTruthy());
    await fireEvent.click(panel.getAllByText("编辑")[0]);
    await fireEvent.input(panel.getByLabelText("编辑 P01 Seedance 2.0"), { target: { value: "改过的正文" } });
    await fireEvent.click(panel.getByText("保存为新版本"));
    await waitFor(() => expect(edit).toHaveBeenCalled());
    expect(edit.mock.calls[0][3]).toMatchObject({ target: "seedance2", prompt: "改过的正文", parent_id: 11 });
  });

  it("秒数一律整数：区间输入与段时长都不出现小数", async () => {
    const plan = vi.spyOn(videoPromptApi, "plan").mockResolvedValue(makeRun({ id: 8 }));
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 15.116 });
    await waitFor(() => expect(panel.getByText("时长 15 秒")).toBeTruthy());
    const end = panel.getByLabelText("反推结束秒") as HTMLInputElement;
    expect(end.step).toBe("1");
    expect(end.placeholder).toBe("15");
    end.value = "15.6";
    await fireEvent.input(end);
    await fireEvent.click(panel.getByText("反推分镜方案"));
    await waitFor(() => expect(plan).toHaveBeenCalled());
    expect(plan.mock.calls[0][1]).toMatchObject({ start_ms: null, end_ms: 16000 });
  });

  it("译文与原文一键切换，切回来不再花调用", async () => {
    const translate = vi.spyOn(videoPromptApi, "translate").mockResolvedValue({
      record_id: 11, language: "zh", text: "【风格】中文译文正文", model_name: "视觉模型", model: "vision",
      created_at: "2026-10-19T02:00:00Z", source: "model",
    });
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("【风格】写实，15 秒，16:9")).toBeTruthy());
    expect(panel.getByLabelText("翻译 P01 Seedance 2.0")).toBeTruthy();
    await fireEvent.click(panel.getByLabelText("翻译 P01 Seedance 2.0"));
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    expect(translate.mock.calls[0][3]).toMatchObject({ target: "seedance2", model_config_id: 1 });
    await waitFor(() => expect(panel.getByText("【风格】中文译文正文")).toBeTruthy());
    expect(panel.queryByText("【风格】写实，15 秒，16:9")).toBeNull();
    expect(panel.getByText(/机器翻译，只用于阅读/)).toBeTruthy();
    await fireEvent.click(panel.getByText("复制译文"));
    expect(copyText).toHaveBeenLastCalledWith("【风格】中文译文正文");
    await fireEvent.click(panel.getAllByText("复制Seedance 2.0")[0]);
    expect(copyText).toHaveBeenLastCalledWith("【风格】写实，15 秒，16:9");
    await fireEvent.click(panel.getByLabelText("显示原文 P01 Seedance 2.0"));
    await waitFor(() => expect(panel.getByText("【风格】写实，15 秒，16:9")).toBeTruthy());
    await fireEvent.click(panel.getByLabelText("翻译 P01 Seedance 2.0"));
    await waitFor(() => expect(panel.getByText("【风格】中文译文正文")).toBeTruthy());
    expect(translate).toHaveBeenCalledTimes(1);  // 已有译文，第二次点开不再请求
  });

  it("服务端存过译文后重新打开面板也不再请求", async () => {
    const stored = { record_id: 11, language: "zh" as const, text: "【风格】已存过的译文",
      model_name: "视觉模型", model: "vision", created_at: "2026-10-19T02:00:00Z" };
    const base = makeRun().units;
    vi.mocked(videoPromptApi.history).mockResolvedValue(history([makeRun({
      units: base.map(u => (u.index === 1
        ? { ...u, current: { seedance2: { ...seg(11, 1, "seedance2", "【风格】写实，15 秒，16:9"), translation: stored } } }
        : u)),
    })]));
    const translate = vi.spyOn(videoPromptApi, "translate").mockResolvedValue({ ...stored, source: "cache" });
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("【风格】写实，15 秒，16:9")).toBeTruthy());
    await fireEvent.click(panel.getByLabelText("翻译 P01 Seedance 2.0"));
    await waitFor(() => expect(panel.getByText("【风格】已存过的译文")).toBeTruthy());
    expect(translate).not.toHaveBeenCalled();
  });

  it("翻译失败留下中文错误，正文仍可复制", async () => {
    vi.spyOn(videoPromptApi, "translate").mockRejectedValue({ detail: "模型请求超时，可调整超时后手动重试" });
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("【风格】写实，15 秒，16:9")).toBeTruthy());
    await fireEvent.click(panel.getByLabelText("翻译 P01 Seedance 2.0"));
    await waitFor(() => expect(panel.getByText("模型请求超时，可调整超时后手动重试")).toBeTruthy());
    expect(panel.getByText("【风格】写实，15 秒，16:9")).toBeTruthy();
  });
});