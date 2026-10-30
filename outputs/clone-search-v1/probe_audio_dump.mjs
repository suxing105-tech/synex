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


console.log("tiles ->", JSON.stringify(await ev(`JSON.stringify([...document.querySelectorAll(".cm-tile-add,.cm-tile-pick,.cm-ref-add")].map((b) => ({ cls: b.className, aria: b.getAttribute("aria-label") })))`)));
console.log("click ->", JSON.stringify(await ev(`(() => { const b = document.querySelector(".cm-ref-add") || document.querySelector(".cm-tile-add") || document.querySelector(".cm-tile-pick"); if (!b) return "none"; b.click(); return b.getAttribute("aria-label"); })()`)));
await sleep(2200);
console.log("state ->", JSON.stringify(await ev(`JSON.stringify({ panel: !!document.querySelector(".mp-panel"), names: [...document.querySelectorAll(".mp-panel .media-card-name")].length, caps: window.__cap.slice(-3) }))`)));
chrome.kill();
process.exit(0);
