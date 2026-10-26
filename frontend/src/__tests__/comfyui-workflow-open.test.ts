import { beforeEach, describe, expect, it, vi } from "vitest";
import { openWorkflowForMedia } from "../lib/comfyui-window";
import { comfyuiApi } from "../lib/api";
import { isTauri } from "../lib/tauri";

// 「在 ComfyUI 中打开」对图片和视频是同一条路：
// 桌面版 = 后端落临时文件 + Rust 开应用内 ComfyUI 窗口注入 loadGraphData；
// 浏览器版 = 复用同名标签页 + 落临时文件，用户自己 File → Open。
// 浏览器版有个硬约束：window.open 必须发生在点击手势的同步段，所以顺序也要锁。

vi.mock("../lib/tauri", () => ({ isTauri: vi.fn(() => false) }));
vi.mock("../lib/api", () => ({ itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) }, comfyuiApi: { openWorkflow: vi.fn() } }));

const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(comfyuiApi.openWorkflow).mockImplementation(async () => {
    calls.push("api");
    return {
      ok: true,
      image_id: 7,
      file_path: "C:/data/comfyui_temp/clip.json",
      workflow_name: "clip",
      comfyui_url: "http://127.0.0.1:8188",
      browser_opened: false,
      message: "",
      workflow: { nodes: [{ id: 1, type: "SaveVideo" }], links: [] },
    };
  });
  (window as any).open = vi.fn(() => {
    calls.push("open");
    return { focus: vi.fn() };
  });
  delete (window as any).__TAURI__;
});

describe("openWorkflowForMedia", () => {
  it("浏览器版：先复用同名标签页，再落临时文件，并给出 File → Open 提示", async () => {
    const message = await openWorkflowForMedia(7, "clip.mp4", "http://127.0.0.1:8188");
    expect(window.open).toHaveBeenCalledWith("http://127.0.0.1:8188", "suxing_comfyui");
    expect(calls.slice(0, 2), "window.open 必须发生在请求后端之前").toEqual(["open", "api"]);
    expect(message).toContain("clip.json 已写入");
    expect(message).toContain("File → Open");
  });

  it("浏览器版：没给 URL 时退回默认 8188", async () => {
    await openWorkflowForMedia(7, "clip.mp4", "");
    expect(window.open).toHaveBeenCalledWith("http://127.0.0.1:8188", "suxing_comfyui");
  });

  it("桌面版：走 open_comfy_workflow 注入工作流，不碰 window.open", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as any).__TAURI__ = { core: { invoke } };
    const message = await openWorkflowForMedia(7, "人物三视图.png", "http://127.0.0.1:8188");
    expect(invoke).toHaveBeenCalledWith("open_comfy_workflow", {
      url: "http://127.0.0.1:8188",
      name: "人物三视图",
      workflow: { nodes: [{ id: 1, type: "SaveVideo" }], links: [] },
    });
    expect(window.open).not.toHaveBeenCalled();
    expect(message).toBe("已在 ComfyUI 中打开工作流");
  });

  it("后端报错原样抛出，交给调用方转成中文提示", async () => {
    vi.mocked(comfyuiApi.openWorkflow).mockRejectedValue(new Error("→ 400: no_workflow"));
    await expect(openWorkflowForMedia(7, "clip.mp4", "http://127.0.0.1:8188")).rejects.toThrow("no_workflow");
  });
});