// 探针 4：底部胶囊宽度 + 语言网格中文（打开音频卡弹窗后直接量）。
import fs from "node:fs";
import { start } from "./cdp.mjs";
const expr = (n) => fs.readFileSync(n, "utf8");
const p = await start("http://127.0.0.1:5199/", Number(process.env.PORT || 9345));
await p.sleep(4000);
const log = (k, v) => console.log(k, JSON.stringify(v));
const kind = process.env.KIND || "audio";
log("opened", await p.ev(`(() => { const c = document.querySelector(".media-card.is-" + KIND); c.scrollIntoView({ block: "center" }); const b = c.querySelector(".media-clone-btn"); if (!b) return "no btn"; b.click(); return c.querySelector(".media-card-name").textContent; })()`.replace("KIND", JSON.stringify(kind))));
await p.sleep(2600);
log("foot", await p.ev(expr("measure_foot.js")));
await p.ev(`document.querySelector(".cm-pill").click()`);
await p.sleep(1000);
log("grid", await p.ev(expr("measure_pop.js")));
await p.shot("foot-" + kind + ".png");
p.close();
process.exit(0);
