(() => {
  const f = document.querySelector('.cm-foot-left');
  if (!f) return null;
  const pills = [...f.querySelectorAll('.cm-pill')].map((el) => {
    const r = el.getBoundingClientRect();
    const t = el.querySelector('.cm-pill-text');
    const ch = el.querySelector('.cm-chevron');
    return { w: +r.width.toFixed(1), text: t ? t.textContent : null, textW: t ? +t.getBoundingClientRect().width.toFixed(1) : 0,
      chevW: ch ? +ch.getBoundingClientRect().width.toFixed(1) : 0, inFill: !!el.closest('.cm-fill') };
  });
  const go = document.querySelector('.cm-go');
  return { footW: +f.getBoundingClientRect().width.toFixed(1), goW: go ? +go.getBoundingClientRect().width.toFixed(1) : 0, pills };
})()
