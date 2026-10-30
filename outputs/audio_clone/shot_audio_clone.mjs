// 音频一键同款自检：起 headless Chrome 打开 5199，挑一张音频卡，截「悬停时的角标」与「点开弹窗」两张图。
// 只读：不点生成。用法：node outputs/audio_clone/shot_audio_clone.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";

const EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.PORT || 9337);
const OUT = process.env.OUT || "outputs/audio_clone";
const URL = process.env.PAGE_URL || "http://127.0.0.1:5199/";
const profile = fs.mkdtempSync(process.env.TEMP + "\\audio-clone-shot-");
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
await sleep(2000);
const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith(URL));
if (!page) { console.log("NO PAGE", JSON.stringify(list.map((t) => t.url))); process.exit(2); }
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
  const file = OUT + "/" + name + ".png";
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log("shot:", file);
};
await send("Page.enable");
await send("Runtime.enable");
await sleep(4000);
console.log("cards ->", JSON.stringify(await ev("document.querySelectorAll('.media-card').length")));
console.log("audio ->", JSON.stringify(await ev("document.querySelectorAll('.media-card.is-audio').length")));
console.log("pick ->", JSON.stringify(await ev(`(() => {
  const card = document.querySelector('.media-card.is-audio');
  if (!card) return 'no audio card';
  card.scrollIntoView({ block: 'center' });
  const r = card.getBoundingClientRect();
  window.__clip = { x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 6), width: r.width + 12, height: r.height + 12 };
  card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  card.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }));
  return card.querySelector('.media-card-name')?.textContent || 'unnamed';
})()`)));
await sleep(1200);
const clip = (await ev("JSON.stringify(window.__clip)")).value;
await shot("audio-card-hover", clip ? JSON.parse(clip) : undefined);
console.log("open clone ->", JSON.stringify(await ev(`(() => {
  const card = document.querySelector('.media-card.is-audio');
  const btn = card && card.querySelector('.media-clone-btn');
  if (!btn) return 'no clone button';
  btn.click();
  return 'clicked';
})()`)));
await sleep(2500);
await shot("audio-clone-modal");
console.log("modal ->", JSON.stringify(await ev("(() => { const h = document.querySelector('.cm-title, h2'); return h ? h.textContent : 'no modal'; })()")));
console.log("subboxes ->", JSON.stringify(await ev("[...document.querySelectorAll('.cm-textarea-sub')].map((t) => t.getAttribute('aria-label') + '=' + t.value).join(' | ')")));
console.log("substyle ->", JSON.stringify(await ev("[...document.querySelectorAll('.cm-textarea-sub')].map((t) => { const c = getComputedStyle(t); return c.color + ' / bg ' + c.backgroundColor; }).join(' | ')")));
console.log("mainstyle ->", JSON.stringify(await ev("(() => { const t = document.querySelector('.cm-textarea-mirror'); if (!t) return 'none'; const c = getComputedStyle(t); return c.color + ' / bg ' + c.backgroundColor; })()")));
chrome.kill();
process.exit(0);
