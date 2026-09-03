import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { imagesApi } from "../lib/api";

// 复用 happy-dom 的全局 fetch；mock 一个返回 ImportResponse 的 endpoint。
const originalFetch = globalThis.fetch;
let calls: { url: string; init?: RequestInit; body?: unknown }[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    // 提取 body 用于断言（FormData 是 FormData 实例）
    let body: unknown = init?.body;
    if (body instanceof FormData) {
      const obj: Record<string, unknown[]> = {};
      for (const [k, v] of body.entries()) {
        obj[k] = obj[k] ?? [];
        obj[k].push(v instanceof File ? `File:${v.name}` : v);
      }
      body = obj;
    }
    calls.push({ url: u, init, body });
    return new Response(
      JSON.stringify({
        saved: [{ id: 1, filename: "a.png", path: "/tmp/inbox/a.png" }],
        skipped: [{ filename: "b.jpg", reason: "unsupported_format" }],
        folder_id: null,
        inbox_dir: "/tmp/inbox",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("imagesApi.import", () => {
  it("走 POST /api/images/import，body 是 FormData（含 files + folder_id）", async () => {
    const f1 = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    const f2 = new File([new Uint8Array([4, 5])], "b.png", { type: "image/png" });
    const r = await imagesApi.import([f1, f2], 7);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("/api/images/import");
    expect(calls[0].init?.method).toBe("POST");
    const body = calls[0].body as Record<string, unknown[]>;
    expect(body.files).toEqual(["File:a.png", "File:b.png"]);
    expect(body.folder_id).toEqual(["7"]);
    // FormData 时不能手动覆盖 Content-Type
    const headers = calls[0].init?.headers as Record<string, string> | undefined;
    if (headers && headers["Content-Type"]) {
      expect(headers["Content-Type"]).not.toMatch(/application\/json/);
    }
  });

  it("folderId 为 null 时不附带 folder_id 字段", async () => {
    const f1 = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    const r = await imagesApi.import([f1], null);
    const body = calls[0].body as Record<string, unknown[]>;
    expect(body.files).toEqual(["File:a.png"]);
    expect(body.folder_id).toBeUndefined();
  });

  it("folderId 为 undefined 时不附带 folder_id 字段", async () => {
    const f1 = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    const r = await imagesApi.import([f1], undefined);
    const body = calls[0].body as Record<string, unknown[]>;
    expect(body.folder_id).toBeUndefined();
  });

  it("返回 ImportResponse 结构（saved/skipped/folder_id/inbox_dir）", async () => {
    const f1 = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    const r = await imagesApi.import([f1], null);
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0].filename).toBe("a.png");
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toBe("unsupported_format");
    expect(r.folder_id).toBeNull();
    expect(r.inbox_dir).toBe("/tmp/inbox");
  });

  it("空文件列表也会发出请求（让后端决定）；FormData 不附 files 字段（loop 不执行）", async () => {
    await imagesApi.import([], null);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("/api/images/import");
    expect((calls[0].body as Record<string, unknown[]>).files).toBeUndefined();
  });
});
