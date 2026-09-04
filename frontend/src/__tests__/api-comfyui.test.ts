import { describe, it, expect, vi, beforeEach } from "vitest";
import { comfyuiApi } from "../lib/api";

describe("comfyuiApi", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: true,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  }

  it("status() → GET /api/integrations/comfyui/status", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ running: true, url: "http://127.0.0.1:8188", enabled: true, checked_at: 123 })
    );
    const s = await comfyuiApi.status();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/integrations/comfyui/status");
    expect(init.method).toBeUndefined();
    expect(s.running).toBe(true);
  });

  it("updateConfig({url, enabled}) → PUT with JSON body", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ running: false, url: "http://127.0.0.1:9999", enabled: false, checked_at: 0 })
    );
    const s = await comfyuiApi.updateConfig({ url: "http://127.0.0.1:9999", enabled: false });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/integrations/comfyui/config");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ url: "http://127.0.0.1:9999", enabled: false });
    expect(s.enabled).toBe(false);
  });

  it("openWorkflow(id) → POST /api/integrations/comfyui/open_workflow/<id>", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        image_id: 42,
        file_path: "C:/data/comfyui_temp/42.json",
        comfyui_url: "http://127.0.0.1:8188",
        browser_opened: true,
        message: "已生成",
      })
    );
    const r = await comfyuiApi.openWorkflow(42);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/integrations/comfyui/open_workflow/42");
    expect(init.method).toBe("POST");
    expect(r.image_id).toBe(42);
    expect(r.file_path.endsWith("42.json")).toBe(true);
  });

  it("HTTP 错误 → 抛出包含 URL/状态码的 Error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "no_workflow",
    } as unknown as Response);
    await expect(comfyuiApi.openWorkflow(99)).rejects.toThrow(/400/);
  });
});
