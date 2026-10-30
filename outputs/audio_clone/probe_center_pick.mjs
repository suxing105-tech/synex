// 探针 2：点缩略图正中间（隐藏的替换小圆钮）能否开选择器；换一份素材后格子是否真的换掉。
import { start } from "./cdp.mjs";

const p = await start("http://127.0.0.1:5199/", Number(process.env.PORT || 9342));
await p.sleep(3500);
const log = (k, v) => console.log(k, JSON.stringify(v));
await p.ev(`(() => { const card = document.querySelector(".media-card.is-audio"); card.scrollIntoView({ block: "center" }); card.querySelector(".media-clone-btn").click(); })()`);
await p.sleep(2500);
const tile = JSON.parse((await p.ev(`(() => { const t = document.querySelector(".cm-ref-row .cm-tile.media-chip"); const r = t.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, title: t.getAttribute("title"), src: t.querySelector(".cm-tile-img").src }); })()`)).value);
log("before", tile);
await p.click(tile.x, tile.y);
await p.sleep(1500);
log("picker open", await p.ev("!!document.querySelector('.mp-panel')"));
log("heading", await p.ev("document.querySelector('.mp-panel h3')?.textContent || null"));
log("tabs", await p.ev("[...document.querySelectorAll('.mp-tab')].map((b) => b.textContent + ':' + b.getAttribute('aria-pressed')).join('|')"));
const target = JSON.parse((await p.ev(`(() => { const cards = [...document.querySelectorAll(".mp-card")]; if (!cards.length) return "null"; const r = cards[0].getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + 18, name: cards[0].getAttribute("aria-label") }); })()`)).value);
log("click first card", target);
if (target) { await p.click(target.x, target.y); await p.sleep(1600); }
log("after", await p.ev("(() => { const t = document.querySelector('.cm-ref-row .cm-tile.media-chip'); return { title: t.getAttribute('title'), src: t.querySelector('.cm-tile-img').src }; })()"));
await p.shot("probe-center-pick.png");
p.close();
process.exit(0);
