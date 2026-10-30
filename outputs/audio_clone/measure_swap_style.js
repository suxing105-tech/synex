(() => {
  const sw = document.querySelector('.cm-tile-swap');
  const pk = document.querySelector('.cm-tile-pick');
  if (!sw || !pk) return null;
  const a = getComputedStyle(sw);
  const b = getComputedStyle(pk);
  return [a.opacity, a.pointerEvents, b.cursor, b.position, b.width + "x" + b.height].join(" | ");
})()
