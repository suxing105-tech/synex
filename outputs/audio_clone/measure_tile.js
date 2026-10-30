(() => {
  const t = document.querySelector('.cm-ref-row .cm-tile.media-chip');
  if (!t) return "null";
  const r = t.getBoundingClientRect();
  const img = t.querySelector(".cm-tile-img");
  const el = document.elementFromPoint(r.x + 14, r.y + 14);
  return JSON.stringify({ hitX: r.x + 14, hitY: r.y + 14, hit: el ? String(el.className) : null,
    title: t.getAttribute('title'), src: img ? img.src : null, pick: !!t.querySelector('.cm-tile-pick') });
})()
