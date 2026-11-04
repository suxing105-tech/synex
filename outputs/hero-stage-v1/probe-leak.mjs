// 换分支时旧内容到底摘不摘？三个形状在真 Chrome 里量一遍：
//   nested  —— 嵌套 {#if} 直接坐在 {:else} 里（本轮「再次创作」左栏换成的形状）
//   flat    —— 同一条链摊平，没有一个嵌套 if 坐在 else 里
//   wrapped —— else 分支的内容包在一个真元素里
// 为什么要量：happy-dom（vitest 那侧）跑 nested 时换完分支会把旧图留在 .cm-left 里，
// 看着像产品 bug。真浏览器里三种都干净，所以单元测试不许把「旧图必须消失」当规格。
// 仓库根跑：  node outputs/hero-stage-v1/probe-leak.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const req = createRequire(path.resolve("frontend/package.json"));
const P = (p) => path.resolve("frontend/node_modules", p);
const svelte = req("svelte/compiler");
const esbuild = req(path.resolve("frontend/node_modules/.pnpm/esbuild@0.21.5/node_modules/esbuild/lib/main.js"));

const EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.PORT || 9411);
const DIR = "outputs/hero-stage-v1/probe";

const body = (mid) => `
<script>
  let busy = $state(false);
  let job = $state(null);
  const src = "/a.png";
  $effect(() => { job = busy ? { state: "running" } : null; });
</script>
<div class="cm-left">
  {#if busy && job}
    <div class="cm-stage">{job.state}</div>
  {:else if false}
    <span>other</span>
${mid}  {/if}
</div>
<button onclick={() => (busy = !busy)}>go</button>`;

const SRC = {
  nested: body(`  {:else}
    {#if src}
      <img class="cm-hero" src={src} alt="x" />
    {:else}
      <div class="empty">no</div>
    {/if}
`),
  flat: body(`  {:else if src}
    <img class="cm-hero" src={src} alt="x" />
  {:else}
    <div class="empty">no</div>
`),
  wrapped: body(`  {:else}
    <div class="slot">
      {#if src}
        <img class="cm-hero" src={src} alt="x" />
      {:else}
        <div class="empty">no</div>
      {/if}
    </div>
`),
};

const plugin = {
  name: "svelte",
  setup(b) {
    b.onLoad({ filter: /\.svelte$/ }, ({ path: p }) => {
      const tag = path.basename(p, ".svelte");
      const r = svelte.compile(SRC[tag], { generate: "client", dev: false, filename: tag + ".svelte", css: "injected" });
      return { contents: r.js.code, loader: "js" };
    });
  },
};

const entry = `
import { mount, flushSync } from "svelte";
import Nested from "./nested.svelte";
import Flat from "./flat.svelte";
import Wrapped from "./wrapped.svelte";
const kids = (root) => {
  const l = root.querySelector(".cm-left");
  return l ? [...l.children].map((e) => e.tagName.toLowerCase() + "." + String(e.className).split(" ")[0]).join(",") : "NO ROOT";
};
const target = (id) => document.getElementById(id);
mount(Nested, { target: target("nested") });
mount(Flat, { target: target("flat") });
mount(Wrapped, { target: target("wrapped") });
window.__run = () => {
  const out = {};
  for (const name of ["nested", "flat", "wrapped"]) {
    const root = target(name);
    const go = () => { root.querySelector("button").click(); flushSync(); };
    out[name] = { initial: kids(root) };
    go(); out[name].stage = kids(root);
    go(); out[name].back = kids(root);
    go(); out[name].stage2 = kids(root);
    go(); out[name].back2 = kids(root);
  }
  return JSON.stringify(out, null, 1);
};
`;

fs.mkdirSync(DIR, { recursive: true });
for (const k of Object.keys(SRC)) fs.writeFileSync(path.join(DIR, k + ".svelte"), SRC[k]);
fs.writeFileSync(path.join(DIR, "entry.js"), entry);
await esbuild.build({
  entryPoints: [path.resolve(path.join(DIR, "entry.js"))],
  bundle: true, format: "iife", outfile: path.resolve(path.join(DIR, "bundle.js")),
  platform: "browser", conditions: ["browser"], plugins: [plugin],
  nodePaths: [path.resolve("frontend/node_modules"), P(".pnpm/svelte@5.57.0/node_modules")],
  logLevel: "warning",
});
const js = fs.readFileSync(path.join(DIR, "bundle.js"), "utf8");
const CLOSE = String.fromCharCode(60) + "/script>";
fs.writeFileSync(path.join(DIR, "probe.html"),
  '<!doctype html><meta charset="utf-8"><div id="nested"></div><div id="flat"></div><div id="wrapped"></div><' + "script>" + js + CLOSE);

const URLH = "file:///" + fs.realpathSync(path.join(DIR, "probe.html")).replace(/\\/g, "/");
const profile = fs.mkdtempSync(process.env.TEMP + "\\cleak-");
const chrome = spawn(EXE, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
  "--window-size=900,700", "--disable-gpu", "about:blank"], { stdio: "ignore" });
chrome.unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { await sleep(300); try { ready = (await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).ok); } catch { /* 还没起来 */ } }
if (!ready) { console.log("NO DEVTOOLS：Chrome 起不来，检查 " + EXE); process.exit(2); }
await fetch("http://127.0.0.1:" + PORT + "/json/new?" + encodeURIComponent(URLH), { method: "PUT" }).catch(() => {});
await sleep(2500);
const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("file://"));
if (!page) { console.log("NO PAGE"); process.exit(3); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws fail")); });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
await send("Runtime.enable");
console.log("真 Chrome（每种写法切四次分支，旧内容留在树上的话会并排出现在同一行里）：");
console.log(await ev("window.__run()"));
// 先收 WebSocket 再收 Chrome：反过来会在 Windows 上撞 libuv 的 async 断言，
// 输出是好的、退出码却是 1，看着像跑挂了
ws.close();
await sleep(200);
chrome.kill();
process.exit(0);