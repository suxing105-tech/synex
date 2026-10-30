(() => {
  const foot = document.querySelector('.cm-foot');
  if (!foot) return JSON.stringify({ error: 'no foot' });
  const b = (n) => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), r: Math.round(r.right), w: Math.round(r.width) }; };
  const left = foot.querySelector(".cm-foot-left");
  const act = foot.querySelector(".cm-actions");
  const pills = [...foot.querySelectorAll(".cm-pill")].map((p) => ({ t: p.textContent.trim().slice(0,10), ...b(p) }));
  const modal = document.querySelector(".cm-modal, [role=dialog]");
  return JSON.stringify({
    vw: window.innerWidth, modal: modal ? b(modal) : null, foot: b(foot),
    left: { ...b(left), jc: getComputedStyle(left).justifyContent, flex: getComputedStyle(left).flex },
    act: act ? b(act) : null, pills,
    formLeft: (() => { const f = document.querySelector(".cm-form"); return f ? Math.round(f.getBoundingClientRect().x) : null; })(),
    blockLeft: (() => { const f = document.querySelector(".cm-block-title"); return f ? Math.round(f.getBoundingClientRect().x) : null; })(),
  }, null, 1);
})()
