import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

const target = document.getElementById("app");
if (!target) throw new Error("#app not found");

// Svelte 5 必须用 mount()，new App({ target }) 在 Svelte 5 里不会建立 effect root，
// 会导致所有 $effect / onMount 触发 effect_orphan 异常，页面黑屏。
const app = mount(App, { target });

// mount() 是同步的：跑到这一行时 SplashOverlay 已经在 DOM 里了，预挂载壳当场撤掉，
// 两者同帧交接，中间不留空白。
document.getElementById("boot-shell")?.remove();

export default app;
