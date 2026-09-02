import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { imagesApi } from "../lib/api";

// 用全局 fetch；happy-dom 默认提供
const originalFetch = globalThis.fetch;
let calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({ url: u, init });
    const body = JSON.stringify({ id: 7, filename: "renamed.png" });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("imagesApi rename / reveal", () => {
  it("rename 走 PATCH + body {filename}, 期望解码为 ImageSummary", async () => {
    const r = await imagesApi.rename(7, "renamed");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("/api/images/7/filename");
    expect(calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ filename: "renamed" });
    expect(r).toEqual({ id: 7, filename: "renamed.png" });
  });

  it("reveal 走 POST，无 body", async () => {
    const r = await imagesApi.reveal(12);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("/api/images/12/reveal");
    expect(calls[0].init?.method).toBe("POST");
    expect(r.id).toBe(7);  // mock 返回固定 body
  });
});
