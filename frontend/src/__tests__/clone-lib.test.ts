import { describe, expect, it } from "vitest";
import {
  EMPTY_CLONE_JOB, applyCloneProgress, buildGenerateRequest, cloneError, cloneStatusLabel,
  allowsTextMode, controlSlots, controlSummary, defaultControlValues, defaultReferences, formatControlValue, modesFor,
  imageSlots, jobForTemplate, latestReversePrompt, modeFromRefCount, numberPresets, numberUnit,
  modeLabel, optionLabel, promptSourceLabel, promptSlots, ratioShape, referenceCells, referenceIssues, visibleRefCells,
  resolvePromptSource, shouldOfferWorkflowPrompt, slotKey, templateDisplayName,
  applyMention, comparePair, matchMention, mentionChunks, mentionItems, mentionToken,
  type CloneMode, type CloneSlot, type CloneTemplate,
} from "../lib/clone";

/**
 * 一键同款的纯逻辑层：槽位取数、提示词预填、任务状态机。
 * 这三件事都直接影响「点一下图标出去的是不是想要的图」，所以必须在没有后端的情况下钉死。
 */

const promptSlot: CloneSlot = { kind: "prompt", node: "582", input: "prompt", label: "完整提示词" };
const imageSlot: CloneSlot = { kind: "image", node: "543", input: "image", label: "参考图" };
const ratioSlot: CloneSlot = { kind: "select", node: "13", input: "aspect_ratio", label: "比例", options: ["1:1", "16:9"], value: "1:1" };
const megaSlot: CloneSlot = { kind: "number", node: "13", input: "megapixels", label: "百万像素", value: 1.4, min: 0.5, max: 4, step: 0.1 };

const tpl = (slots: CloneSlot[], over: Partial<CloneTemplate> = {}): CloneTemplate => ({
  id: 1, name: "Qwen 多图编辑", slots, default_prompt: "工作流内置的提示词", is_active: true,
  created_at: "", updated_at: "", node_count: 4, prompt_count: 1, reference_count: 1, control_count: 2, ...over,
});

const image = (id: number, filename = `n${id}.png`) => ({ id, filename, kind: "image" } as any);

describe("槽位取数", () => {
  const template = tpl([promptSlot, imageSlot, ratioSlot, megaSlot]);

  it("弹窗只画参考位与控件，提示词单独占一个大框", () => {
    expect(promptSlots(template).map(slotKey)).toEqual(["582.prompt"]);
    expect(imageSlots(template).map(slotKey)).toEqual(["543.image"]);
    expect(controlSlots(template).map(slotKey)).toEqual(["13.aspect_ratio", "13.megapixels"]);
  });

  it("参考位默认只填「图片1」＝单图编辑，控件用工作流里的当前值", () => {
    const refs = defaultReferences(template, image(7, "source.png"));
    expect(refs["543.image"]?.id).toBe(7);
    expect(referenceIssues(template, refs)).toEqual([]);
    expect(defaultControlValues(template)).toEqual({ "13.aspect_ratio": "1:1", "13.megapixels": 1.4 });
  });

  it("一张都不放：能摘掉参考的工作流就是文生图，摘不掉的才要至少一张", () => {
    expect(referenceIssues(template, { "543.image": null }, true)).toEqual([]);
    expect(referenceIssues(template, { "543.image": null }, false)).toEqual(["至少放一张参考图"]);
  });

  it("没有模板时全部退化成空，不炸", () => {
    expect(imageSlots(null)).toEqual([]);
    expect(defaultReferences(undefined, null)).toEqual({});
    expect(defaultControlValues(null)).toEqual({});
  });
});

describe("多图参考（工作流的 autogrow 输入组）", () => {
  const growSlot: CloneSlot = {
    kind: "image", node: "543", input: "image", label: "人物参考",
    grow: { node: "582", group: "images", names: ["image_2", "image_3"] },
  };
  const growTpl = tpl([promptSlot, growSlot], { reference_count: 1 });

  it("工作流原生能吃多张时，按续位补出更多参考格，编号连着排", () => {
    const cells = referenceCells(growTpl);
    expect(cells.map((c) => c.key)).toEqual(["543.image", "543.image::image_2", "543.image::image_3"]);
    expect(cells.map((c) => c.label)).toEqual(["图片1", "图片2", "图片3"]);
  });

  it("续位只是多摆几格，默认还是只占图片1，空着不算没放满", () => {
    const refs = defaultReferences(growTpl, image(7, "source.png"));
    expect(refs["543.image"]?.id).toBe(7);
    expect(refs["543.image::image_2"]).toBeUndefined();
    expect(referenceIssues(growTpl, refs)).toEqual([]);
  });

  it("续位填了才提交，键名带 :: 原样交给后端", () => {
    const refs = defaultReferences(growTpl, image(7, "source.png"));
    refs["543.image::image_2"] = image(8, "extra.png");
    const req = buildGenerateRequest({
      templateId: 1, prompt: "p", references: refs, controls: {}, sourceImageId: 7,
      cellOrder: ["543.image", "543.image::image_2", "543.image::image_3"],
    });
    expect(req.references).toEqual([{ slot: "543.image", image_id: 7 }, { slot: "543.image::image_2", image_id: 8 }]);
  });

  it("没有 grow 信息的老模板照旧只有一格", () => {
    expect(referenceCells(tpl([imageSlot])).map((c) => c.key)).toEqual(["543.image"]);
    expect(referenceCells(null)).toEqual([]);
  });
});

describe("提交给后端的请求", () => {
  it("只交填好的参考位，没填的不占位", () => {
    const req = buildGenerateRequest({
      templateId: 3, prompt: "  换一张同款的  ",
      references: { "543.image": image(9), "544.image": null },
      controls: { "13.aspect_ratio": "16:9", "13.megapixels": "" },
      sourceImageId: 9,
    });
    expect(req.prompt).toBe("换一张同款的");
    expect(req.references).toEqual([{ slot: "543.image", image_id: 9 }]);
    expect(req.controls).toEqual({ "13.aspect_ratio": "16:9" });
    expect(req.template_id).toBe(3);
  });
});

describe("提示词预填", () => {
  it("图片自带的 ComfyUI 提示词优先", () => {
    expect(resolvePromptSource({ imagePrompt: " 图里写的 ", reversePrompt: "反推的" })).toEqual({ text: "图里写的", origin: "image" });
  });

  it("图片没有就读反推提示词，两条都没有才留空", () => {
    expect(resolvePromptSource({ imagePrompt: "  ", reversePrompt: "反推的" }).text).toBe("反推的");
    expect(resolvePromptSource({ imagePrompt: null, reversePrompt: null })).toEqual({ text: "", origin: "none" });
  });

  it("只有提示词空着且工作流有内置文案时，才给「填入工作流内置提示词」", () => {
    expect(shouldOfferWorkflowPrompt("", "工作流内置")).toBe(true);
    expect(shouldOfferWorkflowPrompt("用户已经写了", "工作流内置")).toBe(false);
    expect(shouldOfferWorkflowPrompt("", "   ")).toBe(false);
  });

  it("反推历史取最新一条有中文的，跳过空记录", () => {
    expect(latestReversePrompt([{ prompt_zh: "" }, { prompt_zh: " 第二条 " }, { prompt_zh: "第三条" }])).toBe("第二条");
    expect(latestReversePrompt(undefined)).toBe("");
  });

  it("空提示词要说清楚会用工作流内置的那条，而不是让人以为坏了", () => {
    expect(promptSourceLabel("none")).toContain("工作流");
    expect(promptSourceLabel("image")).toContain("这张图");
  });
});

describe("任务状态机", () => {
  it("运行中的状态一律算 busy，完成/失败/取消不是", () => {
    for (const state of ["uploading", "queued", "running", "downloading"] as const) {
      expect(applyCloneProgress({ active: true, state, job_id: "j" }).running).toBe(true);
    }
    for (const state of ["done", "error", "cancelled"] as const) {
      expect(applyCloneProgress({ active: true, state, job_id: "j" }).running).toBe(false);
    }
  });

  it("认不出的状态退回空壳，界面不会显示一个没听过的词", () => {
    const job = applyCloneProgress({ active: true, state: "quantum" });
    expect(job.state).toBe("");
    expect(job.running).toBe(false);
  });

  it("脏 payload（非对象 / image_ids 里有非数字）不会把 store 打成 NaN", () => {
    expect(applyCloneProgress(null)).toEqual(EMPTY_CLONE_JOB);
    expect(applyCloneProgress({ image_ids: [3, "x", null] }).image_ids).toEqual([3]);
  });

  it("完成后把产出张数写进状态文案，弹窗里能直接看见", () => {
    const job = applyCloneProgress({ active: true, state: "done", image_ids: [11, 12] });
    expect(cloneStatusLabel(job)).toBe("已生成 2 张");
  });

  it("报错时优先显示后端那句中文", () => {
    const job = applyCloneProgress({ active: true, state: "error", message: "节点 加载图像 找不到输入图片" });
    expect(cloneStatusLabel(job)).toContain("加载图像");
  });

  it("同一时刻只认一个任务：不是本模板的就不是这个弹窗该显示的", () => {
    const job = applyCloneProgress({ active: true, state: "running", template_id: 2 });
    expect(jobForTemplate(job, 2)).toBe(job);
    expect(jobForTemplate(job, 5)).toBeNull();
    expect(jobForTemplate(EMPTY_CLONE_JOB, 2)).toBeNull();
  });

  it("后端错误没有 detail 时退回 message，绝不显示 undefined", () => {
    expect(cloneError({ detail: "已有任务在生成" })).toBe("已有任务在生成");
    expect(cloneError(new Error("网络断了"))).toBe("网络断了");
    expect(cloneError(null)).toContain("后端");
  });
});

describe("参数面板的取数与文案", () => {
  const ratioSlot: CloneSlot = { kind: "select", node: "13", input: "aspect_ratio", label: "比例", options: ["9:16 (Portrait Widescreen)", "16:9 (Widescreen)"], value: "9:16 (Portrait Widescreen)" };
  const megaSlot: CloneSlot = { kind: "number", node: "13", input: "megapixels", label: "分辨率", value: 2.2, min: 0.1, max: 16, step: 0.1 };
  const tpl = { id: 1, name: "t", slots: [ratioSlot, megaSlot] } as unknown as CloneTemplate;

  it("选项文案去掉括号里的英文说明", () => {
    expect(optionLabel("9:16 (Portrait Widescreen)")).toBe("9:16");
    expect(optionLabel("  high（高） ")).toBe("high");
    expect(optionLabel("normal")).toBe("normal");
  });

  it("比例格子按真实宽高比给尺寸，认不出的选项只给文字", () => {
    expect(ratioShape("9:16 (Portrait Widescreen)")).toEqual({ label: "9:16", ratio: { w: 9, h: 16 }, box: { w: 15, h: 26 } });
    expect(ratioShape("1:1").box).toEqual({ w: 26, h: 26 });
    expect(ratioShape("21:9").box.w).toBeGreaterThan(ratioShape("21:9").box.h);
    const unknown = ratioShape("very wide");
    expect(unknown.ratio).toBeNull();
    expect(unknown.box).toEqual({ w: 0, h: 0 });
  });

  it("数值档位按 min/max 收窄，并把工作流当前值补进去", () => {
    expect(numberPresets(megaSlot)).toEqual([0.5, 1, 1.5, 2, 2.2, 2.5, 3, 4, 6, 8]);
    expect(numberPresets({ ...megaSlot, min: 0.5, max: 4, value: 1.4 })).toEqual([0.5, 1, 1.4, 1.5, 2, 2.5, 3, 4]);
  });

  it("只有百万像素那种数值带 MP 后缀，别的裸数字（不瞎猜单位）", () => {
    expect(numberUnit(megaSlot)).toBe("MP");
    expect(numberUnit({ ...megaSlot, label: "百万像素" })).toBe("MP");
    expect(numberUnit({ kind: "number", node: "7", input: "steps", label: "步数" })).toBe("");
  });

  it("底部 pill 的汇总用短标签拼，空值不进句子", () => {
    expect(controlSummary(tpl, { "13.aspect_ratio": "9:16 (Portrait Widescreen)", "13.megapixels": 2.2 })).toBe("9:16 / 2.2MP");
    expect(controlSummary(tpl, { "13.aspect_ratio": "", "13.megapixels": 2.2 })).toBe("2.2MP");
    expect(formatControlValue(megaSlot, "")).toBe("");
    expect(controlSummary(null, {})).toBe("");
  });
});

describe("生成方式三档：文生图 / 单图编辑 / 多图编辑", () => {
  // 两台 LoadImage 常常长进下游同一个 autogrow 图组，扩位必须按「目标格」去重。
  const twoLoad = tpl(
    [
      promptSlot,
      { kind: "image", node: "543", input: "image", label: "人物参考", grow: { node: "582", group: "images", names: ["image_2"] } },
      { kind: "image", node: "564", input: "image", label: "背景参考", grow: { node: "582", group: "images", names: ["image_2", "image_3"] } },
    ],
    { reference_count: 2 },
  );

  it("后端报了 modes 就照它，顺序永远是 文 → 单 → 多", () => {
    expect(modesFor(tpl([promptSlot, imageSlot], { modes: ["multi", "text"] }))).toEqual(["text", "multi"]);
    expect(modesFor(tpl([promptSlot, imageSlot], { modes: ["单图", "bogus"] as unknown as CloneMode[] }))).toEqual(["single"]);
  });

  it("老模板没 modes 时按槽位兜底：没有参考位只有文生图，能扩位才算多图", () => {
    expect(modesFor(tpl([promptSlot]))).toEqual(["text"]);
    expect(modesFor(tpl([promptSlot, imageSlot]))).toEqual(["single"]);
    expect(modesFor(twoLoad)).toEqual(["single", "multi"]);
    expect(modesFor(null)).toEqual(["text"]);
  });

  it("生成方式由参考图数量决定：0 文生图 / 1 单图编辑 / 2 张以上多图编辑", () => {
    expect(modeFromRefCount(0)).toBe("text");
    expect(modeFromRefCount(1)).toBe("single");
    expect(modeFromRefCount(2)).toBe("multi");
    expect(modeFromRefCount(9)).toBe("multi");
    expect(modeLabel("single")).toBe("单图编辑");
  });

  it("能不能一张图都不放，只看 modes 里有没有文生图", () => {
    expect(allowsTextMode(tpl([promptSlot, imageSlot], { modes: ["single", "multi"] }))).toBe(false);
    expect(allowsTextMode(tpl([promptSlot, imageSlot], { modes: ["text", "single"] }))).toBe(true);
    expect(allowsTextMode(tpl([promptSlot]))).toBe(true);
  });

  it("同一个图组的扩位只数一次，真槽位排在前面，编号连着排", () => {
    const cells = referenceCells(twoLoad);
    expect(cells.map((c) => c.key)).toEqual(["543.image", "564.image", "543.image::image_2", "564.image::image_3"]);
    expect(cells.map((c) => c.label)).toEqual(["图片1", "图片2", "图片3", "图片4"]);
    // 两台 LoadImage 的真槽位必须挨在一起：交错排的话第二台会被第一台的扩位推到最后，
    // 参考条上就出现「图片1、图片2、图片16」这种像坏了的编号。
    const refs = defaultReferences(twoLoad, image(7));
    expect(refs["543.image"]?.id).toBe(7);
    expect(visibleRefCells(cells, refs).map((c) => c.label)).toEqual(["图片1", "图片2"]);
  });

  it("参考格的数量和填了几张图无关——档位是结果，不是前提", () => {
    expect(referenceCells(twoLoad)).toHaveLength(4);
    expect(defaultReferences(twoLoad, null)).toEqual({ "543.image": null });
    expect(defaultReferences(tpl([promptSlot]), image(7))).toEqual({});
  });

  it("跳着填要指认空掉的那一格（序号就是接线顺序，不能留洞）", () => {
    expect(referenceIssues(twoLoad, { "543.image": null, "564.image": image(8) })).toEqual(["图片1 还空着"]);
  });

  it("请求里没有 mode：参考图按画面顺序交回去，后端自己数", () => {
    const req = buildGenerateRequest({
      templateId: 1, prompt: "写点什么",
      references: { "564.image": image(8), "543.image": image(7) }, controls: {}, sourceImageId: 7,
      cellOrder: ["543.image", "564.image"],
    });
    expect(req.references).toEqual([{ slot: "543.image", image_id: 7 }, { slot: "564.image", image_id: 8 }]);
    expect("mode" in req).toBe(false);
  });
});

describe("参考条永远只有一颗「+ 参考」", () => {
  const grow: CloneSlot = {
    kind: "image", node: "543", input: "image", label: "人物参考",
    grow: { node: "582", group: "images", names: ["image_2", "image_3", "image_4"] },
  };
  const template = tpl([grow], { reference_count: 1 });

  it("已填的都留着，空格只画第一格", () => {
    const cells = referenceCells(template);
    expect(cells).toHaveLength(4);
    const refs: Record<string, any> = { "543.image": image(1), "543.image::image_2": null, "543.image::image_3": null, "543.image::image_4": null };
    expect(visibleRefCells(cells, refs).map((c) => c.key)).toEqual(["543.image", "543.image::image_2"]);
    refs["543.image::image_2"] = image(2);
    expect(visibleRefCells(cells, refs).map((c) => c.key)).toEqual(["543.image", "543.image::image_2", "543.image::image_3"]);
  });

  it("放满了就没有空格子；一张都没填时也只有一颗 +", () => {
    const cells = referenceCells(template);
    const full: Record<string, any> = Object.fromEntries(cells.map((c, i) => [c.key, image(i + 1)]));
    expect(visibleRefCells(cells, full)).toHaveLength(4);
    expect(visibleRefCells(referenceCells(template), {}).map((c) => c.key)).toEqual(["543.image"]);
  });
});

it("产出图点击要不要进对比：原图和产出图都在列表里才算，缺一张就别说对比", () => {
  expect(comparePair(1, 2, [2, 1, 3])).toEqual([1, 2]);
  // 原图被筛掉了 / 产出图还没进流 / 点的是自己 / 没有原图 → 都不许凑对比
  expect(comparePair(1, 2, [2, 3])).toBeNull();
  expect(comparePair(1, 9, [1, 3])).toBeNull();
  expect(comparePair(2, 2, [2, 1])).toBeNull();
  expect(comparePair(null, 2, [1, 2])).toBeNull();
});

describe("@ 引用素材", () => {
  /** 提示词里打 @ 挑参考图：命中判断、候选列表、插入文本，全是弹窗离不开的东西。 */
  const one = referenceCells(tpl([promptSlot, imageSlot]));
  const two = referenceCells(tpl([promptSlot, imageSlot, { ...imageSlot, node: "564" }]));
  const refs = { [slotKey(imageSlot)]: image(11, "人物.png") };

  it("caret 前面那个 @xxx 才算命中，词打完（有空格）菜单自己收", () => {
    expect(mentionToken("把 @", 3)).toEqual({ start: 2, end: 3, query: "" });
    expect(mentionToken("把 @图", 4)).toEqual({ start: 2, end: 4, query: "图" });
    expect(mentionToken("把 @图片1 ", 7)).toBeNull();
  // 中文逗号不是空格：不给查询串加边界的话，「@图片1，一镜到底」会让菜单永远收不起来
  expect(mentionToken("参考 @图片1，一镜到底", 12)).toBeNull();
  expect(mentionToken("参考 @图片1。", 8)).toBeNull();
  // 查询串长到 32 以上说明早就不在选图了
  expect(mentionToken("@" + "a".repeat(40), 41)).toBeNull();
  });

  it("图2 / 2 / 文件名都命中图片2，图3 不命中", () => {
    expect(matchMention("图片2", "bg.png", "图2")).toBe(true);
    expect(matchMention("图片2", "bg.png", "2")).toBe(true);
    expect(matchMention("图片2", "bg.png", "BG")).toBe(true);
    expect(matchMention("图片2", "bg.png", "图3")).toBe(false);
    expect(matchMention("图片2", "bg.png", "")).toBe(true);
  });

  it("菜单只列挂上参考位的图，末尾永远补一条「再挂一张」", () => {
    const items = mentionItems(two, refs);
    expect(items.map((item) => [item.label, item.add])).toEqual([["图片1", false], ["", true]]);
    expect(items[0].filename).toBe("人物.png");
    expect(items[0].key).toBe(slotKey(imageSlot));
    expect(items[1].key).toBe("564.image");
    expect(mentionItems(two, refs, "图9")).toEqual(items.slice(1));
    expect(mentionItems([], {}, "")).toEqual([]);
    expect(mentionItems(one, refs).map((item) => item.add)).toEqual([false]);
  });

  it("插入 @图片N 后面补一个空格，光标停在空格后面接着打字", () => {
    const token = mentionToken("把 @图换衣服", 4);
    expect(token).not.toBeNull();
    const next = applyMention("把 @图换衣服", token!, "图片1");
    expect(next.text).toBe("把 @图片1 换衣服");
    expect(next.caret).toBe(7);
  });
});

describe("@ 引用的高亮切分", () => {
  /** 输入框背后那层高亮全靠这个切分，切错一格就和光标错位。 */
  it("普通文字与 @图片N 交替切开", () => {
    expect(mentionChunks("参考 @图片1 的镜头，外貌参考@图片2。")).toEqual([
      { text: "参考 ", mention: false },
      { text: "@图片1", mention: true },
      { text: " 的镜头，外貌参考", mention: false },
      { text: "@图片2", mention: true },
      { text: "。", mention: false },
    ]);
  });

  it("@图1 这种简写也点亮；邮箱和 @谁 不点亮", () => {
    expect(mentionChunks("@图1 换装").map((c) => c.mention)).toEqual([true, false]);
    expect(mentionChunks("联系 a@b.com 与 @苏醒").every((c) => !c.mention)).toBe(true);
    expect(mentionChunks("")).toEqual([]);
  });

  it("结尾换行补零宽字符，遮罩才和 textarea 一样多一行", () => {
    expect(mentionChunks("第一行\n")).toEqual([
      { text: "第一行\n\u200b", mention: false },
    ]);
  });

  it("切分结果拼回去等于原文（零宽字符那行除外）", () => {
    const src = "等比例 @图片3 构图，@图4 收尾";
    expect(mentionChunks(src).map((c) => c.text).join("")).toBe(src);
  });
});

describe("参考位的初始摆法（这张图当初喂了哪几张）", () => {
  const twoSlots = tpl([promptSlot, imageSlot, { ...imageSlot, node: "564", label: "背景参考" }]);
  const oneSlot = tpl([promptSlot, imageSlot]);
  const produced = image(9, "成图.png");

  it("有来源记录：两张就摆两张，顺序＝参考位顺序", () => {
    const refs = defaultReferences(twoSlots, produced, [image(7, "甲.png"), image(8, "乙.png")]);
    expect(refs["543.image"]?.id).toBe(7);
    expect(refs["564.image"]?.id).toBe(8);
    expect(referenceIssues(twoSlots, refs)).toEqual([]);
    expect(modeFromRefCount(Object.values(refs).filter(Boolean).length)).toBe("multi");
  });

  it("来源比参考位多：装不下的丢掉，不凭空造格子", () => {
    const refs = defaultReferences(oneSlot, produced, [image(7, "甲.png"), image(8, "乙.png")]);
    expect(Object.keys(refs)).toEqual(["543.image"]);
    expect(refs["543.image"]?.id).toBe(7);
  });

  it("没有来源记录：退回把被点的这张放进「图片1」", () => {
    expect(defaultReferences(oneSlot, produced)).toEqual({ "543.image": produced });
    expect(defaultReferences(oneSlot, produced, [])).toEqual({ "543.image": produced });
  });

  it("记着参考位的那份各回各位：中间少一张不会把「图片3」顶成「图片2」", () => {
    const three = tpl([promptSlot, imageSlot, { ...imageSlot, node: "564" }, { ...imageSlot, node: "582" }]);
    const refs = defaultReferences(three, produced, [
      { ...image(11, "乙.png"), slot: "564.image" },
      { ...image(12, "丙.png"), slot: "582.image" },
    ]);
    expect(refs["543.image"]).toBeUndefined();
    expect(refs["564.image"]?.id).toBe(11);
    expect(refs["582.image"]?.id).toBe(12);
    // 编号还是当初的编号，缺的那一格要如实报「图片1 还空着」
    expect(referenceIssues(three, refs)).toEqual(["图片1 还空着"]);
  });

  it("带参考位的先归位，没带的按顺序补空位", () => {
    const refs = defaultReferences(twoSlots, produced, [
      { ...image(8, "乙.png"), slot: "564.image" },
      image(7, "甲.png"),
    ]);
    expect(refs["564.image"]?.id).toBe(8);
    expect(refs["543.image"]?.id).toBe(7);
  });

  it("参考位键对不上这份工作流（换了工作流）：退回按顺序摆，不硬塞", () => {
    const refs = defaultReferences(oneSlot, produced, [{ ...image(8, "乙.png"), slot: "999.image" }]);
    expect(refs["543.image"]?.id).toBe(8);
  });

  it("来源里混进空位也不占序号", () => {
    const refs = defaultReferences(twoSlots, produced, [null as any, image(7, "甲.png")]);
    expect(refs["543.image"]?.id).toBe(7);
    expect(refs["564.image"]).toBeUndefined();
  });
});

describe("templateDisplayName", () => {
  it("本地导入的工作流不显示 .json 后缀，大小写都算", () => {
    expect(templateDisplayName("视频创作者-1024 x 576_参考生视频_.json")).toBe("视频创作者-1024 x 576_参考生视频_");
    expect(templateDisplayName("多图编辑.JSON")).toBe("多图编辑");
    expect(templateDisplayName("  带空格也带 .json .json ")).toBe("带空格也带 .json");
  });

  it("只砍结尾那一个后缀；名字里别处的 json 原样留着，空结果不返回空串", () => {
    expect(templateDisplayName("Qwen json 多图编辑")).toBe("Qwen json 多图编辑");
    expect(templateDisplayName("")).toBe("");
    expect(templateDisplayName(".json")).toBe(".json");
    expect(templateDisplayName(null)).toBe("");
    expect(templateDisplayName(undefined)).toBe("");
  });
});
