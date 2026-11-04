// 「再次创作」顶部那一格的三态实拍：静止 / 生成中等待台 / 跑完直接展示新产出。
// 不打服务商接口：/api/clone/generate 与 jobs/current 在页面里被 fetch 拦掉，出图那一步不发生，
// 只把「提交之后前端会看到什么」照实走一遍（提交本身走的是真按钮、真代码路径）。
// 仓库根跑：  $TAG='-v1' node outputs/hero-stage-v1/shot_hero.mjs
import fs from "node:fs";
import { spawn } from "node:child_process";

const EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.PORT || 9407);
const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const TAG = process.env.TAG || "";
const OUT = "outputs/hero-stage-v1/probe-short";
const PAGE_URL = "http://127.0.0.1:5199/";
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(process.env.TEMP + "\\cherostage-");
const chrome = spawn(EXE, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
  "--window-size=" + W + "," + H, "--force-device-scale-factor=1", "--hide-scrollbars", "--disable-gpu", "about:blank"], { stdio: "ignore" });
chrome.unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ready = false;
for (let i = 0; i < 60 && !ready; i++) { await sleep(300); try { ready = (await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).ok); } catch { /* 等 Chrome */ } }
if (!ready) { console.log("NO DEVTOOLS"); process.exit(2); }
await fetch("http://127.0.0.1:" + PORT + "/json/new?" + encodeURIComponent(PAGE_URL), { method: "PUT" }).catch(() => {});
await sleep(3500);
const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith(PAGE_URL));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws fail")); });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) console.log("PAGE EXC", JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(OUT + "/" + name + ".png", Buffer.from(r.data, "base64"));
  console.log("SHOT " + name);
};
await send("Page.enable");
await send("Runtime.enable");

// 1) 打开图库里第一张图片卡的「再次创作」
console.log("open:", await ev(`(() => {
  const btn = document.querySelector('.media-clone-btn');
  if (!btn) return 'no clone btn';
  btn.click();
  return 'clicked';
})()`));
await sleep(2200);

const idleProbe = await ev(`(() => {
  const panel = document.querySelector('.cm-panel');
  const hero = document.querySelector('.cm-left img.cm-hero');
  const goBtn = document.querySelector('.cm-go');
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
  const pr = panel.getBoundingClientRect();
  return JSON.stringify({
    innerH: window.innerHeight, hero: box(hero),
    panel: { h: Math.round(pr.height), scrollH: panel.scrollHeight, clientH: panel.clientHeight },
    go: box(goBtn),
    goInsidePanel: goBtn ? (goBtn.getBoundingClientRect().bottom <= pr.bottom + 1) : null,
    panelScrolls: panel.scrollHeight > panel.clientHeight + 1,
  }, null, 1);
})()`);
console.log("SHORT-IDLE " + idleProbe);
await shot("short-idle");

// 3) 拦掉两个接口 + 记下 clone.ts 的真实模块地址（HMR 之后带 ?t=，拿错地址就是两个 store 实例）
await ev(`(async () => {
  const real = window.fetch.bind(window);
  window.__job = null;
  window.fetch = (u, init) => {
    const p = String(u);
    if (window.__job && (p.startsWith('/api/clone/generate') || p.startsWith('/api/clone/jobs/current'))) {
      return Promise.resolve(new Response(JSON.stringify(window.__job), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return real(u, init);
  };
  const ids = await fetch('/api/images?limit=6').then((r) => r.json());
  window.__ids = (ids.items || []).map((i) => i.id).filter((n) => typeof n === 'number');
  const hit = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\\/src\\/lib\\/clone\\.ts/.test(n));
  window.__cloneUrl = hit.length ? hit[hit.length - 1] : location.origin + '/src/lib/clone.ts';
  window.__mod = await import(window.__cloneUrl);
  return 'ok';
})()`);
console.log("ids:", await ev("JSON.stringify({ids: window.__ids, url: window.__cloneUrl})"));
// 4) 提示词没预填就补一句（生成那颗要它才亮），然后点真·生成：请求被拦，服务商那边什么都没发生
await ev(`(() => {
  const ta = document.querySelector('textarea.cm-textarea');
  if (ta && !ta.value) {
    ta.value = '把这套视觉再抽一次（实拍用）';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return 'ok';
})()`);
await sleep(400);
await ev(`(() => { window.__job = { active: true, job_id: 'shot-hero', state: 'running', running: true, template_id: null, image_ids: [], outputs: [], message: '模型正在出图 · 第 3 步 / 共 4 步', elapsed: 41 }; return 1; })()`);
await ev(`(() => { const b = [...document.querySelectorAll('.cm-go')][0]; if (b && !b.disabled) { b.click(); return 'go'; } return b ? 'disabled' : 'no go'; })()`);
await sleep(1200);


const probe = await ev(`(() => {
  const panel = document.querySelector('.cm-panel');
  const hero = document.querySelector('.cm-left img.cm-hero');
  const st = document.querySelector('.cm-stage');
  const card = document.querySelector('.cm-stage-card');
  const goBtn = document.querySelector('.cm-go');
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
  const pr = panel.getBoundingClientRect();
  return JSON.stringify({
    innerH: window.innerHeight,
    hero: box(hero), stage: box(st),
    stageCardClip: card ? card.scrollHeight - card.clientHeight : null,
    panel: { h: Math.round(pr.height), scrollH: panel.scrollHeight, clientH: panel.clientHeight },
    go: box(goBtn),
    goInsidePanel: goBtn ? (goBtn.getBoundingClientRect().bottom <= pr.bottom + 1) : null,
    panelScrolls: panel.scrollHeight > panel.clientHeight + 1,
  }, null, 1);
})()`);
console.log("SHORT-STAGE " + probe);
await shot("short-stage");
ws.close();
await sleep(200);
chrome.kill();
process.exit(0);
