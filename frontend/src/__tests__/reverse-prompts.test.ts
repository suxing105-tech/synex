import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { get } from "svelte/store";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";
import ReversePromptPanel from "../components/ReversePromptPanel.svelte";
import ModelSettings from "../components/ModelSettings.svelte";
import { reverseApi, reverseJobs, modelConfigs, reverseSettings, generateReverse } from "../lib/reverse-prompts";
import { copyText } from "../lib/ws";
vi.mock("../lib/ws", () => ({ copyText: vi.fn().mockResolvedValue(true) }));

const model = { id: 1, name: "测试视觉", base_url: "https://example.com/v1", model: "vision", timeout: 120, has_api_key: true, key_persistence: "encrypted" as const };
const settings = { default_model_id: 1, instruction: "描述画面", default_instruction: "默认描述" };
const record = { id: 10, image_id: 1, prompt_zh: "红色花朵", prompt_en: "red flower", raw_text: "", status: "complete" as const, source: "generated" as const, parent_id: null, model_name: "测试视觉", model: "vision", instruction: "", fingerprint: "abc", created_at: "2026-09-17T01:00:00Z" };

beforeEach(() => {
  reverseJobs.set({}); modelConfigs.set([model]); reverseSettings.set(settings);
  vi.spyOn(reverseApi, "models").mockResolvedValue([model]);
  vi.spyOn(reverseApi, "settings").mockResolvedValue(settings);
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
    expect(panel.getByText("＋ 添加模型").getAttribute("aria-pressed")).toBe("false");
    expect((panel.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
    await fireEvent.click(panel.getByText("保存模型"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).not.toHaveProperty("api_key");
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
});
