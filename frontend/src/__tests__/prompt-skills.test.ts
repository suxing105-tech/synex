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
  describeImport,
  isSkillSourcePath,
  isTextFilePath,
  loadPromptSkills,
  missingMarks,
  missingStructure,
  dominantLanguage,
  pickSkillFor,
  promptMarks,
  promptSkills,
  promptSkillsApi,
  promptSkillSettings,
  resetPromptSkills,
  setDefaultSkill,
  skillsForKind,
  targetLanguage,
} = await import("../lib/prompt-skills");

function skill(over: Partial<PromptSkill> = {}): PromptSkill {
  return {
    id: 1, name: "镜头补全", note: "", kinds: ["image"], instruction: "补上景别与光影",
    language: "auto", with_refs: true, builtin_key: null, sort: 0, created_at: "", updated_at: "",
    source: "manual", package_dir: null, package: null,
    ...over,
  };
}

/** 只数清单那一条：loadPromptSkills 一次会同时打清单和默认值两个接口。 */
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body));
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

  it("界面参数那一行原样跟着走：优化那条技能靠它知道用户挑了文戏还是武戏", async () => {
    http.mockResolvedValue({ prompt: "x", model_name: "A", model: "m", degraded_refs: null });
    await promptSkillsApi.optimize(17, {
      prompt: "一句", kind: "video", refs: [], context: "戏种：武戏｜武打速度：5档",
    });
    expect(JSON.parse(String(http.mock.calls[0][1].body)))
      .toEqual({ prompt: "一句", kind: "video", refs: [], context: "戏种：武戏｜武打速度：5档" });
  });

  it("没有旋钮的工作流不必带一个空 context 过去", async () => {
    http.mockResolvedValue({ prompt: "x", model_name: "A", model: "m", degraded_refs: null });
    await promptSkillsApi.optimize(1, { prompt: "一句", kind: "image", refs: [] });
    expect(http.mock.calls[0][1].body).not.toContain("context");
  });

  it("导入交出去的是读到的原文，文件名一起带上，头一次一律先问", async () => {
    http.mockResolvedValue({ imported: [], conflicts: [], skipped: [] });
    await promptSkillsApi.importMarkdown("SKILL.md", "# 标题\n正文");
    const [path, init] = http.mock.calls[0];
    expect(path).toBe("/api/prompt-skills/import");
    expect(JSON.parse(String(init.body))).toEqual({ filename: "SKILL.md", content: "# 标题\n正文", on_conflict: "ask" });
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

describe("技能包", () => {
  it("只有能读成文字的文件才当文本送出去", () => {
    expect(isTextFilePath("SKILL.md")).toBe(true);
    expect(isTextFilePath("references/style.MARKDOWN")).toBe(true);
    expect(isTextFilePath("scripts/check.py")).toBe(true);
    expect(isTextFilePath("assets/palette.png")).toBe(false);
    expect(isTextFilePath("data.bin")).toBe(false);
  });

  it("桌面版那一个入口：路径整批打到 import-path，md、.zip、目录都从这儿走", async () => {
    http.mockResolvedValue({ imported: [], conflicts: [], skipped: [] });
    await promptSkillsApi.importPaths(["C:/skills/shop", "C:/a.zip"]);
    const [path, init] = http.mock.calls[0];
    expect(path).toBe("/api/prompt-skills/import-path");
    expect(bodyOf(init)).toEqual({ paths: ["C:/skills/shop", "C:/a.zip"], on_conflict: "ask" });
  });

  it("重发时带上人挑的那个处理：替换", async () => {
    http.mockResolvedValue({ imported: [], conflicts: [], skipped: [] });
    await promptSkillsApi.importPaths(["C:/skills/shop"], "replace");
    expect(bodyOf(http.mock.calls[0][1]).on_conflict).toBe("replace");
  });

  it("浏览器版上传 .zip：multipart，参数挂在 form 上", async () => {
    http.mockResolvedValue({ imported: [], conflicts: [], skipped: [] });
    const blob = new File([new Uint8Array([80, 75])], "pack.zip");
    await promptSkillsApi.importArchive(blob, "pack.zip", "new");
    const [path, init] = http.mock.calls[0];
    expect(path).toBe("/api/prompt-skills/import-archive");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("on_conflict")).toBe("new");
    expect((form.get("file") as File).name).toBe("pack.zip");
  });

  it("浏览器版选文件夹：文件内容连相对路径一起交上去", async () => {
    http.mockResolvedValue({ imported: [], conflicts: [], skipped: [] });
    await promptSkillsApi.importPackageUpload("shop", [{ path: "shop/SKILL.md", content: "# 写法" }]);
    const [path, init] = http.mock.calls[0];
    expect(path).toBe("/api/prompt-skills/import-package/upload");
    expect(bodyOf(init)).toEqual({
      root: "shop", files: [{ path: "shop/SKILL.md", content: "# 写法" }], on_conflict: "ask",
    });
  });

  it("入口只认 md 和 zip：其余交给后端说明原因", () => {
    expect(isSkillSourcePath("C:/技能包/SKILL.md")).toBe(true);
    expect(isSkillSourcePath("C:/技能包.zip")).toBe(true);
    expect(isSkillSourcePath("C:/a.MARKDOWN")).toBe(true);
    expect(isSkillSourcePath("C:/a.7z")).toBe(false);
    expect(isSkillSourcePath("C:/技能包")).toBe(false);
    expect(isSkillSourcePath("")).toBe(false);
  });

  it("一句回执说清进了什么：条数、参考资料、替换、没进来的", () => {
    const packed = (over: any = {}) => ({ name: "电商视觉包", package: null, ...over });
    const refs = (n: number) => ({
      files: Array.from({ length: n }, (_x, i) => ({ role: "参考", included: true, path: "r" + i })),
      dropped: [] as string[],
    });
    const done = (imported: any[], skipped: any[] = []) => ({ imported, conflicts: [], skipped });
    expect(describeImport(done([packed({ name: "电商视觉包", package: refs(2) })]))).toBe(
      "已导入技能「电商视觉包」，带进 2 份参考资料");
    // 包里没带参考资料也要说：空着不报，人以为模型读到了作者其实没写的东西
    expect(describeImport(done([packed({ package: refs(0) })]))).toBe(
      "已导入技能「电商视觉包」，包里没带参考资料");
    expect(describeImport(done([packed(), packed(), packed()]))).toBe("已导入 3 条技能");
    expect(describeImport(done([packed({ replaced: true })]))).toBe("已导入技能「电商视觉包」，已替换原来那条");
    expect(describeImport(done([packed()], [{ path: "C:/a.7z", reason: "得先解压" }]))).toBe(
      "已导入技能「电商视觉包」，1 个没进来：得先解压");
    expect(describeImport(done([], [{ path: "C:/a.7z", reason: "得先解压" }]))).toBe("没能导入：得先解压");
  });
});

describe("提示词框那颗中英互译", () => {
  it("互译只送正文、走那一条新接口，signal 一路带到 fetch", async () => {
    http.mockResolvedValue({ text: "A woman walks.", source_language: "zh", target_language: "en", model_name: "魔搭", model: "deepseek" });
    const ctl = new AbortController();
    await promptSkillsApi.translate("一个女人在雨里走", ctl.signal);
    const [path, init] = http.mock.calls[0];
    expect(path).toBe("/api/translate-prompt");
    expect(init?.method).toBe("POST");
    expect(bodyOf(init)).toEqual({ text: "一个女人在雨里走" });
    expect(init?.signal).toBe(ctl.signal);
  });

  it("方向按正文主体语言判，和后端 video_prompts 同一个算法", () => {
    expect(dominantLanguage("一个女人在雨里慢慢往前走。")).toBe("zh");
    expect(dominantLanguage("A woman walks slowly in the rain.")).toBe("en");
    // 六段提示词的段名是英文的，靠的是正文够长把天平压回中文那边；判法两边同源，
    // 所以悬停写的方向和后端真翻的方向不会各说各话（正文短到只剩段名时两边一起判成英文）
    expect(dominantLanguage("subject_definitions:\nsummary:\n" + "一个女人在雨里慢慢往前走，裙摆湿透了贴在腿上。".repeat(4))).toBe("zh");
    expect(targetLanguage("一个女人在雨里走")).toBe("en");
    expect(targetLanguage("A woman walks in the rain")).toBe("zh");
  });

  it("段名、镜头标号、台词块少一个就报出来", () => {
    const base = "subject_definitions:\nsummary:\n[Shot 1]\n<d>[Chinese] 走吧 </d>\n一个女人在雨里走";
    expect(missingStructure(base, base)).toEqual([]);
    expect(missingStructure(base, base.replace("summary:", "详细描述："))).toEqual(["summary:"]);
    expect(missingStructure(base, base.replace("[Shot 1]", ""))).toEqual(["镜头标号"]);
    expect(missingStructure(base, base.replace("<d>[Chinese] 走吧 </d>", ""))).toEqual(["<d> 台词块"]);
    // 四类一起丢就一次报全，别让人一句一句试；顺序照段名表→镜头→台词，报出来稳定
    expect(missingStructure(base, "一个女人在雨里走")).toEqual([
      "subject_definitions:", "summary:", "镜头标号", "<d> 台词块",
    ]);
  });

  it("只查变少不查变多：多写一个镜头标号不算事故", () => {
    const base = "summary:\n[Shot 1]\n正文";
    expect(missingStructure(base, base + "\n[Shot 2]\n再来一段")).toEqual([]);
  });
});
