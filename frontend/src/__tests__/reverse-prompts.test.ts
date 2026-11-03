import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { get } from "svelte/store";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";
import ReversePromptPanel from "../components/ReversePromptPanel.svelte";
import ModelSettings from "../components/ModelSettings.svelte";
import { reverseApi, reverseJobs, modelConfigs, reverseSettings, generateReverse } from "../lib/reverse-prompts";
import { copyText } from "../lib/ws";
import { cloudApi, requestCloudKeyEdit } from "../lib/clone";
vi.mock("../lib/ws", () => ({ copyText: vi.fn().mockResolvedValue(true) }));

const model = { id: 1, name: "测试视觉", base_url: "https://example.com/v1", model: "vision", timeout: 120, provider: null, has_api_key: true, key_persistence: "encrypted" as const };
const preset = { id: "qwen", name: "通义千问 Qwen", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: [{ id: "qwen2.5-vl-72b-instruct", label: "Qwen2.5-VL-72B", recommended: true }], default_timeout: 120, note: "" };
// RunningHub：Key 与「一键同款」云端生成共用一把（credential_scope=cloud），清单由它自己报（models_dynamic）
const cloudPreset = {
  id: "runninghub", name: "RunningHub", base_url: "https://llm.runninghub.cn/v1", models: [],
  default_timeout: 120, note: "一把 Key 走天下：这里的 Key 与云端生成共用同一把", credential_scope: "cloud", models_dynamic: true,
};
const settings = { default_model_id: 1, instruction: "描述画面", default_instruction: "默认描述" };
/** 服务商选择页把下拉换成卡片网格了：点卡按 data-provider 拿，选中看 aria-pressed。 */
const pickProvider = async (panel: { container: HTMLElement }, id: string) => {
  const card = panel.container.querySelector(`[data-provider="${id}"]`) as HTMLButtonElement;
  expect(card, `没有这张服务商卡：${id}`).toBeTruthy();
  await fireEvent.click(card);
};
const pressedCard = (panel: { container: HTMLElement }) =>
  panel.container.querySelector(".api-card[aria-pressed='true']")?.getAttribute("data-provider") ?? "";
const record = { id: 10, image_id: 1, prompt_zh: "红色花朵", prompt_en: "red flower", raw_text: "", status: "complete" as const, source: "generated" as const, parent_id: null, model_name: "测试视觉", model: "vision", instruction: "", fingerprint: "abc", created_at: "2026-09-17T01:00:00Z" };

beforeEach(() => {
  reverseJobs.set({}); modelConfigs.set([model]); reverseSettings.set(settings);
  vi.spyOn(reverseApi, "models").mockResolvedValue([model]);
  vi.spyOn(reverseApi, "settings").mockResolvedValue(settings);
  vi.spyOn(reverseApi, "providers").mockResolvedValue([preset]);
  vi.spyOn(reverseApi, "modelList").mockResolvedValue({ models: [], source: "preset", reason: "" });
  vi.spyOn(reverseApi, "history").mockResolvedValue({ items: [], total: 0, running: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("reverse prompts", () => {
  it("deduplicates requests and keeps completion attached to original image", async () => {
    let finish!: (value: typeof record) => void;
    const call = vi.spyOn(reverseApi, "generate").mockImplementation(() => new Promise(resolve => finish = resolve));
    const pending = generateReverse(1, 1);
    await generateReverse(1, 1);
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
  it("copies the selected language or both without changing history", async () => {
    vi.mocked(reverseApi.history).mockResolvedValue({ items: [record], total: 1, running: false });
    const panel = render(ReversePromptPanel, { imageId: 1 });
    await waitFor(() => expect(panel.getByText("复制中文")).toBeTruthy());
    await fireEvent.click(panel.getByText("复制中文"));
    expect(copyText).toHaveBeenLastCalledWith("红色花朵");
    await fireEvent.click(panel.getByText("English"));
    expect(panel.getByText("English").getAttribute("aria-pressed")).toBe("true");
    expect(panel.getByText("中文").getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(panel.getByText("复制英文"));
    expect(copyText).toHaveBeenLastCalledWith("red flower");
    await fireEvent.click(panel.getByText("复制双语"));
    expect(copyText).toHaveBeenLastCalledWith("中文\n红色花朵\n\nEnglish\nred flower");
    expect(panel.getByText("历史版本（1）")).toBeTruthy();
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
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    await fireEvent.click(panel.getByText("测试视觉"));
    expect(panel.getByText("测试视觉").getAttribute("aria-pressed")).toBe("true");
    expect((panel.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
    await fireEvent.click(panel.getByText("保存模型"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).not.toHaveProperty("api_key");
  });
  it("新建配置只有一个入口：厂商卡片就是入口，不再另摆一颗「＋ 添加模型」", async () => {
    // 点厂商卡片＝新建或打开那一份配置，「自定义（手动填写）」那张卡＝手动填 Base URL 的那一份。
    // 再留一颗「＋ 添加模型」是同一件事的第三个入口，被指「多余内容太多」，删掉并钉住。
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    expect(panel.queryByText("＋ 添加模型")).toBeNull();
    expect(panel.queryAllByRole("button", { name: /自定义（手动填写）/ })).toHaveLength(1);
  });

  it("选中的厂商卡片文字不许被全局按钮配色涂黑：选中态自己声明浅色", async () => {
    // 全局 .fill-interactions button[aria-pressed="true"] 是红底近黑字（给小胶囊用的）。
    // 卡片只覆盖了背景，文字会跟着被涂成 #0e0e10，压在自己的深红底上完全读不出来。
    const source = readFileSync("src/components/ModelSettings.svelte", "utf8").replace(/\r\n/g, "\n");
    const rule = source.match(/\.api-card\[aria-pressed="true"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("background");
    expect(rule).toMatch(/color:\s*#[def]/);
  });

  it("打开设置先落在已经配好 Key 的那家，但不自己拿真 Key 去拉清单", async () => {
    // 清单里排第一的是 OpenAI，而这里只有 RunningHub 配过 Key：默认摊开一张没配的 OpenAI
    // 表单，等于每个人进来都要重新找自己那家。
    // 同时「打开设置」不许替用户发外部请求——清单要现拉，但只该由他点那一下触发。
    vi.mocked(reverseApi.providers).mockResolvedValue([preset, { ...cloudPreset, shared_has_key: true }]);
    const list = vi.spyOn(reverseApi, "modelList").mockResolvedValue({ models: [], source: "preset", reason: "" });
    const panel = render(ModelSettings);
    await waitFor(() => expect(pressedCard(panel)).toBe("runninghub"));
    expect(list).not.toHaveBeenCalled();
    // 清单留给人自己点：点这张已经选中的卡，才去拉
    await pickProvider(panel, "runninghub");
    await waitFor(() => expect(list).toHaveBeenCalled());
  });

  it("clears keys explicitly and previews endpoint without duplication", async () => {
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue({ ...model, has_api_key: false });
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    await fireEvent.click(panel.getByText("测试视觉"));
    await fireEvent.input(panel.getByLabelText("Base URL"), { target: { value: "https://example.com/v1/chat/completions/" } });
    expect(panel.getByText("请求地址：https://example.com/v1/chat/completions")).toBeTruthy();
    await fireEvent.click(panel.getByLabelText("清除已保存密钥"));
    await fireEvent.click(panel.getByText("保存模型"));
    await waitFor(() => expect(save.mock.calls[0][0].api_key).toBe(""));
  });
  it("preset autofills model and saves with only an API Key", async () => {
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue({ ...model, provider: "qwen", name: "通义千问 Qwen · Qwen2.5-VL-72B", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen2.5-vl-72b-instruct", has_api_key: true });
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    await waitFor(() => expect((panel.getByLabelText("反推模型") as HTMLSelectElement).value).toBe("qwen2.5-vl-72b-instruct"));
    await fireEvent.input(panel.getByLabelText("API Key"), { target: { value: "sk-123" } });
    await fireEvent.click(panel.getByText("保存模型"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ provider: "qwen", model: "qwen2.5-vl-72b-instruct", api_key: "sk-123" });
  });
  it("选 RunningHub：Key 那一格说清这是一把共用的 Key，模型清单现拉不抄", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([preset, cloudPreset]);
    const list = vi.spyOn(reverseApi, "modelList").mockResolvedValue({
      models: [{ id: "x/deepseek-v4.1-flash", label: "x/deepseek-v4.1-flash", recommended: false },
               { id: "y/qwen2.5-vl", label: "y/qwen2.5-vl", recommended: true }],
      source: "live", reason: "",
    });
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    await pickProvider(panel, "runninghub");
    expect(await panel.findByText(/一把 Key 走天下/)).toBeTruthy();
    expect(panel.getByText(/只存一份/)).toBeTruthy();
    expect(list).toHaveBeenCalledWith("runninghub");
    // 清单是服务商报的：点一下就填进模型 ID，不再假装我们有一份标准答案
    await fireEvent.click(await panel.findByRole("button", { name: "y/qwen2.5-vl" }));
    expect((panel.getByLabelText("反推模型 ID") as HTMLInputElement).value).toBe("y/qwen2.5-vl");
    expect(panel.queryByLabelText("反推模型")).toBeNull();
  });
  it("RunningHub 的 Key 只往接口交出去一次：请求体里带 api_key，界面上不留明文", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([preset, cloudPreset]);
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue({
      ...model, provider: "runninghub", name: "RunningHub", base_url: "https://llm.runninghub.cn/v1",
      model: "y/qwen2.5-vl", has_api_key: true,
    });
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    await pickProvider(panel, "runninghub");
    await fireEvent.input(panel.getByLabelText("反推模型 ID"), { target: { value: "y/qwen2.5-vl" } });
    await fireEvent.input(panel.getByLabelText("API Key"), { target: { value: "RH-SECRET-VALUE" } });
    await fireEvent.click(panel.getByText("保存模型"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ provider: "runninghub", model: "y/qwen2.5-vl", api_key: "RH-SECRET-VALUE" });
    await waitFor(() => expect((panel.getByLabelText("API Key") as HTMLInputElement).value).toBe(""));
    expect(panel.container.textContent).not.toContain("RH-SECRET-VALUE");
  });
  it("勾「清掉这把 Key」时把空串交出去，并说清两边一起失效", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([
      preset, { ...cloudPreset, shared_has_key: true },
      // 已存在的共用配置：has_api_key 走的是云端那条账号
    ]);
    modelConfigs.set([{ ...model, provider: "runninghub", name: "RunningHub", has_api_key: true }]);
    vi.mocked(reverseApi.models).mockResolvedValue([{ ...model, provider: "runninghub", name: "RunningHub", has_api_key: true }]);
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue({ ...model, provider: "runninghub", has_api_key: false });
    const panel = render(ModelSettings);
    // 服务商下拉里也有这一个词，所以要按角色点那颗配置按钮；等偏好读回来，在那之前整张卡是禁用的
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    await waitFor(() => expect((panel.getByRole("button", { name: "RunningHub" }) as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(panel.getByRole("button", { name: "RunningHub" }));
    const clear = panel.getByLabelText("清除已保存密钥") as HTMLInputElement;
    expect(clear.parentElement?.textContent).toContain("反推与一键同款同时失效");
    await fireEvent.click(clear);
    await fireEvent.click(panel.getByText("保存模型"));
    await waitFor(() => expect(save.mock.calls[0][0].api_key).toBe(""));
  });
  it("从一键同款那一屏点「设置 RunningHub 的 API Key」：直接落在 RunningHub 那一格", async () => {
    // 设置页是按下这颗按钮之后才挂载的，所以来意要留在模块里，由挂载那一次取走
    vi.mocked(reverseApi.providers).mockResolvedValue([preset, cloudPreset]);
    vi.spyOn(reverseApi, "modelList").mockResolvedValue({ models: [], source: "none", reason: "先保存这把 API Key，才能向它要模型清单" });
    requestCloudKeyEdit();
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    await waitFor(() => expect(pressedCard(panel)).toBe("runninghub"));
    expect(await panel.findByText(/先保存这把 API Key/)).toBeTruthy();
  });
  it("带着来意进来时改的是已有那条 RunningHub 配置，不新建第二条", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([preset, { ...cloudPreset, shared_has_key: true }]);
    const existing = { ...model, id: 7, provider: "runninghub", name: "RunningHub",
      base_url: "https://llm.runninghub.cn/v1", model: "y/qwen2.5-vl", has_api_key: true };
    vi.mocked(reverseApi.models).mockResolvedValue([existing]);
    modelConfigs.set([existing]);
    const save = vi.spyOn(reverseApi, "saveModel").mockResolvedValue(existing);
    requestCloudKeyEdit();
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    await waitFor(() => expect(pressedCard(panel)).toBe("runninghub"));
    // 模型 ID 沿用那条配置里已有的值，不是一份空表单
    expect((panel.getByLabelText("反推模型 ID") as HTMLInputElement).value).toBe("y/qwen2.5-vl");
    await fireEvent.input(panel.getByLabelText("API Key"), { target: { value: "RH-NEW-KEY" } });
    await fireEvent.click(panel.getByText("保存模型"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1]).toBe(7);
    expect(save.mock.calls[0][0]).toMatchObject({ provider: "runninghub", model: "y/qwen2.5-vl", api_key: "RH-NEW-KEY" });
  });
  it("能力过滤只列真接进来的那几家：图像/视频/音频目前只有 RunningHub", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([
      preset,
      { ...cloudPreset, capabilities: ["text", "image", "video", "audio"] },
    ]);
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    const cards = () => Array.from(panel.container.querySelectorAll(".api-card"))
      .map(c => c.getAttribute("data-provider"));
    expect(cards()).toContain("qwen");
    await fireEvent.click(panel.getByRole("button", { name: "图像" }));
    expect(cards()).toEqual(["runninghub"]);
    await fireEvent.click(panel.getByRole("button", { name: "音频" }));
    expect(cards()).toEqual(["runninghub"]);
    await fireEvent.click(panel.getByRole("button", { name: "全部" }));
    expect(cards()).toContain("qwen");
    // 想按自己的 Base URL 连一家没在列表里的：勾掉「只显示内置厂商」才看得到那张卡
    const only = panel.getByLabelText("只显示内置厂商") as HTMLInputElement;
    await fireEvent.click(only);
    expect(cards()).not.toContain("custom");
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
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    await pickProvider(panel, "runninghub");
    // 没有 workflow_key 的别家不该出现第二格
    expect(panel.getByLabelText("工作流 API Key")).toBeTruthy();
    expect(await panel.findByText(/扣钱包余额/)).toBeTruthy();
    expect(await panel.findByText(/扣 RH币/)).toBeTruthy();
    await fireEvent.input(panel.getByLabelText("反推模型 ID"), { target: { value: "some/vl" } });
    await fireEvent.input(panel.getByLabelText("API Key"), { target: { value: "RH-MODEL-KEY" } });
    await fireEvent.input(panel.getByLabelText("工作流 API Key"), { target: { value: "RH-WF-KEY" } });
    await fireEvent.click(panel.getByText("保存模型"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ api_key: "RH-MODEL-KEY", workflow_api_key: "RH-WF-KEY" });
    expect(panel.container.textContent).not.toContain("RH-WF-KEY");
    // 控制台外链只在这家确认过地址时才画
    const link = panel.container.querySelector("a.api-console") as HTMLAnchorElement;
    expect(link?.href).toBe("https://www.runninghub.cn/");
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
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
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
  it("「设为默认模型」点了就存住，不用再去「图片反推」那栏再点一次保存", async () => {
    // 挂载时会重新拉一次偏好，所以「当前默认不是这条」要在接口那一层成立
    vi.spyOn(reverseApi, "settings").mockResolvedValue({ ...settings, default_model_id: 2 });
    const save = vi.spyOn(reverseApi, "saveSettings").mockResolvedValue({ ...settings, default_model_id: 1 });
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    await fireEvent.click(panel.getByRole("button", { name: "测试视觉" }));
    const btn = panel.getByRole("button", { name: "设为默认模型" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await fireEvent.click(btn);
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ default_model_id: 1 });
    expect(await panel.findByText(/已把这条模型设为图片反推的默认模型/)).toBeTruthy();
  });
  it("没有工作流那一说的厂商，不许多出一格 Key", async () => {
    vi.mocked(reverseApi.providers).mockResolvedValue([preset, { ...cloudPreset, workflow_key: false }]);
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    await pickProvider(panel, "qwen");
    expect(panel.queryByLabelText("工作流 API Key")).toBeNull();
  });
  it("switching to custom exposes manual fields and hides preset model dropdown", async () => {
    const panel = render(ModelSettings);
    await waitFor(() => expect(panel.getByLabelText("默认模型")).toBeTruthy());
    await waitFor(() => expect((panel.getByLabelText("反推模型") as HTMLSelectElement).value).toBe("qwen2.5-vl-72b-instruct"));
    await pickProvider(panel, "custom");
    expect(panel.getByLabelText("配置名称")).toBeTruthy();
    expect(panel.getByLabelText("Base URL")).toBeTruthy();
    expect(panel.getByLabelText("模型 ID")).toBeTruthy();
    expect(panel.queryByLabelText("反推模型")).toBeNull();
  });
});
