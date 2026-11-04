import { describe, expect, it } from "vitest";
import {
  AUDIO_MODE_GROUP_LABEL, CLOUD_SETTINGS_TAB, EMPTY_CLONE_JOB, applyCloneProgress, cloneStatusLabel,
  cloudMenuGroups, coinsLabel, controlSummary, defaultControlValues, isCloudTemplate, menuRowLabel,
  mentionInsertText, mentionItems,
  mentionsTags, referenceCells, slotKey, stateLabel, supportsRefFamily, workflowMenuRows,
  type CloneJob, type CloneSlot, type CloneTemplate,
} from "../lib/clone";

/**
 * 「一键同款」接入 RunningHub 云端收费模型 API 的数据层契约。
 *
 * 这一族最容易出的错不是崩溃，是**静默说假话**：把云端那条折进本机菜单里藏掉、
 * 给不认标签的 TTS 插一个 <Audio 1> 被念进台词、把本机工作流说成要扣费、
 * 花钱了却不报数。所以下面每条都钉「界面上会出现什么字」，不是钉实现细节。
 */

const promptSlot: CloneSlot = { kind: "prompt", node: "582", input: "prompt", label: "完整提示词" };

const tpl = (slots: CloneSlot[], over: Partial<CloneTemplate> = {}): CloneTemplate => ({
  id: 1, name: "本机工作流", slots, default_prompt: "", is_active: true,
  created_at: "", updated_at: "", node_count: 3, prompt_count: 1,
  reference_count: 0, control_count: 0, ...over,
});

/** 云端那条：后端给的是 is_cloud + engine，弹窗一切「花钱」的判断都从这里起。 */
const cloudTpl = (over: Partial<CloneTemplate> = {}): CloneTemplate => tpl([], {
  id: 90, name: "图片API", is_cloud: true, engine: "cloud", provider: "runninghub", model: "image", ...over,
});

const image = (id: number, filename = `n${id}.png`) => ({ id, filename, kind: "image" } as any);

describe("切换工作流清单里的云端条目", () => {
  it("云端「音频API」不折进「闪寻音频」：付费通道不能在本机那三种模式里被藏掉", () => {
    const cloudAudio = tpl([], { id: 5, name: "音频API", media_kind: "audio", is_cloud: true, engine: "cloud" });
    expect(isCloudTemplate(cloudAudio)).toBe(true);
    const rows = workflowMenuRows([
      tpl([promptSlot], { id: 1, name: "闪寻图片编辑", media_kind: "image" }),
      tpl([], { id: 2, name: "闪寻参考音色", media_kind: "audio" }),
      tpl([], { id: 3, name: "闪寻音色描述", media_kind: "audio" }),
      tpl([], { id: 4, name: "闪寻指定音色", media_kind: "audio" }),
      cloudAudio,
    ]);
    expect(rows.map((row) => row.label)).toEqual(["闪寻图片编辑", AUDIO_MODE_GROUP_LABEL, "音频API"]);
    const audioRow = rows.find((row) => row.label === "音频API")!;
    expect(audioRow.collapsed).toBe(false);
    expect(audioRow.memberIds).toEqual([5]);
    const group = rows.find((row) => row.collapsed)!;
    expect(group.memberIds).toEqual([2, 3, 4]);
    expect(group.targetId).toBe(2);
  });

  it("只有一条音频工作流时照旧按名字列，云端那条永远单独一行", () => {
    const rows = workflowMenuRows([
      tpl([], { id: 2, name: "闪寻参考音色", media_kind: "audio" }),
      tpl([], { id: 5, name: "音频API", media_kind: "audio", is_cloud: true, engine: "cloud" }),
    ]);
    expect(rows.map((row) => row.label)).toEqual(["闪寻参考音色", "音频API"]);
    expect(rows.every((row) => !row.collapsed)).toBe(true);
  });
});

describe("API 那一屏的两列级联", () => {
  const rowOf = (over: Partial<CloneTemplate> = {}) => {
    const item = cloudTpl(over);
    return workflowMenuRows([item]).find((row) => row.targetId === item.id)!;
  };

  it("行名报模型名：底部那颗、弹窗标题、级联右列同一个来源，不许一处一个叫法", () => {
    const declared = cloudTpl({ cloud: { model_label: "即梦 Seedream v5 lite" } });
    expect(menuRowLabel(declared)).toBe("即梦 Seedream v5 lite");
    expect(workflowMenuRows([declared])[0].label).toBe("即梦 Seedream v5 lite");
  });

  it("后端没给 model_label 就退回库里的名字：老后端与设置页恢复回来的裸条目都不自己编", () => {
    expect(menuRowLabel(cloudTpl({}))).toBe("图片API");
    expect(menuRowLabel(tpl([], { id: 3, name: "本机工作流.json" }))).toBe("本机工作流");
  });

  it("按 provider 分组：一家一行，模型只落在自己那一行里", () => {
    const mine = cloudTpl({ id: 90, cloud: { provider_label: "RunningHub", model_label: "Seedream v5" } });
    const other = cloudTpl({ id: 93, provider: "grsai", cloud: { provider_label: "GRSAI", model_label: "别家出图" } });
    const local = tpl([promptSlot], { id: 1, name: "本机工作流" });
    const rows = workflowMenuRows([mine, other, local]);
    const groups = cloudMenuGroups(rows, [mine, other, local]);
    expect(groups.map((g) => [g.key, g.label, g.rows.length])).toEqual([
      ["runninghub", "RunningHub", 1],
      ["grsai", "GRSAI", 1],
    ]);
    expect(groups[0].rows[0].label).toBe("Seedream v5");
    expect(groups[1].rows[0].label).toBe("别家出图");
  });

  it("左列那一行分两行说实话：能干什么一行、扣什么钱一行，拼起来那句进悬浮提示", () => {
    const items = [
      cloudTpl({ id: 90, cloud: { provider_label: "RunningHub" } }),
      cloudTpl({ id: 91, name: "视频API", media_kind: "video", model: "video", cloud: { provider_label: "RunningHub" } }),
      cloudTpl({ id: 92, name: "音频API", media_kind: "audio", model: "audio", cloud: { provider_label: "RunningHub" } }),
    ];
    const groups = cloudMenuGroups(workflowMenuRows(items), items);
    expect(groups).toHaveLength(1);
    // 左列只有 172px：拼成一句会被截成「按 R…」，所以 caps / cost 分开，blurb 只进 title
    expect(groups[0].caps).toBe("出图/出片/出声音");
    expect(groups[0].cost).toBe("按 RH币扣费");
    expect(groups[0].blurb).toBe("出图/出片/出声音 · 按 RH币扣费");
  });

  it("本机那条不进左列；provider 没标时兜底成一组，不让一行掉进 undefined 组里", () => {
    const bare = cloudTpl({ id: 94, cloud: undefined, provider: undefined });
    const local = tpl([promptSlot], { id: 1, name: "本机工作流" });
    const groups = cloudMenuGroups(workflowMenuRows([bare, local]), [bare, local]);
    expect(groups.map((g) => [g.key, g.label])).toEqual([["cloud", "云端"]]);
    expect(cloudMenuGroups(workflowMenuRows([local]), [local])).toEqual([]);
  });
});

describe("参考位与 @ 引用", () => {
  it("云端参考位 tag 是空串就保持空串：本机才补 <Audio 1>，TTS 会把它念进台词", () => {
    const wire = [{ key: "a.audio", kind: "audio" as const, ordinal: 1, label: "音频1", slot_label: "加载音频", tag: "" }];
    const cloud = cloudTpl({ id: 95, name: "音频API", media_kind: "audio", reference_cells: wire });
    expect(referenceCells(cloud)[0].tag).toBe("");
    const local = tpl([], { id: 40, media_kind: "audio", reference_cells: wire });
    expect(referenceCells(local)[0].tag).toBe("<Audio 1>");
  });

  it("云端插什么标签只照后端报的：给空串就插空串，给 @Image 1 就插 @Image 1，前端不猜", () => {
    const cell = { key: "v.image", label: "图片1", slotLabel: "加载图片", kind: "image" as const, ordinal: 1, tag: "" };
    expect(mentionInsertText(cell, "video", true)).toBe("");
    expect(mentionInsertText({ ...cell, tag: undefined }, "video", true)).toBe("");
    expect(mentionInsertText({ ...cell, tag: "@Image 1" }, "video", true)).toBe("@Image 1");
    // 本机两条老链路一个字不改：视频工作流补 H3 尖括号，图片工作流仍是 @图片N
    expect(mentionInsertText(cell, "video")).toBe("<Picture 1>");
    expect(mentionInsertText(cell, "image")).toBe("@图片1");
  });

  it("模型说不认 @ 标签时整个菜单不弹：插进去的标签只会污染提示词", () => {
    const noTag = cloudTpl({
      id: 95, name: "音频API", media_kind: "audio", cloud: { mentions: false },
      reference_cells: [
        { key: "a.audio", kind: "audio", ordinal: 1, label: "音频1", slot_label: "加载音频", tag: "" },
        { key: "b.audio", kind: "audio", ordinal: 2, label: "音频2", slot_label: "加载音频", tag: "" },
      ],
    });
    expect(mentionsTags(noTag)).toBe(false);
    expect(mentionsTags(cloudTpl({ cloud: { mentions: true } }))).toBe(true);
    expect(mentionsTags(cloudTpl({}))).toBe(true);
    expect(mentionsTags(tpl([]))).toBe(true);
    // 音频1 已经挂了素材：认标签的模型会给菜单，不认的必须一条都不给
    const cells = referenceCells(noTag);
    expect(Object.keys(cells).length).toBe(2);
    expect(mentionItems(cells, { "a.audio": image(11) }, "", "audio", true)).toEqual([]);
    const tagged = referenceCells(cloudTpl({
      id: 91, name: "视频API", media_kind: "video", cloud: { mentions: true },
      reference_cells: [{ key: "v.image", kind: "image", ordinal: 1, label: "图片1", slot_label: "加载图片", tag: "@Image 1" }],
    }));
    expect(mentionItems(tagged, { "v.image": image(12) }, "", "video", true).map((item) => item.insert)).toEqual(["@Image 1"]);
  });
});

describe("任务进度里的钱与状态", () => {
  it("老后端一条云端字段都不发时也必须填好默认值：留 undefined 会炸掉弹窗", () => {
    const job = applyCloneProgress({});
    expect(job.engine).toBe("comfyui");
    expect(job.estimated_cost).toBeNull();
    expect(job.cost_coins).toBeNull();
    expect(job.task_row_id).toBeNull();
    expect(job.recoverable).toBe(false);
    expect(job.task_id).toBe("");
    expect(Object.values(job).every((value) => value !== undefined)).toBe(true);
    expect(applyCloneProgress(null)).toEqual(EMPTY_CLONE_JOB);
  });

  it("task_row_id 只认正整数：0 / 负数 / 乱码一律当没有这条任务，否则「取回结果」打的是坏地址", () => {
    const rowOf = (value: unknown) => applyCloneProgress({ state: "error", task_row_id: value }).task_row_id;
    expect(rowOf("12")).toBe(12);
    expect(rowOf(7)).toBe(7);
    expect([rowOf(0), rowOf(-1), rowOf("abc"), rowOf(null), rowOf(undefined)]).toEqual([null, null, null, null, null]);
  });

  it("云端 pill 只报比例与画质：本机的「百万像素」不是云端的参数，不许冒出来", () => {
    const ratio: CloneSlot = { kind: "select", node: "9", input: "ratio", label: "比例", options: ["9:16", "16:9"], value: "9:16" };
    const resolution: CloneSlot = { kind: "select", node: "9", input: "resolution", label: "分辨率", options: ["2K", "1080p"], value: "2K" };
    const mega: CloneSlot = { kind: "number", node: "9", input: "megapixels", label: "百万像素", value: 1.4, min: 0.2, max: 4, step: 0.1 };
    const cloud = cloudTpl({ slots: [ratio, resolution, mega], control_count: 3 });
    const local = tpl([ratio, resolution, mega], { id: 41, control_count: 3 });
    const summary = controlSummary(cloud, defaultControlValues(cloud));
    expect(summary).toContain("9:16");
    expect(summary).toContain("2K");
    expect(summary).not.toMatch(/megapixels/i);
    expect(summary).not.toMatch(/MP/i);
    expect(summary).not.toContain("百万像素");
    // 本机照旧把百万像素报出来，别为了云端把老 pill 削短
    expect(controlSummary(local, defaultControlValues(local))).toContain("1.4MP");
  });

  it("云端话术不提 ComfyUI，并说清花了多少 RH币、停止等待不等于没付钱", () => {
    expect(stateLabel({ state: "uploading", engine: "cloud" })).not.toContain("ComfyUI");
    expect(stateLabel({ state: "queued", engine: "cloud" })).not.toContain("ComfyUI");
    expect(stateLabel({ state: "downloading", engine: "cloud" })).not.toContain("ComfyUI");
    expect(stateLabel({ state: "queued", engine: "comfyui" })).toContain("ComfyUI");

    const done: CloneJob = {
      ...EMPTY_CLONE_JOB, active: true, state: "done", engine: "cloud", cost_coins: 12,
      outputs: [{ id: 21, kind: "video", filename: "out.mp4", thumbnail_url: "" }],
    };
    expect(cloneStatusLabel(done)).toContain("花 12 RH币");
    const unpriced: CloneJob = { ...done, cost_coins: null };
    expect(cloneStatusLabel(unpriced)).not.toContain("RH币");

    const cancelled: CloneJob = { ...EMPTY_CLONE_JOB, active: true, state: "cancelled", engine: "cloud", recoverable: true };
    expect(cloneStatusLabel(cancelled)).toContain("取回结果");
    const localCancelled: CloneJob = { ...cancelled, engine: "comfyui" };
    expect(cloneStatusLabel(localCancelled)).not.toContain("取回结果");
  });
});

describe("模型 spec 报的参考上限", () => {
  const cells = (kinds: ("image" | "audio" | "video")[]) => kinds.map((kind, index) => ({
    key: `${kind}.${index + 1}`, kind, ordinal: index + 1, label: `${kind}${index + 1}`, slot_label: `加载${kind}`, tag: "",
  }));

  it("Seedance 的图 9 / 视频 3 / 音频 3 由 spec 报，本机没有这个上限（0 = 不限）", () => {
    const seedance = cloudTpl({
      id: 91, name: "视频API", media_kind: "video", model: "video",
      cloud: { model_label: "Seedance 2.0", ref_limits: { image: 9, video: 3, audio: 3 } },
      reference_cells: cells(["image", "video", "audio"]),
    });
    expect([supportsRefFamily(seedance, "image"), supportsRefFamily(seedance, "video"), supportsRefFamily(seedance, "audio")])
      .toEqual([true, true, true]);
  });

  it("图片API 不收音频：整行置灰而不是报「第 1 格还空着」", () => {
    const imageApi = cloudTpl({
      id: 92, name: "图片API", media_kind: "image",
      cloud: { ref_limits: { image: 4 } },
      reference_cells: cells(["image"]),
    });
    expect(supportsRefFamily(imageApi, "image")).toBe(true);
    expect(supportsRefFamily(imageApi, "audio")).toBe(false);
    expect(supportsRefFamily(imageApi, "video")).toBe(false);
  });
});

describe("钱与入口的措辞", () => {
  it("RH币统一说法：整数不带小数点、小数只留两位、没测出来直说未实测", () => {
    expect(coinsLabel(12)).toBe("12 RH币");
    expect(coinsLabel(1.234)).toBe("1.23 RH币");
    expect(coinsLabel(null)).toBe("未实测");
    expect(coinsLabel(undefined)).toBe("未实测");
  });

  it("云端那张卡不是一整页，是「模型API配置」里的一张卡：弹窗跳转靠这个字符串", () => {
    expect(CLOUD_SETTINGS_TAB).toBe("模型API配置");
  });

  it("参考位键名走 slotKey，云端与本机同一套键（生成时后端按它接线）", () => {
    const slot: CloneSlot = { kind: "image", node: "543", input: "image", label: "参考图" };
    expect(slotKey(slot)).toBe("543.image");
  });

  it("跑一次真没收钱也要报数：0 RH币和「没测出来」不是一回事", () => {
    const done = (cost: number | null) => applyCloneProgress({
      active: true, state: "done", image_ids: [1], engine: "cloud", cost_coins: cost,
    });
    expect(cloneStatusLabel(done(0))).toContain("花 0 RH币");
    expect(cloneStatusLabel(done(null))).not.toContain("花");
  });
});
