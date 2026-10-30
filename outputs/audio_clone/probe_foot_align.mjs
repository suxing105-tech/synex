// 底部那一排在三种窗口宽度下的实际几何：空隙到底落在左边还是胶囊与生成中间。
import fs from "node:fs";
import { start } from "./cdp.mjs";
const expr = (n) => fs.readFileSync(n, "utf8");
const p = await start("http://127.0.0.1:5199/", Number(process.env.PORT || 9361));
await p.sleep(5000);
const log = (k, v) => console.log(k, JSON.stringify(v));
log("opened", await p.ev(expr("open_audio_card.js")));
await p.sleep(2600);
for (const w of [1500, 1180, 980]) {
  await p.send('Browser.setWindowBounds', { bounds: { width: w, height: 1000 } }).catch(() => {});
  await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: 950, deviceScaleFactor: 1, mobile: false }).catch((e) => console.log('emf', e));
  await p.sleep(700);
  log(w, JSON.parse((await p.ev(expr("measure_foot_align.js"))).value));
}
p.close();
process.exit(0);
