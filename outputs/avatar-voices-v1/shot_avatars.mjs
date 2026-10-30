// 真机看一眼「指定音色」那九张脸：起 headless Chrome，走 vite 5199（后端 8897）。
// 只读：点开弹窗和参数面板，不点生成。用法：node outputs/avatar-voices-v1/shot_avatars.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";

const EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.PORT || 9341);
const OUT = "outputs/avatar-voices-v1";
const URL = "http://127.0.0.1:5199/";
const profile = fs.mkdtempSync(process.env.TEMP + "\\avatar-shot-");
const chrome = spawn(EXE, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
  "--window-size=1500,1000", "--force-device-scale-factor=1", "--hide-scrollbars", "--disable-gpu", "about:blank"], { stdio: "ignore" });
chrome.unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(400);
  try { ready = (await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).ok); } catch { /* 还没起来 */ }
}
if (!ready) { console.log("NO DEVTOOLS"); process.exit(2); }
await fetch("http://127.0.0.1:" + PORT + "/json/new?" + encodeURIComponent(URL), { method: "PUT" }).catch(() => {});
await sleep(2500);
const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith(URL));
if (!page) { console.log("NO PAGE"); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws fail")); });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || "eval error" };
  return { value: r.result?.value };
};
const shot = async (name, clip) => {
  const params = { format: "png", captureBeyondViewport: !clip };
  if (clip) params.clip = { ...clip, scale: 1 };
  const r = await send("Page.captureScreenshot", params);
  fs.writeFileSync(OUT + "/" + name + ".png", Buffer.from(r.data, "base64"));
  console.log("shot:", OUT + "/" + name + ".png");
};
await send("Page.enable");
await send("Runtime.enable");
await sleep(4500);

console.log("open clone ->", JSON.stringify(await ev(`(() => {
  const card = document.querySelector('.media-card.is-audio');
  const btn = card && card.querySelector('.media-clone-btn');
  if (!btn) return 'no audio clone button';
  btn.click();
  return 'clicked';
})()`)));
await sleep(2600);

console.log("pick mode ->", JSON.stringify(await ev(`(() => {
  const btn = [...document.querySelectorAll('.cm-seg-mode')].find((b) => b.textContent.trim() === '指定音色');
  if (!btn) return 'no mode button';
  btn.click();
  return 'clicked';
})()`)));
await sleep(1500);

console.log("open params ->", JSON.stringify(await ev(`(() => {
  const btn = document.querySelector('button[aria-label="画面参数"]');
  if (!btn) return 'no params pill';
  btn.click();
  return 'clicked';
})()`)));
await sleep(1800);

console.log("faces ->", JSON.stringify(await ev(`(() => {
  const imgs = [...document.querySelectorAll('.cm-pop img.cm-ratio-face')];
  return {
    count: imgs.length,
    loaded: imgs.filter((i) => i.naturalWidth > 0).length,
    srcs: imgs.map((i) => i.getAttribute('src') + '=' + i.naturalWidth).join(','),
    pill: (() => { const p = document.querySelector('.cm-pill-face'); return p ? p.getAttribute('src') + '=' + p.naturalWidth : 'none'; })(),
  };
})()`)));

const popRect = (await ev(`JSON.stringify((() => { const p = document.querySelector('.cm-pop'); if (!p) return null;
  const r = p.getBoundingClientRect(); return { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: r.width + 20, height: r.height + 20 }; })())`)).value;
await shot("avatars-popover", popRect ? JSON.parse(popRect) : undefined);

const footRect = (await ev(`JSON.stringify((() => { const p = document.querySelector('.cm-foot'); if (!p) return null;
  const r = p.getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(r.width + 16, 900), height: r.height + 16 }; })())`)).value;
await shot("avatars-pill", footRect ? JSON.parse(footRect) : undefined);
await shot("avatars-modal");
chrome.kill();
process.exit(0);
