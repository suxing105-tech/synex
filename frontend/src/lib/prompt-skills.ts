/**
 * 提示词优化技能的前端那一侧：接口、store，以及「引用标记有没有被模型吃掉」这道校验。
 *
 * 为什么单独一个模块：一颗按钮要的清单、默认值、优化请求都归它，CloneModal 只管接线；
 * 这些逻辑不挂 DOM，能直接单测（见 __tests__/prompt-skills.test.ts）。
 */
import { writable } from "svelte/store";
import { http } from "./api";

export type PromptSkillKind = "image" | "video";
export type PromptSkillLanguage = "auto" | "zh" | "en";

/** 技能包里一个文件的去处。丢掉的要看得见——悄悄少给一份资料最难查。 */
export interface PromptSkillPackageFile {
  path: string;
  size: number;
  /** 写法＝SKILL.md 本体，参考＝文本附属文件，资源＝二进制（不发） */
  role: "写法" | "参考" | "资源";
  /** 是否进了这次发给模型的资料块 */
  included: boolean;
  /** 进了但被预算截断了 */
  truncated: boolean;
  /** 没进去的原因（超预算、二进制文件……） */
  reason: string;
  /** 进资料块的先后次序（1 起）；没进去的是 0 */
  order: number;
}

export interface PromptSkillPackage {
  /** 包名：frontmatter 的 name，没有就取文件夹名 */
  root: string;
  /** 桌面上导入时那份文件夹的原始路径 */
  source_dir: string;
  description: string;
  license: string;
  allowed_tools: string | string[];
  version: string;
  extra_fields: Record<string, unknown>;
  files: PromptSkillPackageFile[];
  /** 真正发给模型的资料字数（不含标题与分隔线） */
  refs_chars: number;
  /** 没进资料块的文件 */
  dropped: string[];
}

export interface PromptSkill {
  id: number;
  name: string;
  note: string;
  kinds: PromptSkillKind[];
  instruction: string;
  language: PromptSkillLanguage;
  with_refs: boolean;
  /** 有值＝内置那两条：能改、能恢复默认，但不能删 */
  builtin_key: string | null;
  /** manual＝手写的，md＝导入的单个 SKILL.md，package＝一整个技能包 */
  source: "manual" | "md" | "package";
  /** 技能包在数据目录里的落盘位置 */
  package_dir: string | null;
  package: PromptSkillPackage | null;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface PromptSkillDraft {
  name?: string;
  note?: string;
  kinds?: PromptSkillKind[];
  instruction?: string;
  language?: PromptSkillLanguage;
  with_refs?: boolean;
}

export interface PromptSkillSettings {
  default_image_skill: number | null;
  default_video_skill: number | null;
}

/** 一格参考图。ordinal 是提示词里的编号——空格子时它不连续，后端按它标「图 N」。 */
export interface OptimizeRef {
  ordinal: number;
  image_id: number;
}

export interface OptimizeResult {
  prompt: string;
  model_name: string;
  model: string;
  /** 参考图被少带了才非空：sent 是真发出去的张数，dropped 是被跳过的格子编号 */
  degraded_refs: { sent: number; dropped: number[] } | null;
}

/** 一次中英互译的结果。方向是后端按正文主体语言判出来的，界面照着写悬停提示。 */
export interface TranslateResult {
  text: string;
  source_language: TranslateLanguage;
  target_language: TranslateLanguage;
  model_name: string;
  model: string;
}

/**
 * 浏览器版目录上传时只送这些扩展名：其余是二进制，读成文字就是一堆乱码，
 * 塞进系统提示只会浪费 token。后端还会再筛一遍，这里先筛是为了少传。
 */
export const TEXT_FILE_SUFFIXES = [
  ".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".csv", ".tsv", ".py", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".sh", ".bash", ".bat", ".ps1",
  ".html", ".css", ".xml", ".sql", ".tex", ".rst",
];

/** 这个路径像不像一个能读成文字的文件。 */
export function isTextFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  return TEXT_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export const LANGUAGE_WORDS: Record<PromptSkillLanguage, string> = { auto: "跟随原文", zh: "中文", en: "英文" };
export const KIND_WORDS: Record<PromptSkillKind, string> = { image: "图片", video: "视频" };

/** 中英互译只在两种语言之间来回，没有「跟随原文」这一档——那是优化那一条的事。 */
export type TranslateLanguage = "zh" | "en";
export const TRANSLATE_WORDS: Record<TranslateLanguage, string> = { zh: "中文", en: "英文" };

/**
 * 「带进模型多少字」到这一步就该给人提个醒。
 *
 * 技能包的附属文件是整份塞进同一次请求的，字数直接等于每次优化要送进模型的输入：
 * 出词更慢、更贵，而且资料厚到一定份上，模型抓重点的能力反而下降。后端把预算闸放在
 * 6 万字（skill_packages.MAX_REFS_CHARS），够放随包的 H3 视频技能那份四合一资料；
 * 这里报的是「已经吃掉大半预算」，不是「超了」，所以数取得比它低一档。
 */
export const HEAVY_REFS_CHARS = 40_000;

/** 撞名/撞来源时怎么办：先问、替换原来的、另存为新的。和后端 CONFLICT_MODES 一个口径。 */
export type SkillConflictMode = "ask" | "replace" | "new";

/** 一条在问「要替换还是另存」的冲突：existing_* 是库里那一条，报给人看的。 */
export interface SkillImportConflict {
  name: string;
  source_dir: string;
  existing_id: number;
  existing_name: string;
}

/** 没进来的那一个来源和后端给的原因——被拒的拖放要能说出来为什么。 */
export interface SkillImportSkipped {
  path: string;
  reason: string;
}

/** 一次导入的完整回执。进了几条、哪几条在问、哪些没进来，三份都得有人说话。 */
export interface SkillImportResult {
  imported: (PromptSkill & {
    replaced?: boolean;
    package?: PromptSkillPackage | null;
  })[];
  conflicts: SkillImportConflict[];
  skipped: SkillImportSkipped[];
}

/** 「导入技能」那一个入口认的后缀：Rust 那颗筛子、后端那份名单、这里，同一个口径。 */
export const SKILL_SOURCE_SUFFIXES = [".md", ".markdown", ".txt", ".zip"];

/** 拖进来的路径值不值得把整块地描红。压缩包只认 .zip，其余交给后端说明原因。 */
export function isSkillSourcePath(path: string): boolean {
  const lower = String(path || "").toLowerCase();
  return SKILL_SOURCE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * 导入回执 → 一句给人看的话。
 *
 * 一句话要说清四件事：进了哪条/几条、参考资料带进几份、有没有替换掉旧的、什么没进来。
 * 「包里没带参考资料」这句是故意说的：从技能包导进来的默认以为带了，
 * 空着不报，人就会以为模型读到了作者其实没写的东西。
 */
export function describeImport(result: SkillImportResult): string {
  const list = result.imported ?? [];
  const skipped = result.skipped ?? [];
  if (!list.length) {
    return skipped.length ? "没能导入：" + skipped[0].reason : "没有可导入的技能";
  }
  const parts: string[] = [];
  parts.push(list.length === 1 ? "已导入技能「" + list[0].name + "」" : "已导入 " + list.length + " 条技能");
  const packed = list.filter((item) => item.package);
  if (packed.length) {
    const refs = packed.reduce(
      (sum, item) => sum + (item.package?.files ?? []).filter((f) => f.role === "参考" && f.included).length,
      0,
    );
    parts.push(refs ? "带进 " + refs + " 份参考资料" : "包里没带参考资料");
  }
  const replaced = list.filter((item) => item.replaced).length;
  if (replaced === 1 && list.length === 1) parts.push("已替换原来那条");
  else if (replaced) parts.push("其中 " + replaced + " 条替换了原来的");
  const dropped = packed.reduce((sum, item) => sum + (item.package?.dropped?.length ?? 0), 0);
  if (dropped) parts.push(dropped + " 个文件没进预算");
  if (skipped.length) parts.push(skipped.length + " 个没进来：" + skipped[0].reason);
  return parts.join("，");
}

const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

const skillPath = (id: number) => `/api/prompt-skills/${id}`;

export const promptSkillsApi = {
  list: () => http<PromptSkill[]>("/api/prompt-skills"),
  create: (draft: PromptSkillDraft) => http<PromptSkill>("/api/prompt-skills", json("POST", draft)),
  update: (id: number, draft: PromptSkillDraft) => http<PromptSkill>(skillPath(id), json("PATCH", draft)),
  remove: (id: number) => http<{ deleted: number }>(skillPath(id), { method: "DELETE" }),
  /** 内置那条回到出厂写法；自己建的那条没有默认可回，后端会顶 409 */
  restoreDefault: (id: number) => http<PromptSkill>(`${skillPath(id)}/restore-default`, json("POST", {})),
  /**
   * 桌面版那一个入口：挑中的或拖进来的路径，md、.zip、一整个目录都从这儿走。
   *
   * 挑中的是 SKILL.md 时后端会连着它所在的整包一起收——那才是完整的一条技能。
   */
  importPaths: (paths: string[], onConflict: SkillConflictMode = "ask") =>
    http<SkillImportResult>(
      "/api/prompt-skills/import-path",
      json("POST", { paths, on_conflict: onConflict }),
    ),
  /** 浏览器版：读到的一份 md 原文。截断规则只在后端一处，这里不许先切一刀。 */
  importMarkdown: (filename: string, content: string, onConflict: SkillConflictMode = "ask") =>
    http<SkillImportResult>(
      "/api/prompt-skills/import",
      json("POST", { filename, content, on_conflict: onConflict }),
    ),
  /** 浏览器版上传的 .zip：multipart，后端从内存里读，不落临时文件 */
  importArchive: (file: File | Blob, filename: string, onConflict: SkillConflictMode = "ask") => {
    const form = new FormData();
    form.append("file", file, filename);
    form.append("on_conflict", onConflict);
    return http<SkillImportResult>("/api/prompt-skills/import-archive", { method: "POST", body: form });
  },
  /** 浏览器版选文件夹：前端读好的文本内容（二进制读不成文字，进不来） */
  importPackageUpload: (root: string, files: { path: string; content: string }[], onConflict: SkillConflictMode = "ask") =>
    http<SkillImportResult>(
      "/api/prompt-skills/import-package/upload",
      json("POST", { root, files, on_conflict: onConflict }),
    ),
  /** 一条技能背后的包：文件清单与元数据 */
  packageDetail: (id: number) =>
    http<{ id: number; source: string; package_dir: string | null; package: PromptSkillPackage | null }>(
      `${skillPath(id)}/package`,
    ),
  settings: () => http<PromptSkillSettings>("/api/prompt-skill-settings"),
  saveSettings: (value: PromptSkillSettings) =>
    http<PromptSkillSettings>("/api/prompt-skill-settings", json("PUT", value)),
  /** signal 是给「取消」用的：只断前端这一头的等待，服务端那次调用该跑完还是跑完 */
  optimize: (
    id: number,
    // context 是弹窗上选定的旋钮（戏种、武打速度、时长、比例），见 clone.ts 的 controlContextLine。
    // 可选：技能管理弹窗那条不经过工作流弹窗，本来就没有这些东西可选
    body: { prompt: string; kind: PromptSkillKind; refs: OptimizeRef[]; context?: string },
    signal?: AbortSignal,
  ) => http<OptimizeResult>(`${skillPath(id)}/optimize`, { ...json("POST", body), signal }),
  /**
   * 提示词框右下角那颗中英互译：一次调用换一种语言，不带技能、不落库。
   *
   * 为什么不缓存译文：那颗按钮是「译文 ↔ 原文」来回切，第三下要重新翻。人在中间是会改字的，
   * 读缓存等于把旧译文扣在新原文上。
   */
  translate: (text: string, signal?: AbortSignal) =>
    http<TranslateResult>("/api/translate-prompt", { ...json("POST", { text }), signal }),
};

export const promptSkills = writable<PromptSkill[]>([]);
export const promptSkillSettings = writable<PromptSkillSettings | null>(null);

/**
 * 清单拿回来同时留一份同步可读的：右键菜单要在 pointerdown 那一刻现算，
 * 不能等 promise；store 那份留给界面响应式用。失败时不置 loaded，下一次点还能重试。
 */
let snapshot: PromptSkill[] = [];
let snapshotSettings: PromptSkillSettings | null = null;
promptSkills.subscribe((value) => {
  snapshot = value;
});
promptSkillSettings.subscribe((value) => {
  snapshotSettings = value;
});
let loaded = false;

export async function loadPromptSkills(force = false): Promise<PromptSkill[]> {
  if (loaded && !force) return snapshot;
  const [list, settings] = await Promise.all([promptSkillsApi.list(), promptSkillsApi.settings()]);
  promptSkills.set(list);
  promptSkillSettings.set(settings);
  loaded = true;
  return list;
}

/** 单测与状态复位用：清掉「已经拉过一次」这件事。 */
export function resetPromptSkills(): void {
  loaded = false;
  promptSkills.set([]);
  promptSkillSettings.set(null);
}

export function skillsForKind(kind: PromptSkillKind): PromptSkill[] {
  return snapshot.filter((item) => item.kinds.includes(kind));
}

export function defaultSkillId(kind: PromptSkillKind): number | null {
  if (!snapshotSettings) return null;
  return kind === "video" ? snapshotSettings.default_video_skill : snapshotSettings.default_image_skill;
}

/** 设某一族的默认技能。先落本地再写库：菜单勾子必须立刻跟着走，不该等一次网络往返。 */
export async function setDefaultSkill(kind: PromptSkillKind, skillId: number | null): Promise<PromptSkillSettings> {
  const current = snapshotSettings ?? { default_image_skill: null, default_video_skill: null };
  const next: PromptSkillSettings =
    kind === "video"
      ? { ...current, default_video_skill: skillId }
      : { ...current, default_image_skill: skillId };
  promptSkillSettings.set(next);
  const saved = await promptSkillsApi.saveSettings(next);
  promptSkillSettings.set(saved);
  return saved;
}

/** 点左键该用哪一条：这一族的默认还在就用它，否则退回这一族的第一条——点了得有反应。 */
export function pickSkillFor(kind: PromptSkillKind): PromptSkill | null {
  const list = skillsForKind(kind);
  const wanted = defaultSkillId(kind);
  return list.find((item) => item.id === wanted) ?? list[0] ?? null;
}

/**
 * 提示词里的引用标记，按 @图片N / <Picture N> / 图N 三种写法认。
 *
 * 形状与 clone.ts 的 mentionChunks 同源（那边只管高亮，这边要拿去比对），改一边必须同步另一边：
 * 漏一种写法＝模型把它改写掉也查不出来，而「参考不生效」是不报错的。
 * 最后那条裸 图N 是给云端 Seedream 那类标签用的（它的 tag 就是 图1）。
 */
const MARK_RE =
  /@\s*(?:图片|图像|图|音频|音|视频|片|image|video|audio|picture)\s*\d+|<\s*(?:picture|video|audio)\s*\d+\s*>|(?<![@\w])(?:图片|图像|视频|音频|图)\s*\d+/gi;

/**
 * 一条标记折成「哪一族、第几格」。
 *
 * 为什么折到格子而不是照字面比：@图片1、图1、<Picture 1> 是同一格参考的三种写法（本地工作流用
 * @图片N，H3 那类只认 <Picture N>，云端 Seedream 的标签就是 图N）。模型把它们互相换一下写法，
 * 指的还是那一格参考，不算丢；整格没了或者编号错了才是事故。
 */
function markKey(mark: string): string {
  const text = mark.toLowerCase();
  // 图片那一族先判：「图片」里也带一个「片」字，后判就会把 图1 折到视频那一族去。
  const family = /图|image|picture/.test(text) ? "image" : /audio|音频|音/.test(text) ? "audio" : "video";
  return family + ((text.match(/\d+/) ?? ["0"])[0]);
}

/** 原句里点到过哪几格参考，每种写法留一句原样（报错时要照人自己打的字念给他听）。 */
export function promptMarks(text: string): string[] {
  const seen = new Map<string, string>();
  for (const match of text.matchAll(MARK_RE)) {
    const key = markKey(match[0]);
    if (!seen.has(key)) seen.set(key, match[0]);
  }
  return [...seen.values()];
}

/**
 * 优化结果弄丢了哪几格。只查「原来点过的还在不在」，不管模型新点了什么：
 * 多一个记号顶多是句废话，少一格是参考静默失效，两边后果不对等。
 */
export function missingMarks(original: string, result: string): string[] {
  const got = new Set(promptMarks(result).map(markKey));
  return promptMarks(original).filter((mark) => !got.has(markKey(mark)));
}

/**
 * 正文主体语言：中日韩字符比拉丁字母多就算中文。
 *
 * 判法与后端 video_prompts.dominant_language 同源（连字符区间一起抄），两边各判一次就会
 * 出现「悬停写着译成英文、点下去翻成中文」。
 */
const CJK_CHARS = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
const LATIN_LETTERS = /[A-Za-z]/g;

export function dominantLanguage(text: string): TranslateLanguage {
  return (text.match(CJK_CHARS)?.length ?? 0) > (text.match(LATIN_LETTERS)?.length ?? 0) ? "zh" : "en";
}

/** 要翻成哪一种：与正文主体相反的那一种。 */
export function targetLanguage(text: string): TranslateLanguage {
  return dominantLanguage(text) === "zh" ? "en" : "zh";
}

/**
 * 六段段名：本地工作流是按这些名字往节点里填词的，被译成「详细描述：」就等于那一格没吃到东西。
 * 大小写照后端原样比——段名就是键名，不是给人读的句子。
 */
const SECTION_NAMES = [
  "subject_definitions:", "summary:", "retention_analysis:",
  "detailed_description:", "overall_soundscape:", "non_diegetic_music:",
];

/**
 * 译文把哪几处结构弄丢了，报给人看的名字。
 *
 * 翻译比优化更容易犯的错在这儿：missingMarks 管的是参考编号（丢了＝参考静默失效），
 * 而把段名一起译了、把 <d> 那一整块台词删了、少了 [Shot 3]，模型照样回得漂漂亮亮。
 * 只查「有没有变少」不查变多：多一个标号是废话，少一段是缺料，两边后果不对等。
 */
export function missingStructure(original: string, result: string): string[] {
  const lost = SECTION_NAMES.filter((name) => result.split(name).length < original.split(name).length);
  const counting: Array<[RegExp, string]> = [
    [/\[\s*(?:shot|镜头)\s*\d+\s*\]/gi, "镜头标号"],
    [/<d>/gi, "<d> 台词块"],
  ];
  for (const [re, label] of counting) {
    if ((result.match(re)?.length ?? 0) < (original.match(re)?.length ?? 0)) lost.push(label);
  }
  return lost;
}
