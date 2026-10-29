/**
 * 悬停即播：海报上叠一层 `<video>`，只有鼠标滑过那一张被挂进 DOM，移开就卸载。
 *
 * `muted` 必须先显式写成 DOM 属性——Svelte 只把 muted 当 attribute 写，而 autoplay 策略读的是
 * property，两者不同步会被 Chromium 拦掉。解不开容器就什么都不做，底下的海报图本来就在，
 * 最差也只是不动。
 *
 * 图库卡片（Feed）与一键同款的素材选择器共用这一份：两处各写一遍，早晚有一处忘了置 muted。
 */
export function hoverPlay(node: HTMLVideoElement) {
  node.muted = true;
  node.volume = 0;
  // jsdom / happy-dom 的 play() 返回 undefined，直接 .catch 会在测试里炸；浏览器返回 Promise。
  const p = node.play();
  if (p && typeof p.catch === "function") p.catch(() => {});
}