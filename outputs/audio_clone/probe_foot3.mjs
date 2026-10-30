// 探针 5：底部整排靠右 + 长名字不换行。
import fs from "node:fs";
import { start } from "./cdp.mjs";
const expr = (n) => fs.readFileSync(n, "utf8");
const p = await start("http://127.0.0.1:5199/", Number(process.env.PORT || 9346));
await p.sleep(4000);
const log = (k, v) => console.log(k, JSON.stringify(v));
const kind = process.env.KIND || "audio";
log("opened", await p.ev(`(() => { const c = document.querySelector(".media-card.is-" + KIND); c.scrollIntoView({ block: "center" }); const b = c.querySelector(".media-clone-btn"); if (!b) return "no btn"; b.click(); return c.querySelector(".media-card-name").textContent; })()`.replace("KIND", JSON.stringify(kind))));
await p.sleep(2600);
log("foot", await p.ev(expr("measure_foot3.js")));
await p.shot("foot-right-" + kind + ".png");
const long = (await p.ev(expr("measure_long_name.js")));
log("long name", long);
await p.shot("foot-long-name.png");
p.close();
process.exit(0);
