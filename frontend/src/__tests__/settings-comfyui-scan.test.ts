import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import SettingsModal from "../components/SettingsModal.svelte";
import { comfyuiApi } from "../lib/api";

// 换机器最容易翻车的一处：ComfyUI 装了、也开着，但端口不是 8188。
// 设置页必须说清为什么连不上，并且把本机真在跑的那个找出来让人一键换过去。
const SAVED = "http://127.0.0.1:8188";
const FOUND = "http://127.0.0.1:8189";
const REFUSED = "127.0.0.1:8188 上没有服务在监听（连接被拒绝）";

vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  settingsApi: { get: vi.fn(async () => ({ watch_dirs: [], live_enabled: true })), update: vi.fn(async (cfg: any) => cfg) },
  comfyuiApi: {
    status: vi.fn(async (draft?: string) => ({
      running: false,
      enabled: true,
      url: draft || SAVED,
      reason: draft ? `本机 ${draft} 上没有人应答，确认 ComfyUI 已经启动、端口没填错` : REFUSED,
      reason_code: "refused",
    })),
    scan: vi.fn(async () => ({
      current: SAVED,
      running: false,
      reason: REFUSED,
      reason_code: "refused",
      candidates: [{ url: FOUND, version: "0.43.0" }],
    })),
    updateConfig: vi.fn(async (patch: any) => ({
      running: true, enabled: true, url: patch.url, reason: "", reason_code: "",
    })),
  },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  foldersApi: { tree: vi.fn(async () => []), archived: vi.fn(async () => []), restore: vi.fn(async () => ({ ok: true })) },
  healthApi: { get: vi.fn(async () => ({ available: true, missing: [], tools: {} })) },
  http: vi.fn(async (path: string) => (path === "/api/reverse-prompt-settings" ? { default_model_id: null, instruction: "", default_instruction: "" } : [])),
}));

beforeEach(() => {
  vi.mocked(comfyuiApi.status).mockClear();
  vi.mocked(comfyuiApi.scan).mockClear();
  vi.mocked(comfyuiApi.updateConfig).mockClear();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const urlInput = (screen: { getByLabelText: (n: string) => HTMLElement }) =>
  screen.getByLabelText("ComfyUI 服务地址") as HTMLInputElement;

it("连不上时把原因摊开显示，不再只有一句未连接", async () => {
  const screen = render(SettingsModal, { open: true, tab: "ComfyUI" });
  await waitFor(() => expect(comfyuiApi.status).toHaveBeenCalled());
  await waitFor(() => expect(screen.container.querySelector(".comfyui-notice")?.textContent).toContain("没有服务在监听"));
  expect(screen.getByText("未连接 ComfyUI")).toBeTruthy();
});

it("扫描本机后列出候选，点「用这个」直接保存并当场连上", async () => {
  const screen = render(SettingsModal, { open: true, tab: "ComfyUI" });
  await waitFor(() => expect(comfyuiApi.status).toHaveBeenCalled());
  expect(screen.container.querySelector(".comfyui-found")).toBeNull();

  await fireEvent.click(screen.getByRole("button", { name: "扫描本机 ComfyUI" }));
  await waitFor(() => expect(comfyuiApi.scan).toHaveBeenCalled());
  await waitFor(() => expect(screen.container.querySelector(".comfyui-found-url")?.textContent).toBe(FOUND));
  expect(screen.getByText("ComfyUI 0.43.0")).toBeTruthy();

  await fireEvent.click(screen.getByRole("button", { name: `改用 ${FOUND}` }));
  await waitFor(() => expect(comfyuiApi.updateConfig).toHaveBeenCalledWith({ url: FOUND, enabled: true }));
  await waitFor(() => expect(screen.container.textContent).toContain(`已改用 ${FOUND}，连上了。`));
  expect(screen.container.querySelector(".comfyui-found")).toBeNull();
  expect(urlInput(screen).value).toBe(FOUND);
});

it("输入框里没保存的地址先探测，探完不会被打回旧值", async () => {
  const screen = render(SettingsModal, { open: true, tab: "ComfyUI" });
  await waitFor(() => expect(comfyuiApi.status).toHaveBeenCalled());

  await fireEvent.input(urlInput(screen), { target: { value: FOUND } });
  await fireEvent.click(screen.getByRole("button", { name: "重新探测" }));
  await waitFor(() => expect(comfyuiApi.status).toHaveBeenLastCalledWith(FOUND));
  await waitFor(() => expect(screen.container.querySelector(".comfyui-notice")?.textContent).toContain("没有人应答"));

  // 探测是只读的：既不能改输入框，也不能顺手写 config.json
  expect(urlInput(screen).value).toBe(FOUND);
  expect(comfyuiApi.updateConfig).not.toHaveBeenCalled();
});

it("打开设置只探一次，改输入框不会每敲一个字发一次探测", async () => {
  const screen = render(SettingsModal, { open: true, tab: "ComfyUI" });
  await waitFor(() => expect(comfyuiApi.status).toHaveBeenCalledTimes(1));
  const input = urlInput(screen);
  await fireEvent.input(input, { target: { value: "http://127.0.0.1:8" } });
  await fireEvent.input(input, { target: { value: "http://127.0.0.1:8189" } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(comfyuiApi.status).toHaveBeenCalledTimes(1);
});
