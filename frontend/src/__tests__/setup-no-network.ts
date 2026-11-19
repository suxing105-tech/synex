/**
 * 测试会话里的 fetch 一律不许真连网络。
 *
 * 为什么要这一层：happy-dom 的 location 默认是 http://localhost:3000，而 lib/api.ts 的
 * backendUrl() 只在 Tauri 里才补 http://127.0.0.1:8765——所以在测试里 fetch("/api/items?…")
 * 是个相对 URL，Node 真的会去连本机 3000 端口。门禁每跑一次就在 stderr 里冒一串 ECONNREFUSED；
 * 更要紧的是另一头：哪天本机有服务在 3000 上听着，这些用例就会拿到真响应，红绿取决于本机装了
 * 什么——随机红还能查，随机绿基本查不出来。
 *
 * 要假数据就在自己的用例里 vi.stubGlobal("fetch", mock)：这颗桩是它记下的「原值」，
 * unstubAllGlobals 之后断网仍然生效（钉在 no-real-network.test.ts）。
 */

function requestedUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && typeof (input as { url?: unknown }).url === "string") {
    return (input as { url: string }).url;
  }
  return String(input);
}

globalThis.fetch = ((input: unknown) =>
  Promise.reject(
    new Error(
      "测试不许发真实请求：" + requestedUrl(input) + "，要假数据请在本用例里 vi.stubGlobal(\"fetch\", mock)",
    ),
  )) as unknown as typeof fetch;
