(() => {
  const b = document.querySelector('.cm-ref-row .cm-tile .cm-tile-x');
  if (!b) return "null";
  const r = b.getBoundingClientRect();
  return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
})()
