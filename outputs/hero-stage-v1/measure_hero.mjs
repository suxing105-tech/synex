// 「适当放大展示图」到底放到多少：在真浏览器里把几个候选 max-height 各套一遍，
// 量展示图多大、弹窗多高、弹窗自己会不会开始滚（滚起来就等于顶格了，不能再加）。
// 仓库根跑：  node outputs/hero-stage-v1/measure_hero.mjs
import { spawn } from "node:child_process";
const EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.PORT || 9409);
const PAGE_URL = "http://127.0.0.1:5199/";
const profile = (await import("node:fs")).mkdtempSync(process.env.TEMP + "\\chero-");
const chrome = spawn(EXE, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
  "--window-size=" + (process.env.W || 1440) + "," + (process.env.H || 900), "--force-device-scale-factor=1", "--hide-scrollbars", "--disable-gpu", "about:blank"], { stdio: "ignore" });
chrome.unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { await sleep(300); try { ready = (await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).ok); } catch { } }
if (!ready) { console.log("NO DEVTOOLS"); process.exit(2); }
await fetch("http://127.0.0.1:" + PORT + "/json/new?" + encodeURIComponent(PAGE_URL), { method: "PUT" }).catch(() => { });
await sleep(3500);
const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith(PAGE_URL));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws fail")); });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) console.log("EXC " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400)); return r.result?.value; };
await send("Page.enable"); await send("Runtime.enable");
console.log(await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = await fetch('/api/images?limit=40').then((r) => r.json());
  const items = pick.items || [];
  const tall = items.find((i) => i.height > i.width);
  const wide = items.find((i) => i.width > i.height);
  const out = { inner: { w: innerWidth, h: innerHeight }, vh38: Math.round(innerHeight * 0.38) };
  const open = async (item) => {
    document.querySelectorAll('.cm-backdrop').forEach((e) => e.remove());
    const btn = [...document.querySelectorAll('.media-clone-btn')][0];
    if (!btn) return false;
    btn.click();
    await sleep(1800);
    return Boolean(document.querySelector('.cm-panel'));
  };
  const measure = async (label) => {
    const hero = document.querySelector('.cm-left img.cm-hero, .cm-left video.cm-hero');
    const panel = document.querySelector('.cm-panel');
    if (!hero || !panel) return { [label]: 'no hero' };
    await sleep(160);
    const r = hero.getBoundingClientRect(), pr = panel.getBoundingClientRect();
    return { [label]: { heroW: Math.round(r.width), heroH: Math.round(r.height), panelH: Math.round(pr.height),
      panelMax: getComputedStyle(panel).maxHeight, scrolls: panel.scrollHeight > panel.clientHeight + 1,
      spareVH: Math.round((innerHeight * 0.9 - pr.height) / innerHeight * 100) } };
  };
  const setMax = (v) => {
    let s = document.getElementById('__probe');
    if (!s) { s = document.createElement('style'); s.id = '__probe'; document.head.append(s); }
    s.textContent = v ? '.cm-hero { max-height: ' + v + ' !important; }' : '';
  };
  const rows = [];
  for (const item of [tall, wide].filter(Boolean)) {
    if (!(await open(item))) { rows.push({ err: 'no panel for ' + item.id }); continue; }
    rows.push({ id: item.id, ratio: Math.round(item.width / item.height * 100) / 100, kind: item.kind });
    setMax(null); rows.push(await measure('css-38vh'));
    for (const v of ['42vh', '46vh', '50vh', '54vh']) { setMax('min(' + v + ', 560px)'); rows.push(await measure(v)); }
    setMax(null);
  }
  return JSON.stringify(rows, null, 1);
})()`));
ws.close(); await sleep(200); chrome.kill(); process.exit(0);