(() => {
  const t = document.querySelector('.cm-ref-row .cm-tile.media-chip');
  if (!t) return "null";
  const r = t.getBoundingClientRect();
  return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
})()
