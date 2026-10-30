// Round 28 真机验收：音频三条工作流在「切换工作流」清单里折成一行；底部那一排左对齐；选中模式品牌色高亮。
import fs from "node:fs";
import { start } from "./cdp.mjs";

const expr = (n) => fs.readFileSync(n, "utf8");
const log = (k, v) => console.log(k, JSON.stringify(v));
const p = await start("http://127.0.0.1:5199/", Number(process.env.PORT || 9361));
await p.sleep(6000);

const panelRect = `(() => { const m = document.querySelector(".cm-panel"); return m ? JSON.stringify(m.getBoundingClientRect().toJSON()) : "null"; })()`;
const read = async (n) => JSON.parse((await p.ev(expr(n))).value);
const modalClip = async (extra = 0) => {
  const r = JSON.parse((await p.ev(panelRect)).value);
  return { x: Math.max(0, r.x - extra), y: Math.max(0, r.y - extra), width: r.width + extra * 2, height: r.height + extra * 2 };
};

log("1-audio-card", await p.ev(expr("open_audio_card.js")));
await p.sleep(2800);
log("2-align+mode", await read("measure_round28.js"));
await p.shot("r28-modes-highlight.png", await modalClip(8));

log("3-open-menu", await p.ev(expr("open_wf_menu.js")));
await p.sleep(700);
log("4-rows", await read("measure_menu_rows.js"));
await p.shot("r28-menu-collapsed.png", await modalClip(8));

const before = await p.ev(expr("measure_wf_name.js"));
log("5-before-group-click", before);
log("6-click-group", await p.ev(expr("click_group_row.js")));
await p.sleep(1500);
log("7-after-group-click", await p.ev(expr("measure_wf_name.js")));

// 换到另一种出声方式，再开清单：折叠那行仍要标「当前」
await p.ev(`(() => { const g = document.querySelector("[role=radiogroup]"); if (!g) return "no modes"; g.querySelectorAll("button")[1].click(); return "switched"; })()`);
await p.sleep(1800);
log("8-mode2", await p.ev(expr("measure_wf_name.js")));
await p.ev(expr("open_wf_menu.js"));
await p.sleep(700);
log("9-rows-mode2", await read("measure_menu_rows.js"));
await p.shot("r28-menu-mode2.png", await modalClip(8));

// 从图片卡打开：清单里应当是 图片 / 视频 / 闪寻音频 三行，删除 X 只给前两条
await p.ev(expr("click_group_row.js"));
await p.sleep(1200);
await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await p.sleep(1200);
log("10-image-card", await p.ev(expr("open_image_card.js")));
await p.sleep(2600);
log("11-open-menu", await p.ev(expr("open_wf_menu.js")));
await p.sleep(700);
log("12-rows-from-image", await read("measure_menu_rows.js"));
await p.shot("r28-menu-from-image.png", await modalClip(8));
log("13-click-group", await p.ev(expr("click_group_row.js")));
await p.sleep(2000);
log("14-after-from-image", await p.ev(expr("measure_wf_name.js")));
await p.shot("r28-after-group-from-image.png", await modalClip(8));
log("15-align-final", await read("measure_round28.js"));

p.close();
process.exit(0);