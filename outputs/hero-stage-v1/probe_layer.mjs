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
console.log("open:", await ev(`(() => {
  const btn = document.querySelector('.media-clone-btn');
  if (!btn) return 'no clone btn';
  btn.click();
  return 'clicked';
})()`));
await sleep(2200);


console.log("LAYER " + await ev(`(() => {
  const bd = document.querySelector('.cm-backdrop');
  const panel = document.querySelector('.cm-panel');
  const main = document.querySelector('main');
  const asides = [...document.querySelectorAll('aside')];
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const cs = (el) => el ? { bg: getComputedStyle(el).backgroundColor, bf: getComputedStyle(el).backdropFilter, z: getComputedStyle(el).zIndex, pos: getComputedStyle(el).position } : null;
  const br = bd ? bd.getBoundingClientRect() : null, mr = main ? main.getBoundingClientRect() : null;
  const overlap = (a, b) => !!(a && b && !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom));
  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight },
    backdrop: r(bd), main: r(main),
    sameBox: br && mr ? { dx: Math.round(br.x - mr.x), dy: Math.round(br.y - mr.y), dw: Math.round(br.width - mr.width), dh: Math.round(br.height - mr.height) } : null,
    backdropStyle: cs(bd), panelStyle: cs(panel),
    panel: r(panel), panelScroll: panel ? { scrollH: panel.scrollHeight, clientH: panel.clientHeight } : null,
    coversLeftAside: overlap(br, asides[0] ? asides[0].getBoundingClientRect() : null),
    coversRightAside: overlap(br, asides[1] ? asides[1].getBoundingClientRect() : null),
    hero: r(document.querySelector('.cm-left img.cm-hero')),
  }, null, 1);
})()`));
await shot("layer");
ws.close();
await sleep(200);
chrome.kill();
process.exit(0);
