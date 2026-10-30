(() => {
  const foot = document.querySelector('.cm-foot');
  const left = document.querySelector('.cm-foot-left');
  const acts = document.querySelector('.cm-actions');
  if (!foot || !left || !acts) return null;
  const lr = left.getBoundingClientRect();
  const ar = acts.getBoundingClientRect();
  const pills = [...left.querySelectorAll('.cm-pill')].map((el) => {
    const r = el.getBoundingClientRect();
    return { text: el.querySelector('.cm-pill-text').textContent.slice(0, 12), w: +r.width.toFixed(1), x: +r.x.toFixed(1) };
  });
  return { sameLine: Math.abs(lr.y - ar.y) < 2, leftX: +lr.x.toFixed(1), leftW: +lr.width.toFixed(1),
    actionsX: +ar.x.toFixed(1), actionsW: +ar.width.toFixed(1), footW: +foot.getBoundingClientRect().width.toFixed(1), pills };
})()
