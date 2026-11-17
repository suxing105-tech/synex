import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { get } from "svelte/store";
import PromptSkillModal from "../components/PromptSkillModal.svelte";
import { clearToasts, toasts } from "../lib/toast";
import { subscribeFileDrop } from "../lib/native-drop";
import { promptSkills, promptSkillSettings, resetPromptSkills, type PromptSkill } from "../lib/prompt-skills";

/**
 * 技能管理弹窗那一层：清单、编辑器、设默认、导入、删除。
 *
 * 弹窗自己不去拉清单（清单是点提示词框那颗按钮时懒加载进来的），所以路由表里本来就不该有
 * GET /api/prompt-skills——真多打了会被「未预演的接口」顶出来，这条约定就钉在这里。
 */
const http = vi.fn();
vi.mock("../lib/api", () => ({
  http: (path: string, init?: RequestInit) => (globalThis as any).__http(path, init),
}));
(globalThis as any).__http = http;

// 桌面壳那层在这个文件里要能切换：同一颗「导入技能」是走原生文件框还是走浏览器文件框，看 isTauri。
vi.mock("../lib/tauri", () => ({
  isTauri: () => (globalThis as any).__tauri.isTauri,
  selectSkillSourcePath: () => (globalThis as any).__tauri.pickDir(),
  selectImportDirectory: async () => null,
  selectTextPaths: async () => [],
  getSidecarStatus: async () => null,
  onSidecarReady: async () => () => {},
  onSidecarDied: async () => () => {},
  restartSidecar: async () => null,
}));
(globalThis as any).__tauri = { isTauri: false, pickDir: async () => null };

// 拖放事件本身由 native-drop 那把标尺管，这里有专门两条用例现拿它的回调，
// 其余用例只要它别真去挂原生监听。
vi.mock("../lib/native-drop", () => ({ subscribeFileDrop: vi.fn(() => () => {}) }));

/** 按「METHOD 路径」预演，长的键先匹配：PATCH 与 POST 落在同一个前缀上。 */
function routes(map: Record<string, unknown>) {
  http.mockImplementation(async (path: string, init?: RequestInit) => {
    const key0 = (init?.method ?? "GET") + " " + path;
    for (const key of Object.keys(map).sort((a, b) => b.length - a.length)) {
      if (!key0.startsWith(key)) continue;
      const value = map[key];
      return typeof value === "function" ? (value as (i?: RequestInit) => unknown)(init) : value;
    }
    throw new Error("未预演的接口：" + key0);
  });
}

function skill(over: Partial<PromptSkill> = {}): PromptSkill {
  return {
    id: 1, name: "镜头补全", note: "只补镜头与光影", kinds: ["image"], instruction: "补上景别与光影",
    language: "auto", with_refs: true, builtin_key: null, sort: 0, created_at: "", updated_at: "",
    source: "manual", package_dir: null, package: null,
    ...over,
  };
}

const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body));
const keyOf = (entry: unknown[]) =>
  ((entry[1] as RequestInit | undefined)?.method ?? "GET") + " " + entry[0];
const call = (method: string, path: string) =>
  http.mock.calls.find((entry) => keyOf(entry) === method + " " + path);
/** 同一个入口重发时看最后一次：第一次是「先问」，那一次的 body 不是结论。 */
const lastCall = (method: string, path: string) => {
  const hits = http.mock.calls.filter((entry) => keyOf(entry) === method + " " + path);
  return hits[hits.length - 1];
};

/** 后端那个回执的形状：进了几条、哪几条在问、哪些没进来。 */
const envelope = (item: unknown, skipped: { path: string; reason: string }[] = []) => ({
  imported: [item], conflicts: [], skipped,
});
const CLASH = [{ name: "电商视觉包", source_dir: "C:/skills/shop", existing_id: 7, existing_name: "电商视觉包" }];

const baseRoutes = () => ({
  // 脚下那句「现在吃的是哪家哪个模型」读的是反推那一份配置
  "GET /api/reverse-prompt-settings": { default_model_id: 3, instruction: "", default_instruction: "" },
  "GET /api/model-configs": [
    { id: 3, name: "智谱", base_url: "https://api.example.com", model: "glm-4v", timeout: 60, provider: null, has_api_key: true, key_persistence: "encrypted" },
  ],
  "PUT /api/prompt-skill-settings": (init?: RequestInit) => bodyOf(init),
});

beforeEach(() => {
  http.mockReset();
  vi.mocked(subscribeFileDrop).mockImplementation(() => () => {});
  clearToasts();
  promptSkills.set([
    skill(),
    skill({ id: 2, name: "分镜脚本", kinds: ["video"], instruction: "按镜头分段", builtin_key: "video_default" }),
  ]);
  promptSkillSettings.set({ default_image_skill: 1, default_video_skill: 2 });
});

afterEach(() => {
  cleanup();
  resetPromptSkills();
  clearToasts();
});

async function ready() {
  const screen = render(PromptSkillModal, { open: true, onClose: () => {} });
  await screen.findByRole("option", { name: /镜头补全/ });
  return screen;
}

describe("清单与编辑器", () => {
  it("两条技能都在清单里，默认、族和内置各标各的，选中那条的内容落进编辑器", async () => {
    routes(baseRoutes());
    const screen = await ready();
    expect(screen.getByRole("option", { name: /镜头补全/ }).textContent).toContain("图片默认");
    expect(screen.getByRole("option", { name: /分镜脚本/ }).textContent).toContain("视频默认");
    expect(screen.getByRole("option", { name: /分镜脚本/ }).textContent).toContain("内置");
    expect((screen.getByLabelText("技能名字") as HTMLInputElement).value).toBe("镜头补全");
    expect((screen.getByLabelText("技能写法") as HTMLTextAreaElement).value).toBe("补上景别与光影");
  });

  it("没动手时保存是灰的；改完点保存走 PATCH，store 与脚下那句跟着走", async () => {
    routes({ ...baseRoutes(), "PATCH /api/prompt-skills/1": (init?: RequestInit) => ({ ...skill(), ...bodyOf(init) }) });
    const screen = await ready();
    const save = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await fireEvent.input(screen.getByLabelText("技能名字"), { target: { value: "只补镜头" } });
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    await vi.waitFor(() => expect(call("PATCH", "/api/prompt-skills/1")).toBeTruthy());
    expect(bodyOf(call("PATCH", "/api/prompt-skills/1")?.[1] as RequestInit).name).toBe("只补镜头");
    expect(get(promptSkills)[0].name).toBe("只补镜头");
    expect((await screen.findByText(/智谱 · glm-4v/)).textContent).toContain("反推提示词");
  });

  it("切换选中项时编辑器跟着换那一条，不串上一位的草稿", async () => {
    routes(baseRoutes());
    const screen = await ready();
    const box = screen.getByLabelText("技能写法") as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: "改过还没保存" } });
    // 换选中再换回来：编辑位永远显示当前这条的内容，改过没保存的那份不该留在下一格上
    await fireEvent.click(screen.getByRole("option", { name: /分镜脚本/ }));
    expect(box.value).toBe("按镜头分段");
    await fireEvent.click(screen.getByRole("option", { name: /镜头补全/ }));
    expect(box.value).toBe("补上景别与光影");
  });

  it("两族都不勾就不发请求，错留在弹窗里", async () => {
    routes(baseRoutes());
    const screen = await ready();
    // 选中的这条本来只管图片：勾掉图片，两族就都不勾了
    expect((screen.getByLabelText(/视频/) as HTMLInputElement).checked).toBe(false);
    await fireEvent.click(screen.getByLabelText(/图片/) as HTMLInputElement);
    await fireEvent.input(screen.getByLabelText("技能名字"), { target: { value: "谁都不管" } });
    await fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain("至少勾一族");
    expect(call("PATCH", "/api/prompt-skills/1")).toBeFalsy();
  });
});

describe("设默认 · 导入 · 删除", () => {
  it("设为视频默认：PUT 带上整份默认值，清单上的勾跟着挪", async () => {
    // 管两族的那条才有资格当视频默认，所以这一条得专门造一条给它
    promptSkills.set([
      skill(),
      skill({ id: 2, name: "分镜脚本", kinds: ["video"], builtin_key: "video_default" }),
      skill({ id: 3, name: "通吃两族", kinds: ["image", "video"] }),
    ]);
    routes(baseRoutes());
    const screen = await ready();
    await fireEvent.click(screen.getByRole("option", { name: /通吃两族/ }));
    await fireEvent.click(screen.getByRole("button", { name: "设为视频默认" }));
    await vi.waitFor(() => expect(call("PUT", "/api/prompt-skill-settings")).toBeTruthy());
    expect(bodyOf(call("PUT", "/api/prompt-skill-settings")?.[1] as RequestInit)).toEqual({
      default_image_skill: 1, default_video_skill: 3,
    });
    await vi.waitFor(() =>
      expect(screen.getByRole("option", { name: /通吃两族/ }).textContent).toContain("视频默认"));
    await vi.waitFor(() =>
      expect(screen.getByRole("option", { name: /分镜脚本/ }).textContent).not.toContain("视频默认"));
  });

  it("这条技能不管视频时，「设为视频默认」点不动", async () => {
    routes(baseRoutes());
    const screen = await ready();
    expect((screen.getByRole("button", { name: "设为视频默认" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("浏览器版挑 md：交原文给后端，回来的那条直接进清单并被选中", async () => {
    routes({
      ...baseRoutes(),
      "POST /api/prompt-skills/import": (init?: RequestInit) =>
        envelope({
          ...skill({ id: 9, name: "导入的技能", kinds: ["image", "video"], instruction: bodyOf(init).content }),
        }),
    });
    const screen = await ready();
    const input = screen.container.querySelector(".psk-file") as HTMLInputElement;
    const file = new File(["# 写法\n正文很细"], "SKILL.md");
    Object.defineProperty(file, "text", { value: async () => "# 写法\n正文很细" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await fireEvent.change(input);
    await vi.waitFor(() => expect(call("POST", "/api/prompt-skills/import")).toBeTruthy());
    const sent = bodyOf(call("POST", "/api/prompt-skills/import")?.[1] as RequestInit);
    expect(sent.filename).toBe("SKILL.md");
    // 头一次一律「先问」：撞不撞名归后端判断，前端不许替人挑一个默认处理
    expect(sent.on_conflict).toBe("ask");
    await vi.waitFor(() => expect((screen.getByLabelText("技能名字") as HTMLInputElement).value).toBe("导入的技能"));
    expect(get(promptSkills).map((item) => item.name)).toContain("导入的技能");
  });

  it("浏览器版挑 .zip：走 multipart，不在前端读成正文", async () => {
    routes({ ...baseRoutes(), "POST /api/prompt-skills/import-archive": () => envelope(skill({ id: 8 })) });
    const screen = await ready();
    const input = screen.container.querySelector(".psk-file") as HTMLInputElement;
    const zip = new File([new Uint8Array([80, 75, 3, 4])], "技能包.zip");
    Object.defineProperty(input, "files", { value: [zip], configurable: true });
    await fireEvent.change(input);
    await vi.waitFor(() => expect(call("POST", "/api/prompt-skills/import-archive")).toBeTruthy());
    const form = (call("POST", "/api/prompt-skills/import-archive")?.[1] as RequestInit).body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get("file") as File).name).toBe("技能包.zip");
    expect(form.get("on_conflict")).toBe("ask");
  });

  it("内置那条只给恢复默认、不给删除；恢复之后编辑器里是出厂写法", async () => {
    routes({ ...baseRoutes(), "POST /api/prompt-skills/2/restore-default": { ...skill({ id: 2, name: "分镜脚本", kinds: ["video"], instruction: "出厂那段写法", builtin_key: "video_default" }) } });
    const screen = await ready();
    await fireEvent.click(screen.getByRole("option", { name: /分镜脚本/ }));
    // 内置那条改得、退得，就是删不得：删了别人的库里就少一条出厂技能
    expect(screen.queryByRole("button", { name: /删除这条技能/ })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "恢复默认写法" }));
    await vi.waitFor(() => expect((screen.getByLabelText("技能写法") as HTMLTextAreaElement).value).toBe("出厂那段写法"));
    expect(get(promptSkills)[1].instruction).toBe("出厂那段写法");
  });

  it("删除分两步：第一下只把按钮变成「确认删除」，第二下才真删", async () => {
    routes({ ...baseRoutes(), "DELETE /api/prompt-skills/1": { deleted: 1 } });
    const screen = await ready();
    await fireEvent.click(screen.getByRole("option", { name: /镜头补全/ }));
    const del = screen.getByRole("button", { name: "删除这条技能" });
    await fireEvent.click(del);
    expect(call("DELETE", "/api/prompt-skills/1")).toBeFalsy();
    await fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await vi.waitFor(() => expect(call("DELETE", "/api/prompt-skills/1")).toBeTruthy());
    await vi.waitFor(() => expect(get(promptSkills).map((item) => item.id)).toEqual([2]));
    // 剩下那条自动接上编辑位
    await vi.waitFor(() => expect((screen.getByLabelText("技能名字") as HTMLInputElement).value).toBe("分镜脚本"));
  });

  it("后端顶回来的中文 detail 直接落在弹窗里，不另挑一句官话", async () => {
    routes({
      ...baseRoutes(),
      "PATCH /api/prompt-skills/1": () => {
        throw Object.assign(new Error("422"), { detail: "技能写法最长 300000 字，太长的指令模型记不住" });
      },
    });
    const screen = await ready();
    await fireEvent.input(screen.getByLabelText("技能写法"), { target: { value: "长" } });
    await fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain("太长的指令模型记不住");
    expect(get(toasts)).toHaveLength(0);
  });

  it("成功才报喜：保存成功那句进提示队列", async () => {
    routes({ ...baseRoutes(), "PATCH /api/prompt-skills/1": (init?: RequestInit) => ({ ...skill(), ...bodyOf(init) }) });
    const screen = await ready();
    await fireEvent.input(screen.getByLabelText("技能名字"), { target: { value: "换个名" } });
    await fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => expect(get(toasts).map((item) => item.message)).toContain("已保存「换个名」"));
  });
});

describe("版面口径", () => {
  it("标题下不再摆那句操作说明", async () => {
    routes(baseRoutes());
    const screen = await ready();
    expect(screen.queryByText(/左键点提示词框右下角/)).toBeNull();
    expect(readFileSync("src/components/PromptSkillModal.svelte", "utf8")).not.toMatch(/左键点提示词框右下角/);
  });

  it("新建 / 导入在清单顶上，且是描过 accent 的那颗，不是藏在清单底下的灰按钮", async () => {
    routes(baseRoutes());
    const screen = await ready();
    const side = screen.container.querySelector(".psk-side") as HTMLElement;
    expect(side.firstElementChild?.className).toContain("psk-side-actions");
    expect(side.querySelector(".psk-list")).toBeTruthy();
    for (const name of ["新建技能", "导入技能"]) {
      const btn = screen.getByRole("button", { name });
      expect(btn.classList.contains("is-lead")).toBe(true);
      expect(side.querySelector(".psk-side-actions")?.contains(btn)).toBe(true);
    }
  });

  it("新建与导入排在同一行：左右各占一半、文字居中", async () => {
    routes(baseRoutes());
    const screen = await ready();
    const actions = screen.container.querySelector(".psk-side-actions") as HTMLElement;
    for (const name of ["新建技能", "导入技能"]) {
      expect(actions.contains(screen.getByRole("button", { name }))).toBe(true);
    }
    const source = readFileSync("src/components/PromptSkillModal.svelte", "utf8");
    const box = source.match(/\.psk-side-actions \{[^}]*\}/)?.[0] ?? "";
    expect(box, "两个入口的容器样式没找到").not.toBe("");
    expect(box, "容器不许再竖排：两颗入口要占同一行").not.toMatch(/flex-direction:\s*column/);
    expect(box, "第三颗（浏览器版的选文件夹）要能换行").toMatch(/flex-wrap:\s*wrap/);
    const lead = source.match(/\.psk-side-actions \.psk-btn \{[^}]*\}/)?.[0] ?? "";
    expect(lead, "两颗按钮没有各占一半的规则").not.toBe("");
    expect(lead).toMatch(/flex:\s*1 1 calc\(50%/);
    expect(lead, "文字要居中，不再顶着左边").toMatch(/justify-content:\s*center/);
    expect(lead).toMatch(/text-align:\s*center/);
  });

  it("保存排在最后一排的最右，不跟辅助操作挤在一起", async () => {
    routes(baseRoutes());
    const screen = await ready();
    const foot = screen.container.querySelector(".psk-edit-foot") as HTMLElement;
    const buttons = [...foot.querySelectorAll("button")];
    expect(buttons[buttons.length - 1].textContent).toBe("保存");
    // 右对齐写在样式里，DOM 层面只能确认它是这一排的最后一颗
    expect(readFileSync("src/components/PromptSkillModal.svelte", "utf8"))
      .toMatch(/\.psk-edit-foot \.psk-btn\.is-primary \{ margin-left: auto; \}/);
  });

  it("技能原文整篇摆在编辑区，标题边上跟着它的字数", async () => {
    const long = "保留主体，补上景别。".repeat(3000);
    promptSkills.set([skill({ instruction: long })]);
    routes(baseRoutes());
    const screen = await ready();
    const text = screen.getByLabelText("技能写法") as HTMLTextAreaElement;
    expect(text.value).toBe(long);
    expect(text.value).not.toMatch(/技能原文过长/);
    expect(screen.container.querySelector(".psk-count")?.textContent).toBe(long.length + " 字");
  });

  it("字号只引 token、颜色不新增裸 hex：新组件一条 hex 都不许写", () => {
    const source = readFileSync("src/components/PromptSkillModal.svelte", "utf8");
    expect(source.match(/#[0-9a-fA-F]{3,8}\b/g) || []).toEqual([]);
    expect(source).toMatch(/font-size:\s*var\(--fs-/);
  });
});

describe("导入技能：一个入口", () => {
  const packageSkill = (over: Partial<PromptSkill> = {}) =>
    skill({
      id: 7,
      name: "电商视觉包",
      source: "package",
      package_dir: "D:/data/skills/7",
      package: {
        root: "电商视觉包",
        source_dir: "C:/skills/shop",
        description: "影驰电商主图写法",
        license: "MIT",
        allowed_tools: [],
        version: "",
        extra_fields: {},
        files: [
          { path: "SKILL.md", size: 120, role: "写法", included: false, truncated: false, reason: "就是这条技能的写法", order: 0 },
          { path: "references/style.md", size: 80, role: "参考", included: true, truncated: false, reason: "", order: 1 },
          { path: "assets/palette.png", size: 900, role: "资源", included: false, truncated: false, reason: "二进制文件，不发给模型", order: 0 },
        ],
        refs_chars: 80,
        dropped: ["assets/palette.png"],
      },
      ...over,
    });

  it("桌面版：那颗「导入技能」走原生文件框，路径整条交给后端按路径扫", async () => {
    (globalThis as any).__tauri = { isTauri: true, pickDir: async () => "C:/skills/shop" };
    routes({ ...baseRoutes(), "POST /api/prompt-skills/import-path": () => envelope(packageSkill()) });
    const screen = await ready();
    await fireEvent.click(screen.getByRole("button", { name: "导入技能" }));
    await vi.waitFor(() => expect(call("POST", "/api/prompt-skills/import-path")).toBeTruthy());
    expect(bodyOf(call("POST", "/api/prompt-skills/import-path")?.[1] as RequestInit)).toEqual({
      paths: ["C:/skills/shop"], on_conflict: "ask",
    });
    await vi.waitFor(() => expect((screen.getByLabelText("技能名字") as HTMLInputElement).value).toBe("电商视觉包"));
    expect(get(promptSkills).map((item) => item.name)).toContain("电商视觉包");
    // 一句回执把该说的都说了：进了哪条、参考资料带进几份、什么没进预算
    await vi.waitFor(() =>
      expect(get(toasts).map((item) => item.message)).toContain(
        "已导入技能「电商视觉包」，带进 1 份参考资料，1 个文件没进预算"));
  });

  it("桌面版不给「选文件夹」那颗：这里把目录直接拖进来", async () => {
    (globalThis as any).__tauri = { isTauri: true, pickDir: async () => null };
    routes(baseRoutes());
    const screen = await ready();
    expect(screen.queryByRole("button", { name: "选文件夹" })).toBeNull();
    expect(screen.getByRole("button", { name: "导入技能" })).toBeTruthy();
  });

  it("拖进来的路径整批交给后端，被它拒的那条连原因一起报出来", async () => {
    (globalThis as any).__tauri = { isTauri: true, pickDir: async () => null };
    let drop!: (paths: string[], point: { x: number; y: number } | null) => Promise<void>;
    vi.mocked(subscribeFileDrop).mockImplementation((_region, _hover, dropCb) => {
      drop = dropCb;
      return () => {};
    });
    routes({
      ...baseRoutes(),
      "POST /api/prompt-skills/import-path": () =>
        envelope(packageSkill(), [{ path: "C:/技能包.7z", reason: "这种压缩包得先解压成文件夹再导" }]),
    });
    const screen = await ready();
    await drop(["C:/skills/shop.zip", "C:/技能包.7z"], null);
    await vi.waitFor(() => expect(call("POST", "/api/prompt-skills/import-path")).toBeTruthy());
    expect(bodyOf(call("POST", "/api/prompt-skills/import-path")?.[1] as RequestInit)).toEqual({
      paths: ["C:/skills/shop.zip", "C:/技能包.7z"], on_conflict: "ask",
    });
    await vi.waitFor(() =>
      expect(get(toasts).map((item) => item.message).join("")).toContain("1 个没进来："));
    expect(get(toasts)[0].kind).toBe("error");
    expect(screen.getByText("references/style.md")).toBeTruthy();
  });

  it("拖的东西像是技能才描红：.zip 点亮，一堆图片不点亮", async () => {
    (globalThis as any).__tauri = { isTauri: true, pickDir: async () => null };
    let hover!: (count: number, paths: string[]) => void;
    vi.mocked(subscribeFileDrop).mockImplementation((_region, hoverCb, _dropCb) => {
      hover = hoverCb;
      return () => {};
    });
    routes(baseRoutes());
    const screen = await ready();
    const panel = screen.container.querySelector(".psk") as HTMLElement;
    hover(1, ["C:/skills/shop.zip"]);
    await vi.waitFor(() => expect(panel.className).toContain("is-dropping"));
    hover(2, ["C:/图/一张.png", "C:/图/两张.jpg"]);
    await vi.waitFor(() => expect(panel.className).not.toContain("is-dropping"));
    hover(0, []);
    expect(call("POST", "/api/prompt-skills/import-path")).toBeFalsy();
  });

  it("撞名时先问：问句挂着的时候库里一个字都没写", async () => {
    (globalThis as any).__tauri = { isTauri: true, pickDir: async () => "C:/skills/shop" };
    routes({
      ...baseRoutes(),
      "POST /api/prompt-skills/import-path": (init?: RequestInit) =>
        bodyOf(init).on_conflict === "ask" ? { imported: [], conflicts: CLASH, skipped: [] } : envelope(packageSkill()),
    });
    const screen = await ready();
    await fireEvent.click(screen.getByRole("button", { name: "导入技能" }));
    const bar = await screen.findByRole("group", { name: "已有同名技能" });
    expect(bar.textContent).toContain("已经有一条「电商视觉包」");
    expect(bar.textContent).toContain("就是这一份");
    expect(get(promptSkills).map((item) => item.id)).toEqual([1, 2]);
    expect(get(toasts)).toHaveLength(0);
    // 「先不动」只撤问句，不再打一次接口
    await fireEvent.click(screen.getByRole("button", { name: "先不动" }));
    await vi.waitFor(() => expect(screen.queryByRole("group", { name: "已有同名技能" })).toBeNull());
    expect(http.mock.calls.filter((entry) => keyOf(entry) === "POST /api/prompt-skills/import-path")).toHaveLength(1);
  });

  it("点「替换原来的」原样重发，编辑器里换成新写法", async () => {
    (globalThis as any).__tauri = { isTauri: true, pickDir: async () => "C:/skills/shop" };
    routes({
      ...baseRoutes(),
      "POST /api/prompt-skills/import-path": (init?: RequestInit) =>
        bodyOf(init).on_conflict === "ask"
          ? { imported: [], conflicts: CLASH, skipped: [] }
          : envelope(packageSkill({ instruction: "改过的写法" })),
    });
    const screen = await ready();
    await fireEvent.click(screen.getByRole("button", { name: "导入技能" }));
    await screen.findByRole("group", { name: "已有同名技能" });
    await fireEvent.click(screen.getByRole("button", { name: "替换原来的" }));
    await vi.waitFor(() =>
      expect((screen.getByLabelText("技能写法") as HTMLTextAreaElement).value).toBe("改过的写法"));
    // 重发的是原样那一次，只换了「怎么办」那一参
    expect(bodyOf(lastCall("POST", "/api/prompt-skills/import-path")?.[1] as RequestInit)).toEqual({
      paths: ["C:/skills/shop"], on_conflict: "replace",
    });
    expect(get(promptSkills).map((item) => item.id)).toEqual([1, 2, 7]);
  });

  it("点「另存为新的」按新条目落库，不动库里那条", async () => {
    (globalThis as any).__tauri = { isTauri: true, pickDir: async () => "C:/skills/shop" };
    routes({
      ...baseRoutes(),
      "POST /api/prompt-skills/import-path": (init?: RequestInit) =>
        bodyOf(init).on_conflict === "ask"
          ? { imported: [], conflicts: CLASH, skipped: [] }
          : envelope(packageSkill({ id: 11, instruction: "另存的一份" })),
    });
    const screen = await ready();
    await fireEvent.click(screen.getByRole("button", { name: "导入技能" }));
    await screen.findByRole("group", { name: "已有同名技能" });
    await fireEvent.click(screen.getByRole("button", { name: "另存为新的" }));
    await vi.waitFor(() => expect(get(promptSkills).map((item) => item.id)).toEqual([1, 2, 11]));
    expect(bodyOf(lastCall("POST", "/api/prompt-skills/import-path")?.[1] as RequestInit).on_conflict).toBe("new");
    expect(get(promptSkills).find((item) => item.id === 11)?.instruction).toBe("另存的一份");
  });

  it("浏览器版「选文件夹」：只送能读成文字的文件，带相对路径", async () => {
    (globalThis as any).__tauri = { isTauri: false, pickDir: async () => null };
    routes({ ...baseRoutes(), "POST /api/prompt-skills/import-package/upload": () => envelope(packageSkill()) });
    const screen = await ready();
    const inputs = screen.container.querySelectorAll(".psk-file");
    const dirInput = inputs[inputs.length - 1] as HTMLInputElement;
    const md = new File(["# 电商视觉包"], "SKILL.md");
    Object.defineProperty(md, "webkitRelativePath", { value: "shop/SKILL.md" });
    Object.defineProperty(md, "text", { value: async () => "# 电商视觉包" });
    const png = new File([new Uint8Array([1, 2, 3])], "palette.png", { type: "image/png" });
    Object.defineProperty(png, "webkitRelativePath", { value: "shop/assets/palette.png" });
    Object.defineProperty(png, "text", { value: async () => "binary" });
    Object.defineProperty(dirInput, "files", { value: [md, png], configurable: true });
    await fireEvent.click(screen.getByRole("button", { name: "选文件夹" }));
    await fireEvent.change(dirInput);
    await vi.waitFor(() => expect(call("POST", "/api/prompt-skills/import-package/upload")).toBeTruthy());
    const sent = bodyOf(call("POST", "/api/prompt-skills/import-package/upload")?.[1] as RequestInit);
    expect(sent.root).toBe("shop");
    expect(sent.on_conflict).toBe("ask");
    // 二进制发过去就是乱码，前端先筛掉
    expect(sent.files).toEqual([{ path: "shop/SKILL.md", content: "# 电商视觉包" }]);
  });

  it("包来源的技能：编辑区列出包内文件与它们的去处，并说明脚本不会执行", async () => {
    (globalThis as any).__tauri = { isTauri: true, pickDir: async () => null };
    promptSkills.set([skill(), packageSkill()]);
    routes(baseRoutes());
    const screen = await ready();
    await fireEvent.click(screen.getByRole("option", { name: /电商视觉包/ }));
    await vi.waitFor(() => expect(screen.getByText("references/style.md")).toBeTruthy());
    const block = screen.getByText("references/style.md").closest(".psk-pkg") as HTMLElement;
    expect(block.textContent).toContain("已带");
    // 三种角色各标各的：写法 / 参考 / 资源
    expect(block.textContent).toContain("写法");
    expect(block.textContent).toContain("资源");
    expect(block.textContent).toContain("脚本不会执行");
  });

  it("删技能包时先说清楚会连带删掉包内文件", async () => {
    (globalThis as any).__tauri = { isTauri: true, pickDir: async () => null };
    promptSkills.set([skill(), packageSkill()]);
    routes({ ...baseRoutes(), "DELETE /api/prompt-skills/7": { deleted: 7 } });
    const screen = await ready();
    await fireEvent.click(screen.getByRole("option", { name: /电商视觉包/ }));
    await fireEvent.click(screen.getByRole("button", { name: "删除这条技能" }));
    expect(screen.getByRole("button", { name: /连同包内文件/ })).toBeTruthy();
    expect(call("DELETE", "/api/prompt-skills/7")).toBeFalsy();
  });
});
