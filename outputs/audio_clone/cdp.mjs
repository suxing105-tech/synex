// 通用 CDP 探针：起 headless Chrome，给表达式、点坐标、截图。用法见 probe_*.mjs。
import { spawn } from "node:child_process";
import fs from "node:fs";

const EXE = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

export async function start(url, port = 9341) {
  const profile = fs.mkdtempSync(process.env.TEMP + "/cdp-probe-");
  const chrome = spawn(EXE, ["--headless=new", "--remote-debugging-port=" + port, "--user-data-dir=" + profile,
    "--window-size=1500,1000", "--force-device-scale-factor=1", "--hide-scrollbars", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  chrome.unref();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(400);
    try { ready = (await (await fetch("http://127.0.0.1:" + port + "/json/version")).ok); } catch { /* not yet */ }
  }
  if (!ready) throw new Error("NO DEVTOOLS");
  await fetch("http://127.0.0.1:" + port + "/json/new?" + encodeURIComponent(url), { method: "PUT" }).catch(() => {});
  await sleep(2500);
  const list = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  const page = list.find((t) => t.type === "page" && t.url.startsWith(url));
  if (!page) throw new Error("NO PAGE");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws fail")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  await send("Page.enable");
  await send("Runtime.enable");
  return {
    chrome, sleep, send,
    async ev(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) return { error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || "eval error" };
      return { value: r.result && r.result.value };
    },
    async shot(file, clip) {
      const params = { format: "png", captureBeyondViewport: !clip };
      if (clip) params.clip = { ...clip, scale: 1 };
      const r = await send("Page.captureScreenshot", params);
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      console.log("shot:", file);
    },
    async click(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    },
    close() { chrome.kill(); },
  };
}
