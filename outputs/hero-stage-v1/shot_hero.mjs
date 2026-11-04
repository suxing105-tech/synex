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
const OUT = "outputs/hero-stage-v1/shot" + TAG;
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

/* 开窗之前就接管两个接口：实拍期间 jobs/current 只认页面里那条假任务。
   2026-11-04 采到过一次事故——库里用户自己那一单还在跑，弹窗一开 adoptRunningJob 就把真任务认了进来，
   line 变成后端的「生成中…」、假 done 因 job_id 不匹配整段失效，量出来的全是别人的数。 */
await ev(`(() => {
  const real = window.fetch.bind(window);
  const idle = { active: false, running: false, state: "", message: "", error: "", image_ids: [], outputs: [], template_ids: [], template_id: null, source_image_id: null, media_kind: "", elapsed: 0 };
  window.__job = null;
  window.fetch = (u2, init) => {
    const path = String(u2).split("?")[0];
    if (path === "/api/clone/generate" || path === "/api/clone/jobs/current") {
      return Promise.resolve(new Response(JSON.stringify(window.__job || idle), { status: 200, headers: { "content-type": "application/json" } }));
    }
    return real(u2, init);
  };
  return "intercepted-before-open";
})()`);

// 1) 打开图库里第一张图片卡的「再次创作」
console.log("open:", await ev(`(() => {
  const btn = document.querySelector('.media-clone-btn');
  if (!btn) return 'no clone btn';
  btn.click();
  return 'clicked';
})()`));
await sleep(2200);

// 2) 量静止态：顶栏撤字之后让出来的竖向空间、展示图多大、文件名那行还在不在
const idle = await ev(`(() => {
  const panel = document.querySelector('.cm-panel');
  if (!panel) return JSON.stringify({ err: 'no panel' });
  const hero = document.querySelector('.cm-left img.cm-hero');
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  const pr = panel.getBoundingClientRect();
  return JSON.stringify({
    panel: { w: Math.round(pr.width), h: Math.round(pr.height) },
    topText: { kicker: Boolean(document.querySelector('.cm-kicker')), title: Boolean(document.querySelector('.cm-title')) },
    topBarH: Math.round((document.querySelector('.cm-top') || panel).getBoundingClientRect().height),
    hero: box(hero), heroName: Boolean(document.querySelector('.cm-hero-name')),
    heroMaxH: hero ? getComputedStyle(hero).maxHeight : null,
    heroSrc: hero ? hero.getAttribute('src') : null,
    leftH: Math.round(document.querySelector('.cm-left').getBoundingClientRect().height),
    dialogLabel: document.querySelector('.cm-panel')?.getAttribute('aria-label'),
    closeLabel: document.querySelector('.cm-close')?.getAttribute('aria-label'),
  }, null, 1);
})()`);
console.log("IDLE " + idle);
await shot("1-idle");

// 3) 拦掉两个接口 + 记下 clone.ts 的真实模块地址（HMR 之后带 ?t=，拿错地址就是两个 store 实例）
await ev(`(async () => {
  const ids = await fetch('/api/images?limit=6').then((r) => r.json());
  window.__ids = (ids.items || []).map((i) => i.id).filter((n) => typeof n === 'number');
  const hit = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\\/src\\/lib\\/clone\\.ts/.test(n));
  window.__cloneUrl = hit.length ? hit[hit.length - 1] : location.origin + '/src/lib/clone.ts';
  window.__mod = await import(window.__cloneUrl);
  // 自检：订阅到的 store 必须就是界面在用那一份（HMR 之后 import 错地址会得到第二个实例）
  window.__seen = null;
  window.__mod.cloneJob.subscribe((v) => { window.__seen = v; });
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
console.log("go:", await ev(`(() => { const b = [...document.querySelectorAll('.cm-go')][0]; if (b && !b.disabled) { b.click(); return 'clicked'; } return b ? 'disabled' : 'no go'; })()`));
console.log("store:", await ev("JSON.stringify(window.__seen && { id: window.__seen.job_id, state: window.__seen.state, msg: window.__seen.message, elapsed: window.__seen.elapsed })"));
await sleep(1200);

const stage = await ev(`(() => {
  const st = document.querySelector('.cm-stage');
  if (!st) return JSON.stringify({ err: 'no stage', left: (document.querySelector('.cm-left') || {}).className, foot: document.querySelector('.cm-foot-note')?.textContent });
  const r = st.getBoundingClientRect();
  const cs = (sel) => { const el = st.querySelector(sel); return el ? getComputedStyle(el) : null; };
  const ghost = cs('.cm-stage-ghost'), beam = cs('.cm-stage-beam');
  return JSON.stringify({
    box: { w: Math.round(r.width), h: Math.round(r.height) },
    dataStage: st.getAttribute('data-stage'),
    line: st.querySelector('.cm-stage-line')?.textContent,
    lineRole: st.querySelector('.cm-stage-line')?.getAttribute('role'),
    clock: st.querySelector('.cm-stage-clock')?.textContent,
    barWidth: st.querySelector('.cm-stage-bar > span')?.getAttribute('style'),
    steps: [...st.querySelectorAll('.cm-stage-step')].map((e) => e.textContent + (e.className.includes('is-now') ? '[现在]' : e.className.includes('is-past') ? '[已过]' : '')),
    ghost: ghost ? { animation: ghost.animationName + ' ' + ghost.animationDuration, opacity: ghost.opacity, blur: ghost.filter } : null,
    beam: beam ? { animation: beam.animationName + ' ' + beam.animationDuration } : null,
    goButton: document.querySelector('.cm-go')?.textContent.trim(),
    cancel: Boolean([...document.querySelectorAll('button,span')].find((e) => e.textContent.trim() === '取消')),
  }, null, 1);
})()`);
console.log("STAGE " + stage);
await sleep(3000);
console.log("clock 3 秒后:", await ev("document.querySelector('.cm-stage-clock')?.textContent"));
await shot("2-stage");
// 悬停那一格：光带扫得更快（减少等待焦虑的那点「它还活着」）
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(W / 2 - 300), y: 360 });
await sleep(600);
console.log("hover ghost:", await ev("(() => { const g = document.querySelector('.cm-stage-ghost'), b = document.querySelector('.cm-stage-beam'); return g ? JSON.stringify({ ghostAnim: getComputedStyle(g).animationName, ghostOpacity: getComputedStyle(g).opacity, beamDur: getComputedStyle(b).animationDuration }) : 'no stage'; })()"));
await shot("3-stage-hover");

// 5) 跑完：同一格直接换成刚出的那一份（用库里真有的图，图能真加载出来）
const done = await ev(`(async () => {
  // 现取现用：图库会被后台扫描重排，脚本开头那份 id 跑几十秒就可能不在了
  const fresh = (await fetch('/api/images?limit=3').then((r) => r.json())).items.map((i) => i.id).filter((n) => typeof n === 'number');
  const ids = fresh.length ? fresh.slice(0, 1) : [1];
  const out = (n) => ({ id: n, kind: 'image', filename: 'ComfyUI_000' + n + '_.png', thumbnail_url: '/api/images/' + n + '/file?max=256' });
  const panel = document.querySelector('.cm-panel');
  panel.scrollTop = 320;
  window.__mod.applyCloneProgress({ active: true, job_id: 'shot-hero', state: 'done', running: false, template_id: null, image_ids: ids.slice(0, 1), outputs: [out(ids[0])] });
  await new Promise((r) => setTimeout(r, 900));
  const hero = document.querySelector('img.cm-hero-new');
  const btn = document.querySelector('.cm-hero-out');
  return JSON.stringify({
    mod: window.__cloneUrl.split('/').pop(),
    hero: hero ? { w: Math.round(hero.getBoundingClientRect().width), h: Math.round(hero.getBoundingClientRect().height), src: hero.getAttribute('src'), cls: hero.className.split(' ').join('.') } : null,
    label: btn ? btn.getAttribute('aria-label') : null,
    hint: document.querySelector('.cm-hero-out-hint')?.textContent,
    pager: Boolean(document.querySelector('.cm-hero-pager')),
    store: window.__seen && { id: window.__seen.job_id, state: window.__seen.state, outputs: window.__seen.outputs.length },
    foot: document.querySelector('.cm-foot-note')?.textContent,
    scrollTopAfter: panel.scrollTop,
    results: Boolean(document.querySelector('.cm-results')),
  }, null, 1);
})()`);
console.log("DONE " + done);
await sleep(1200);
await shot("4-done");

// 6) 一次出两份：中间那排箭头
const two = await ev(`(async () => {
  const fresh2 = (await fetch('/api/images?limit=3').then((r) => r.json())).items.map((i) => i.id).filter((n) => typeof n === 'number');
  const ids = fresh2.length > 1 ? fresh2.slice(0, 2) : [1, 2];
  const out = (n) => ({ id: n, kind: 'image', filename: 'x' + n + '.png', thumbnail_url: '/api/images/' + n + '/file?max=256' });
  window.__mod.applyCloneProgress({ active: true, job_id: 'shot-hero', state: 'done', running: false, template_id: null, image_ids: ids, outputs: ids.map(out) });
  await new Promise((r) => setTimeout(r, 700));
  const before = document.querySelector('img.cm-hero-new')?.getAttribute('src');
  const next = [...document.querySelectorAll('.cm-hero-nav')].find((b) => b.getAttribute('aria-label') === '看下一份产出');
  next?.click();
  await new Promise((r) => setTimeout(r, 500));
  return JSON.stringify({
    count: document.querySelector('.cm-hero-count')?.textContent,
    srcBefore: before,
    srcAfter: document.querySelector('img.cm-hero-new')?.getAttribute('src'),
    label: document.querySelector('.cm-hero-out')?.getAttribute('aria-label'),
  }, null, 1);
})()`);
console.log("TWO " + two);
await sleep(1000);
await shot("5-done-two");

// 7) 关动效的人看到的等待台：台阶、话、秒表都在，动画全停
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await ev("(() => { window.__mod.applyCloneProgress({ active: true, job_id: 'shot-hero', state: 'running', running: true, template_id: null, image_ids: [], outputs: [], message: '模型正在出图 · 第 3 步 / 共 4 步', elapsed: 41 }); return 1; })()");
await sleep(900);
console.log("REDUCED " + await ev(`(() => {
  const st = document.querySelector('.cm-stage');
  if (!st) return 'no stage';
  const g = st.querySelector('.cm-stage-ghost'), b = st.querySelector('.cm-stage-beam'), o = st.querySelector('.cm-stage-orb i');
  return JSON.stringify({
    line: st.querySelector('.cm-stage-line')?.textContent,
    clock: st.querySelector('.cm-stage-clock')?.textContent,
    ghostAnim: g ? getComputedStyle(g).animationName : null,
    beamDisplay: b ? getComputedStyle(b).display : null,
    orbAnim: o ? getComputedStyle(o).animationName : null,
    barWidth: st.querySelector('.cm-stage-bar > span')?.getAttribute('style'),
  }, null, 1);
})()`));
await shot("6-reduced-motion");

ws.close();
await sleep(200);
chrome.kill();
process.exit(0);