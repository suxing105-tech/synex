import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

const target = document.getElementById("app");
if (!target) throw new Error("#app not found");

// Svelte 5 必须用 mount()，new App({ target }) 在 Svelte 5 里不会建立 effect root，
// 会导致所有 $effect / onMount 触发 effect_orphan 异常，页面黑屏。
const app = mount(App, { target });
export default app;
