import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

/**
 * 提示词优化技能这一侧的纯逻辑：清单怎么拉、默认那条怎么选、接口怎么拼，
 * 以及最要紧的一道校验——模型有没有把「@图片1」这种引用标记吃掉。
 * 这些都不挂 DOM，直接单测；界面那一半在 prompt-skill-modal.test.ts。
 */
import type { PromptSkill } from "../lib/prompt-skills";

const http = vi.fn();
// vi.mock 的工厂会被提到 import 上面，取不到这里的 http，所以走 globalThis 现取。
vi.mock("../lib/api", () => ({
  http: (path: string, init?: RequestInit) => (globalThis as any).__http(path, init),
}));
(globalThis as any).__http = http;

const {
  loadPromptSkills,
  missingMarks,
  pickSkillFor,
  promptMarks,
  promptSkills,
  promptSkillsApi,
  promptSkillSettings,
  resetPromptSkills,
  setDefaultSkill,
  skillsForKind,
} = await import("../lib/prompt-skills");

function skill(over: Partial<PromptSkill> = {}): PromptSkill {
  return {
    id: 1, name: "镜头补全", note: "", kinds: ["image"], instruction: "补上景别与光影",
    language: "auto", with_refs: true, builtin_key: null, sort: 0, created_at: "", updated_at: "",
    ...over,
  };
}

/** 只数清单那一条：loadPromptSkills 一次会同时打清单和默认值两个接口。 */
const listCalls = () => http.mock.calls.filter((call) => call[0] === "/api/prompt-skills").length;

beforeEach(() => {
  http.mockReset();
  resetPromptSkills();
});

describe("提示词里的引用标记", () => {
  it("三种写法都认，各算一格", () => {
    expect(promptMarks("照 @图片1 画，第二段接 <Picture 2>，最后补一张图3")).toEqual(["@图片1", "<Picture 2>", "图3"]);
  });

  it("换写法不算丢：@图片1 被写成 <Picture 1>，指的还是同一格参考", () => {
    expect(missingMarks("照 @图片1 画", "按 <Picture 1> 的画面制作")).toEqual([]);
  });

  it("整格没了、编号挪了都要报出来，报的是人自己打的那种写法", () => {
    expect(missingMarks("照 @图片1 和 <Video 2> 剪", "按 <Picture 1> 的画面制作")).toEqual(["<Video 2>"]);
    expect(missingMarks("照 图1 画", "按 图2 画")).toEqual(["图1"]);
  });

  it("同一格写两遍只算一格；纯数字、分辨率不算标记", () => {
    expect(promptMarks("图1 和 <Picture 1> 是同一格")).toEqual(["图1"]);
    expect(promptMarks("1080p 30fps 竖屏 9:16")).toEqual([]);
  });

  it("音频那一族单独成族，不会被图片那格顶掉", () => {
    expect(missingMarks("照 图1 画，配 音频1 的节奏", "按 图1 的画面")).toEqual(["音频1"]);
  });
});

describe("清单与默认技能", () => {
  it("清单是懒加载的：第一次拉，之后复用，reset 之后重新拉", async () => {
    http.mockResolvedValue([]);
    await loadPromptSkills();
    expect(listCalls()).toBe(1);
    await loadPromptSkills();
    expect(listCalls()).toBe(1);
    resetPromptSkills();
    await loadPromptSkills();
    expect(listCalls()).toBe(2);
  });

  it("拉失败不许留下「已经加载过」，下一次点还能重试", async () => {
    http.mockRejectedValueOnce(new Error("离线"));
    await expect(loadPromptSkills()).rejects.toThrow("离线");
    http.mockResolvedValue([]);
    await expect(loadPromptSkills()).resolves.toEqual([]);
    expect(listCalls()).toBe(2);
  });

  it("按族筛；默认那条已经不存在就退回这一族的第一条", async () => {
    http.mockImplementation(async (path: string) =>
      path === "/api/prompt-skills"
        ? [skill({ id: 1, kinds: ["video"], name: "分镜" }), skill({ id: 2, kinds: ["image"], name: "出图" })]
        : { default_image_skill: 9, default_video_skill: 1 });
    await loadPromptSkills();
    expect(skillsForKind("image").map((item) => item.id)).toEqual([2]);
    // 9 这条早被删了，还按它挑就等于让人点一颗不存在的技能
    expect(pickSkillFor("image")?.name).toBe("出图");
    expect(pickSkillFor("video")?.name).toBe("分镜");
  });

  it("这一族一条都没有时挑不出技能，而不是拿另一族顶数", async () => {
    http.mockImplementation(async (path: string) =>
      path === "/api/prompt-skills"
        ? [skill({ id: 1, kinds: ["video"] })]
        : { default_image_skill: null, default_video_skill: 1 });
    await loadPromptSkills();
    expect(pickSkillFor("image")).toBeNull();
  });

  it("设默认先画本地再写库：菜单勾子不等网络往返", async () => {
    let settle: (value: unknown) => void = () => {};
    http.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PUT") return new Promise((resolve) => (settle = resolve));
      return path === "/api/prompt-skills" ? [skill()] : { default_image_skill: null, default_video_skill: null };
    });
    await loadPromptSkills();
    const inflight = setDefaultSkill("image", 1);
    await Promise.resolve();
    expect(get(promptSkillSettings)).toEqual({ default_image_skill: 1, default_video_skill: null });
    settle({ default_image_skill: 1, default_video_skill: 2 });
    expect(await inflight).toEqual({ default_image_skill: 1, default_video_skill: 2 });
    const put = http.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PUT");
    expect(put?.[0]).toBe("/api/prompt-skill-settings");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ default_image_skill: 1, default_video_skill: null });
  });
});

describe("接口拼装", () => {
  it("优化请求带上 prompt、这一族和参考格编号，signal 原样交出去", async () => {
    const ctl = new AbortController();
    http.mockResolvedValue({ prompt: "x", model_name: "A", model: "m", degraded_refs: null });
    await promptSkillsApi.optimize(7, { prompt: "一句", kind: "image", refs: [{ ordinal: 3, image_id: 42 }] }, ctl.signal);
    const [path, init] = http.mock.calls[0];
    expect(path).toBe("/api/prompt-skills/7/optimize");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ prompt: "一句", kind: "image", refs: [{ ordinal: 3, image_id: 42 }] });
    expect(init.signal).toBe(ctl.signal);
  });

  it("导入交出去的是读到的原文，文件名一起带上", async () => {
    http.mockResolvedValue({ ...skill(), truncated: false });
    await promptSkillsApi.import("SKILL.md", "# 标题\n正文");
    const [path, init] = http.mock.calls[0];
    expect(path).toBe("/api/prompt-skills/import");
    expect(JSON.parse(String(init.body))).toEqual({ filename: "SKILL.md", content: "# 标题\n正文" });
  });

  it("store 里就是接口拉回来那一份，reset 清得干净", async () => {
    http.mockImplementation(async (path: string) =>
      path === "/api/prompt-skills" ? [skill()] : { default_image_skill: 1, default_video_skill: null });
    await loadPromptSkills();
    expect(get(promptSkills).map((item) => item.name)).toEqual(["镜头补全"]);
    resetPromptSkills();
    expect(get(promptSkills)).toEqual([]);
    expect(get(promptSkillSettings)).toBeNull();
  });
});
