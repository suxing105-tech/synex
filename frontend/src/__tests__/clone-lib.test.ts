import { describe, expect, it } from "vitest";
import {
  EMPTY_CLONE_JOB, applyCloneProgress, buildGenerateRequest, cloneError, cloneStatusLabel,
  allowsTextMode, controlSlots, controlSummary, defaultControlValues, defaultReferences, formatControlValue, modesFor,
  imageSlots, jobForTemplate, latestReversePrompt, modeFromRefCount, numberPresets, numberUnit,
  modeLabel, optionLabel, promptSourceLabel, promptSlots, ratioShape, referenceCells, referenceIssues, visibleRefCells,
  resolvePromptSource, shouldOfferWorkflowPrompt, slotKey, templateDisplayName,
  applyMention, comparePair, matchMention, mentionAddLabel, mentionChunks, mentionItems, mentionToken,
  familyCells, formatElapsed, inspectAsTemplate, isImageOnlyRefs, isVideoTemplate, mentionInsertText, refTag,
  referenceCounter, referenceFamilies, referenceNoun,
  firstFreeRefKey, mergedRefCells, openRefKinds, REF_DISPLAY_ORDER, sortByDisplayFamily,
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

/* ── 视频一键同款（H3 参考生视频）──────────────────────────────────────── */

/** 后端从 H3 参考生视频工作流里检测出来的那份槽位表：三族参考位 + 时长控件。 */
function h3Slots(soundtracks = 0): CloneTemplate {
  return tpl([
    promptSlot,
    { kind: "image", node: "188", input: "image", label: "参考图片",
      grow: { node: "136", group: "ref_images", names: ["ref_image_1", "ref_image_2"], type: "IMAGE" } },
    { kind: "image", node: "199", input: "image", label: "参考图片 2" },
    { kind: "audio", node: "182", input: "audio", label: "参考音频",
      grow: { node: "136", group: "ref_audios", names: ["ref_audio_1", "ref_audio_2"], type: "AUDIO" } },
    { kind: "video", node: "185", input: "video", label: "参考视频",
      grow: { node: "136", group: "ref_videos", names: ["ref_video_1", "ref_video_2"], type: "IMAGE" } },
    { kind: "number", node: "227", input: "value", label: "视频时长（秒）", value: 8, min: 1, max: 60, unit: "秒", presets: [5, 8, 10, 12, 15] },
  ], { name: "H3参考视频", media_kind: "video", soundtracks, modes: ["text", "single", "multi"] });
}

describe("三族参考位：图片 → 音频 → 视频，每族先真槽位再扩位", () => {
  const cells = referenceCells(h3Slots());

  it("编号一族一族连着排，扩位排在真槽位之后", () => {
    expect(cells.map((c) => c.label)).toEqual([
      "图片1", "图片2", "图片3", "图片4",
      "音频1", "音频2", "音频3",
      "视频1", "视频2", "视频3",
    ]);
    expect(cells.map((c) => c.key)).toEqual([
      "188.image", "199.image", "188.image::ref_image_1", "188.image::ref_image_2",
      "182.audio", "182.audio::ref_audio_1", "182.audio::ref_audio_2",
      "185.video", "185.video::ref_video_1", "185.video::ref_video_2",
    ]);
  });

  it("H3 原生标签按族编号", () => {
    const t = referenceCells(h3Slots());
    expect(familyCells(t, "image").map((c) => c.tag)).toEqual(["<Picture 1>", "<Picture 2>", "<Picture 3>", "<Picture 4>"]);
    expect(familyCells(t, "audio").map((c) => c.tag)).toEqual(["<Audio 1>", "<Audio 2>", "<Audio 3>"]);
    expect(familyCells(t, "video").map((c) => c.tag)).toEqual(["<Video 1>", "<Video 2>", "<Video 3>"]);
    expect(referenceFamilies(h3Slots())).toEqual(["image", "audio", "video"]);
  });

  it("一族一行，各自只有一颗 +：图片排满了也不影响继续加音频", () => {
    const refs = { "188.image": image(1), "199.image": image(2) };
    expect(visibleRefCells(familyCells(cells, "image"), refs).map((c) => c.key))
      .toEqual(["188.image", "199.image", "188.image::ref_image_1"]);
    expect(visibleRefCells(familyCells(cells, "audio"), refs).map((c) => c.key)).toEqual(["182.audio"]);
    expect(visibleRefCells(familyCells(cells, "video"), refs).map((c) => c.key)).toEqual(["185.video"]);
  });

  it("跳格报错按族分开说：「音频1 还空着」不会被读成图片空着", () => {
    const refs = { "188.image": image(1), "182.audio::ref_audio_1": image(2) };
    expect(referenceIssues(h3Slots(), refs)).toEqual(["音频1 还空着"]);
  });

  it("三族都空着＝文生视频；工作流支持 text 就不报，不支持就说至少放一份", () => {
    expect(referenceIssues(h3Slots(), {}, true)).toEqual([]);
    expect(referenceIssues({ ...h3Slots(), modes: ["single", "multi"] }, {}, false)).toEqual(["至少放一份参考素材"]);
  });
});

describe("<Audio j> 的序号要先让位给参考视频自带的音轨", () => {
  it("工作流里连了几条音轨，独立音频就从几后面接着数", () => {
    expect(refTag("audio", 1)).toBe("<Audio 1>");
    expect(refTag("audio", 1, 2)).toBe("<Audio 3>");
    // 只有音频一族受影响，图片和视频按自己族内编号
    expect(refTag("image", 3, 2)).toBe("<Picture 3>");
    expect(refTag("video", 1, 2)).toBe("<Video 1>");
  });

  it("这份工作流已连一条 ref_video_audios 时，音频标签整体后移一号", () => {
    expect(familyCells(referenceCells(h3Slots(1)), "audio").map((c) => c.tag))
      .toEqual(["<Audio 2>", "<Audio 3>", "<Audio 4>"]);
  });

  it("后端算好的格子清单优先，前端不重算一遍", () => {
    const t = tpl([promptSlot, imageSlot], {
      media_kind: "video",
      soundtracks: 1,
      reference_cells: [{ key: "182.audio", label: "音频1", slot_label: "参考音频", kind: "audio", ordinal: 1, tag: "<Audio 9>" }],
    });
    expect(referenceCells(t).map((c) => [c.key, c.tag])).toEqual([["182.audio", "<Audio 9>"]]);
  });

  it("接口给的是 snake_case：slot_label 要落成 slotLabel，不然格子悬停只剩「undefined｜文件名」", () => {
    // 这条是补现场的债：后端一直发 slot_label，前端类型当年写成 slotLabel，
    // 展开后取不到值。假数据跟着类型写，谁都没红过——所以假数据必须照接口真实返回写。
    const t = tpl([promptSlot, imageSlot], {
      reference_cells: [
        { key: "185.video", kind: "video", ordinal: 1, label: "视频1", name: "", slot_label: "Load Video (Upload)", tag: "<Video 1>" },
      ],
    });
    expect(referenceCells(t)[0]).toMatchObject({
      key: "185.video", label: "视频1", kind: "video", slotLabel: "Load Video (Upload)",
    });
  });
});

describe("@ 引用写进提示词的文本：图片插 @图片N，视频工作流插 H3 原生标签", () => {
  const refs = { "188.image": image(11, "首帧.png"), "182.audio": image(12, "配乐.mp3") };

  it("图片那条链路一个字不改", () => {
    const items = mentionItems(referenceCells(tpl([promptSlot, imageSlot])), { "543.image": image(1) }, "", "image");
    expect(items[0]).toMatchObject({ label: "图片1", insert: "@图片1", kind: "image" });
  });

  it("视频工作流菜单上显示中文编号，插进去的是 <Picture 1> 与 <Audio 2>", () => {
    const items = mentionItems(referenceCells(h3Slots(1)), refs, "", "video");
    expect(items.filter((i) => !i.add).map((i) => [i.label, i.insert, i.kind])).toEqual([
      ["图片1", "<Picture 1>", "image"],
      ["音频1", "<Audio 2>", "audio"],
    ]);
    // 末尾那条「再从图库挂一份」挂到第一个空位，也就是图片2
    expect(items.at(-1)).toMatchObject({ add: true, key: "199.image", kind: "image" });
  });

  it("mentionInsertText：mediaKind 决定形状，缺省＝图片工作流", () => {
    const cell = referenceCells(h3Slots())[0];
    expect(mentionInsertText(cell, "video")).toBe("<Picture 1>");
    expect(mentionInsertText(cell, "image")).toBe("@图片1");
    expect(mentionInsertText(cell, undefined)).toBe("@图片1");
  });

  it("插入时换掉刚打的 @xxx 并补一个空格，光标停在后面接着打字", () => {
    const token = mentionToken("让 @", 3)!;
    expect(token).toEqual({ start: 2, end: 3, query: "" });
    expect(applyMention("让 @", token, "<Picture 1>")).toEqual({ text: "让 <Picture 1> ", caret: 14 });
    expect(applyMention("让 @", token, "图片1")).toEqual({ text: "让 @图片1 ", caret: 7 });
  });

  it("高亮遮罩既认 @图片N，也认 <Picture 1> / <Audio 2> / <Video 1>", () => {
    const text = "参考 <Picture 1> 与 <Audio 2>、<Video 1> 和 @图片3 各";
    expect(mentionChunks(text).filter((c) => c.mention).map((c) => c.text))
      .toEqual(["<Picture 1>", "<Audio 2>", "<Video 1>", "@图片3"]);
  });
});

describe("时长档位：视频工作流多出来的那颗控件", () => {
  it("单位与预设都听后端的：5/8/10/12/15 秒，不套分辨率那张 MP 表", () => {
    const duration = controlSlots(h3Slots()).find((s) => s.node === "227")!;
    expect(numberPresets(duration)).toEqual([5, 8, 10, 12, 15]);
    expect(numberUnit(duration)).toBe("秒");
    expect(formatControlValue(duration, 8)).toBe("8秒");
  });

  it("老模板没带 presets 时，标题里有「时长」也退回秒那一套档位；认不出单位就不写单位", () => {
    const legacy: CloneSlot = { kind: "number", node: "227", input: "value", label: "视频时长", value: 3, min: 1, max: 20 };
    expect(numberPresets(legacy)).toEqual([3, 5, 8, 10, 12, 15]);
    expect(numberUnit(legacy)).toBe("");
  });
});

describe("生成中那一行说人话", () => {
  it("跑动中带上已经跑了多久：一条片子是十分钟级的，不报秒数像卡死了", () => {
    const job = applyCloneProgress({ active: true, job_id: "j", state: "running", running: true, media_kind: "video", message: "生成中…", elapsed: 192 });
    expect(cloneStatusLabel(job)).toBe("生成中… · 3分12秒");
  });

  it("出片论条、出图论张；老后端只回 image_ids 也照样报", () => {
    const video = applyCloneProgress({ state: "done", running: false, media_kind: "video", outputs: [{ id: 3, kind: "video", filename: "a.mp4", thumbnail_url: "/api/videos/3/thumb" }] });
    expect(cloneStatusLabel(video)).toBe("已生成 1 条");
    expect(video.outputs.map((o) => [o.id, o.kind, o.thumbnail_url])).toEqual([[3, "video", "/api/videos/3/thumb"]]);
    expect(cloneStatusLabel(applyCloneProgress({ state: "done", running: false, image_ids: [3] }))).toBe("已生成 1 张");
  });

  it("formatElapsed：不到一分钟说秒，整分钟不说余秒", () => {
    expect(formatElapsed(0)).toBe("0秒");
    expect(formatElapsed(59)).toBe("59秒");
    expect(formatElapsed(192)).toBe("3分12秒");
    expect(formatElapsed(120)).toBe("2分钟");
  });
});

describe("从哪一类卡片点开，素材就落进哪一族", () => {
  const videoCard = { id: 21, filename: "shot.mp4", kind: "video" } as any;

  it("视频卡默认站「视频1」，图片卡默认站「图片1」", () => {
    expect(Object.keys(defaultReferences(h3Slots(), videoCard, [], { kind: "video" }))).toEqual(["185.video"]);
    expect(Object.keys(defaultReferences(h3Slots(), image(22, "a.png")))).toEqual(["188.image"]);
  });

  it("这份工作流没接视频加载器时退回第一格，素材不许凭空消失", () => {
    const onlyImage = tpl([promptSlot, imageSlot], { media_kind: "video" });
    expect(Object.keys(defaultReferences(onlyImage, videoCard, [], { kind: "video" }))).toEqual(["543.image"]);
  });

  it("有来源记录时按 slot 各回各位；没带 slot 的按族补位，绝不跨族", () => {
    const prior = [
      { id: 5, filename: "b.png", kind: "image", slot: "199.image" },
      { id: 6, filename: "m.mp3", kind: "audio" },
      { id: 7, filename: "v.mp4", kind: "video" },
    ] as any[];
    const refs = defaultReferences(h3Slots(), videoCard, prior);
    expect(refs["199.image"]?.id).toBe(5);
    expect(refs["182.audio"]?.id).toBe(6);
    expect(refs["185.video"]?.id).toBe(7);
    // 带着 slot 的那张不会因为「图片1 空着」就被顶到图片1——编号是接线顺序，不能是假的
    expect(refs["188.image"]).toBeUndefined();
  });
});

describe("称呼与档位名跟着族走，但图片那一套一个字不改", () => {
  it("只有图片一族：参考图 / 张 / 单图编辑", () => {
    const t = tpl([promptSlot, imageSlot]);
    expect(referenceNoun(t)).toBe("参考图");
    expect(referenceCounter(t)).toBe("张");
    expect(isImageOnlyRefs(t)).toBe(true);
    expect(isVideoTemplate(t)).toBe(false);
    expect(modeLabel("single", t.media_kind)).toBe("单图编辑");
  });

  it("三族混在一起：参考素材 / 份，档位叫文生视频 / 图生视频 / 多参考视频", () => {
    const t = h3Slots();
    expect(referenceNoun(t)).toBe("参考素材");
    expect(referenceCounter(t)).toBe("份");
    expect(isImageOnlyRefs(t)).toBe(false);
    expect(isVideoTemplate(t)).toBe(true);
    expect(modeLabel("text", "video")).toBe("文生视频");
    expect(modeLabel("single", "video")).toBe("图生视频");
    expect(modeLabel("multi", "video")).toBe("多参考视频");
  });
});

describe("inspectAsTemplate：还没落库的检测结果也能按族画格子", () => {
  it("设置页的导入预览靠它，media_kind / soundtracks 都要带过来", () => {
    const t = inspectAsTemplate({
      slots: h3Slots().slots, candidates: [], nodes: [], default_prompt: "", warnings: [],
      suggested_name: "H3参考视频", media_kind: "video", soundtracks: 1, modes: ["text"],
    });
    expect(isVideoTemplate(t)).toBe(true);
    expect(referenceFamilies(t)).toEqual(["image", "audio", "video"]);
    expect(familyCells(referenceCells(t), "video")).toHaveLength(3);
    expect(numberUnit(controlSlots(t).find((s) => s.node === "227")!)).toBe("秒");
  });
});


describe("「@」菜单末尾那颗「再去挂一份」", () => {
  const cells = referenceCells(h3Slots());

  it("称呼跟着要填的那一格走：图片位说「一张参考图」，音频位说「一段参考音频」", () => {
    expect(mentionAddLabel("image")).toBe("从图库再挂一张参考图");
    expect(mentionAddLabel("audio")).toBe("从图库再挂一段参考音频");
    expect(mentionAddLabel("video")).toBe("从图库再挂一条参考视频");
  });

  it("图片排满之后，那颗按钮指向的是第一个空着的音频位，不是凭空多出来的图片位", () => {
    const refs: Record<string, any> = {};
    for (const cell of familyCells(cells, "image")) refs[cell.key] = image(1);
    const items = mentionItems(cells, refs, "", "video");
    expect(items.at(-1)).toMatchObject({ add: true, kind: "audio", key: "182.audio" });
  });
});


/* ── 参考区合成一行：展示序与「+ 参考」的落位 ───────────────────────────── */

describe("参考区合成一行", () => {
  const cells = referenceCells(h3Slots());
  const ref = (id: number, kind: string, name: string) => ({ id, filename: name, kind } as any);

  it("展示序是图片 → 视频 → 音频，族内接线序不动", () => {
    expect(REF_DISPLAY_ORDER).toEqual(["image", "video", "audio"]);
    expect(sortByDisplayFamily(cells).map((c) => c.label)).toEqual([
      "图片1", "图片2", "图片3", "图片4",
      "视频1", "视频2", "视频3",
      "音频1", "音频2", "音频3",
    ]);
  });

  it("只画填上的格子，按展示序混排：三族各放一份就是 图片1 视频1 音频1", () => {
    const refs: Record<string, any> = {
      "188.image": ref(1, "image", "a.png"),
      "185.video": ref(2, "video", "b.mp4"),
      "182.audio": ref(3, "audio", "c.mp3"),
    };
    expect(mergedRefCells(cells, refs).map((c) => c.label)).toEqual(["图片1", "视频1", "音频1"]);
    // 扩位（图片3）空着不算「跳格」：合并行只画已经填的
    const skip: Record<string, any> = { "199.image": ref(4, "image", "d.png") };
    expect(mergedRefCells(cells, skip).map((c) => c.label)).toEqual(["图片2"]);
  });

  it("还有空位的族才给 tab：某一族放满它就从 tab 上消失", () => {
    expect(openRefKinds(cells, {})).toEqual(["image", "video", "audio"]);
    const full: Record<string, any> = {};
    for (const cell of familyCells(cells, "video")) full[cell.key] = ref(9, "video", "v.mp4");
    expect(openRefKinds(cells, full)).toEqual(["image", "audio"]);
    for (const kind of ["image", "audio", "video"] as const) {
      for (const cell of familyCells(cells, kind)) full[cell.key] = ref(10, kind, "x");
    }
    expect(openRefKinds(cells, full)).toEqual([]);
  });

  it("「+ 参考」的落位：那一族的第一个空位，从第 1 格连着填", () => {
    expect(firstFreeRefKey(cells, {}, "audio")).toBe("182.audio");
    expect(firstFreeRefKey(cells, { "182.audio": ref(3, "audio", "c.mp3") }, "audio")).toBe("182.audio::ref_audio_1");
    // 那一族满了就不硬塞
    const full: Record<string, any> = {};
    for (const cell of familyCells(cells, "audio")) full[cell.key] = ref(4, "audio", "c.mp3");
    expect(firstFreeRefKey(cells, full, "audio")).toBe("");
  });
});