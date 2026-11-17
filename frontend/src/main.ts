import { mount } from "svelte";
import App from "./App.svelte";
import { installExternalLinkHandler } from "./lib/external-links";
import "./app.css";

// 外链在挂载之前先接管：APP 端（WebView2）没有新窗口宿主，页面里任何 target="_blank"
// 或跨源链接点了都不会有反应，统一交给系统默认浏览器（见该模块顶上的说明）。
installExternalLinkHandler();

const target = document.getElementById("app");
if (!target) throw new Error("#app not found");

// Svelte 5 必须用 mount()，new App({ target }) 在 Svelte 5 里不会建立 effect root，
// 会导致所有 $effect / onMount 触发 effect_orphan 异常，页面黑屏。
const app = mount(App, { target });

// mount() 是同步的：跑到这一行时 SplashOverlay 已经在 DOM 里了，预挂载壳当场撤掉，
// 两者同帧交接，中间不留空白。
document.getElementById("boot-shell")?.remove();

export default app;
