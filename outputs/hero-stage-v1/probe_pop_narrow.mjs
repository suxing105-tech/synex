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
const OUT = "outputs/hero-stage-v1/shot-layer"+TAG;
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
/* 卡片要等图库首批渲染完才有那颗角标（库里现在三百多项，首屏比以前慢）：轮询等它出现。 */
let opened = 'timeout';
for (let k = 0; k < 40; k++) {
  opened = await ev(`(() => { const b = document.querySelector('.media-clone-btn'); if (!b) return 'no btn'; b.click(); return 'clicked'; })()`);
  if (opened === 'clicked') break;
  await sleep(500);
}
console.log("open:", opened, "| cards:", await ev("document.querySelectorAll('.media-card').length"));
await sleep(2200);



const measure = (tag) => ev(`(() => {
  const bd = document.querySelector('.cm-backdrop');
  const panel = document.querySelector('.cm-panel');
  const main = document.querySelector('main');
  if (!panel) return 'no panel';
  const pop = document.querySelector('.cm-pop-wf');
  const pr = pop ? pop.getBoundingClientRect() : null, pa = panel.getBoundingClientRect();
  const mr = main.getBoundingClientRect();
  return JSON.stringify({
    vw: innerWidth, mainW: Math.round(mr.width),
    panelW: Math.round(pa.width), panelRight: Math.round(pa.right),
    popMax: panel.style.getPropertyValue('--cm-pop-max'),
    pop: pr ? { w: Math.round(pr.width), right: Math.round(pr.right), over: Math.round(pr.right - pa.right) } : null,
    hScroll: panel.scrollWidth - panel.clientWidth,
    backdropSameAsMain: bd ? (Math.round(bd.getBoundingClientRect().width - mr.width) === 0 && Math.round(bd.getBoundingClientRect().height - mr.height) === 0) : null,
  }, null, 1);
})()`);
console.log("WIDE  " + await measure("wide"));
await ev("(() => { const p = document.querySelector('[aria-label=\"工作流\"]'); if (p) p.click(); return 1; })()");
await sleep(500);
console.log("WIDE+POP " + await ev(`(() => {
  const pop = document.querySelector('.cm-pop-wf'), panel = document.querySelector('.cm-panel');
  if (!pop) return 'no pop';
  const pr = pop.getBoundingClientRect(), pa = panel.getBoundingClientRect();
  return JSON.stringify({ cls: pop.className, w: Math.round(pr.width), over: Math.round(pr.right - pa.right), hScroll: panel.scrollWidth - panel.clientWidth });
})()`));
await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
await sleep(900);
console.log("NARROW " + await measure());
await sleep(300);
console.log("NARROW+POP " + await ev(`(() => {
  const pop = document.querySelector('.cm-pop-wf'), panel = document.querySelector('.cm-panel');
  if (!pop) return 'no pop';
  const pr = pop.getBoundingClientRect(), pa = panel.getBoundingClientRect();
  return JSON.stringify({ cls: pop.className, cssW: getComputedStyle(pop).width, w: Math.round(pr.width), over: Math.round(pr.right - pa.right), hScroll: panel.scrollWidth - panel.clientWidth, popMax: panel.style.getPropertyValue('--cm-pop-max') }, null, 1);
})()`));
await shot("pop-narrow");
ws.close();
await sleep(200);
chrome.kill();
process.exit(0);
