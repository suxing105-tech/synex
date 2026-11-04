// 再次创作·上半区局部画布（?cm_canvas=1）实拍四组：1 批 1 张 / 1 批 4 张 / 3 批累积 / 窄窗 474。
// 不打服务商接口：/api/clone/generate 与 jobs/current 在页面里被 fetch 拦掉，出图不发生，
// 只把「提交之后画布长什么样」照实走一遍（提交本身走真按钮、真代码路径）。
// 仓库根跑：  node outputs/hero-canvas-v1/shot_canvas.mjs
import fs from "node:fs";
import { spawn } from "node:child_process";

const EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.PORT || 9411);
const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const TAG = process.env.TAG || "";
const OUT = "outputs/hero-canvas-v1/shot" + TAG;
const PAGE_URL = "http://127.0.0.1:5199/?cm_canvas=1";
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(process.env.TEMP + "\\chercanvas-");
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
const page = list.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1:5199/"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws fail")); });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) console.log("PAGE EXC", JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(OUT + "/" + name + ".png", Buffer.from(r.data, "base64"));
  console.log("SHOT " + name);
};
await send("Page.enable");
await send("Runtime.enable");

/* 开窗之前就接管两个接口：实拍期间只认页面里那条假任务（沿用 shot_hero.mjs 的口径，
   库里用户自己那一单还在跑时，弹窗一开 adoptRunningJob 会把真任务认进来，量出来全是别人的数）。 */
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

// 开弹窗 + 拿到弹窗真正在用的那份 store（HMR 之后 import 错地址会得到第二个实例，所以自检）
console.log("open:", await ev(`(() => { const b = document.querySelector('.media-clone-btn'); if (!b) return 'no clone btn'; b.click(); return 'clicked'; })()`));
await sleep(2200);
console.log("store:", await ev(`(async () => {
  const hit = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\\/src\\/lib\\/clone\\.ts/.test(n));
  window.__cloneUrl = hit.length ? hit[hit.length - 1] : location.origin + '/src/lib/clone.ts';
  window.__mod = await import(window.__cloneUrl);
  window.__seen = null; window.__batches = null;
  window.__mod.cloneJob.subscribe((v) => { window.__seen = v; });
  window.__mod.cloneBatches.subscribe((v) => { window.__batches = v; });
  const ids = await fetch('/api/images?limit=12').then((r) => r.json());
  window.__ids = (ids.items || []).map((i) => i.id).filter((n) => typeof n === 'number');
  return JSON.stringify({ url: window.__cloneUrl.split('/').pop(), ids: window.__ids.length, canvas: Boolean(document.querySelector('.cc-root')), hasCanvasModule: typeof window.__mod.clearCloneBatches === 'function' });
})()`));

/* 点真·生成按钮提交一批：generate() 会把 jobId 记成 mock 回的那条，之后按同一个 job_id 推 done。
   多批必须真的点多次生成——弹窗那条 job derived 只认自己提交过的 job_id。 */
await ev(`(() => {
  window.__fill = () => { const ta = document.querySelector('textarea.cm-textarea'); if (ta && !ta.value) { ta.value = '把这套视觉再抽一次（画布实拍用）'; ta.dispatchEvent(new Event('input', { bubbles: true })); } return Boolean(ta); };
  window.__pick = async (n) => {
    // 现取现用 + 先验图：图库会被后台扫描重排，文件被移走的那份 naturalWidth 永远是 0，拍出来是一块坏图
    const fresh = await fetch('/api/images?limit=30').then((r) => r.json());
    const pool = (fresh.items || []).map((i) => i.id).filter((k) => typeof k === 'number');
    const ok = [];
    for (const id of pool) {
      if (ok.length >= n) break;
      const good = await new Promise((res) => {
        const im = new Image();
        im.onload = () => res(im.naturalWidth > 0);
        im.onerror = () => res(false);
        im.src = '/api/images/' + id + '/file?max=256';
      });
      if (good) ok.push(id);
    }
    return ok;
  };
  window.__run = async (jobId, wanted) => {
    const ids = await window.__pick(wanted);
    window.__fill();
    await new Promise((r) => setTimeout(r, 260));
    window.__job = { active: true, job_id: jobId, state: 'running', running: true, template_id: null, image_ids: [], outputs: [], message: '模型正在出图 · 第 3 步 / 共 4 步', elapsed: 22 };
    const go = document.querySelector('.cm-go');
    if (!go || go.disabled) return JSON.stringify({ err: 'go 不可点', disabled: go ? go.disabled : 'no go' });
    go.click();
    await new Promise((r) => setTimeout(r, 420));
    const stage = Boolean(document.querySelector('.cm-stage'));
    const out = (n) => ({ id: n, kind: 'image', filename: 'ComfyUI_000' + n + '_.png', thumbnail_url: '/api/images/' + n + '/file?max=256' });
    window.__job = { active: true, job_id: jobId, state: 'done', running: false, template_id: null, image_ids: ids, outputs: ids.map(out) };
    window.__mod.applyCloneProgress(window.__job);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const imgs = [...document.querySelectorAll('.cc-card img')];
      if (imgs.length >= ids.length && imgs.every((n) => n.complete && n.naturalWidth > 0)) break;
    }
    const imgs = [...document.querySelectorAll('.cc-card img')];
    return JSON.stringify({ stage, batches: window.__batches.map((b) => b.key + '×' + b.outputs.length), cards: imgs.length, loaded: imgs.filter((n) => n.complete && n.naturalWidth > 0).length });
  };
  return 'ok';
})()`);

/* 一次量齐：视口溢出、两层 transform、每张卡的 opacity 与图源、画布子树里的 fixed、计数与翻页 */
await ev(`(() => {
  window.__measure = () => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; };
    const vp = document.querySelector('.cc-viewport'), stage = document.querySelector('.cc-stage'), content = document.querySelector('.cc-content');
    const panel = document.querySelector('.cm-panel'), root = document.querySelector('.cc-root');
    if (!vp || !root) return JSON.stringify({ err: 'no canvas', hero: Boolean(document.querySelector('.cm-hero')), stage: Boolean(document.querySelector('.cm-stage')) });
    const leak = [];
    for (const el of root.querySelectorAll('*')) { const p = getComputedStyle(el).position; if (p === 'fixed' || p === 'sticky') leak.push(el.className || el.tagName); }
    const cards = [...root.querySelectorAll('.cc-card')].map((c) => {
      const img = c.querySelector('img');
      return { faded: c.className.includes('is-faded'), focused: c.className.includes('is-focused'), opacity: getComputedStyle(c).opacity, box: box(c),
        src: img ? img.getAttribute('src').replace(location.origin, '') : null, natural: img ? img.naturalWidth : 0,
        zoomLabel: c.querySelector('.cc-zoom')?.getAttribute('aria-label'), openLabel: c.querySelector('.cc-open')?.getAttribute('aria-label') };
    });
    return JSON.stringify({
      vpBox: box(vp), overflowX: vp.scrollWidth - vp.clientWidth, overflowY: vp.scrollHeight - vp.clientHeight,
      panelOverflowX: panel ? panel.scrollWidth - panel.clientWidth : null, panelScrollTop: panel ? panel.scrollTop : null,
      stageTransform: getComputedStyle(stage).transform, stageBox: box(stage),
      contentTransform: getComputedStyle(content).transform, contentStyle: content.getAttribute('style'),
      cards, count: document.querySelector('.cc-count')?.textContent || null,
      pager: Boolean(document.querySelector('.cm-hero-pager')), legacyHero: Boolean(document.querySelector('.cm-hero-new')),
      fixedLeak: leak, cursor: getComputedStyle(vp).cursor,
    }, null, 1);
  };
  return 'ok';
})()`);
const measure = async (tag) => { const raw = await ev("window.__measure()"); console.log("MEASURE " + tag + " " + raw); return JSON.parse(raw); };

const key = async (k, code, vk) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};

/* ── A 组：1 批 1 张 ─────────────────────────────────────────────── */
console.log("A:", await ev(`window.__run('shot-c1', 1)`));
await sleep(600);
const A = await measure("A·1批1张");
await shot("a1-单批单张");
console.log("A 填充率: 卡片高/视口高 =", A.cards[0] ? (A.cards[0].box.h / A.vpBox.h).toFixed(2) : "n/a", " 宽 =", A.cards[0] ? (A.cards[0].box.w / A.vpBox.w).toFixed(2) : "n/a");

/* ── B 组：关窗清历史 → 重开 → 1 批 4 张 ────────────────────────── */
await ev(`(() => { document.querySelector('.cm-close').click(); return 1; })()`);
await sleep(900);
console.log("关窗后批次:", await ev("JSON.stringify({batches: (window.__batches||[]).length, canvas: Boolean(document.querySelector('.cc-root')), panel: Boolean(document.querySelector('.cm-panel'))})"));
await ev(`(() => { document.querySelector('.media-clone-btn').click(); return 1; })()`);
await sleep(1800);
console.log("接手读不复活旧批:", await ev("JSON.stringify({batches:(window.__batches||[]).length, adoptedState: window.__seen && window.__seen.state, canvas: Boolean(document.querySelector('.cc-root'))})"));
console.log("B:", await ev(`window.__run('shot-c2', 4)`));
await sleep(600);
const B = await measure("B·1批4张·fit");
await shot("b1-单批四张-fit");
// 悬停：去图库那颗才显形
const bFirst = B.cards[0].box;
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(bFirst.x + bFirst.w / 2), y: Math.round(bFirst.y + bFirst.h / 2) });
await sleep(400);
console.log("悬停 open 可见性:", await ev(`(() => { const b = document.querySelector('.cc-card:hover .cc-open'); return b ? getComputedStyle(b).opacity : 'no hover card'; })()`));
// 点第一张 → 聚焦放大
await ev(`(() => { document.querySelectorAll('.cc-zoom')[0].click(); return 1; })()`);
await sleep(700);
const B2 = await measure("B·放大那一张");
await shot("b2-放大一张");
// 图源档位：放大过 1.0× 就该切更大的一档
console.log("图源 fit→放大:", B.cards[0] && B.cards[0].src, "→", B2.cards[0] && B2.cards[0].src);
// Esc 第一段：只退回全览，弹窗还在
await key("Escape", "Escape", 27);
await sleep(700);
const B3 = await measure("B·Esc 第一段");
console.log("Esc1 后弹窗还在:", await ev("Boolean(document.querySelector('.cm-panel'))"));
await shot("b3-esc退回全览");
// 键盘 ←→：焦点在第一张，按右移焦点并放大第二张
await ev(`(() => { document.querySelectorAll('.cc-zoom')[0].focus(); return document.activeElement.getAttribute('data-cc-key'); })()`);
await key("ArrowRight", "ArrowRight", 39);
await sleep(600);
const B4 = await measure("B·方向键移焦");
console.log("方向键后焦点:", await ev("document.activeElement.getAttribute('data-cc-key')"));
await shot("b4-方向键第二张");
// 边界：画布里不许有 fixed / sticky，也不许成为弹窗外壳的祖先
console.log("坐标孤岛:", JSON.stringify({ fixedLeak: B4.fixedLeak, canvasIsPanelAncestor: await ev("Boolean(document.querySelector('.cm-close').closest('.cc-root'))") }));
await key("ArrowLeft", "ArrowLeft", 37);
await sleep(300);
await key("Escape", "Escape", 27);
await sleep(400);
await key("Escape", "Escape", 27);
await sleep(600);
console.log("两段 Esc 之后弹窗:", await ev("Boolean(document.querySelector('.cm-panel'))"));
await ev(`(() => { document.querySelector('.media-clone-btn').click(); return 1; })()`);
await sleep(1800);
console.log("接手读不复活旧批:", await ev("JSON.stringify({batches:(window.__batches||[]).length, adoptedState: window.__seen && window.__seen.state, canvas: Boolean(document.querySelector('.cc-root'))})"));

/* ── C 组：3 批累积，旧批变淡 ───────────────────────────────────── */
console.log("C-1:", await ev(`window.__run('shot-c3', 3)`));
await sleep(500);
console.log("C-2:", await ev(`window.__run('shot-c4', 2)`));
await sleep(500);
const C = await measure("C·3批累积");
await shot("c1-三批累积");
console.log("C 上限前批次:", await ev("JSON.stringify((window.__batches||[]).map((b)=>b.key))"));
console.log("C-4/5/6 补跑（验上限）:", await ev(`(async () => { await window.__run('shot-c5', 1); await window.__run('shot-c6', 1); await window.__run('shot-c7', 1); return JSON.stringify({ stored: (window.__batches||[]).map((b)=>b.key), limit: window.__mod.CLONE_BATCH_LIMIT }); })()`));
await sleep(700);
const C2 = await measure("C·第6批入队后");
await shot("c2-五批上限");

/* ── D 组：窄窗 474 ─────────────────────────────────────────────── */
await send("Emulation.setDeviceMetricsOverride", { width: 474, height: 860, deviceScaleFactor: 1, mobile: false });
await sleep(900);
const D = await measure("D·窄窗474");
await shot("d1-窄窗474");
// 撤动效的人：两层 transform 过渡都该关掉
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await sleep(400);
console.log("REDUCED:", await ev(`(() => { const c = document.querySelector('.cc-content'), s = document.querySelector('.cc-stage'); return c ? JSON.stringify({ contentTransition: getComputedStyle(c).transitionDuration, stageTransition: getComputedStyle(s).transitionDuration }) : 'no canvas'; })()`));
await shot("d2-窄窗-无动效");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
// 滚轮缩放：画布自己吃掉滚轮，面板不该跟着滚
const scrollBefore = await ev("document.querySelector('.cm-panel').scrollTop");
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: D.vpBox.x + Math.round(D.vpBox.w / 2), y: D.vpBox.y + Math.round(D.vpBox.h / 2) });
for (let i = 0; i < 4; i++) { await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: D.vpBox.x + Math.round(D.vpBox.w / 2), y: D.vpBox.y + Math.round(D.vpBox.h / 2), deltaX: 0, deltaY: -120 }); await sleep(120); }
await sleep(700);
const E = await measure("E·滚轮缩放");
console.log("滚轮后面板 scrollTop:", await ev("document.querySelector('.cm-panel').scrollTop"), " 面板位移:", (await ev("document.querySelector('.cm-panel').scrollTop")) - scrollBefore);
await shot("d3-滚轮缩放");
// 拖动平移
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: D.vpBox.x + 200, y: D.vpBox.y + 200, button: "left", clickCount: 1, buttons: 1, pointerType: "mouse" });
for (let i = 1; i <= 5; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: D.vpBox.x + 200 + i * 18, y: D.vpBox.y + 200 + i * 10, buttons: 1, pointerType: "mouse" }); await sleep(60); }
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: D.vpBox.x + 290, y: D.vpBox.y + 250, button: "left", clickCount: 1, buttons: 0, pointerType: "mouse" });
await sleep(500);
const F = await measure("F·拖动平移");
console.log("拖动后 stage transform:", F.stageTransform, " 面板位移:", await ev("document.querySelector('.cm-panel').scrollTop"));
await shot("d4-拖动平移");
// 点空白退回全览
await ev(`(() => { const b = document.querySelector('.cc-backdrop'); if (b) b.click(); return Boolean(b); })()`);
await sleep(700);
const G = await measure("G·退回全览");
await shot("d5-退回全览");

/* ── 汇总 ───────────────────────────────────────────────────────── */
const fitClean = [A, B, C, D, G].map((m, i) => ({ g: "ABCDEFG"[i], overflowX: m.overflowX, overflowY: m.overflowY, panelOverflowX: m.panelOverflowX, leak: (m.fixedLeak || []).length }));
console.log("三把量尺:");
console.log("  1) fit 态不溢出:", JSON.stringify(fitClean));
console.log("  2) 缩放态 transform 非单位矩阵: fit =", B.contentTransform, " 放大 =", B2.contentTransform, " 滚轮 =", E.contentTransform, " stage放大 =", B2.stageTransform);
console.log("  3) 旧批 opacity 实测:", JSON.stringify({ 最新: C.cards.filter((c) => !c.faded).map((c) => c.opacity), 旧批: C.cards.filter((c) => c.faded).map((c) => c.opacity) }));
console.log("  批次上限:", await ev("JSON.stringify((window.__batches||[]).map(b=>b.key))"), "limit =", C2.cards.length, "张卡");
console.log("  窄窗高度:", D.vpBox.h, " 常规高度:", A.vpBox.h);
console.log("  计数与播报:", A.count, "|", B.count, "|", C.count, " 翻页箭头还在吗:", C.pager, " 旧那一格还在吗:", C.legacyHero);
ws.close();
await sleep(200);
chrome.kill();
process.exit(0);
