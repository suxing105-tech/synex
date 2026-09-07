// 详情面板参数分组 + LoRA 抽取（纯函数，便于单测）。
//
// 设计：
// - groupParams 把 ComfyUI 常见参数按「采样器 / 模型 / LoRA / 其他」分组，
//   同时把 <lora:name:weight> 也归到 LoRA 组（即便 parameters 里没有 loras 字段）。
// - extractLoras 支持两种来源：
//     1. parameters.loras（数组或对象）
//     2. 正向 prompt 中 <lora:name:weight> 标记
//   去重按 name，权重取绝对值最大者（多次出现一般取最强）。

export interface LoraItem {
  name: string;
  weight: number;
}

export interface ParamGroup {
  id: "sampler" | "model" | "lora" | "size" | "other";
  label: string;
  entries: Array<[string, string]>; // 与现有 paramsToKv 输出一致
}

const SAMPLER_KEYS = new Set([
  "sampler_name",
  "scheduler",
  "steps",
  "cfg",
  "cfg_scale",
  "cfg_rescale",
  "denoise",
  "seed",
  "noise_seed",
  "add_noise",
  "start_at_step",
  "end_at_step",
  "return_with_leftover_noise",
  "latent_image",
  "model_seed",
  "control_after_generate",
  "script_name",
]);

const MODEL_KEYS = new Set([
  "model",
  "model_name",
  "ckpt_name",
  "checkpoint",
  "unet_name",
  "vae",
  "vae_name",
  "clip_name1",
  "clip_name2",
]);

const SIZE_KEYS = new Set([
  "width",
  "height",
  "size",
  "aspect_ratio",
  "resolution",
  "batch_size",
  "batch",
]);

const LORA_KEYS = new Set(["loras", "lora_name", "lora_strength"]);

// 匹配 <lora:NAME:WEIGHT>；NAME 不含 :，WEIGHT 可负（抑制 LoRA）默认 1.0。
// 允许大括号包住 / 空格 / 复合权重 <lora:a:0.5:0.8> → 只取第一个权重。
const LORA_REGEX = /<lora:([^:>]+):(-?\d+(?:\.\d+)?)(?::[^>]+)?>/gi;

export function extractLoras(
  positivePrompt: string | null | undefined,
  parameters: Record<string, unknown>,
): LoraItem[] {
  const map = new Map<string, number>();

  // 1) prompt 中 <lora:name:weight>
  if (positivePrompt) {
    for (const m of positivePrompt.matchAll(LORA_REGEX)) {
      const name = m[1].trim();
      const w = parseFloat(m[2]);
      if (!name || Number.isNaN(w)) continue;
      const prev = map.get(name);
      if (prev === undefined || Math.abs(w) > Math.abs(prev)) map.set(name, w);
    }
  }

  // 2) parameters.loras 支持：[{name,strength}, {name,model_strength,clip_strength}]、
  //    {name: weight} 对象、或纯字符串 "name:weight, name:weight"
  const raw = parameters.loras ?? parameters.lora;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item == null) continue;
      if (typeof item === "string") {
        const parsed = parseLoraString(item);
        for (const it of parsed) mergeLora(map, it);
      } else if (typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const name = String(obj.name ?? obj.lora ?? "").trim();
        const w = firstNumber([
          obj.strength,
          obj.model_strength,
          obj.weight,
          obj.strength_model,
        ]);
        if (name && w !== null) mergeLora(map, { name, weight: w });
      }
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const w = firstNumber([v]);
      if (w !== null) mergeLora(map, { name: k.trim(), weight: w });
    }
  } else if (typeof raw === "string") {
    for (const it of parseLoraString(raw)) mergeLora(map, it);
  }

  // 按权重绝对值降序
  return Array.from(map, ([name, weight]) => ({ name, weight })).sort(
    (a, b) => Math.abs(b.weight) - Math.abs(a.weight),
  );
}

function parseLoraString(s: string): LoraItem[] {
  const out: LoraItem[] = [];
  for (const part of s.split(/[,;\n]/)) {
    const t = part.trim();
    if (!t) continue;
    // "name:weight" 或 "name weight"（支持负数）
    const m = t.match(/^([^:]+?)[:\s]+(-?\d+(?:\.\d+)?)$/);
    if (m) {
      const name = m[1].trim();
      const w = parseFloat(m[2]);
      if (name && !Number.isNaN(w)) out.push({ name, weight: w });
    }
  }
  return out;
}

function mergeLora(map: Map<string, number>, it: LoraItem) {
  if (!it.name) return;
  const prev = map.get(it.name);
  if (prev === undefined || Math.abs(it.weight) > Math.abs(prev)) {
    map.set(it.name, it.weight);
  }
}

function firstNumber(values: Array<unknown>): number | null {
  for (const v of values) {
    if (v == null) continue;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

// 把 parameters 字典拆成 5 组。detail 顶层字段（sampler/steps/cfg/seed/...）会被合并
// 到 sampler 组，避免与 parameters 里的同名键重复。
export function groupParams(
  parameters: Record<string, unknown>,
  detail: {
    sampler?: string | null;
    steps?: number | null;
    cfg?: number | null;
    seed?: number | null;
    model?: string | null;
    width?: number | null;
    height?: number | null;
    size_bytes?: number | null;
  } = {},
): ParamGroup[] {
  const sampler: Array<[string, string]> = [];
  const model: Array<[string, string]> = [];
  const loras: Array<[string, string]> = [];
  const size: Array<[string, string]> = [];
  const other: Array<[string, string]> = [];

  // 顶层 detail 字段优先（detail.sampler > parameters.sampler_name 之类）
  const seen = new Set<string>();
  const topLevel: Array<[string, string]> = [];
  if (detail.sampler) topLevel.push(["sampler_name", detail.sampler]);
  if (detail.steps != null) topLevel.push(["steps", String(detail.steps)]);
  if (detail.cfg != null) topLevel.push(["cfg", String(detail.cfg)]);
  if (detail.seed != null) topLevel.push(["seed", String(detail.seed)]);
  if (detail.model) topLevel.push(["model", detail.model]);
  if (detail.width != null) topLevel.push(["width", String(detail.width)]);
  if (detail.height != null) topLevel.push(["height", String(detail.height)]);
  if (detail.size_bytes != null)
    topLevel.push(["size_bytes", String(detail.size_bytes)]);

  for (const [k, v] of topLevel) {
    seen.add(k);
    push(k, v, sampler, model, loras, size, other);
  }

  for (const [k, v] of Object.entries(parameters)) {
    if (seen.has(k)) continue;
    push(k, v, sampler, model, loras, size, other);
  }

  const groups: ParamGroup[] = [];
  if (sampler.length) groups.push({ id: "sampler", label: "采样", entries: sampler });
  if (model.length) groups.push({ id: "model", label: "模型", entries: model });
  if (loras.length) groups.push({ id: "lora", label: "LoRA", entries: loras });
  if (size.length) groups.push({ id: "size", label: "尺寸", entries: size });
  if (other.length) groups.push({ id: "other", label: "其他", entries: other });
  return groups;
}

function push(
  k: string,
  v: unknown,
  sampler: Array<[string, string]>,
  model: Array<[string, string]>,
  loras: Array<[string, string]>,
  size: Array<[string, string]>,
  other: Array<[string, string]>,
) {
  const target = SAMPLER_KEYS.has(k)
    ? sampler
    : MODEL_KEYS.has(k)
      ? model
      : SIZE_KEYS.has(k)
        ? size
        : LORA_KEYS.has(k)
          ? loras
          : other;
  target.push([k, String(v)]);
}

// LoRA 强度统一保留 2 位小数（如 "1.00" / "0.80"），让列表右对齐列宽统一。
export function formatWeight(w: number): string {
  return w.toFixed(2);
}

// 工具：长值截断 + tooltip（前端展示用）。
export function truncateValue(s: string, max = 24): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

