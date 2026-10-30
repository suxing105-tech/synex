// 跨族换卡验收：音频卡 → 图片卡 → 视频卡 → 音频卡，工作流那颗每次都该落在同一族里（Round 28 顺手修的死 bug）。
import fs from "node:fs";
import { start } from "./cdp.mjs";

const expr = (n) => fs.readFileSync(n, "utf8");
const log = (k, v) => console.log(k, JSON.stringify(v));
const p = await start("http://127.0.0.1:5199/", Number(process.env.PORT || 9364));
await p.sleep(6000);

const pillName = `(() => {
  const pills = [...document.querySelectorAll(".cm-pill")];
  const b = pills.find((x) => x.getAttribute("aria-label") === "同款工作流");
  const g = document.querySelector("[role=radiogroup]");
  const on = g ? [...g.querySelectorAll("button")].filter((x) => x.getAttribute("aria-checked") === "true").map((x) => x.textContent.trim()) : [];
  return JSON.stringify({ wf: b ? b.textContent.trim() : null, mode: on[0] || null });
})()`;

const closeIt = async () => {
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await p.sleep(1000);
};

for (const want of ["audio", "image", "video", "audio"]) {
  await closeIt();
  await p.ev(`window.__want = "` + want + `"; "ok"`);
  const card = await p.ev(expr("open_kind_card.js"));
  await p.sleep(2600);
  log("card=" + want, { card: card.value, wf: (await p.ev(pillName)).value });
}

p.close();
process.exit(0);