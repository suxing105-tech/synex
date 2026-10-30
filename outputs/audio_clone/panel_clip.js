(() => {
  const p = document.querySelector(".cm-panel");
  if (!p) return "null";
  const r = p.getBoundingClientRect();
  return JSON.stringify({ x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 6), width: r.width + 12, height: r.height + 12 });
})()