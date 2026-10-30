(() => {
  const row = document.querySelector('.cm-ref-row');
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return JSON.stringify({ x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 });
})()
