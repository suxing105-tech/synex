// 探针：素材位整块是不是点得动？换一份素材能不能真的换掉。
import { start } from "./cdp.mjs";

const p = await start("http://127.0.0.1:5199/", Number(process.env.PORT || 9341));
await p.sleep(3500);
const log = (k, v) => console.log(k, JSON.stringify(v));

log("audio cards", await p.ev("document.querySelectorAll('.media-card.is-audio').length"));
log("open modal", await p.ev(`(() => {
  const card = document.querySelector(".media-card.is-audio");
  if (!card) return "no audio card";
  card.scrollIntoView({ block: "center" });
  const btn = card.querySelector(".media-clone-btn");
  if (!btn) return "no clone btn";
  btn.click();
  return card.querySelector(".media-card-name")?.textContent;
})()`));
await p.sleep(2500);

log("tile probe", await p.ev(`(() => {
  const tile = document.querySelector(".cm-ref-row .cm-tile.media-chip");
  if (!tile) return "no filled tile";
  const r = tile.getBoundingClientRect();
  const pts = { center: [r.x + r.width / 2, r.y + r.height / 2], topLeft: [r.x + 14, r.y + 14], bottomRight: [r.x + r.width - 12, r.y + r.height - 12] };
  const hit = {};
  for (const [name, [x, y]] of Object.entries(pts)) {
    const el = document.elementFromPoint(x, y);
    hit[name] = el ? (el.className || el.tagName) : null;
  }
  window.__tile = pts;
  return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, hit, src: tile.querySelector(".cm-tile-img")?.src, title: tile.getAttribute("title") };
})()`));

const tl = (await p.ev("JSON.stringify(window.__tile.topLeft)")).value;
const [tx, ty] = JSON.parse(tl);
await p.click(tx, ty);
await p.sleep(1200);
log("picker after off-center click", await p.ev("document.querySelectorAll('.mp-panel').length"));
log("picker open flag", await p.ev("!!document.querySelector('.mp-panel')"));
log("picker heading", await p.ev("document.querySelector('.mp-panel h3')?.textContent"));
await p.shot("probe-picker-open.png");

log("pick other", await p.ev(`(() => {
  const cards = [...document.querySelectorAll(".mp-card")];
  return cards.slice(0, 4).map((c) => c.getAttribute("aria-label") + "=" + c.getBoundingClientRect().x.toFixed(0));
})()`));
const pickRect = (await p.ev(`(() => {
  const cards = [...document.querySelectorAll(".mp-card")];
  if (!cards.length) return null;
  const c = cards[cards.length > 1 ? 1 : 0];
  const r = c.getBoundingClientRect();
  return JSON.stringify({ x: r.x + r.width / 2, y: r.y + 20, name: c.getAttribute("aria-label") });
})()`)).value;
if (pickRect) {
  const q = JSON.parse(pickRect);
  log("picking", q);
  await p.click(q.x, q.y);
  await p.sleep(1500);
  log("tile after pick", await p.ev("(() => { const t = document.querySelector('.cm-ref-row .cm-tile.media-chip'); return t ? { title: t.getAttribute('title'), src: t.querySelector('.cm-tile-img')?.src } : 'gone'; })()"));
}
await p.shot("probe-after-pick.png");
p.close();
process.exit(0);
