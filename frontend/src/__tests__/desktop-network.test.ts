import { afterEach, describe, expect, it, vi } from "vitest";
import { backendUrl, eventsUrl } from "../lib/backend-url";
import { settingsApi, scanApi, imagesApi } from "../lib/api";
import { connectEvents, disconnectEvents } from "../lib/ws";

afterEach(() => { disconnectEvents(); vi.unstubAllGlobals(); });

describe("桌面后端路由", () => {
  it("桌面 API、预览图和缩略图指向 sidecar，静态品牌资源保持原地址", () => {
    vi.stubGlobal("__TAURI__", {});
    for (const path of ["/api/settings", "/api/images/1/file?max=256", "/thumbs/abc.webp"]) {
      expect(backendUrl(path)).toBe(`http://127.0.0.1:8765${path}`);
    }
    for (const path of ["/logo.png", "blob:example", "data:image/png;base64,AA", "https://example.com/image.png"]) {
      expect(backendUrl(path)).toBe(path);
    }
  });

  it("浏览器版保持同源 API 和 WebSocket 地址", () => {
    vi.stubGlobal("__TAURI__", undefined);
    expect(backendUrl("/api/settings")).toBe("/api/settings");
    expect(eventsUrl()).toBe(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/events`);
  });

  it("保存目录、启动扫描和图片列表请求都使用桌面后端地址", async () => {
    vi.stubGlobal("__TAURI__", {});
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await settingsApi.update({ watch_dirs: ["D:\\images"] });
    await scanApi.start("D:\\images");
    await imagesApi.list();
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual([
      "http://127.0.0.1:8765/api/settings", "http://127.0.0.1:8765/api/scan", "http://127.0.0.1:8765/api/images",
    ]);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PUT");
  });

  it("实际 WebSocket 构造使用 sidecar 地址", () => {
    vi.stubGlobal("__TAURI__", {});
    const addresses: string[] = [];
    vi.stubGlobal("WebSocket", class { readyState = 1; constructor(url: string) { addresses.push(url); } close() {} });
    connectEvents();
    expect(addresses).toEqual(["ws://127.0.0.1:8765/ws/events"]);
  });

  it("HTML 响应显示明确连接错误，不暴露 JSON 解析异常", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!DOCTYPE html><html></html>", { headers: { "Content-Type": "text/html" } })));
    await expect(settingsApi.get()).rejects.toThrow("接口返回了网页");
  });
});
