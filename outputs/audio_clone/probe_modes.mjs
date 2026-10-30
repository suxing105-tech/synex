// 真机 UI：音频弹窗顶上那排三种出声方式，切过去之后参考区与附框要跟着换。
import fs from "node:fs";
import { start } from "./cdp.mjs";
const expr = (n) => fs.readFileSync(n, "utf8");
const p = await start("http://127.0.0.1:5199/", Number(process.env.PORT || 9352));
await p.sleep(5000);
const log = (k, v) => console.log(k, JSON.stringify(v));
log("opened", await p.ev(expr("open_audio_card.js")));
await p.sleep(2600);
log("modes", await p.ev(expr("measure_modes.js")));
const clip = JSON.parse((await p.ev(`(() => {
  const m = document.querySelector('.cm-modal') || document.querySelector('[role=dialog]');
  return m ? JSON.stringify(m.getBoundingClientRect().toJSON()) : "null";
})()`)).value);
await p.shot("modes-clone.png", clip);
log("pick2", await p.ev(`(() => {
  const g = document.querySelector('[role=radiogroup][aria-label*=音频模式]');
  if (!g) return "no group";
  g.querySelectorAll('button')[1].click();
  return 'clicked';
})()`));
await p.sleep(1800);
log("after", await p.ev(expr("measure_modes.js")));
await p.shot("modes-design.png", clip);
log("pick3", await p.ev(`(() => {
  const g = document.querySelector('[role=radiogroup][aria-label*=音频模式]');
  if (!g) return "no group";
  g.querySelectorAll('button')[2].click();
  return 'clicked';
})()`));
await p.sleep(1800);
log("after3", await p.ev(expr("measure_modes.js")));
await p.shot("modes-custom.png", clip);
p.close();
process.exit(0);
