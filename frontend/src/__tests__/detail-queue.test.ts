import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import CloneQueuePanel from "../components/CloneQueuePanel.svelte";
import { imagesApi, itemsApi } from "../lib/api";
import { pushToast } from "../lib/toast";
import {
  EMPTY_CLONE_JOB,
  applyCloneProgress,
  clearCloneHistory,
  cloneApi,
  cloneHistory,
  cloneGoneOutputs,
  cloneJob,
  cloudApi,
} from "../lib/clone";
import type { CloneOutput, CloudPendingTask } from "../lib/clone";

vi.mock("../lib/toast", () => ({ pushToast: vi.fn(() => 1) }));

/**
 * 右侧栏「队列」那一页（方案 3 第三批，2026-11-11）。
 *
 * 这一页的全部价值在于「说的是真话」：跑动中要说清跑在哪一侧哪一步、跑了多久，
 * 云端钱花了要能把产物取回来，跑完的批次点了要能回到图库看那一张。
 * 所以每条都断言界面上真的出现那句话 / 真的调那个接口，而不是断言 class 名。
 *
 * 反向也钉一条：后端同一时刻只允许一条任务在跑（clone_jobs.CloneBusy → 409），
 * 所以这一页不许出现「排队中」的列表——画出来就是在许诺一个后端会拒绝的行为。
 */

const here = dirname(fileURLToPath(import.meta.url));
const panelRaw = readFileSync(resolve(here, "..", "components", "CloneQueuePanel.svelte"), "utf8");

const out = (id: number, kind = "image"): CloneOutput => ({
  id,
  kind,
  filename: "out-" + id + "." + (kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "png"),
  thumbnail_url: "/api/images/" + id + "/file?max=256",
});

const pendingTask = (over: Partial<CloudPendingTask> = {}): CloudPendingTask => ({
  id: 55, job_id: "c1", capability: "video", model: "Seedance", state: "running",
  state_label: "云端仍在跑", remote_task_id: "RH-1", cost_coins: 8, error: "", created_at: "",
  ...over,
});

const runningLike = () =>
  ({
    active: true, job_id: "rq", state: "queued", outputs: [], image_ids: [], media_kind: "image",
  }) as never;

const emptyPage = {
  items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 }, limit: 0, offset: 0,
} as never;

beforeEach(() => {
  clearCloneHistory();
  vi.spyOn(cloudApi, "pending").mockResolvedValue({ items: [] });
  vi.spyOn(cloudApi, "refetch").mockResolvedValue({
    task_id: 55, image_ids: [7], outputs: [out(7)], count: 1, cost_coins: 8,
  });
  vi.spyOn(cloneApi, "cancelJob").mockImplementation(async () =>
    applyCloneProgress({ active: true, job_id: "r1", state: "cancelled", outputs: [], image_ids: [] }),
  );
  vi.spyOn(itemsApi, "list").mockResolvedValue(emptyPage);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearCloneHistory();
  cloneJob.set(EMPTY_CLONE_JOB);
  cloneGoneOutputs.set(new Set());
});

describe("队列页的空态", () => {
  it("默认只展示最近三条，更早的产出自己展开看", () => {
    const ui = render(CloneQueuePanel, { active: false });
    expect(ui.getByText("这一轮还没跑过生成")).toBeTruthy();
    expect(ui.getByText(/在卡片右下角点「再次创作」跑一批/)).toBeTruthy();
    expect(ui.container.querySelector(".queue-card")).toBeNull();
  });

  it("没有排队列表这一说：后端同一时刻只让一条在跑，多提交的那次会被 409 拒掉", () => {
    applyCloneProgress(runningLike());
    const ui = render(CloneQueuePanel, { active: false });
    expect(ui.container.textContent ?? "").not.toContain("排队");
    // 跑动中的卡片永远只有一张，不存在「等在前面」的第二条
    expect(ui.container.querySelectorAll(".queue-card")).toHaveLength(1);
    // 阶段条里 queued 那格叫「提交」，不叫「排队中」：那一步是在往引擎递任务
    const stages = Array.from(ui.container.querySelectorAll(".queue-stage"));
    expect(stages.map((x) => x.textContent)).toEqual(["上传", "提交", "生成", "取回"]);
  });

  it("这一页没翻开时不去问云端待取回（不轮询、不开页才取一次）", () => {
    render(CloneQueuePanel, { active: false });
    expect(cloudApi.pending).not.toHaveBeenCalled();
  });
});

describe("跑动中的那一条", () => {
  const running = {
    active: true, job_id: "r1", state: "running", message: "正在生成第 2 段",
    error: "", outputs: [], image_ids: [], media_kind: "video", engine: "cloud",
    provider: "seedance", elapsed: 192,
  } as never;

  it("说清跑在哪一侧、走到哪一步、跑了多久", () => {
    applyCloneProgress(running);
    const ui = render(CloneQueuePanel, { active: false });
    expect(ui.getByText("云端 · seedance")).toBeTruthy();
    expect(ui.getByText("生成中…")).toBeTruthy();
    expect(ui.getByText("3分12秒")).toBeTruthy();
    expect(ui.getByText("正在生成第 2 段")).toBeTruthy();
    const stages = Array.from(ui.container.querySelectorAll(".queue-stage"));
    expect(stages.map((s) => s.textContent)).toEqual(["上传", "提交", "生成", "取回"]);
    expect(stages[2]?.className).toContain("is-on");
    expect(stages[0]?.className).toContain("is-done");
    expect(stages[3]?.className).not.toContain("is-done");
  });

  it("进度条是不定长走带：后端没有百分比，就不许画一个假的出来", () => {
    applyCloneProgress(running);
    const ui = render(CloneQueuePanel, { active: false });
    const bar = ui.container.querySelector(".queue-bar");
    expect(bar).toBeTruthy();
    expect(bar?.getAttribute("aria-hidden")).toBe("true");
    expect(ui.container.textContent ?? "").not.toMatch(new RegExp("\\d+%"));
  });

  it("那一格的秒数自己往前走：后端只在状态切换那一刻推 elapsed，照抄就是数字不动", async () => {
    // 2026-11-23 苏醒圈着跑动卡片右上角那个「0秒」：「生成状态，我希望这个耗时也动起来。」
    // 后端那句 elapsed 中间不推，本地得起一条秒表；但每收到一次推送要拿它重新对齐，
    // 不然本地走表会把真实进度顶掉——云端那条更不能由前端说了算。
    vi.useFakeTimers();
    try {
      const waitCard = (elapsed: number) => ({
        active: true, job_id: "t1", state: "running", engine: "comfyui", message: "",
        error: "", outputs: [], image_ids: [], media_kind: "image", elapsed,
      }) as never;
      applyCloneProgress(waitCard(41));
      const ui = render(CloneQueuePanel, { active: false });
      // 首帧先照后端那句，别在挂载与秒表第一步之间闪一个 0秒
      expect(ui.container.querySelector(".queue-elapsed")?.textContent).toBe("41秒");
      await vi.advanceTimersByTimeAsync(3_000);
      await tick();
      expect(ui.container.querySelector(".queue-elapsed")?.textContent).toBe("44秒");
      // 后端又推了一次：拿它给的数重新起表，本地补的那几秒作废
      applyCloneProgress(waitCard(90));
      await tick();
      expect(ui.container.querySelector(".queue-elapsed")?.textContent).toBe("1分30秒");
    } finally {
      vi.useRealTimers();
    }
  });

  it("「停止等待」走后端取消，回来的状态立刻换上，跑动卡片不再占位", async () => {
    applyCloneProgress(running);
    const ui = render(CloneQueuePanel, { active: false });
    await fireEvent.click(ui.getByRole("button", { name: "停止等待" }));
    await waitFor(() => expect(cloneApi.cancelJob).toHaveBeenCalled());
    await waitFor(() => expect(ui.queryByText("生成中…")).toBeNull());
    expect(ui.container.querySelector(".queue-card")).toBeNull();
  });
});

describe("云端那条钱已经付了、产物还没回来的", () => {
  it("翻开这一页取一次待取回，行上写清花的钱", async () => {
    vi.mocked(cloudApi.pending).mockResolvedValue({ items: [pendingTask()] });
    const ui = render(CloneQueuePanel, { active: true });
    await waitFor(() => expect(ui.getByText("云端待取回")).toBeTruthy());
    expect(cloudApi.pending).toHaveBeenCalledTimes(1);
    expect(ui.getByText("云端仍在跑 · Seedance")).toBeTruthy();
    expect(ui.getByText("已花 8 RH币")).toBeTruthy();
  });

  it("花费没实测出来时写「花费未实测」，不写成 0", async () => {
    vi.mocked(cloudApi.pending).mockResolvedValue({ items: [pendingTask({ cost_coins: null })] });
    const ui = render(CloneQueuePanel, { active: true });
    await waitFor(() => expect(ui.getByText("花费未实测")).toBeTruthy());
  });

  it("「取回结果」只重查那一条（重新提交就是二次扣费），取回来让图库重拉一次并报数", async () => {
    vi.mocked(cloudApi.pending).mockResolvedValue({ items: [pendingTask()] });
    const ui = render(CloneQueuePanel, { active: true });
    await waitFor(() => expect(ui.getByText("云端待取回")).toBeTruthy());
    await fireEvent.click(ui.getByRole("button", { name: "取回结果" }));
    await waitFor(() => expect(cloudApi.refetch).toHaveBeenCalledWith(55));
    expect(itemsApi.list).toHaveBeenCalled();
    const last = vi.mocked(pushToast).mock.calls.at(-1);
    expect(String(last?.[0])).toContain("取回来了");
    expect(String(last?.[0])).toContain("1 份");
    await waitFor(() => expect(ui.queryByText("云端待取回")).toBeNull());
  });

  it("上一条停了但产物还能取时，红卡片上直接给「取回结果」", async () => {
    applyCloneProgress({
      active: true, job_id: "c9", state: "cancelled", engine: "cloud", recoverable: true,
      task_row_id: 61, outputs: [], image_ids: [],
    } as never);
    const ui = render(CloneQueuePanel, { active: false });
    expect(ui.getByText(/已停止等待，云端仍在跑/)).toBeTruthy();
    await fireEvent.click(ui.getByRole("button", { name: "取回结果" }));
    await waitFor(() => expect(cloudApi.refetch).toHaveBeenCalledWith(61));
  });

  it("跑挂了且取不回来的，只说错在哪，不给一个点了没用的按钮", () => {
    applyCloneProgress({
      active: true, job_id: "e1", state: "error", engine: "comfyui", recoverable: false,
      error: "显存不够", outputs: [], image_ids: [],
    } as never);
    const ui = render(CloneQueuePanel, { active: false });
    expect(ui.getByText("显存不够")).toBeTruthy();
    expect(ui.queryByRole("button", { name: "取回结果" })).toBeNull();
  });
});

describe("本次运行的那几批", () => {

  it("每批右侧写着这一批跑了多久，单位秒，数字与单位之间空一格", () => {
    // 2026-11-17 苏醒在队列那一页圈了右侧那格：「我希望这里显示生成用的时间，用秒（S）为计量单位」。
    // 2026-11-23 同一格再批一次「耗时的 35S 中间加空格显示」→ 写成「耗时：40 S」。
    // 左边那句「几分前」答的是什么时候跑完的，答不了快慢，两句都要在。
    cloneHistory.set([
      {
        key: "job-a", jobId: "job-a", outputs: [out(201)], mediaKind: "image",
        engine: "comfyui", provider: "", costCoins: null, at: Date.now(), elapsedSec: 40,
      },
      {
        key: "job-b", jobId: "job-b", outputs: [out(202)], mediaKind: "image",
        engine: "comfyui", provider: "", costCoins: null, at: Date.now(), elapsedSec: null,
      },
    ]);
    const ui = render(CloneQueuePanel, { active: false });
    const cost = ui.getByText("耗时：40 S");
    expect(cost.classList.contains("queue-row-cost")).toBe(true);
    // 那一格的颜色按 2026-11-17 第二轮批注走品牌色，口径与对比度钉在
    // __tests__/target-size-contrast.test.ts（happy-dom 不套 scoped CSS，这里只钉落点）
    expect(cost.classList.contains("queue-row-sub")).toBe(false);
    // 第二条没测出时长：那一格整个不排，不写「耗时：0 S」骗人
    expect(ui.getAllByText("耗时：40 S")).toHaveLength(1);
    expect(ui.queryByText(/耗时：0 S/)).toBeNull();
    expect(ui.getAllByText("1 张 · 本机")).toHaveLength(2);
  });
  it("默认显示最近三批，更早批次在展开后仍能打开产出", async () => {
    cloneHistory.set(Array.from({ length: 5 }, (_, i) => ({
      key: `job-${i}`, jobId: `job-${i}`, outputs: [out(100 + i)], mediaKind: "image",
      engine: "comfyui", provider: "", costCoins: null, at: Date.now() - i * 60_000,
      elapsedSec: 40 + i,
    })));
    const ui = render(CloneQueuePanel, { active: false });
    expect(ui.getByRole("button", { name: "看 out-100.png 产出" })).toBeTruthy();
    expect(ui.getByRole("button", { name: "看 out-102.png 产出" })).toBeTruthy();
    const older = ui.container.querySelector(".queue-older") as HTMLDetailsElement;
    expect(older.open).toBe(false);
    await fireEvent.click(ui.getByText("更早的产出（2 批）"));
    expect(ui.getByRole("button", { name: "看 out-103.png 产出" })).toBeTruthy();
  });

  it("默认只展示最近三批，更早的产出可以按需展开", () => {
    expect(panelRaw).toContain("$cloneHistory.slice(0, 3)");
    expect(panelRaw).toContain("更早的产出");
    expect(panelRaw).toContain("$cloneHistory.slice(3)");
  });

  it("跑完的批次留在列表里，点缩略图派发 open-lightbox 回到图库", async () => {
    applyCloneProgress({
      active: true, job_id: "j1", state: "done", media_kind: "image",
      outputs: [out(11)], image_ids: [11],
    } as never);
    const seen: string[] = [];
    const onLightbox = (e: Event) => seen.push("lightbox:" + String((e as CustomEvent<{ id: number }>).detail.id));
    const onVideo = (e: Event) => seen.push("video:" + String((e as CustomEvent<{ id: number }>).detail.id));
    window.addEventListener("open-lightbox", onLightbox);
    window.addEventListener("open-video-player", onVideo);
    const ui = render(CloneQueuePanel, { active: false });
    expect(ui.getByText("1 张 · 本机")).toBeTruthy();
    await fireEvent.click(ui.getByRole("button", { name: "看 out-11.png 产出" }));
    window.removeEventListener("open-lightbox", onLightbox);
    window.removeEventListener("open-video-player", onVideo);
    expect(seen).toEqual(["lightbox:11"]);
  });

  it("视频产出走播放器；音频没有对应弹层，所以不给按钮", async () => {
    applyCloneProgress({
      active: true, job_id: "j2", state: "done", media_kind: "video", engine: "cloud",
      outputs: [out(21, "video")], image_ids: [21],
    } as never);
    const ui = render(CloneQueuePanel, { active: false });
    expect(ui.getByRole("button", { name: "看 out-21.mp4 产出" })).toBeTruthy();
    expect(ui.getByText("1 条 · 云端")).toBeTruthy();
    applyCloneProgress({
      active: true, job_id: "j3", state: "done", media_kind: "audio",
      outputs: [out(31, "audio")], image_ids: [31],
    } as never);
    await tick();
    expect(ui.queryByRole("button", { name: "看 out-31.mp3 产出" })).toBeNull();
    expect(ui.container.querySelectorAll(".queue-out-btn.is-plain")).toHaveLength(1);
  });
});

describe("标题行那颗「正在跑」的红点", () => {
  it("跟着「队列」那一行对齐，不落在标题和副标题中间", () => {
    // 2026-11-23 苏醒：「生成状态时，右侧栏红点位置错位，这个红点修复一下」。
    // .section-heading 是 align-items:center，两行标题中间被塞进一颗 7px 的点，谁都不靠。
    // 钉法只能钉写法：happy-dom 不套 scoped CSS，量不出计算值，所以钉那条规则自己——
    // 盒子顶到行首、按标题那一行（--fs-sm × --lh-label）撑高，点画在 ::after 里上下居中。
    const raw = readFileSync(resolve(here, "..", "components", "DetailPanel.svelte"), "utf8");
    const at = raw.indexOf(".queue-live-dot {");
    expect(at, "DetailPanel 里找不到 .queue-live-dot 那条规则").toBeGreaterThan(-1);
    const rule = raw.slice(at, raw.indexOf("}", at));
    expect(rule, "红点又跟着两行标题一起居中了").toMatch(/align-self:\s*flex-start/);
    expect(rule, "盒子高度要跟着标题那一行，别再写字面像素").toMatch(/height:\s*calc\(var\(--fs-sm\)\s*\*\s*var\(--lh-label\)\)/);
    const after = raw.slice(raw.indexOf(".queue-live-dot::after"));
    const afterRule = after.slice(0, after.indexOf("}") + 1);
    expect(afterRule, "点本体（含朱红）得画在 ::after 上").toMatch(/background:\s*var\(--accent\)/);
    expect(afterRule).toMatch(/border-radius:\s*var\(--r-circle\)/);
  });
});

describe("产出后来被删掉的那一格", () => {
  // 2026-11-23 苏醒：「生成之后我再删掉图，显示这个不太美观」→ 定的是那一格直接不显示。
  // 但「读不到」和「没了」是两件事，三条用例各钉一头：真没了才收格子，问不动就不动。
  const batch = (id: number, elapsedSec: number) => ({
    key: "job-" + id, jobId: "job-" + id, outputs: [out(id)], mediaKind: "image",
    engine: "comfyui", provider: "", costCoins: null, at: Date.now(), elapsedSec,
  });

  it("缩略图 404 且 presence 说没了：那一格整格收掉，行、张数、耗时都不动", async () => {
    vi.spyOn(imagesApi, "presence").mockResolvedValue({ exists: false });
    cloneHistory.set([batch(201, 5)]);
    const ui = render(CloneQueuePanel, { active: false });
    expect(ui.container.querySelector("img.queue-out")).toBeTruthy();
    fireEvent.error(ui.container.querySelector("img.queue-out") as HTMLImageElement);
    await waitFor(() => expect(ui.container.querySelector(".queue-thumbs")).toBeNull());
    expect(imagesApi.presence).toHaveBeenCalledWith(201);
    // 收的是那一格，不是这一行：那一批确实跑过，耗时还得留着跟别批比快慢
    expect(ui.getByText("1 张 · 本机")).toBeTruthy();
    expect(ui.getByText("耗时：5 S")).toBeTruthy();
  });

  it("只是缩略图取不到（东西还在）不许收格：换站里那颗空位，仍可点", async () => {
    vi.spyOn(imagesApi, "presence").mockResolvedValue({ exists: true });
    cloneHistory.set([batch(202, 8)]);
    const ui = render(CloneQueuePanel, { active: false });
    fireEvent.error(ui.container.querySelector("img.queue-out") as HTMLImageElement);
    await waitFor(() => expect(ui.container.querySelector("img.queue-out")).toBeNull());
    expect(ui.container.querySelector(".queue-thumbs")).toBeTruthy();
    // 换的是画面不是入口：东西在，点了就该能开
    expect(ui.getByRole("button", { name: "看 out-202.png 产出" })).toBeTruthy();
    expect(get(cloneGoneOutputs).has(202)).toBe(false);
  });

  it("后端问不动时也不收格：宁可留着一颗空位，不猜「删了」", async () => {
    vi.spyOn(imagesApi, "presence").mockRejectedValue(new Error("后端没答"));
    cloneHistory.set([batch(203, 6)]);
    const ui = render(CloneQueuePanel, { active: false });
    fireEvent.error(ui.container.querySelector("img.queue-out") as HTMLImageElement);
    await tick();
    await tick();
    expect(ui.container.querySelector(".queue-thumbs")).toBeTruthy();
    expect(get(cloneGoneOutputs).has(203)).toBe(false);
  });
});
