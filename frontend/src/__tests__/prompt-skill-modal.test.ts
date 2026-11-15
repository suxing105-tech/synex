import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { get } from "svelte/store";
import PromptSkillModal from "../components/PromptSkillModal.svelte";
import { clearToasts, toasts } from "../lib/toast";
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

// 桌面壳那层在这个文件里要能切换：导入技能包是走原生对话框还是走目录上传，就看 isTauri。
vi.mock("../lib/tauri", () => ({
  isTauri: () => (globalThis as any).__tauri.isTauri,
  selectSkillPackageDir: () => (globalThis as any).__tauri.pickDir(),
  selectImportDirectory: async () => null,
  selectTextPaths: async () => [],
  getSidecarStatus: async () => null,
  onSidecarReady: async () => () => {},
  onSidecarDied: async () => () => {},
  restartSidecar: async () => null,
}));
(globalThis as any).__tauri = { isTauri: false, pickDir: async () => null };

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
const call = (method: string, path: string) =>
  http.mock.calls.find((entry) => ((entry[1] as RequestInit | undefined)?.method ?? "GET") + " " + entry[0] === method + " " + path);

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

  it("导入 SKILL.md：交原文给后端，回来的那条直接进清单并被选中", async () => {
    routes({
      ...baseRoutes(),
      "POST /api/prompt-skills/import": (init?: RequestInit) => {
        const sent = bodyOf(init);
        return { ...skill({ id: 9, name: "导入的技能", kinds: ["image", "video"], instruction: sent.content }), truncated: false };
      },
    });
    const screen = await ready();
    const input = screen.container.querySelector(".psk-file") as HTMLInputElement;
    const file = new File(["# 写法\n正文很细"], "SKILL.md");
    Object.defineProperty(file, "text", { value: async () => "# 写法\n正文很细" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await fireEvent.change(input);
    await vi.waitFor(() => expect(call("POST", "/api/prompt-skills/import")).toBeTruthy());
    expect(bodyOf(call("POST", "/api/prompt-skills/import")?.[1] as RequestInit).filename).toBe("SKILL.md");
    await vi.waitFor(() => expect((screen.getByLabelText("技能名字") as HTMLInputElement).value).toBe("导入的技能"));
    expect(get(promptSkills).map((item) => item.name)).toContain("导入的技能");
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
        throw Object.assign(new Error("422"), { detail: "技能写法最长 20000 字，太长的指令模型记不住" });
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
  it("字号只引 token、颜色不新增裸 hex：新组件一条 hex 都不许写", () => {
    const source = readFileSync("src/components/PromptSkillModal.svelte", "utf8");
    expect(source.match(/#[0-9a-fA-F]{3,8}\b/g) || []).toEqual([]);
    expect(source).toMatch(/font-size:\s*var\(--fs-/);
  });
});

describe("导入技能包", () => {
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
        truncated: false,
        dropped: ["assets/palette.png"],
      },
      ...over,
    });

  it("桌面版：选文件夹后按路径交给后端，回来那条进清单并被选中", async () => {
    (globalThis as any).__tauri = { isTauri: true, pickDir: async () => "C:/skills/shop" };
    routes({
      ...baseRoutes(),
      "POST /api/prompt-skills/import-package": () => packageSkill(),
    });
    const screen = await ready();
    await fireEvent.click(screen.getByRole("button", { name: "导入技能包" }));
    await vi.waitFor(() => expect(call("POST", "/api/prompt-skills/import-package")).toBeTruthy());
    expect(bodyOf(call("POST", "/api/prompt-skills/import-package")?.[1] as RequestInit)).toEqual({
      path: "C:/skills/shop",
    });
    await vi.waitFor(() => expect((screen.getByLabelText("技能名字") as HTMLInputElement).value).toBe("电商视觉包"));
    expect(get(promptSkills).map((item) => item.name)).toContain("电商视觉包");
  });

  it("浏览器版：目录上传只送能读成文字的文件，带相对路径", async () => {
    (globalThis as any).__tauri = { isTauri: false, pickDir: async () => null };
    routes({
      ...baseRoutes(),
      "POST /api/prompt-skills/import-package/upload": () => packageSkill(),
    });
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
    await fireEvent.click(screen.getByRole("button", { name: "导入技能包" }));
    await fireEvent.change(dirInput);
    await vi.waitFor(() => expect(call("POST", "/api/prompt-skills/import-package/upload")).toBeTruthy());
    const sent = bodyOf(call("POST", "/api/prompt-skills/import-package/upload")?.[1] as RequestInit);
    expect(sent.root).toBe("shop");
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
