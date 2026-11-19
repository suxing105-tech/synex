/**
 * 钉住「测试环境默认断网」这件事本身。
 *
 * 断网桩在 __tests__/setup-no-network.ts，由 vite.config.ts 的 setupFiles 挂上。少了那一行、
 * 或者有人把桩改成了透传真 fetch，都会从这里先红——而不是像以前那样，只在 stderr 里多冒几行
 * ECONNREFUSED，等本机真有个服务占着 3000 时变成随机绿。
 */
import { describe, expect, it, vi } from "vitest";

describe("测试环境的 fetch 桩", () => {
  it("没被 mock 的请求直接拒绝，不去连本机 3000", async () => {
    await expect(fetch("/api/items?limit=1")).rejects.toThrow("测试不许发真实请求");
  });

  it("用例 stub 完再 unstub，退回的仍是这颗桩", async () => {
    const stub = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn());
    vi.unstubAllGlobals();
    expect(globalThis.fetch).toBe(stub);
    await expect(fetch("/api/items?limit=1")).rejects.toThrow("测试不许发真实请求");
  });
});
