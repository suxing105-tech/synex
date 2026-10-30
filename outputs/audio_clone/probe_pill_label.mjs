// 三种出声方式下，弹窗标题与底部那颗都必须写「闪寻音频」；全名在悬浮提示里。顺带量一次底部左对齐。
import fs from "node:fs";
import { start } from "./cdp.mjs";
const expr = (n) => fs.readFileSync(n, "utf8");
const log = (k, v) => console.log(k, JSON.stringify(v));
const p = await start("http://127.0.0.1:5199/", Number(process.env.PORT || 9371));
await p.sleep(6000);
log("card", await p.ev(expr("open_audio_card.js")));
await p.sleep(2800);
const clip = JSON.parse((await p.ev(expr("panel_clip.js"))).value);
for (const i of [0, 1, 2]) {
  await p.ev("window.__mode = " + i + "; " + String.fromCharCode(34) + "ok" + String.fromCharCode(34));
  log("pick" + i, await p.ev(expr("click_mode.js")));
  await p.sleep(2200);
  log("pill" + i, await p.ev(expr("measure_pill.js")));
  await p.shot("r28-pill-mode" + i + ".png", clip);
}
p.close();
process.exit(0);