// 设置 → 一键同款：五条内置工作流的徽标与族别在真机 UI 里对不对。
import fs from "node:fs";
import { start } from "./cdp.mjs";
const expr = (n) => fs.readFileSync(n, "utf8");
const p = await start("http://127.0.0.1:5199/", Number(process.env.PORT || 9355));
await p.sleep(5000);
const log = (k, v) => console.log(k, JSON.stringify(v));
log("settings", await p.ev(expr("open_settings.js")));
await p.sleep(1500);
log("tab", await p.ev(expr("open_clone_tab.js")));
await p.sleep(2000);
log("rows", await p.ev(expr("measure_templates.js")));
await p.shot('settings-templates.png');
p.close();
process.exit(0);
