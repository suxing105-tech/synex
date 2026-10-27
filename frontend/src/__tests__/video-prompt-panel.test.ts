import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";
import VideoPromptPanel from "../components/VideoPromptPanel.svelte";
import ModelSettings from "../components/ModelSettings.svelte";
import { modelConfigs, reverseApi, reverseSettings } from "../lib/reverse-prompts";
import { segmentQueue, translationJobs, videoPromptApi, videoPromptJobs, videoPromptSettings } from "../lib/video-prompts";
import type { PromptMode, PromptReference, PromptRun, SegmentRecord, VideoPromptHistory, VideoPromptSettings } from "../lib/video-prompts";
import { copyText } from "../lib/ws";

vi.mock("../lib/ws", () => ({ copyText: vi.fn().mockResolvedValue(true) }));
vi.mock("../lib/toast", () => ({ pushToast: vi.fn(() => 1), updateToast: vi.fn(), dismissToast: vi.fn() }));
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
  instruction_h3: "write H3", default_mode_h3: "t2va", default_mode_seedance: "t2v",
  frame_limit: 12, max_unit_seconds: 15, max_units: 12,
  defaults: { instruction_plan: "默认拆分镜", instruction_seedance: "默认 Seedance", instruction_h3: "default H3",
    default_mode_h3: "t2va", default_mode_seedance: "t2v", frame_limit: 12, max_unit_seconds: 15, max_units: 12 },
};

function seg(id: number, index: number, target: "seedance2" | "h3", prompt: string,
             references: PromptReference[] = [], mode: PromptMode | null = null): SegmentRecord {
  return {
    id, segment_index: index, target, mode: target === "h3" ? (mode ?? "t2va") : mode, prompt,
    risk_terms: ["真人 → 写实风格"], raw_text: "", status: "complete", source: "generated", parent_id: null,
    model_name: "视觉模型", model: "vision", created_at: "2026-10-19T01:00:00Z", video_changed: false,
    translation: null, references,
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
        current: {
          seedance2: seg(11, 1, "seedance2", "【风格】写实，15 秒，16:9", [
            { label: "@图片 1", what: "作为本段首帧上传", frame: { index: 1, edge: "first" }, warn: null,
              slot: "picture" }]),
          h3: seg(12, 1, "h3", "integrated_multimodal_description: a host") },
        versions: { seedance2: 2, h3: 1 } },
      { index: 2, start_ms: 15000, end_ms: 22000, shots: [], role: "产品特写收尾", warn: "短于 4 秒",
        frames: { first: { at: 15 }, last: { at: 21.75 } },
        current: {
          seedance2: seg(13, 2, "seedance2", "将@视频 1 延长 7 秒", [
            { label: "@视频 1", what: "上一段生成结果的视频成品，正文用「将@视频 1 延长」续接",
              frame: null, warn: "本工具不生成视频：需要先跑完上一段并导出成片", slot: "video" }]),
          h3: seg(14, 2, "h3", "integrated_multimodal_description: close-up") } },
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

  it("按正文声明给参考：有图的能复制与存盘，没图的写清要自备什么", async () => {
    const ref = vi.mocked(videoPromptApi.referenceFrame);
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByLabelText("复制P01 首帧")).toBeTruthy());
    expect(panel.getByText(/本段需要的参考（图 1 · 视频 0 · 音频 0） · 原片帧 @0–@15 秒/)).toBeTruthy();
    expect(panel.getByText(/本段需要的参考（图 0 · 视频 1 · 音频 0） · 原片帧 @15–@22 秒/)).toBeTruthy();
    expect(panel.getByText("@图片 1")).toBeTruthy();
    expect(panel.getByText("作为本段首帧上传")).toBeTruthy();
    expect(panel.getAllByText("复制图")).toHaveLength(1);
    expect(panel.getByText("需要自备视频：本工具不生成视频，按上面的说明导出成品后按这个编号上传。")).toBeTruthy();
    expect(ref).toHaveBeenCalledWith(5, 7, 1, "first");
    expect(ref).not.toHaveBeenCalledWith(5, 7, 2, "last");
    await fireEvent.click(panel.getByLabelText("下载P01 首帧"));
    expect(downloadBlob).toHaveBeenLastCalledWith(expect.any(Blob), "clip-图片1-P01-first.jpg");
  });

  it("T2VA 不列参考也不显示图，切到 I2VA 才列出 Picture 1", async () => {
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("MiniMax H3")).toBeTruthy());
    await fireEvent.click(panel.getByText("MiniMax H3"));
    await waitFor(() => expect(panel.queryByText(/本段需要的参考/)).toBeNull());
    expect(panel.queryByLabelText("复制P01 首帧")).toBeNull();
    expect(panel.getByText(/纯文本：正文不引用图片或视频/)).toBeTruthy();
    const mode = panel.container.querySelector<HTMLSelectElement>('select[aria-label="H3 模式"]')!;
    mode.value = "i2va";
    await fireEvent.change(mode, { target: { value: "i2va" } });
    await waitFor(() => expect(panel.getAllByTestId(/ref-\d+-<Picture 1>/)).toHaveLength(2));
    expect(panel.getByText("原片首帧，直接上传这一张")).toBeTruthy();
    expect(panel.getByLabelText("复制P01 首帧")).toBeTruthy();
    expect(panel.getByText("上一段生成结果的末帧，作为本段首帧上传")).toBeTruthy();
    expect(panel.getAllByText(/真正要上传的是上一段生成结果的最后一帧/)).toHaveLength(1);
    expect(panel.getByText(/第 2 段起用上一段生成结果的末帧/)).toBeTruthy();
  });

  it("H3 模式说明收进问号浮层，四种模式各一行", async () => {
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("MiniMax H3")).toBeTruthy());
    await fireEvent.click(panel.getByText("MiniMax H3"));
    const card = panel.getByTestId("mode-hints");
    expect(card.textContent).toContain("纯文本：正文不引用图片或视频");
    expect(card.textContent).toContain("首帧图：每段首行写");
    expect(card.textContent).toContain("首尾帧：每段首行列出首帧与末帧");
    expect(card.textContent).toContain("全参考：正文改成六段式");
    expect(card.textContent).toContain("<Subject N> 只是正文里的内容标签");
    // 悬停靠 CSS，触屏没有 hover，所以点一下也要能展开
    const help = panel.container.querySelector(".vp-help")!;
    expect(help.className).not.toContain("open");
    await fireEvent.click(panel.getByLabelText("H3 模式说明"));
    expect(help.className).toContain("open");
  });

  it("Ref2VA 说明要自备哪些参考，并按正文声明逐条列出", async () => {
    const run = makeRun();
    run.units[0].current.h3 = seg(21, 1, "h3", "subject_definitions:", [
      { label: "<Picture 1>", what: "本段首帧，本工具能直接给：用下方缩略图复制或存盘后按这个编号上传",
        what_en: "is reference image 1 to upload: the first frame of this segment",
        frame: { index: 1, edge: "first" }, warn: null, slot: "picture" },
      { label: "<Picture 2>", what: "绿发少女正面全身立绘，纯色背景",
        what_en: "is reference image 2 to upload: front-facing view of the host",
        frame: null, warn: null, slot: "picture" },
      { label: "<Audio 1>", what: "一段自备音频：锁说话人音色或背景配乐，按这个编号上传",
        what_en: "is reference audio 1 to upload: the voice timbre of the host",
        frame: null, warn: null, slot: "audio" },
    ], "ref2va");
    vi.mocked(videoPromptApi.history).mockResolvedValue(history([run]));
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("MiniMax H3")).toBeTruthy());
    await fireEvent.click(panel.getByText("MiniMax H3"));
    const mode = panel.container.querySelector<HTMLSelectElement>('select[aria-label="H3 模式"]')!;
    expect(mode.querySelector('option[value="ref2va"]')).toBeTruthy();
    mode.value = "ref2va";
    await fireEvent.change(mode, { target: { value: "ref2va" } });
    await waitFor(() => expect(panel.getByText("<Picture 2>")).toBeTruthy());
    // <Subject N> 是正文标签、不是文件，不进待上传清单
    expect(panel.queryByText(/^<Subject 1>$/)).toBeNull();
    // 清单说明一律中文，正文里的英文原文只在悬停提示里
    expect(panel.getByText("绿发少女正面全身立绘，纯色背景")).toBeTruthy();
    expect(panel.queryByText(/is reference image 2/)).toBeNull();
    expect(panel.getByText("绿发少女正面全身立绘，纯色背景").getAttribute("title"))
      .toBe("is reference image 2 to upload: front-facing view of the host");
    expect(panel.getByText(/本段需要的参考（图 2 · 视频 0 · 音频 1）/)).toBeTruthy();
    expect(panel.getByText("需要自备图片：本工具拿不到这张图，按上面的说明准备后按这个编号上传。")).toBeTruthy();
    expect(panel.getByText("需要自备音频：按上面的说明准备音频文件后按这个编号上传。")).toBeTruthy();
    expect(panel.getByLabelText("复制P01 首帧")).toBeTruthy();
  });

  it("素材编号超过 MiniMax 上限时红字提示合并", async () => {
    const run = makeRun();
    const many = Array.from({ length: 7 }, (_, i) => ({
      label: `<Picture ${i + 1}>`, what: `reference image ${i + 1}`,
      frame: null, warn: null, slot: "picture" as const,
    }));
    run.units[0].current.h3 = seg(31, 1, "h3", "subject_definitions:", many, "ref2va");
    vi.mocked(videoPromptApi.history).mockResolvedValue(history([run]));
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("MiniMax H3")).toBeTruthy());
    await fireEvent.click(panel.getByText("MiniMax H3"));
    const mode = panel.container.querySelector<HTMLSelectElement>('select[aria-label="H3 模式"]')!;
    mode.value = "ref2va";
    await fireEvent.change(mode, { target: { value: "ref2va" } });
    await waitFor(() => expect(panel.getByRole("alert").textContent.replace(/\s+/g, ""))
      .toBe("图7个超过MiniMax上限（图6/视频3/音频3），请合并素材后编辑正文。"));
  });

  it("Seedance 页也有模式选择，换模式后按新模式告诉你要备哪些帧", async () => {
    // 正文是「全能参考」写的：当前选 t2v 时模式不匹配，参考清单按新模式给计划
    const run = makeRun();
    run.units[0].current.seedance2 = seg(51, 1, "seedance2", "【风格】A", [], "ref");
    run.units[1].current.seedance2 = seg(52, 2, "seedance2", "【风格】B", [], "ref");
    vi.mocked(videoPromptApi.history).mockResolvedValue(history([run]));
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("时长 30 秒")).toBeTruthy());
    const select = panel.getByLabelText("Seedance 模式") as HTMLSelectElement;
    expect(select.value).toBe("t2v");                       // 偏好里的默认模式
    expect([...select.options].map(o => o.value)).toEqual(["t2v", "i2v", "flv", "ref"]);
    // 文生视频不列参考：列出来只会误导用户去找文件
    expect(panel.queryByText(/本段需要的参考/)).toBeNull();
    const card = panel.getByTestId("mode-hints");
    expect(card.textContent).toContain("合计 ≤12");
    expect(card.textContent).toContain("首帧图不能和参考图混在同一个请求里");
    expect(card.textContent).toContain("只认镜头序号");
    expect(card.textContent).not.toContain("subject_definitions");        // H3 的说明不串台
    select.value = "flv";
    await fireEvent.change(select, { target: { value: "flv" } });
    await waitFor(() => expect(panel.getAllByTestId(/ref-\d+-@图片2/)).toHaveLength(2));
    expect(panel.getAllByText("本段末帧：把下面这张图存盘后作为尾帧上传")).toHaveLength(2);
  });

  it("版本卡片标出它是哪种模式生成的，老记录没有模式就不标", async () => {
    const run = makeRun();
    run.units[0].current.seedance2 = seg(51, 1, "seedance2", "【风格】首帧版", [], "i2v");
    vi.mocked(videoPromptApi.history).mockResolvedValue(history([run]));
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("【风格】首帧版")).toBeTruthy());
    expect(panel.getByText("首帧")).toBeTruthy();            // 新模式 → 短徽标
    // 第 2 段是老记录（没有模式），不该凭空标出一个模式来
    expect(panel.getAllByText("首帧")).toHaveLength(1);
    expect(panel.queryByText("T2V")).toBeNull();
  });

  it("正文超过官方建议字数时提示，不拦复制", async () => {
    const run = makeRun();
    run.units[0].current.seedance2 = seg(52, 1, "seedance2", "字".repeat(520), [], "t2v");
    vi.mocked(videoPromptApi.history).mockResolvedValue(history([run]));
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText(/520 字 · 超建议 500 字/)).toBeTruthy());
  });

  it("历史版本可点选查看，正文与提示跟着那一版走", async () => {
    const run = makeRun();
    const current = run.units[0].current.seedance2!;
    const old = seg(41, 1, "seedance2", "【风格】旧版正文，15 秒，16:9");
    vi.mocked(videoPromptApi.versions).mockResolvedValue({ records: [current, old], total: 2, limit: 50, offset: 0 });
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("【风格】写实，15 秒，16:9")).toBeTruthy());
    await fireEvent.click(panel.getByLabelText("查看 P01 Seedance 2.0 历史版本"));
    await waitFor(() => expect(panel.getByLabelText("P01 历史版本")).toBeTruthy());
    await fireEvent.click(panel.getByText(/^#41/));
    await waitFor(() => expect(panel.getByText("【风格】旧版正文，15 秒，16:9")).toBeTruthy());
    expect(panel.getByText(/正在看历史版本 #41/)).toBeTruthy();
    expect(panel.getByText(/当前版本 #11/)).toBeTruthy();
    expect(panel.getByText("译文只针对当前版本")).toBeTruthy();
    await fireEvent.click(panel.getByText("回到当前版本"));
    await waitFor(() => expect(panel.getByText("【风格】写实，15 秒，16:9")).toBeTruthy());
  });

  it("删除某段的一个版本：先确认再删，删完刷新该段版本列表", async () => {
    const run = makeRun();
    const current = run.units[0].current.seedance2!;
    const old = seg(41, 1, "seedance2", "【风格】旧版正文，15 秒，16:9");
    let records = [current, old];
    vi.mocked(videoPromptApi.versions).mockImplementation(async () => ({
      records, total: records.length, limit: 50, offset: 0 }));
    const remove = vi.spyOn(videoPromptApi, "removeRecord").mockImplementation(async (_v, _r, _i, _t, recordId) => {
      records = records.filter(item => item.id !== recordId);
      return { deleted: recordId, segment_index: 1, target: "seedance2", current: records[0]?.id ?? null };
    });
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("【风格】写实，15 秒，16:9")).toBeTruthy());
    await fireEvent.click(panel.getByLabelText("查看 P01 Seedance 2.0 历史版本"));
    await waitFor(() => expect(panel.getByLabelText("P01 历史版本")).toBeTruthy());
    await fireEvent.click(panel.getByLabelText("删除 P01 版本 41"));
    expect(remove).not.toHaveBeenCalled();
    expect(panel.getByText("删除这版？")).toBeTruthy();
    await fireEvent.click(panel.getByLabelText("确认删除这一版"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(5, 7, 1, "seedance2", 41));
    await waitFor(() => expect(panel.queryByText(/^#41/)).toBeNull());
    expect(panel.getByText(/^#11/)).toBeTruthy();
  });

  it("删光某段的所有版本后回到「还没有正文」", async () => {
    const run = makeRun();
    const current = run.units[0].current.seedance2!;
    let records = [current];
    vi.mocked(videoPromptApi.versions).mockImplementation(async () => ({
      records, total: records.length, limit: 50, offset: 0 }));
    vi.mocked(videoPromptApi.history).mockImplementation(async () => history([run]));
    vi.spyOn(videoPromptApi, "removeRecord").mockImplementation(async (_v, _r, _i, _t, recordId) => {
      records = records.filter(item => item.id !== recordId);
      run.units[0].current = { h3: run.units[0].current.h3! };   // 服务端：这一段该格式没版本了
      run.units[0].versions = { seedance2: 0, h3: 1 };
      return { deleted: recordId, segment_index: 1, target: "seedance2", current: null };
    });
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByLabelText("查看 P01 Seedance 2.0 历史版本")).toBeTruthy());
    await fireEvent.click(panel.getByLabelText("查看 P01 Seedance 2.0 历史版本"));
    await waitFor(() => expect(panel.getByLabelText("P01 历史版本")).toBeTruthy());
    await fireEvent.click(panel.getByLabelText("删除 P01 版本 11"));
    await fireEvent.click(panel.getByLabelText("确认删除这一版"));
    await waitFor(() => expect(panel.getByText("该段还没有 Seedance 2.0 正文。")).toBeTruthy());
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
    expect(segment.mock.calls[0][3]).toMatchObject({ target: "seedance2", mode: "t2v", model_config_id: 1 });
    await waitFor(() => expect(panel.getByText("模型请求超时")).toBeTruthy());
    const retry = panel.getAllByText("重试本段");
    expect(retry).toHaveLength(1);
    await fireEvent.click(retry[0]);
    await waitFor(() => expect(segment).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(panel.getByText("【风格】新生成的第 2 段")).toBeTruthy());
  });

  it("生成中有看得见的进度：转圈、走秒、骨架线与队列位置", async () => {
    segmentQueue.set({ total: 5, done: 2 });
    videoPromptJobs.set({ "7:1:h3": { running: true, startedAt: Date.now() - 8000 } });
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("MiniMax H3")).toBeTruthy());
    await fireEvent.click(panel.getByText("MiniMax H3"));
    await waitFor(() => expect(panel.getByTestId("progress-1-h3")).toBeTruthy());
    const card = panel.getByTestId("progress-1-h3");
    expect(card.textContent).toContain("正在生成 MiniMax H3 正文");
    expect(card.textContent).toContain("已等 8 秒");
    expect(card.textContent).toContain("队列第 3/5 项");
    expect(card.textContent).toContain("本段 15 秒");
    expect(card.querySelectorAll(".vp-spin").length).toBeGreaterThan(0);
    expect(card.querySelectorAll(".vp-skeleton i")).toHaveLength(3);
    // 顶部队列条是真百分比：2/5 = 40%
    const queue = panel.getByTestId("queue-progress");
    expect(queue.textContent).toContain("串行生成 2/5");
    expect(queue.querySelector("i")?.getAttribute("style")).toMatch(/width:\s*40%/);
    // 只有正在生成的那一段亮边，另一段不受影响
    expect(panel.container.querySelectorAll('article[data-running="true"]')).toHaveLength(1);
    expect(panel.getAllByText("H3")[0].closest("button")?.querySelector(".vp-spin")).toBeTruthy();
  });

  it("点「全部生成」的那颗按钮亮着转圈，另一颗不受影响，跑完恢复", async () => {
    let calls = 0;
    let finish!: (value: SegmentRecord) => void;
    vi.spyOn(videoPromptApi, "segment").mockImplementation(() => {
      calls += 1;
      if (calls > 1) return Promise.resolve(seg(22, 2, "seedance2", "【风格】排队的第二段"));
      return new Promise(resolve => { finish = resolve; });
    });
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByText("【风格】写实，15 秒，16:9")).toBeTruthy());
    const all = panel.getByRole("button", { name: "全部生成（Seedance 2.0）" });
    const both = panel.getByRole("button", { name: "全部生成（两种）" });
    await fireEvent.click(all);
    await waitFor(() => expect(all.querySelector(".vp-spin")).toBeTruthy());
    expect(all.getAttribute("data-busy")).toBe("true");
    expect(all.hasAttribute("disabled")).toBe(true);   // 期间不能再点，但按钮保持亮着
    expect(both.querySelector(".vp-spin")).toBeNull();
    expect(both.hasAttribute("data-busy")).toBe(false);
    expect(panel.getByTestId("queue-progress").textContent).toContain("串行生成 0/2");
    finish(seg(21, 1, "seedance2", "【风格】跑完的第一段"));
    await waitFor(() => expect(panel.queryByTestId("queue-progress")).toBeNull());
    expect(all.hasAttribute("data-busy")).toBe(false);
    expect(calls).toBe(2);
  });

  it("反推分镜方案时给出等待卡片与已等秒数", async () => {
    videoPromptJobs.set({ "plan:5": { running: true, startedAt: Date.now() - 3000 } });
    vi.mocked(videoPromptApi.history).mockResolvedValue(history([]));
    const panel = render(VideoPromptPanel, { videoId: 5, filename: "clip.mp4", durationSeconds: 30 });
    await waitFor(() => expect(panel.getByTestId("plan-progress")).toBeTruthy());
    const card = panel.getByTestId("plan-progress");
    expect(card.textContent).toContain("正在反推分镜方案");
    expect(card.textContent).toContain("已等 3 秒");
    expect(card.textContent).toContain("1 次模型调用");
    const button = panel.getByRole("button", { name: /拆分镜方案/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.querySelector(".vp-spin")).toBeTruthy();
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
      default_model_id: 1, default_mode_h3: "t2va", default_mode_seedance: "t2v", frame_limit: 8,
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