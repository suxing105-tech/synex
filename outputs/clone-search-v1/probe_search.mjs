// 真机验「素材选择器的搜索框」：在 vite 5199（后端 8897）里真打关键词、真点搜索，
// 看请求有没有带 q=、框里的字有没有被抹掉。用法：node outputs/clone-search-v1/probe_search.mjs [image|video|audio]
import { spawn } from "node:child_process";
import fs from "node:fs";

const EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.PORT || 9351);
const OUT = "outputs/clone-search-v1";
const WANT = process.argv[2] || "image";
const URL = "http://127.0.0.1:5199/";
const profile = fs.mkdtempSync(process.env.TEMP + "\\picker-search-");
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

// 先记下所有打到 /api/images 的 URL，搜索有没有真生效看这个最准。
console.log("hook ->", JSON.stringify(await ev(`(() => {
  if (!window.__cap) {
    window.__cap = [];
    const f = window.fetch.bind(window);
    window.fetch = (...a) => { const u = typeof a[0] === "string" ? a[0] : a[0].url; if (u.includes("/api/images")) window.__cap.push(u); return f(...a); };
  }
  window.__cap.length = 0;
  window.__want = "` + WANT + `";
  return "ok";
})()`)));

// 挑一张对应族的卡开「一键同款」
console.log("open clone ->", JSON.stringify(await ev(fs.readFileSync("outputs/audio_clone/open_kind_card.js", "utf8"))));
await sleep(2600);

// 音频卡默认开在「音色描述」，那一模式根本没有参考位：先切到唯一吃参考音频的那一种。
if (WANT === "audio") {
  console.log("pick mode ->", JSON.stringify(await ev(`(() => {
    const btn = [...document.querySelectorAll(".cm-seg-mode")].find((b) => b.textContent.trim() === "参考音色");
    if (!btn) return "no mode button";
    btn.click();
    return "clicked";
  })()`)));
  await sleep(1600);
}

// 打开素材选择器
console.log("open picker ->", JSON.stringify(await ev(`(() => {
  const btn = document.querySelector(".cm-tile-add") || document.querySelector(".cm-ref-add") || document.querySelector(".cm-tile-pick");
  if (!btn) return "no add-ref button";
  btn.click();
  return "clicked";
})()`)));
await sleep(2200);

if (WANT === "video") {
  // 视频工作流的选择器顶部有三族 tab：切到「视频」再搜，顺手验一下换族清空关键词是否还按设计走。
  console.log("switch tab ->", JSON.stringify(await ev(`(() => {
    const b = [...document.querySelectorAll(".mp-tab")].find((x) => x.textContent.trim() === "视频");
    if (!b) return "no video tab";
    b.click();
    return "clicked";
  })()`)));
  await sleep(1600);
}

// 从当前列表里挑一个真存在的关键词：拿第二张卡文件名里的一段汉字/字母，保证搜得到东西
const kw = (await ev(`(() => {
  const names = [...document.querySelectorAll(".mp-panel .media-card-name")].map((n) => n.textContent.trim());
  if (names.length < 2) return { err: "list too short: " + names.length, panel: !!document.querySelector(".mp-panel"), note: (document.querySelector(".mp-note") || {}).textContent || "", caps: window.__cap.slice(-4) };
  const stem = names[1].split(".")[0];
  return { keyword: stem.slice(0, 4), names: names.slice(0, 4) };
})()`)).value;
if (kw.err) { console.log("KEYWORD FAIL", kw); chrome.kill(); process.exit(3); }
console.log("keyword ->", JSON.stringify(kw));

// 一个字一个字敲进去：模拟真人打字，这正是不修复时会被逐字抹掉的场景
await ev(`(() => { window.__box = document.querySelector(".mp-search"); return !!window.__box; })()`);
const typed = [];
for (let i = 1; i <= kw.keyword.length; i++) {
  typed.push(kw.keyword.slice(0, i));
}
for (const partial of typed) {
  await ev(`(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(window.__box, "` + partial + `");
    window.__box.dispatchEvent(new Event("input", { bubbles: true }));
    return window.__box.value;
  })()`);
  await sleep(220);
}
const afterType = (await ev(`JSON.stringify({ value: window.__box.value, calls: window.__cap.slice() })`)).value;
console.log("after typing ->", afterType);

// 点「搜索」
await ev(`(() => { const b = [...document.querySelectorAll(".mp-btn")].find((x) => x.textContent.trim() === "搜索"); b.click(); return "ok"; })()`);
await sleep(1800);
const afterSearch = (await ev(`(() => {
  const urls = window.__cap.filter((u) => u.includes("q="));
  const names = [...document.querySelectorAll(".mp-panel .media-card-name")].map((n) => n.textContent.trim());
  return JSON.stringify({ box: window.__box.value, q_calls: urls.length, last: urls[urls.length - 1] || null, shown: names.length, names: names.slice(0, 5) });
})()`)).value;
console.log("after search ->", afterSearch);

const head = (await ev(`JSON.stringify((() => { const h = document.querySelector(".mp-head"); if (!h) return null; const r = h.getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(r.width + 16, 1480), height: r.height + 16 }; })())`)).value;
await shot("picker_" + WANT + "_searched", head ? JSON.parse(head) : undefined);
chrome.kill();
process.exit(0);
