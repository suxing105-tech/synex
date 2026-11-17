import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { get } from "svelte/store";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";
import ReversePromptPanel from "../components/ReversePromptPanel.svelte";
import ModelApiSettings from "../components/ModelApiSettings.svelte";
import { autoPickModel, clearAutoModelCache, reverseApi, reverseJobs, modelConfigs, reverseSettings, generateReverse, refreshReverseConfig } from "../lib/reverse-prompts";
import { copyText } from "../lib/ws";
import { toasts, clearToasts } from "../lib/toast";
import { cloudApi } from "../lib/clone";
// 面板还要用 dateTimeLabel（第三刀 T4 之后日期只有一支笔）：整模块 mock 会把它抹成 undefined，
// 所以铺开真实模块，只替换 copyText 这一颗
vi.mock("../lib/ws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ws")>()),
  copyText: vi.fn().mockResolvedValue(true),
}));

const model = { id: 1, name: "测试视觉", base_url: "https://example.com/v1", model: "vision", timeout: 120, provider: null, has_api_key: true, key_persistence: "encrypted" as const };
const preset = { id: "qwen", name: "通义千问 Qwen", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: [{ id: "qwen2.5-vl-72b-instruct", label: "Qwen2.5-VL-72B", recommended: true }], default_timeout: 120, note: "" };
// RunningHub：Key 与「再次创作」云端生成共用一把（credential_scope=cloud），清单由它自己报（models_dynamic）
const cloudPreset = {
  id: "runninghub", name: "RunningHub", base_url: "https://llm.runninghub.cn/v1", models: [],
  default_timeout: 120, note: "一把 Key 走天下：这里的 Key 与云端生成共用同一把", credential_scope: "cloud", models_dynamic: true,
};
const settings = { default_model_id: 1, instruction: "描述画面", default_instruction: "默认描述" };
/** 模型下拉右列当前显示的那几个名字。 */
const rows = (panel: { container: HTMLElement }) =>
  Array.from(panel.container.querySelectorAll(".mp-mname")).map(n => n.textContent?.trim());
/** 服务商选择页把下拉换成卡片网格了：点卡按 data-provider 拿，选中看 aria-pressed。 */
const pickProvider = async (panel: { container: HTMLElement }, id: string) => {
  const card = panel.container.querySelector(`[data-provider="${id}"]`) as HTMLButtonElement;
  expect(card, `没有这张服务商卡：${id}`).toBeTruthy();
  await fireEvent.click(card);
};
const pressedCard = (panel: { container: HTMLElement }) =>
  panel.container.querySelector(".api-card[aria-pressed='true']")?.getAttribute("data-provider") ?? "";
/**
 * 「模型API配置」这一页在读回来之前整张表单是禁用的（busy 从挂载起就是真），
 * 所以「处理中…」这句消失才是「可以动手了」。等某张 .api-card 存在不算判据：
 * 服务商清单是全局 store，上一条测试留下的值会让它在读盘之前就亮着（拆页时 10 条一起红）。
 */
const waitForReady = async (panel: { container: HTMLElement }) => {
  await waitFor(() => expect(panel.container.textContent).not.toContain("处理中"));
};
const record = { id: 10, image_id: 1, prompt_zh: "红色花朵", prompt_en: "red flower", raw_text: "", status: "complete" as const, source: "generated" as const, parent_id: null, model_name: "测试视觉", model: "vision", instruction: "", fingerprint: "abc", created_at: "2026-09-17T01:00:00Z" };

beforeEach(() => {
  reverseJobs.set({}); modelConfigs.set([model]); reverseSettings.set(settings); clearAutoModelCache();
  vi.spyOn(reverseApi, "models").mockResolvedValue([model]);
  vi.spyOn(reverseApi, "settings").mockResolvedValue(settings);
  vi.spyOn(reverseApi, "providers").mockResolvedValue([preset]);
  vi.spyOn(reverseApi, "configModels").mockResolvedValue({ models: [], source: "preset", reason: "" });
  vi.spyOn(reverseApi, "setModel").mockImplementation(async (id, value) => ({ ...model, id, model: value }));
  vi.spyOn(reverseApi, "checkKey").mockResolvedValue({ ok: true, count: 1, models: ["vision"], source: "live" });
  vi.spyOn(reverseApi, "history").mockResolvedValue({ items: [], total: 0, running: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("reverse prompts", () => {
  it("deduplicates requests and keeps completion attached to original image", async () => {
    let finish!: (value: typeof record) => void;
    const call = vi.spyOn(reverseApi, "generate").mockImplementation(() => new Promise(resolve => finish = resolve));
    const pending = generateReverse(1, 1, "vision");
    await generateReverse(1, 1, "vision");
    expect(call).toHaveBeenCalledTimes(1);
    expect(get(reverseJobs)[1].running).toBe(true);
    finish(record); await pending;
    expect(get(reverseJobs)[1].result?.image_id).toBe(1);
    expect(get(reverseJobs)[2]).toBeUndefined();
  });
  it("does not display image A response after selection changes to B", async () => {
    let finish!: (value: any) => void;
    vi.mocked(reverseApi.history).mockImplementation(id => id === 1 ? new Promise(resolve => finish = resolve) : Promise.resolve({ items: [], total: 0, running: false }));
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(finish).toBeDefined());
    await panel.rerender({ imageId: 2 });
    finish({ items: [record], total: 1, running: false });
    await waitFor(() => expect(panel.getByText("尚无反推记录，生成后会自动保存。")).toBeTruthy());
    expect(panel.queryByText("红色花朵")).toBeNull();
  });
  it("keeps history visible on failure and permits retry", async () => {
    vi.mocked(reverseApi.history).mockResolvedValue({ items: [record], total: 1, running: false });
    vi.spyOn(reverseApi, "generate").mockRejectedValue({ detail: "模型请求超时" });
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(panel.getByText("红色花朵")).toBeTruthy());
    await fireEvent.click(panel.getByText("重新反推"));
    await waitFor(() => expect(panel.getByRole("alert").textContent).toContain("模型请求超时"));
    expect(panel.getByText("红色花朵")).toBeTruthy();
    expect(panel.getByText("重新反推").hasAttribute("disabled")).toBe(false);
  });
  it("edits as a new version with the selected parent", async () => {
    vi.mocked(reverseApi.history).mockResolvedValue({ items: [record], total: 1, running: false });
    const edit = vi.spyOn(reverseApi, "edit").mockResolvedValue({ ...record, id: 11, parent_id: 10, source: "edited" });
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(panel.getByText("编辑")).toBeTruthy());
    await fireEvent.click(panel.getByText("编辑"));
    await fireEvent.input(panel.getByLabelText("编辑中文提示词"), { target: { value: "深红花朵" } });
    await fireEvent.click(panel.getByText("保存为新版本"));
    await waitFor(() => expect(edit).toHaveBeenCalledWith(1, 10, "深红花朵", "red flower"));
  });
  it("shows raw nonstandard text and provides history navigation", async () => {
    vi.mocked(reverseApi.history).mockResolvedValue({ items: [{ ...record, status: "unstructured", raw_text: "非标准原文" }], total: 1, running: false });
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(panel.getByText("非标准原文")).toBeTruthy());
    expect(panel.getByText("复制原文")).toBeTruthy();
    await fireEvent.click(panel.getByText("历史版本（1）"));
    expect(panel.getByLabelText("历史版本")).toBeTruthy();
  });
  it("删除历史版本要先确认一次，确认后刷新列表", async () => {
    const older = { ...record, id: 10, prompt_zh: "旧版花朵" };
    const newer = { ...record, id: 11, prompt_zh: "新版花朵" };
    vi.mocked(reverseApi.history).mockResolvedValue({ items: [newer, older], total: 2, running: false });
    const remove = vi.spyOn(reverseApi, "remove").mockResolvedValue({ deleted: 10, current: 11 });
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(panel.getByText("历史版本（2）")).toBeTruthy());
    await fireEvent.click(panel.getByText("历史版本（2）"));
    await fireEvent.click(panel.getByLabelText("删除版本 10"));
    expect(remove).not.toHaveBeenCalled();
    expect(panel.getByText("删除这版？")).toBeTruthy();
    await fireEvent.click(panel.getByLabelText("确认删除这一版"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(1, 10));
    expect(vi.mocked(reverseApi.history).mock.calls.length).toBeGreaterThan(1);
  });
  it("删掉屏幕上正看的那一版后自动回到最新版", async () => {
    const older = { ...record, id: 10, prompt_zh: "旧版花朵" };
    const newer = { ...record, id: 11, prompt_zh: "新版花朵" };
    let items = [newer, older];
    vi.mocked(reverseApi.history).mockImplementation(async () => ({ items, total: items.length, running: false }));
    vi.spyOn(reverseApi, "remove").mockImplementation(async (imageId, recordId) => {
      items = items.filter(item => item.id !== recordId);
      return { deleted: recordId, current: items[0]?.id ?? null };
    });
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(panel.getByText("历史版本（2）")).toBeTruthy());
    await fireEvent.click(panel.getByText("历史版本（2）"));
    await fireEvent.click(panel.getByLabelText("删除版本 11"));
    await fireEvent.click(panel.getByLabelText("确认删除这一版"));
    await waitFor(() => expect(panel.queryByText("新版花朵")).toBeNull());
    expect(panel.getByText("旧版花朵")).toBeTruthy();
  });
  it("switches one prompt between Chinese and English and copies either form from icon buttons", async () => {
    vi.mocked(reverseApi.history).mockResolvedValue({ items: [record], total: 1, running: false });
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(panel.getByLabelText("复制中文提示词")).toBeTruthy());
    await fireEvent.click(panel.getByLabelText("复制中文提示词"));
    expect(copyText).toHaveBeenLastCalledWith("红色花朵");
    expect(panel.getByLabelText("中文反推提示词").textContent).toBe("红色花朵");
    expect(panel.queryByLabelText("English reverse prompt")).toBeNull();
    await fireEvent.click(panel.getByRole("button", { name: "EN" }));
    expect(panel.getByLabelText("English reverse prompt").textContent).toBe("red flower");
    expect(panel.container.querySelector(".reverse-prompt-columns")).toBeNull();
    await fireEvent.click(panel.getByLabelText("复制双语提示词"));
    expect(copyText).toHaveBeenLastCalledWith("中文\n红色花朵\n\nEnglish\nred flower");
    expect(panel.getByText("历史版本（1）")).toBeTruthy();
    expect(panel.queryByText("展开全文")).toBeNull();
    expect(panel.container.querySelector(".prompt-copy")).toBeTruthy();
  });
  it("cancels edits without saving and disables empty versions", async () => {
    vi.mocked(reverseApi.history).mockResolvedValue({ items: [record], total: 1, running: false });
    const save = vi.spyOn(reverseApi, "edit");
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(panel.getByText("编辑")).toBeTruthy());
    await fireEvent.click(panel.getByText("编辑"));
    await fireEvent.input(panel.getByLabelText("编辑中文提示词"), { target: { value: "" } });
    expect(panel.getByText("保存为新版本").hasAttribute("disabled")).toBe(true);
    await fireEvent.click(panel.getByText("取消编辑"));
    expect(panel.getByText("红色花朵")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });
  it("routes unconfigured users to settings", async () => {
    modelConfigs.set([]); vi.mocked(reverseApi.models).mockResolvedValue([]);
    const listener = vi.fn(); window.addEventListener("open-model-settings", listener);
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await fireEvent.click(panel.getByText("配置模型"));
    expect(listener).toHaveBeenCalledOnce(); window.removeEventListener("open-model-settings", listener);
  });
  it("loads settings with no plaintext key and preserves an unchanged key", async () => {
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue(model);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "qwen");
    expect(panel.getByText("当前服务商：通义千问 Qwen")).toBeTruthy();
    expect((panel.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
    await fireEvent.click(panel.getByText("保存配置"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).not.toHaveProperty("api_key");
  });
  it("新建配置只有一个入口：厂商卡片就是入口，不再另摆一颗「＋ 添加模型」", async () => {
    // 点厂商卡片＝新建或打开那一份配置，「自定义（手动填写）」那张卡＝手动填 Base URL 的那一份。
    // 再留一颗「＋ 添加模型」是同一件事的第三个入口，被指「多余内容太多」，删掉并钉住。
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    expect(panel.queryByText("＋ 添加模型")).toBeNull();
    expect(panel.queryAllByRole("button", { name: /自定义（手动填写）/ })).toHaveLength(1);
  });

  it("已配置模型不在设置页顶部重复显示，文本厂商列表包含 MiniMax", async () => {
    vi.mocked(reverseApi.models).mockResolvedValue([
      { ...model, id: 1, name: "视觉配置", provider: "qwen", has_api_key: true },
    ]);
    vi.mocked(reverseApi.providers).mockResolvedValue([
      preset,
      { id: "minimax", name: "MiniMax", base_url: "https://api.minimax.cn/v1",
        models: [{ id: "MiniMax-M3.1-Flash", label: "MiniMax M3.1 Flash", recommended: true }],
        default_timeout: 600, capabilities: ["text", "image", "video", "audio"] },
    ]);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    expect(panel.queryByRole("button", { name: "视觉配置" })).toBeNull();
    await fireEvent.click(panel.getByRole("button", { name: "文本" }));
    expect(panel.container.querySelector('[data-provider="minimax"]')).toBeTruthy();
  });

  it("图像、视频、音频筛选都能选 MiniMax 并保存统一 API Key", async () => {
    const minimax = {
      id: "minimax", name: "MiniMax", base_url: "https://api.minimax.cn/v1",
      models: [
        { id: "MiniMax-H3-Image", label: "MiniMax-H3-Image", recommended: true },
        { id: "MiniMax-H3", label: "MiniMax-H3 视频", recommended: true },
        { id: "speech-2.8-hd", label: "Speech 2.8 HD", recommended: true },
      ],
      default_timeout: 600, capabilities: ["image", "video", "audio"], console_url: "https://platform.minimax.cn",
    };
    vi.mocked(reverseApi.providers).mockResolvedValue([preset, minimax]);
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue({
      ...model, id: 2, name: "MiniMax", base_url: minimax.base_url, model: "",
      provider: "minimax", has_api_key: true,
    });
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await fireEvent.click(panel.getByRole("button", { name: "图像" }));
    expect(panel.getByRole("button", { name: /MiniMax/ })).toBeTruthy();
    await fireEvent.click(panel.getByRole("button", { name: "视频" }));
    expect(panel.getByRole("button", { name: /MiniMax/ })).toBeTruthy();
    await fireEvent.click(panel.getByRole("button", { name: "音频" }));
    expect(panel.getByRole("button", { name: /MiniMax/ })).toBeTruthy();
    await fireEvent.click(panel.getByRole("button", { name: "图像" }));
    await pickProvider(panel, "minimax");
    // 2026-11-16 苏醒第二轮（MiniMax 那句一起删）：这一页除了填 Key 那几格，不再摆任何说明文字
    expect(panel.queryByText(/再次创作可用 MiniMax-H3-Image/)).toBeNull();
    expect(panel.queryByRole("button", { name: "检查 API Key" })).toBeNull();
    expect(panel.getByText("MiniMax API Key 会在再次创作生成时校验；这里不发试生成请求。")).toBeTruthy();
    await fireEvent.input(panel.getByLabelText("API Key"), { target: { value: "sk-minimax-test" } });
    await fireEvent.click(panel.getByText("保存配置"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({
      provider: "minimax", base_url: "https://api.minimax.cn/v1", api_key: "sk-minimax-test",
    });
  });

  it("选中的厂商卡片文字不许被全局按钮配色涂黑：选中态自己声明浅色", async () => {
    // 全局 .fill-interactions button[aria-pressed="true"] 是红底近黑字（给小胶囊用的）。
    // 卡片只覆盖了背景，文字会跟着被涂成 #0e0e10，压在自己的深红底上完全读不出来。
    const source = readFileSync("src/components/ModelApiSettings.svelte", "utf8").replace(/\r\n/g, "\n");
    const rule = source.match(/\.api-card\[aria-pressed="true"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("background");
    expect(rule).toMatch(/color:\s*#[def]/);
  });

  it("打开设置先落在已经配好 Key 的那家，但不自己拿真 Key 去拉清单", async () => {
    // 清单里排第一的是 OpenAI，而这里只有 RunningHub 配过 Key：默认摊开一张没配的 OpenAI
    // 表单，等于每个人进来都要重新找自己那家。
    // 同时「打开设置」不许替用户发外部请求：模型清单要现拉，但那一下归反推面板的模型下拉。
    vi.mocked(reverseApi.providers).mockResolvedValue([preset, { ...cloudPreset, shared_has_key: true }]);
    const list = vi.spyOn(reverseApi, "configModels");
    const panel = render(ModelApiSettings);
    await waitFor(() => expect(pressedCard(panel)).toBe("runninghub"));
    await pickProvider(panel, "runninghub");
    expect(list).not.toHaveBeenCalled();
    expect(panel.queryByLabelText("识别模型")).toBeNull();
  });

  it("非共用厂商点「清除」：即时删这条配置自己的 Key，不用先保存", async () => {
    // 走自己填的那一条：内置厂商那一侧已经没有地址格（见「不再摆高级设置」那条），
    // 要验的「删的是这条配置自己的 Key、且不顺手点保存」和厂商是谁没关系。
    const clear = vi.spyOn(reverseApi, "clearModelKey").mockResolvedValue({ ...model, has_api_key: false });
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue(model);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    expect(pressedCard(panel)).toBe("custom");
    await fireEvent.input(panel.getByLabelText("Base URL"), { target: { value: "https://example.com/v1/chat/completions/" } });
    expect(panel.getByText("请求地址：https://example.com/v1/chat/completions")).toBeTruthy();
    await fireEvent.click(panel.getByRole("button", { name: "清除这把 Key" }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith(1));
    expect(save).not.toHaveBeenCalled();
    expect(await panel.findByText(/这条配置的 Key 已清除/)).toBeTruthy();
  });
  it("Key 那一格留空点保存＝不换：请求体里连 api_key 这个键都不该出现", async () => {
    // 守的是最容易伤人的一种误伤：留空被当成删除，那改一次模型名就会把 Key 清掉
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue(model);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "qwen");
    await fireEvent.click(panel.getByText("保存配置"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect("api_key" in save.mock.calls[0][0]).toBe(false);
    expect("workflow_api_key" in save.mock.calls[0][0]).toBe(false);
  });
  it("Key 那一格不是 password：Chrome 不能把它当登录密码，自动填一串点进来装成已配置", async () => {
    // 苏醒真机就是这么被骗的：框里那串点是浏览器填的，键盘删干净以后库里那把一根毛都没动
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    const box = panel.getByLabelText("API Key") as HTMLInputElement;
    expect(box.type).toBe("text");
    expect(box.getAttribute("autocomplete")).toBe("off");
    expect(panel.container.textContent).not.toContain("清掉这把");
  });
  it("存 Key 不再要求先挑模型：preset 那张表单连 model 都不带", async () => {
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue({ ...model, provider: "qwen", name: "通义千问 Qwen", base_url: preset.base_url, model: "", has_api_key: true });
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "qwen");
    // Key 是入场券，用哪个模型是用的时候挑：这一页不该再留任何模型输入口
    expect(panel.queryByLabelText("识别模型")).toBeNull();
    expect(panel.queryByLabelText("模型 ID")).toBeNull();
    // 2026-11-16 第二轮（苏醒：这些说明文字不要在前端展示）：连「模型不用在这里选」这一句也不摆了，
    // 上面两条「没有模型输入口」就是这句话本来要传达的意思
    expect(panel.queryByText(/模型不用在这里选/)).toBeNull();
    await fireEvent.input(panel.getByLabelText("API Key"), { target: { value: "sk-123" } });
    await fireEvent.click(panel.getByText("保存配置"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ provider: "qwen", api_key: "sk-123" });
    expect("model" in save.mock.calls[0][0]).toBe(false);
  });
  it("厂商卡用真 LOGO，认不得的才回字母块：自定义那张还是＋", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([preset, cloudPreset]);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    // 通义千问在 brands 清单里 → 那张卡里是 <img>，src 指向随包的文件
    const qwen = panel.container.querySelector('[data-provider="qwen"]');
    expect(qwen?.querySelector(".brand-img")?.getAttribute("src")).toBe("/brands/qwen.svg");
    // RunningHub 没有 LOGO → 回字母块，不是空白
    const rh = panel.container.querySelector('[data-provider="runninghub"]');
    expect(rh?.querySelector(".brand-img")).toBeNull();
    expect(rh?.querySelector(".brand-mark")?.textContent?.trim()).toBe("RU");
    // ＋ 那张不给厂商标识，保留那颗加号
    const plus = panel.container.querySelector('[data-provider="custom-new"]');
    expect(plus?.querySelector(".brand-img")).toBeNull();
    expect(plus?.querySelector(".brand-mark")?.textContent?.trim()).toBe("＋");
    // 已存的那条手动填写配置：没厂商可认，用它自己的名字起字母块，不是空白也不是加号
    const saved = panel.container.querySelector('[data-provider="custom"][data-config-id="1"]');
    expect(saved?.querySelector(".brand-img")).toBeNull();
    expect(saved?.querySelector(".brand-mark")?.textContent?.trim()).toBe("测试");
  });
  it("反推下拉左列那一家也认 LOGO：provider 认不得时退回字母，不留空格子", async () => {
    modelConfigs.set([{ ...model, provider: "zhipu", name: "智谱 GLM", model: "glm-4.6v" }]);
    vi.mocked(reverseApi.models).mockResolvedValue([{ ...model, provider: "zhipu", name: "智谱 GLM", model: "glm-4.6v" }]);
    vi.spyOn(reverseApi, "configModels").mockResolvedValue({
      models: [{ id: "glm-4.6v", label: "GLM-4.6V", recommended: true }], source: "live", reason: "",
    });
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(panel.getByText("反推提示词")).toBeTruthy());
    await fireEvent.click(panel.getByLabelText("反推模型"));
    await waitFor(() => expect(rows(panel)).toContain("GLM-4.6V"));
    expect(panel.container.querySelector(".mp-provider .brand-img")?.getAttribute("src")).toBe("/brands/zhipu.svg");
  });
  it("选 RunningHub：Key 那一格说清这是一把共用的 Key，且这一页不再碰模型清单", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([preset, cloudPreset]);
    const list = vi.spyOn(reverseApi, "configModels");
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "runninghub");
    await waitFor(() => expect(panel.container.textContent).toContain("一把 Key 走天下"));
    expect(panel.container.textContent).toContain("只存一份");
    // 现拉清单搬去了反推面板那个两列下拉：这一页只管地址与 Key
    expect(list).not.toHaveBeenCalled();
    expect(panel.queryByLabelText("识别模型")).toBeNull();
    expect(panel.queryByRole("button", { name: "展开模型清单" })).toBeNull();
  });
  it("注册表里那段各家说明（note）不再显示在这一页", async () => {
    // 2026-11-16 苏醒在「模型API配置」页上圈了整块：「这些说明文字不要在前端展示，直接删除」。
    // 后端照样把 note 带回来（注册表里的数据不动），这一页不再念它。
    vi.mocked(reverseApi.providers).mockResolvedValue([
      { ...preset, id: "zhipu", name: "智谱 GLM", note: "反推只能用看得懂图的那几档：GLM-4.6V / GLM-4.6V Flash / GLM-5.3 Flash" },
    ]);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "zhipu");
    expect(panel.queryByText(/反推只能用看得懂图的那几档/)).toBeNull();
    expect(panel.queryByText(/模型不用在这里选/)).toBeNull();
    // 但该说的事仍在他该在的地方：Key 那一格自己会讲清这把 Key 存哪儿、锁没锁
    expect(panel.getByLabelText("API Key")).toBeTruthy();
    expect(panel.container.textContent).toContain("Windows 按当前用户加密保存密钥");
  });
  it("RunningHub 的 Key 只往接口交出去一次：请求体里带 api_key，界面上不留明文", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([preset, cloudPreset]);
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue({
      ...model, provider: "runninghub", name: "RunningHub", base_url: "https://llm.runninghub.cn/v1",
      model: "y/qwen2.5-vl", has_api_key: true,
    });
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "runninghub");
    await fireEvent.input(panel.getByLabelText("API Key"), { target: { value: "RH-SECRET-VALUE" } });
    await fireEvent.click(panel.getByText("保存配置"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ provider: "runninghub", api_key: "RH-SECRET-VALUE" });
    expect("model" in save.mock.calls[0][0]).toBe(false);
    await waitFor(() => expect((panel.getByLabelText("API Key") as HTMLInputElement).value).toBe(""));
    expect(panel.container.textContent).not.toContain("RH-SECRET-VALUE");
  });
  it("RunningHub 点「清除」：即时删掉共用那把，并说清两边一起失效", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([
      preset, { ...cloudPreset, shared_has_key: true },
      // 已存在的共用配置：has_api_key 走的是云端那条账号
    ]);
    modelConfigs.set([{ ...model, provider: "runninghub", name: "RunningHub", has_api_key: true }]);
    vi.mocked(reverseApi.models).mockResolvedValue([{ ...model, provider: "runninghub", name: "RunningHub", has_api_key: true }]);
    const clear = vi.spyOn(reverseApi, "clearProviderKey")
      .mockResolvedValue({ shared_has_key: false, shared_has_workflow_key: false });
    const save = vi.spyOn(reverseApi, "saveModel");
    const panel = render(ModelApiSettings);
    // 通过服务商卡打开已有配置；等偏好读回来，在那之前整张卡是禁用的
    await waitForReady(panel);
    await pickProvider(panel, "runninghub");
    await fireEvent.click(panel.getByRole("button", { name: "清除这把 Key" }));
    // 删的是云端那一行账号，不是这条模型配置：一把 Key 走天下，只能有一个家
    await waitFor(() => expect(clear).toHaveBeenCalledWith("runninghub", "model"));
    expect(save).not.toHaveBeenCalled();
    expect(await panel.findByText(/图片反推与再次创作同时停用/)).toBeTruthy();
  });
  it("点 RunningHub 那张服务商卡时改的是已有那条配置，不新建第二条", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([preset, { ...cloudPreset, shared_has_key: true }]);
    const existing = { ...model, id: 7, provider: "runninghub", name: "RunningHub",
      base_url: "https://llm.runninghub.cn/v1", model: "y/qwen2.5-vl", has_api_key: true };
    vi.mocked(reverseApi.models).mockResolvedValue([existing]);
    modelConfigs.set([existing]);
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue(existing);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "runninghub");
    expect(pressedCard(panel)).toBe("runninghub");
    // 这一页不显示模型，配置里那个值原样带回去：不能被空串覆盖，那是面板里刚挑好的
    expect(panel.queryByLabelText("识别模型")).toBeNull();
    await fireEvent.input(panel.getByLabelText("API Key"), { target: { value: "RH-NEW-KEY" } });
    await fireEvent.click(panel.getByText("保存配置"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1]).toBe(7);
    expect(save.mock.calls[0][0]).toMatchObject({ provider: "runninghub", model: "y/qwen2.5-vl", api_key: "RH-NEW-KEY" });
  });
  it("能力过滤只列真接进来的那几家：图像/视频/音频目前只有 RunningHub，自定义每张 tab 都在", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([
      preset,
      { ...cloudPreset, capabilities: ["text", "image", "video", "audio"] },
    ]);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    const cards = () => Array.from(panel.container.querySelectorAll(".api-card"))
      .map(c => c.getAttribute("data-provider"));
    expect(cards()).toContain("qwen");
    await fireEvent.click(panel.getByRole("button", { name: "图像" }));
    // 手动填写那条排在自己那张卡上，＋ 跟在最后；两者都不按能力 tab 过滤
    expect(cards()).toEqual(["runninghub", "custom", "custom-new"]);
    await fireEvent.click(panel.getByRole("button", { name: "音频" }));
    expect(cards()).toEqual(["runninghub", "custom", "custom-new"]);
    // 切到「文本」也不许把自定义藏起来：苏醒就是在这个 tab 下发现它「不见了」
    await fireEvent.click(panel.getByRole("button", { name: "文本" }));
    expect(cards()).toContain("custom");
    await fireEvent.click(panel.getByRole("button", { name: "全部" }));
    expect(cards()).toContain("qwen");
    // 不想看见它们的话有开关：勾上「只显示内置厂商」把已存那几条和 ＋ 一起收起来
    const only = panel.getByLabelText("只显示内置厂商") as HTMLInputElement;
    await fireEvent.click(only);
    expect(cards()).not.toContain("custom");
    expect(cards()).not.toContain("custom-new");
    await fireEvent.click(only);
    expect(cards()).toContain("custom");
  });
  it("两把 Key 各一格：模型那把与工作流那把一起走「保存」，各说各的扣费", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([
      preset,
      { ...cloudPreset, capabilities: ["text", "image", "video", "audio"], workflow_key: true,
        console_url: "https://www.runninghub.cn" },
    ]);
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue({
      ...model, provider: "runninghub", name: "RunningHub", has_api_key: true,
    });
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "runninghub");
    // 没有 workflow_key 的别家不该出现第二格
    expect(panel.getByLabelText("工作流 API Key")).toBeTruthy();
    expect(await panel.findByText(/扣钱包余额/)).toBeTruthy();
    expect(await panel.findByText(/扣 RH币/)).toBeTruthy();
    await fireEvent.input(panel.getByLabelText("API Key"), { target: { value: "RH-MODEL-KEY" } });
    await fireEvent.input(panel.getByLabelText("工作流 API Key"), { target: { value: "RH-WF-KEY" } });
    await fireEvent.click(panel.getByText("保存配置"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ api_key: "RH-MODEL-KEY", workflow_api_key: "RH-WF-KEY" });
    expect(panel.container.textContent).not.toContain("RH-WF-KEY");
    // 控制台外链只在这家确认过地址时才画
    const link = panel.container.querySelector("a.api-console") as HTMLAnchorElement;
    expect(link?.href).toBe("https://www.runninghub.cn/");
  });
  it("清除工作流那把：只碰工作流，并说清模型那一把没动", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([
      preset, { ...cloudPreset, workflow_key: true, shared_has_workflow_key: true },
    ]);
    const clear = vi.spyOn(reverseApi, "clearProviderKey")
      .mockResolvedValue({ shared_has_key: false, shared_has_workflow_key: false });
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "runninghub");
    // 工作流那一把存过了也给同一串暗下去的点，和模型那一格一个长相
    const wfMask = (panel.getByLabelText("工作流 API Key") as HTMLInputElement).getAttribute("placeholder") ?? "";
    expect(/^•+$/.test(wfMask)).toBe(true);
    // 撤了复选框以后，「怎么删」这件事得在页面上说得出人话
    expect(panel.container.querySelector(".api-help")?.textContent).toContain("点它右边那颗「清除」");
    await fireEvent.click(panel.getByRole("button", { name: "清除工作流这把 Key" }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith("runninghub", "workflow"));
    expect(await panel.findByText(/模型那一把没动/)).toBeTruthy();
    // 没存过的那一把不许长出「清除」：没东西可删
    expect(panel.queryByRole("button", { name: "清除这把 Key" })).toBeNull();
  });
  it("版式复刻：标题行报「已配置 1/2」，右边是「测试连接」与「获取 API Key」", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([
      preset,
      { ...cloudPreset, capabilities: ["text", "image", "video", "audio"], workflow_key: true,
        console_url: "https://www.runninghub.cn", shared_has_key: true },
    ]);
    vi.spyOn(cloudApi, "status").mockResolvedValue({ accounts: [{ id: 9, is_shared: true }] } as never);
    const test = vi.spyOn(cloudApi, "testAccount").mockResolvedValue({
      ok: true, reason_code: "ok", message: "连通正常，余额 1200 RH币", remain_coins: 1200,
    });
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "runninghub");
    // 两把 Key 报几把：模型那把已配、工作流那把还空着
    expect(panel.container.querySelector(".api-provider-badge")?.textContent).toBe("已配置 1/2");
    expect(await panel.findByText(/调用云端工作流 \/ AI 应用/)).toBeTruthy();
    await fireEvent.click(panel.getByRole("button", { name: "测试连接" }));
    expect(await panel.findByText(/余额 1200 RH币/)).toBeTruthy();
    // 测的是后端标 is_shared 的那一行账号，不是数组里排第一条
    expect(test).toHaveBeenCalledWith(9);
    expect(panel.container.querySelector("a.api-console")?.textContent).toContain("获取 API Key");
  });
  it("「设为默认服务商」点了就存住，不用再去「反推指令」那一页再点一次保存", async () => {
    const qwenModel = { ...model, provider: "qwen" };
    vi.spyOn(reverseApi, "models").mockResolvedValue([qwenModel]);
    modelConfigs.set([qwenModel]);
    // 挂载时会重新拉一次偏好，所以「当前默认不是这条」要在接口那一层成立
    vi.spyOn(reverseApi, "settings").mockResolvedValue({ ...settings, default_model_id: 2 });
    const save = vi.spyOn(reverseApi, "saveSettings").mockResolvedValue({ ...settings, default_model_id: 1 });
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "qwen");
    // 「设为默认服务商」要等偏好读回来才亮（canSetDefault 认 $reverseSettings），所以等它本身，不等页面
    const btn = await waitFor(() => {
      const found = panel.getByRole("button", { name: "设为默认服务商" }) as HTMLButtonElement;
      expect(found.disabled).toBe(false);
      return found;
    });
    await fireEvent.click(btn);
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ default_model_id: 1 });
    expect(await panel.findByText(/已把这一家设为图片反推的默认服务商/)).toBeTruthy();
  });
  it("没有工作流那一说的厂商，不许多出一格 Key", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([preset, { ...cloudPreset, workflow_key: false }]);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "qwen");
    expect(panel.queryByLabelText("工作流 API Key")).toBeNull();
  });
  it("切到自定义：只问地址与名称，模型仍然不在这一页", async () => {
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "custom-new");
    expect(panel.getByLabelText("配置名称")).toBeTruthy();
    expect(panel.getByLabelText("Base URL")).toBeTruthy();
    expect(panel.queryByLabelText("模型 ID")).toBeNull();
    expect(panel.queryByLabelText("识别模型")).toBeNull();
    // 只有自定义这条留着「请求超时」：地址是自己的机器，快慢只有自己知道，默认 120 秒、想调就调
    expect((panel.getByLabelText("请求超时") as HTMLInputElement).value).toBe("120");
  });
  it("已存的手动填写配置在设置页有自己的卡：点它就是改这一条，不是又开一张空表单", async () => {
    // 苏醒撞上的那一下：本地那条（库里 provider 是 NULL）在反推下拉里是一行，设置页却没有它的卡，
    // 点「自定义」只会开一张空表单，再保存就是第二条重复配置。
    const qwenRow = { ...model, id: 3, name: "通义千问 Qwen", provider: "qwen", has_api_key: true };
    const mine = { ...model, id: 11, name: "本地 Qwen", base_url: "http://172.18.1.188:8000/v1", provider: null, has_api_key: true };
    vi.mocked(reverseApi.models).mockResolvedValue([qwenRow, mine]);
    modelConfigs.set([qwenRow, mine]);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    // 落点在已配 Key 的那家预设：下面这些回填只能是点这张卡点出来的
    expect(pressedCard(panel)).toBe("qwen");
    const card = panel.container.querySelector('[data-provider="custom"][data-config-id="11"]') as HTMLButtonElement;
    expect(card.textContent).toContain("本地 Qwen");
    expect(card.textContent).toContain("已配置");
    await fireEvent.click(card);
    expect(pressedCard(panel)).toBe("custom");
    expect((panel.getByLabelText("配置名称") as HTMLInputElement).value).toBe("本地 Qwen");
    expect((panel.getByLabelText("Base URL") as HTMLInputElement).value).toBe("http://172.18.1.188:8000/v1");
    // 标题行报它自己的名字，和反推下拉里那一行对得上；这一条也能就地删
    expect(panel.container.querySelector(".api-provider-name")?.textContent).toBe("本地 Qwen");
    expect(panel.container.querySelector(".api-provider-badge")?.textContent).toBe("已配置 1/1");
    expect(panel.getByText("删除配置")).toBeTruthy();
  });
  it("＋ 那张只管新开一条：不认领已存那条，保存也不带 id", async () => {
    const mine = { ...model, id: 11, name: "本地 Qwen", provider: null, has_api_key: true };
    vi.mocked(reverseApi.models).mockResolvedValue([mine]);
    modelConfigs.set([mine]);
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue({ ...mine, id: 12, name: "第二台机器" });
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    // 已经有了一条，＋ 那张就说「再加一条」，别让人以为点它是回到旧的那条
    expect(panel.container.textContent).toContain("再加一条自己的 Base URL");
    await pickProvider(panel, "custom-new");
    expect((panel.getByLabelText("配置名称") as HTMLInputElement).value).toBe("");
    expect((panel.getByLabelText("Base URL") as HTMLInputElement).value).toBe("");
    await fireEvent.input(panel.getByLabelText("配置名称"), { target: { value: "第二台机器" } });
    await fireEvent.input(panel.getByLabelText("Base URL"), { target: { value: "http://127.0.0.1:1234/v1" } });
    await fireEvent.click(panel.getByText("保存配置"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1]).toBeUndefined();
    expect(save.mock.calls[0][0]).toMatchObject({ provider: "custom", name: "第二台机器" });
  });
  it("内置厂商一家都没配 Key 时，进来落在已配好的那条手动填写配置上", async () => {
    const mine = { ...model, id: 11, name: "本地 Qwen", provider: null, has_api_key: true };
    vi.mocked(reverseApi.models).mockResolvedValue([mine]);
    modelConfigs.set([mine]);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    expect(panel.container.querySelector(".api-card[aria-pressed='true']")?.getAttribute("data-config-id")).toBe("11");
    expect(panel.container.querySelector(".api-provider-name")?.textContent).toBe("本地 Qwen");
  });
  it("每一家内置厂商都给一颗「获取 API Key」：跳到它自己的控制台，换厂商也跟着换地址", async () => {
    // 这颗按钮原先只有 RunningHub 与 MiniMax 有，其余几家把「去哪拿 Key」留给了搜索引擎。
    // 后端现在每家都带 console_url，这一条钉住「带了就画、换一家就换成那一家的地址」。
    vi.mocked(reverseApi.providers).mockResolvedValue([
      { ...preset, console_url: "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key" },
      { ...cloudPreset, console_url: "https://www.runninghub.cn" },
    ]);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "qwen");
    const link = panel.container.querySelector("a.api-console") as HTMLAnchorElement;
    expect(link?.textContent).toContain("获取 API Key");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.href).toBe("https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key");
    await pickProvider(panel, "runninghub");
    expect((panel.container.querySelector("a.api-console") as HTMLAnchorElement).href).toBe("https://www.runninghub.cn/");
  });
  it("内置厂商不摆「高级设置」，也不给「请求超时」那一格：时间归注册表管", async () => {
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    await pickProvider(panel, "qwen");
    expect(panel.queryByText("高级设置")).toBeNull();
    expect(panel.container.querySelector("details")).toBeNull();
    // 那三样（配置名称 / Base URL / 请求地址）都在这一个分支里没了：内置厂商的地址归注册表管
    expect(panel.queryByLabelText("配置名称")).toBeNull();
    expect(panel.queryByLabelText("Base URL")).toBeNull();
    expect(panel.queryByText(/请求地址：/)).toBeNull();
    // 超时那一格也删了：内置厂商的时间由后端注册表给到十分钟（思考档够用）。
    // 留个输入框反而误导——填了也不作数，还让人以为自己得先搞懂该填几秒
    expect(panel.queryByLabelText("请求超时")).toBeNull();
  });
  it("存过 Key 的这一格锁住：格子里给一串暗下去的点；清除以后才重新打开", async () => {
    const clear = vi.spyOn(reverseApi, "clearModelKey").mockResolvedValue({ ...model, has_api_key: false });
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    // 默认落在已配 Key 的那条配置上，所以一进来这一格就该是锁着的
    const box = panel.getByLabelText("API Key") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.value).toBe("");
    // 那串点是 placeholder：格子里要有东西，但绝不能是 value（value 里进了东西会被当成新 Key 存回去）
    const mask = box.getAttribute("placeholder") ?? "";
    expect(mask.length).toBeGreaterThanOrEqual(8);
    expect(/^•+$/.test(mask)).toBe(true);
    expect(panel.getByText(/这一格已锁住/)).toBeTruthy();
    await fireEvent.click(panel.getByRole("button", { name: "清除这把 Key" }));
    await waitFor(() => expect(clear).toHaveBeenCalled());
    const again = panel.getByLabelText("API Key") as HTMLInputElement;
    expect(again.disabled).toBe(false);
    expect(again.getAttribute("placeholder")).toBe("粘贴 API Key");
  });
  it("「删除配置」只给手动填写那几条：内置厂商删不掉，这一侧不摆这颗按钮", async () => {
    const qwenRow = { ...model, id: 3, name: "通义千问 Qwen", provider: "qwen", has_api_key: true };
    const mine = { ...model, id: 11, name: "本地 Qwen", provider: null, has_api_key: true };
    vi.mocked(reverseApi.models).mockResolvedValue([qwenRow, mine]);
    modelConfigs.set([qwenRow, mine]);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    expect(pressedCard(panel)).toBe("qwen");
    expect(panel.queryByText("删除配置")).toBeNull();
    // 切到自己填的那一条，这颗才回来：那几条是真能删的
    await fireEvent.click(panel.container.querySelector('[data-provider="custom"][data-config-id="11"]') as HTMLButtonElement);
    expect(panel.getByText("删除配置")).toBeTruthy();
  });
  it("这一页的按钮与输入框同高：一律 --ctl-md，不留三种高度", async () => {
    // 实测量出来的旧账：普通按钮 37、ghost 28、Key 那一格 41，同一排三种高度。
    // 收在本组件的 <style> 里（app.css 的 .setting-button 别的设置页也在用），
    // min-height 必须一起归零，否则全局那条 34 的下限还压着 height 不生效。
    const source = readFileSync("src/components/ModelApiSettings.svelte", "utf8").replace(/\r\n/g, "\n");
    const buttonRule = source.match(/\.model-settings \.setting-button\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(buttonRule).toContain("height: var(--ctl-md)");
    expect(buttonRule).toContain("min-height: 0");
    const fieldRule = source.match(/\.model-settings input:not\(\[type=checkbox\]\)\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(fieldRule).toContain("height: var(--ctl-md)");
    // 存过 Key 那一格：字与边框退一档、点用 --text-3。整格压 opacity 会把那串点一起糊掉，所以不许回来
    const locked = source.match(/\.api-key-row input:disabled\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(locked).toContain("color: var(--text-3)");
    expect(locked).not.toContain("opacity");
    expect(source).toMatch(/\.api-key-row input:disabled::placeholder\s*\{\s*color: var\(--text-3\)/);
  });
  it("手动填写那一条在库里 provider 是 NULL：进 store 统一成 custom，设置页才认得它", async () => {
    vi.mocked(reverseApi.models).mockResolvedValue([{ ...model, provider: null }]);
    await refreshReverseConfig();
    expect(get(modelConfigs)[0].provider).toBe("custom");
  });
  it("底部那颗改叫「检查 API Key」：只问清单，一次模型调用都不产生", async () => {
    const check = vi.spyOn(reverseApi, "checkKey").mockResolvedValue({ ok: true, count: 2, models: ["a", "b"], source: "live" });
    const generate = vi.spyOn(reverseApi, "generate").mockResolvedValue(record);
    const panel = render(ModelApiSettings);
    await waitForReady(panel);
    // 旧的「测试图片识别」要先把模型挑好才按得动，而这一页已经不管模型了
    expect(panel.queryByText("测试图片识别")).toBeNull();
    await fireEvent.click(panel.getByText("检查 API Key"));
    await waitFor(() => expect(check).toHaveBeenCalled());
    expect(await panel.findByText(/读到 2 个模型/)).toBeTruthy();
    expect(generate).not.toHaveBeenCalled();
  });
  it("自动认出语言模型：一家没记住模型时面板自己挑，认完直接能按，不用再手动选", async () => {
    modelConfigs.set([{ ...model, model: "" }]);
    vi.mocked(reverseApi.models).mockResolvedValue([{ ...model, model: "" }]);
    vi.spyOn(reverseApi, "configModels").mockResolvedValue({
      models: [{ id: "x/deepseek-v4.1-flash", label: "x/deepseek-v4.1-flash", recommended: false },
               { id: "b/qwen2.5-vl", label: "b/qwen2.5-vl", recommended: true }],
      source: "live", reason: "",
    });
    const setModel = vi.spyOn(reverseApi, "setModel").mockImplementation(async (id, value) => ({ ...model, id, model: value }));
    const generate = vi.spyOn(reverseApi, "generate").mockResolvedValue(record);
    const panel = render(ReversePromptPanel, { imageId: 1 });
    // 推荐项优先：认出来顺手记回这一家，两个面板读同一份
    await waitFor(() => expect(setModel).toHaveBeenCalledWith(1, "b/qwen2.5-vl"));
    await waitFor(() => expect(panel.queryByText(/没认出这家的语言模型/)).toBeNull());
    await waitFor(() => expect((panel.getByText("开始反推") as HTMLButtonElement).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(panel.getByText("开始反推"));
    await waitFor(() => expect(generate).toHaveBeenCalledWith(1, 1, "b/qwen2.5-vl"));
    // 认过一家就只问一次清单，重挂载不该再敲它一遍
    const listed = vi.mocked(reverseApi.configModels);
    const before = listed.mock.calls.length;
    render(ReversePromptPanel, { imageId: 2 });
    await waitFor(() => expect(listed.mock.calls.length).toBe(before));
  });
  it("模型下拉还能手动换：点服务商、点它家的模型，选中就把这一家当前用的模型记回配置", async () => {
    // 清单是点开下拉那一刻才拉的；模型这一家已经记住了，面板自己不会再挑
    vi.spyOn(reverseApi, "configModels").mockResolvedValue({
      models: [{ id: "a/deepseek-v4.1-flash", label: "a/deepseek-v4.1-flash", recommended: false },
               { id: "b/qwen2.5-vl", label: "b/qwen2.5-vl", recommended: true }],
      source: "live", reason: "",
    });
    const setModel = vi.spyOn(reverseApi, "setModel").mockImplementation(async (id, value) => ({ ...model, id, model: value }));
    const generate = vi.spyOn(reverseApi, "generate").mockResolvedValue(record);
    // 这一家已经记住了模型：面板不再去问清单，手动换才开下拉
    modelConfigs.set([{ ...model, model: "a/deepseek-v4.1-flash" }]);
    vi.mocked(reverseApi.models).mockResolvedValue([{ ...model, model: "a/deepseek-v4.1-flash" }]);
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(panel.getByText("反推提示词")).toBeTruthy());
    await fireEvent.click(panel.getByLabelText("反推模型"));
    await waitFor(() => expect(rows(panel)).toEqual(["a/deepseek-v4.1-flash", "b/qwen2.5-vl"]));
    expect(panel.container.querySelector(".mp-rec")?.textContent).toBe("推荐");
    await fireEvent.click(panel.container.querySelectorAll(".mp-model")[1]);
    await waitFor(() => expect(setModel).toHaveBeenCalledWith(1, "b/qwen2.5-vl"));
    // 这家一张历史都没有，按钮此刻还是「开始反推」
    await waitFor(() => expect((panel.getByText("开始反推") as HTMLButtonElement).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(panel.getByText("开始反推"));
    await waitFor(() => expect(generate).toHaveBeenCalledWith(1, 1, "b/qwen2.5-vl"));
  });
  it("反推下拉里不解释「另外报了 N 个模型」：这一列只列能反推的，不写为什么少列了", async () => {
    // 苏醒 2026-11-16 明确要删这句：清单干净比解释重要。数量还留在接口的 hidden 里，
    // 哪天要放回别处（比如 tooltip）不必再动后端。
    modelConfigs.set([{ ...model, model: "glm-4.6v" }]);
    vi.mocked(reverseApi.models).mockResolvedValue([{ ...model, model: "glm-4.6v" }]);
    vi.spyOn(reverseApi, "configModels").mockResolvedValue({
      models: [{ id: "glm-4.6v", label: "GLM-4.6V", recommended: true }],
      source: "live", reason: "", hidden: 9,
    });
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(panel.getByText("反推提示词")).toBeTruthy());
    await fireEvent.click(panel.getByLabelText("反推模型"));
    await waitFor(() => expect(rows(panel)).toContain("GLM-4.6V"));
    expect(panel.container.querySelector(".mp-models")?.textContent).not.toContain("另外报了");
    expect(panel.container.querySelector(".mp-note")).toBeNull();
  });
  it("图片提示词反推的模型列表不显示 MiniMax 生图、视频和音频 API", async () => {
    const minimax = {
      ...model, id: 2, name: "MiniMax", provider: "minimax", model: "",
      capabilities: ["image", "video", "audio"],
    };
    modelConfigs.set([{ ...model, model: "" }, minimax]);
    vi.mocked(reverseApi.models).mockResolvedValue([{ ...model, model: "" }, minimax]);
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await fireEvent.click(panel.getByLabelText("反推模型"));
    await waitFor(() => expect(panel.container.querySelectorAll(".mp-provider").length).toBeGreaterThan(0));
    expect(panel.container.querySelector(".mp-providers")?.textContent).not.toContain("MiniMax");
    expect(panel.container.querySelector(".mp-providers")?.textContent).toContain("测试视觉");
  });
  it("清单拉不到就说清原因：下拉里报那句原话，不再留手输模型 ID 的口子", async () => {
    // 苏醒真机就撞上一次 APIKEY_USER_NOT_FOUND——清单这条路随时可能断，断的时候要看得见原因
    modelConfigs.set([{ ...model, model: "" }]);
    vi.mocked(reverseApi.models).mockResolvedValue([{ ...model, model: "" }]);
    vi.spyOn(reverseApi, "configModels").mockRejectedValue({ detail: "模型清单没拿到（HTTP 502）：APIKEY_USER_NOT_FOUND" });
    const setModel = vi.spyOn(reverseApi, "setModel").mockImplementation(async (id, value) => ({ ...model, id, model: value }));
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(panel.getByText(/没认出这家的语言模型/)).toBeTruthy());
    await fireEvent.click(panel.getByLabelText("反推模型"));
    // 原因在两个地方都要看得见：面板那条红字 + 下拉里那条
    await waitFor(() => expect(panel.container.querySelector(".mp-pop")?.textContent).toContain("APIKEY_USER_NOT_FOUND"));
    expect(panel.container.querySelector('[role="alert"]')?.textContent).toContain("APIKEY_USER_NOT_FOUND");
    expect(panel.queryByLabelText("直接输入模型 ID")).toBeNull();
    expect(panel.queryByText("用")).toBeNull();
    expect(setModel).not.toHaveBeenCalled();
    expect((panel.getByText("开始反推") as HTMLButtonElement).hasAttribute("disabled")).toBe(true);
  });
  it("自动识别只认一次：认出来之后换面板也不再去问清单", async () => {
    const picked = await autoPickModel(7);
    expect(picked).toBe("");           // 默认那份假清单是空的，什么都不该记
    const again = vi.spyOn(reverseApi, "configModels").mockResolvedValue({
      models: [{ id: "only-one", label: "only-one", recommended: true }], source: "live", reason: "",
    });
    expect(await autoPickModel(8)).toBe("only-one");
    expect(await autoPickModel(8)).toBe("only-one");
    expect(again).toHaveBeenCalledTimes(1);
    clearAutoModelCache();
    expect(await autoPickModel(8)).toBe("only-one");
    expect(again).toHaveBeenCalledTimes(2);
  });
  it("几家的 Key 都清掉了：下拉里一家都不摆，只留一句去设置重新保存的路", async () => {
    // 2026-11-16 苏醒：「当我把已经配置过的 API KEY 删除后，希望 AI 反推选模型处不再显示这家厂商」。
    // 挂着「需配置」还占一行，等于让人在一条点不动的行上试；配置没删，Key 存回来它就自己回来。
    const cleared = { ...model, id: 2, name: "智谱", provider: "zhipu", has_api_key: false, model: "" };
    modelConfigs.set([cleared]);
    vi.mocked(reverseApi.models).mockResolvedValue([cleared]);
    const list = vi.spyOn(reverseApi, "configModels");
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect((panel.getByText("开始反推") as HTMLButtonElement).hasAttribute("disabled")).toBe(true));
    await fireEvent.click(panel.getByLabelText("反推模型"));
    await waitFor(() => expect(panel.container.querySelector(".mp-empty")).toBeTruthy());
    expect(panel.container.querySelector(".mp-provider")).toBeNull();
    expect(panel.queryByText("需配置")).toBeNull();
    // 左列那句话说清是「Key 都清了」，不是「还没有服务商」——两件事出路不同
    expect(panel.getByText("这几家的 API Key 都清掉了，去设置里重新保存才能反推。")).toBeTruthy();
    // 按钮上也说实话：一家都没得用时不顶着厂商名，不装作点下去还能反推
    const trigger = panel.getByLabelText("反推模型");
    expect(trigger.textContent).toContain("没有可用的服务商");
    expect(trigger.getAttribute("title")).toContain("API Key 都清掉了");
    // 没了 Key 就别去敲那家的清单接口：那一下必然失败，只会多一条读不懂的报错
    expect(list).not.toHaveBeenCalled();
    const listener = vi.fn(); window.addEventListener("open-model-settings", listener);
    await fireEvent.click(panel.getByText("去设置里重新保存 API Key"));
    expect(listener).toHaveBeenCalledOnce(); window.removeEventListener("open-model-settings", listener);
  });
  it("正在用的那一家 Key 被清掉：反推自动回落到还配着 Key 的那家", async () => {
    // 2026-11-16 苏醒：「开始反推如果删除了，自动回落到别家」。清完 Key 回来还能一键反推，
    // 不用先回这一页重新挑一家。回落只动这一页的选择，全局默认那一条不替人改。
    clearToasts();
    const zhipu = { ...model, id: 2, name: "智谱", provider: "zhipu", model: "" };
    const qwen = { ...model, id: 1, name: "测试视觉", model: "vision" };
    modelConfigs.set([zhipu]);
    vi.mocked(reverseApi.models).mockResolvedValue([zhipu]);
    vi.mocked(reverseApi.settings).mockResolvedValue({ ...settings, default_model_id: zhipu.id });
    const generate = vi.spyOn(reverseApi, "generate").mockResolvedValue(record);
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(panel.getByLabelText("反推模型").getAttribute("title")).toContain("智谱"));
    // 在设置页点「清除」之后，全局那份配置就是这么变的（这一行的 has_api_key 掉成 false）
    const cleared = [{ ...zhipu, has_api_key: false }, qwen];
    vi.mocked(reverseApi.models).mockResolvedValue(cleared);
    modelConfigs.set(cleared);
    await waitFor(() => expect(panel.getByLabelText("反推模型").getAttribute("title")).toContain("测试视觉"));
    // 换了哪家要说得出，不能让人以为模型自己会动
    await waitFor(() => expect(get(toasts).some(t => t.message.includes("API Key 已清除") && t.message.includes("测试视觉"))).toBe(true));
    // 默认那一条还指着原来那家：它只是暂时没 Key，不表示以后不想用
    expect(get(reverseSettings)?.default_model_id).toBe(zhipu.id);
    // 回落完就能直接按：这一家记得自己的模型
    await waitFor(() => expect((panel.getByText("开始反推") as HTMLButtonElement).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(panel.getByText("开始反推"));
    await waitFor(() => expect(generate).toHaveBeenCalledWith(1, qwen.id, "vision"));
  });
  it("配着 Key 的那几家照常列，清了 Key 的那一家不占行、也不再补一句「另有 N 家」", async () => {
    const keyedRow = { ...model, id: 1, name: "测试视觉", has_api_key: true };
    const cleared = { ...model, id: 2, name: "智谱", provider: "zhipu", has_api_key: false };
    modelConfigs.set([keyedRow, cleared]);
    vi.mocked(reverseApi.models).mockResolvedValue([keyedRow, cleared]);
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await fireEvent.click(panel.getByLabelText("反推模型"));
    await waitFor(() => expect(panel.container.querySelectorAll(".mp-pname").length).toBe(1));
    expect(Array.from(panel.container.querySelectorAll(".mp-pname")).map(n => n.textContent?.trim())).toEqual(["测试视觉"]);
    // 2026-11-16 第二轮（苏醒指着那句说「很多余的显示，删掉」）：左列少一家就是少了，
    // 不用再在末尾报一笔有几家没配 Key——那句话说的是他刚自己干完的事
    expect(panel.queryByText(/没配 Key/)).toBeNull();
    expect(panel.container.querySelector(".mp-goto")).toBeNull();
  });
});
