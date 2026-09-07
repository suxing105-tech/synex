import { describe, it, expect } from "vitest";
import { extractLoras, groupParams, truncateValue } from "../lib/params";

describe("extractLoras（LoRA 抽取）", () => {
  it("从正向 prompt 中识别 <lora:name:weight>", () => {
    const prompt =
      "<lora:Krea2/krea2_wukong_sytle_c1:0.80> a girl <lora:Krea2/detail_slider_krea2_loraholic:0.6>";
    const items = extractLoras(prompt, {});
    expect(items).toEqual([
      { name: "Krea2/krea2_wukong_sytle_c1", weight: 0.8 },
      { name: "Krea2/detail_slider_krea2_loraholic", weight: 0.6 },
    ]);
  });

  it("prompt 与 parameters.loras 合并，按 name 去重，权重取绝对值最大者", () => {
    const prompt = "<lora:foo:0.5>";
    const items = extractLoras(prompt, {
      loras: [
        { name: "foo", strength: 0.9 },
        { name: "bar", strength: 0.7 },
      ],
    });
    expect(items).toEqual([
      { name: "foo", weight: 0.9 },
      { name: "bar", weight: 0.7 },
    ]);
  });

  it("parameters.loras 支持对象形式 {name: weight}", () => {
    const items = extractLoras("", {
      loras: { "a/b": 0.4, "c/d": 1.2 },
    } as Record<string, unknown>);
    expect(items).toEqual([
      { name: "c/d", weight: 1.2 },
      { name: "a/b", weight: 0.4 },
    ]);
  });

  it("parameters.loras 支持字符串 'name:weight'", () => {
    const items = extractLoras("", {
      loras: "foo:0.5, bar:0.7",
    } as Record<string, unknown>);
    expect(items).toEqual([
      { name: "bar", weight: 0.7 },
      { name: "foo", weight: 0.5 },
    ]);
  });

  it("负向权重（lora 抑制）也保留（绝对值排序）", () => {
    const items = extractLoras(
      "<lora:positive:0.3> <lora:negative:-0.9>",
      {},
    );
    expect(items.map((x) => x.name)).toEqual(["negative", "positive"]);
    expect(items[0].weight).toBe(-0.9);
  });

  it("空输入 → 空数组", () => {
    expect(extractLoras("", {})).toEqual([]);
    expect(extractLoras(null, {})).toEqual([]);
  });

  it("prompt 里损坏的 <lora:> 不会炸", () => {
    const items = extractLoras("<lora:::bad><lora:only-name><lora:a:abc>", {});
    expect(items).toEqual([]);
  });
});

describe("groupParams（按域分组）", () => {
  it("默认把常见 sampler / model / size 字段分到对应组", () => {
    const groups = groupParams({
      sampler_name: "er_sde",
      scheduler: "simple",
      steps: 8,
      cfg: 1,
      seed: 123,
      model: "krea2.safetensors",
      width: 1152,
      height: 2064,
    });
    const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
    expect(byId.sampler.entries.map(([k]) => k)).toEqual([
      "sampler_name",
      "scheduler",
      "steps",
      "cfg",
      "seed",
    ]);
    expect(byId.model.entries).toEqual([["model", "krea2.safetensors"]]);
    expect(byId.size.entries).toEqual([
      ["width", "1152"],
      ["height", "2064"],
    ]);
  });

  it("detail 顶层字段优先（sampler/steps/cfg/seed/...）", () => {
    const groups = groupParams(
      {
        sampler_name: "fallback",
        steps: 99,
      },
      { sampler: "er_sde", steps: 8, seed: 42 },
    );
    const sampler = groups.find((g) => g.id === "sampler")!;
    expect(sampler.entries).toContainEqual(["sampler_name", "er_sde"]);
    expect(sampler.entries).toContainEqual(["steps", "8"]);
    expect(sampler.entries).toContainEqual(["seed", "42"]);
    // 没有重复出现
    const keys = sampler.entries.map(([k]) => k);
    expect(keys.filter((k) => k === "sampler_name")).toHaveLength(1);
    expect(keys.filter((k) => k === "steps")).toHaveLength(1);
  });

  it("LoRA 字符串来源的参数被分到 lora 组", () => {
    const groups = groupParams({
      loras: "foo:0.5, bar:0.7",
    } as unknown as Record<string, unknown>);
    const lora = groups.find((g) => g.id === "lora")!;
    expect(lora.entries).toContainEqual(["loras", "foo:0.5, bar:0.7"]);
  });

  it("未知键归入 other 组", () => {
    const groups = groupParams({ custom_thing: "abc", unknown_flag: true });
    const other = groups.find((g) => g.id === "other")!;
    expect(other.entries.map(([k]) => k).sort()).toEqual([
      "custom_thing",
      "unknown_flag",
    ]);
  });

  it("空 parameters → 只有顶层 detail 派生出来的组", () => {
    const groups = groupParams({}, { seed: 1, steps: 4 });
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("sampler");
    expect(groups[0].entries).toContainEqual(["seed", "1"]);
    expect(groups[0].entries).toContainEqual(["steps", "4"]);
  });

  it("完全空 → 空数组（避免渲染空卡片）", () => {
    expect(groupParams({})).toEqual([]);
  });

  it("不修改入参", () => {
    const p = { a: 1, b: 2 };
    const d = { seed: 1, steps: 4 };
    groupParams(p, d);
    expect(p).toEqual({ a: 1, b: 2 });
    expect(d).toEqual({ seed: 1, steps: 4 });
  });
});

describe("truncateValue（长值截断）", () => {
  it("不超 max → 原样返回", () => {
    expect(truncateValue("short", 10)).toBe("short");
  });

  it("超过 max → 截断 + ellipsis", () => {
    expect(truncateValue("a".repeat(30), 10)).toBe("aaaaaaaaa…");
  });

  it("默认 max=24", () => {
    expect(truncateValue("a".repeat(50))).toHaveLength(24);
    expect(truncateValue("a".repeat(24))).toHaveLength(24);
  });


  it("parameters.used_loras 优先于 prompt 文本和 parameters.loras（权威来源）", () => {
    // prompt 文本里写了 bypass:0.5 和 foo:0.9，但后端只标 foo 为"实际使用"
    const items = extractLoras("<lora:bypass:0.5> <lora:foo:0.9>", {
      used_loras: [{ name: "foo", strength: 0.9 }],
      loras: [{ name: "another", strength: 0.7 }],
    });
    expect(items).toEqual([{ name: "foo", weight: 0.9 }]);
  });

  it("parameters.used_loras 支持对象形式 {name: weight}", () => {
    const items = extractLoras("", {
      used_loras: { "a/b": 0.4, "c/d": 1.2 },
    } as Record<string, unknown>);
    expect(items).toEqual([
      { name: "c/d", weight: 1.2 },
      { name: "a/b", weight: 0.4 },
    ]);
  });

  it("parameters.used_loras 支持字符串 'name:weight'", () => {
    const items = extractLoras("", {
      used_loras: "foo:0.5, bar:0.7",
    } as Record<string, unknown>);
    expect(items).toEqual([
      { name: "bar", weight: 0.7 },
      { name: "foo", weight: 0.5 },
    ]);
  });

  it("没有 used_loras 时回退现有逻辑（prompt <lora:> 仍然有效）", () => {
    const items = extractLoras("<lora:foo:0.5>", {});
    expect(items).toEqual([{ name: "foo", weight: 0.5 }]);
  });

  it("parameters.used_loras 为空数组 → 空列表（即使 prompt 文本里有 lora tag）", () => {
    const items = extractLoras("<lora:foo:0.5>", { used_loras: [] });
    expect(items).toEqual([]);
  });

});
