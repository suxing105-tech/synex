// 验收探针：整块缩略图可点、语言网格中文化、底部胶囊宽度。
import fs from "node:fs";
import { start } from "./cdp.mjs";
const expr = (n) => fs.readFileSync(n, "utf8");
const p = await start("http://127.0.0.1:5199/", Number(process.env.PORT || 9344));
await p.sleep(4000);
const log = (k, v) => console.log(k, JSON.stringify(v));
const openCard = (sel) => p.ev(`const c = document.querySelector("${sel}"); c.scrollIntoView({ block: "center" }); c.querySelector(".media-clone-btn").click();`);
await openCard(".media-card.is-audio");
await p.sleep(2500);
const pos = JSON.parse((await p.ev(expr("measure_tile.js"))).value);
log("tile before", pos);
await p.click(pos.hitX, pos.hitY);
await p.sleep(1500);
log("picker after off-center click", await p.ev(expr("measure_picker_open.js")));
const one = JSON.parse((await p.ev(expr("measure_first_card.js"))).value);
if (one) { await p.click(one.x, one.y); await p.sleep(1600); }
log("tile after pick", await p.ev(expr("measure_tile.js")));
await p.ev(`document.querySelector(".cm-close").click()`);
await p.sleep(900);
await openCard(".media-card.is-audio");
await p.sleep(2200);
log("foot", await p.ev(expr("measure_foot.js")));
await p.ev(`document.querySelector(".cm-pill").click()`);
await p.sleep(900);
log("grid", await p.ev(expr("measure_pop.js")));
await p.shot("verify-lang-grid.png");
p.close();
process.exit(0);
