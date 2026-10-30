// 探针 6：图片卡弹窗的底部宽度（决定 foot-left 该给多宽的上限）。
import fs from "node:fs";
import { start } from "./cdp.mjs";
const expr = (n) => fs.readFileSync(n, "utf8");
const p = await start("http://127.0.0.1:5199/", Number(process.env.PORT || 9347));
await p.sleep(4000);
const log = (k, v) => console.log(k, JSON.stringify(v));
log("opened", await p.ev(expr("open_image_card.js")));
await p.sleep(2600);
log("foot", await p.ev(expr("measure_foot3.js")));
await p.shot("foot-right-image.png");
p.close();
process.exit(0);
