import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import CloudServices from "../components/CloudServices.svelte";

/**
 * 设置 → 模型与反推里的「RunningHub 云端生成」（收费模型 API）。
 *
 * 这张卡最要紧的不是好不好看，是两件不可逆的事：API Key 会不会被回显出去（回显＝落盘＝会泄露），
 * 以及花费闸与「待取回」会不会说谎（钱已经花出去了，产物还挂在会过期的链接上）。
 * 所以每条都直接盯 DOM 与真实请求参数。
 *
 * Key 的输入口不在这里了：RunningHub 一把 Key 走天下，反推与一键同款共用同一把，
 * 输入口只留在上面那张「模型服务API」里。这张卡只报状态 + 把「改 Key」这颗按钮送过去——
 * 下面这几条钉的就是「这里既没有第二个输入框，也不许偷偷写 Key」。
 */

const http = vi.fn();
// vi.mock 工厂会被提升到文件顶部，拿不到本文件的 http，所以路由挂在 globalThis 上（同 clone-settings.test.ts）
vi.mock("../lib/api", () => ({
  http: (path: string, init?: RequestInit) => (globalThis as any).__http(path, init),
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  foldersApi: { tree: vi.fn(async () => []), archived: vi.fn(async () => []), restore: vi.fn(async () => ({ ok: true })) },
  comfyuiApi: { status: vi.fn(async () => ({ running: false, enabled: false, url: "" })) },
  settingsApi: { get: vi.fn(async () => ({})), update: vi.fn(async (cfg: unknown) => cfg) },
}));
(globalThis as any).__http = http;

const SECRET_KEY = "sk-SECRET-VALUE-DO-NOT-LEAK";

const ACCOUNT = {
  id: 1, provider: "runninghub", provider_label: "RunningHub", name: "默认",
  base_url: "https://rh.example/openapi", proxy_mode: "system", proxy_label: "跟随系统代理",
  enabled: true, has_api_key: true, key_persistence: "encrypted",
  // 后端契约里根本没有这个字段（只回 has_api_key）。这里故意塞进去：
  // 万一后端哪天误发，界面也不许把它画出来——所以断言看的是 DOM，不是接口。
  api_key: SECRET_KEY,
};

const PRESETS = [
  {
    key: "image", capability: "image", capability_word: "图片", action_word: "出图", name: "图片API",
    model_label: "Seedream v5 lite", blurb: "图生图与文生图，出图比本机那条快。", provider: "runninghub",
    provider_label: "RunningHub", verified: true, notes: [],
  },
  {
    key: "video", capability: "video", capability_word: "视频", action_word: "出片", name: "视频API",
    model_label: "Seedance 2.0", blurb: "参考图 9 / 视频 3 / 音频 3，出 4–15 秒。", provider: "runninghub",
    provider_label: "RunningHub", verified: true, notes: [],
  },
  {
    key: "audio", capability: "audio", capability_word: "音频", action_word: "出声音", name: "音频API",
    model_label: "voice-clone + speech-2.8-hd", blurb: "音色克隆与合成，端点还没实测过。", provider: "runninghub",
    provider_label: "RunningHub", verified: false, notes: ["提交字段未实测"],
  },
];

const PENDING = {
  id: 77, job_id: "job-77", capability: "video", model: "seedance-2.0", state: "error",
  state_label: "生成失败", remote_task_id: "rh-task-77", cost_coins: 12,
  error: "产物链接已过期", created_at: "2026-11-03 10:00",
};

const baseStatus = (over: Record<string, unknown> = {}) => ({
  cloud_enabled: true, cloud_max_single_coins: 0, cloud_max_daily_coins: 0,
  availability: { available: true, reason: "账号、Key 与余额都正常" },
  accounts: [ACCOUNT], presets: PRESETS,
  spend: { today_coins: 0, month: "11月", counts: {}, month_coins: 0, recent: [] },
  pending: [], seeded: true, ...over,
});

let status: Record<string, unknown> = baseStatus();

type HttpCall = [string, RequestInit | undefined];

const call = (path: string, method = "GET") =>
  http.mock.calls.find(
    ([path_, init]) => path_ === path && String((init as RequestInit | undefined)?.method ?? "GET") === method,
  ) as HttpCall | undefined;

const bodyOf = (hit: HttpCall | undefined) => JSON.parse(String(hit?.[1]?.body ?? "{}")) as Record<string, unknown>;
/** 按顺序拿到全部 PUT /cloud/settings：开关与「保存云端设置」各发一条，得能分开看。 */
const settingsCalls = () => http.mock.calls.filter(
  ([p, init]) => String(p) === "/api/clone/cloud/settings" && (init as RequestInit | undefined)?.method === "PUT",
) as HttpCall[];

function routes(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  status = baseStatus(over);
  const accountResponse = { ...ACCOUNT, api_key: undefined };
  const map: Record<string, unknown> = {
    "/api/clone/cloud/status": () => status,
    "/api/clone/cloud/settings": (init?: RequestInit) => {
      const patch = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      // 服务端会记住这三项。不写回 status，保存后那次 reload 就把刚存的值冲掉，
      // 测出来的「开关弹回去」是 mock 的毛病，不是组件的。
      status = { ...status, ...patch };
      return patch;
    },
    "/api/clone/cloud/accounts": () => accountResponse,
    "/api/clone/cloud/accounts/1": () => accountResponse,
    "/api/clone/cloud/accounts/1/test": () => ({ ok: true, reason_code: "ok", message: "连通正常，余额 1200 RH币", remain_coins: 1200 }),
    "/api/clone/cloud/tasks/77/refetch": () => ({ task_id: 77, image_ids: [88], outputs: [{ id: 88, kind: "video", filename: "out.mp4", thumbnail_url: "" }], count: 1, cost_coins: 12 }),
    "/api/clone/cloud/templates/sync": () => ({ ok: true, created: 0, updated: 3 }),
    ...extra,
  };
  http.mockImplementation(async (path: string, init?: RequestInit) => {
    // 最长前缀匹配：否则 /api/clone/cloud/accounts 会把 /api/clone/cloud/accounts/1 抢走
    const key = Object.keys(map).filter((k) => path.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`未预演的接口：${path}`);
    const value = map[key];
    return typeof value === "function" ? (value as (i?: RequestInit) => unknown)(init) : value;
  });
}

const keyLine = (screen: { container: HTMLElement }) =>
  screen.container.querySelector(".cloud-key")?.textContent ?? "";

afterEach(() => { cleanup(); http.mockReset(); });

it("Key 只报状态不回显：这张卡没有输入框，后端误发明文时 DOM 里也不许出现一个字符", async () => {
  routes();
  const screen = render(CloudServices, {});
  await screen.findByText(/三条 API 挂在/);
  expect(keyLine(screen)).toContain("已配置");
  expect(screen.container.textContent).not.toContain(SECRET_KEY);
  // 一把 Key 只有一个家：这张卡不再摆第二个输入框，免得同一把 Key 存两处、一边新一边旧
  expect(screen.queryByLabelText("云端 API Key")).toBeNull();
  const inputs = Array.from(screen.container.querySelectorAll("input")) as HTMLInputElement[];
  expect(inputs.some((input) => input.type === "password")).toBe(false);
});

it("库里排在前面的空账号不算「这把 Key」：卡片和「测一下」都跟着后端标的那一行", async () => {
  // 两行账号：下标第一条没有 Key（历史遗留 / 测试留下的空壳），后端把 is_shared 标在真正会用的第二行
  routes({
    accounts: [
      { ...ACCOUNT, id: 1, name: "空的", has_api_key: false, is_shared: false },
      { ...ACCOUNT, id: 9, name: "真用的", has_api_key: true, is_shared: true },
    ],
  }, {
    "/api/clone/cloud/accounts/9/test": () => ({ ok: true, reason_code: "ok", message: "连通正常，余额 1081 RH币", remain_coins: 1081 }),
  });
  const screen = render(CloudServices, {});
  await screen.findByText(/三条 API 挂在/);
  expect(keyLine(screen)).toContain("已配置");
  await fireEvent.click(screen.getByRole("button", { name: "测一下连通与余额" }));
  await screen.findByText(/余额 1081/);
  // 测的就是出图会用的那一把：打到 9，不是数组下标那条 1
  expect(call("/api/clone/cloud/accounts/9/test", "POST")).toBeTruthy();
  expect(call("/api/clone/cloud/accounts/1/test", "POST")).toBeUndefined();
});

it("「改 Key」只把人送去上面那张卡，自己不写接口：一把 Key 不许有两个入口", async () => {
  routes();
  const seen: string[] = [];
  const onEvent = (event: Event) => seen.push(event.type);
  window.addEventListener("edit-cloud-key", onEvent);
  const screen = render(CloudServices, {});
  await screen.findByText(/三条 API 挂在/);
  await fireEvent.click(screen.getByRole("button", { name: "改 Key" }));
  expect(seen).toEqual(["edit-cloud-key"]);
  await tick();
  expect(http.mock.calls.filter(([path]) => String(path).startsWith("/api/clone/cloud/accounts"))).toHaveLength(0);
  expect(screen.container.textContent).not.toContain(SECRET_KEY);
  window.removeEventListener("edit-cloud-key", onEvent);
});

it("上面那张卡改了 Key，这张卡自己重读一遍，不用人重开设置页", async () => {
  routes();
  const screen = render(CloudServices, {});
  await screen.findByText(/三条 API 挂在/);
  const hits = () => http.mock.calls.filter(([path]) => path === "/api/clone/cloud/status").length;
  const before = hits();
  status = baseStatus({ accounts: [{ ...ACCOUNT, has_api_key: false }] });
  window.dispatchEvent(new Event("cloud-credentials-changed"));
  await waitFor(() => expect(hits()).toBeGreaterThan(before));
  await waitFor(() => expect(keyLine(screen)).toContain("还没填"));
});

it("还没填 Key 时给「去填 Key」，测余额那颗点不动：没 Key 就不该往外发请求", async () => {
  routes({
    accounts: [{ ...ACCOUNT, has_api_key: false }],
    availability: { available: false, reason: "这个账号还没填 API Key" },
  });
  const screen = render(CloudServices, {});
  await screen.findByText(/三条 API 挂在/);
  await fireEvent.click(screen.getByRole("button", { name: "去填 Key" }));
  expect(keyLine(screen)).toContain("还没填");
  expect((screen.getByRole("button", { name: "测一下连通与余额" }) as HTMLButtonElement).disabled).toBe(true);
  expect(http.mock.calls.filter(([path]) => String(path).endsWith("/test"))).toHaveLength(0);
});

it("三条 API 收成一行清单；没实测过的那条写在折叠说明里，别让人以为端点是稳的", async () => {
  routes();
  const screen = render(CloudServices, {});
  const line = await screen.findByText(/三条 API 挂在/);
  expect(line.textContent).toContain("图片API（Seedream v5 lite）");
  expect(line.textContent).toContain("视频API（Seedance 2.0）");
  expect(line.textContent).toContain("音频API（voice-clone + speech-2.8-hd）");
  const notes = screen.container.querySelector(".cloud-notes");
  expect(notes?.querySelector("summary")?.textContent).toContain("3 条里有 1 条");
  expect(notes?.querySelectorAll("li")).toHaveLength(1);
  expect(notes?.textContent).toContain("音频API：提交字段未实测");
  expect(notes?.textContent).not.toContain("图片API");
  // 恢复快捷方式只同步模板，不动 Key
  await fireEvent.click(screen.getByRole("button", { name: "恢复这三条" }));
  await waitFor(() => expect(call("/api/clone/cloud/templates/sync", "POST")).toBeTruthy());
  expect(JSON.parse(String(call("/api/clone/cloud/templates/sync", "POST")?.[1]?.body ?? "{}"))).toEqual({});
});

it("总开关一拨就 PUT /settings 落库；花费上限仍走自己那颗「保存花费上限」", async () => {
  routes({ cloud_enabled: false, availability: { available: false, reason: "云端生成总开关是关的" } });
  const screen = render(CloudServices, {});
  await screen.findByText(/三条 API 挂在/);
  const sw = screen.getByLabelText("启用云端生成") as HTMLInputElement;
  expect(sw.checked).toBe(false);
  expect(screen.container.textContent).toContain("云端生成总开关是关的");
  await fireEvent.change(sw, { target: { checked: true } });
  await tick();
  expect(sw.checked).toBe(true);
  // 开关自己只发这一个字段：不顺手把两个上限按界面上的当前值盖回去
  await waitFor(() => expect(call("/api/clone/cloud/settings", "PUT")).toBeTruthy());
  expect(bodyOf(call("/api/clone/cloud/settings", "PUT"))).toEqual({ cloud_enabled: true });
  const more = screen.container.querySelector(".cloud-more") as HTMLDetailsElement;
  expect(more).toBeTruthy();
  more.open = true;
  await tick();
  await fireEvent.click(screen.getByRole("button", { name: "保存花费上限" }));
  await waitFor(() => expect(settingsCalls().length).toBe(2));
  expect(bodyOf(settingsCalls()[1])).toEqual({
    cloud_enabled: true, cloud_max_single_coins: 0, cloud_max_daily_coins: 0,
  });
});

it("待取回列表非空时给「取回结果」，点了只重新查那一条任务、不重新生成", async () => {
  routes({ pending: [PENDING] });
  const screen = render(CloudServices, {});
  await screen.findByText("待取回的产物");
  expect(screen.getByText("待取回的产物").nextElementSibling?.textContent).toContain("视频");
  expect(screen.getByRole("button", { name: "取回结果" })).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "取回结果" }));
  await waitFor(() => expect(call("/api/clone/cloud/tasks/77/refetch", "POST")).toBeTruthy());
  expect(call("/api/clone/cloud/tasks/77/refetch", "POST")?.[1]).toBeTruthy();
  await waitFor(() => expect(screen.container.querySelector(".cloud-notice")?.textContent).toContain("取回 1 个产物"));
  // 取回只是再查一次那条任务：不重新生成、不二次扣费，所以一次 generate 都不许发
  expect(http.mock.calls.filter(([p]) => p === "/api/clone/generate").length).toBe(0);
  expect(http.mock.calls.filter(([p]) => p === "/api/clone/cloud/tasks/77/refetch").length).toBe(1);
});

it("这张卡不说「去设置 → 模型与反推里打开」：那句是给一键同款弹窗写的，这里的开关就在头顶", async () => {
  routes({
    cloud_enabled: false,   // 卡片自己查得出的那一步：总开关在这张卡头顶
    availability: { available: false, reason: "云端生成没启用，去设置 → 模型与反推里打开" },
    accounts: [{ ...ACCOUNT, has_api_key: true }],
  });
  const screen = render(CloudServices, {});
  await screen.findByText(/三条 API 挂在/);
  const state = screen.container.querySelector(".cloud-state")?.textContent ?? "";
  expect(state).toContain("云端生成总开关是关的");
  expect(state).not.toContain("去设置");
  expect(screen.container.querySelector(".cloud-state")?.className).not.toContain("cloud-ready");
});

it("本地查不出具体差哪一步时，后端那句 reason 仍原样说给人听", async () => {
  const reason = "余额不足，今天的花费已经到顶了";
  routes({ availability: { available: false, reason } }); // 账号开着、Key 也填了 → blockers 为空
  const screen = render(CloudServices, {});
  await screen.findByText(/三条 API 挂在/);
  expect(screen.container.querySelector(".cloud-state")?.textContent).toContain(reason);
});

it("差两步就列两条：开关关着 + Key 没填，一句都不许省", async () => {
  routes({
    cloud_enabled: false,
    availability: { available: false, reason: "云端生成没启用，去设置 → 模型与反推里打开" },
    accounts: [{ ...ACCOUNT, has_api_key: false }],
  });
  const screen = render(CloudServices, {});
  await screen.findByText(/三条 API 挂在/);
  const list = screen.container.querySelector(".cloud-blockers")?.textContent ?? "";
  expect(list).toContain("云端生成总开关是关的");
  expect(list).toContain("这把 API Key 还没填");
});

it("卡片里的指路话不引用旧标题：那一节已经改名「模型服务API」，旧名一条都不许留", () => {
  // 「反推模型」那节上一轮重做成了「模型服务API」的厂商卡片页，不再有服务商下拉。
  // 组件测试的断言只看子串，抓不到「把人支到一个屏幕上已经不存在的标题」，所以直接扫源码。
  const source = readFileSync("src/components/CloudServices.svelte", "utf8").replace(/\r\n/g, "\n");
  expect(source).not.toContain("反推模型");
  expect(source).not.toContain("服务商选成");
  expect(source.match(/模型服务API/g)?.length).toBeGreaterThanOrEqual(4);
});
