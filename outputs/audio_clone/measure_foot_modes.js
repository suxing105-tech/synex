(() => {
  const foot = document.querySelector('.cm-foot');
  const right = document.querySelector('.cm-right, .cm-col-right, .cm-form');
  if (!foot) return JSON.stringify({ error: "no foot" });
  const r = (n) => { const b = n.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) }; };
  const label = document.querySelector(".cm-right .cm-label, .cm-label");
  const kids = [...foot.children].map((c) => ({ cls: c.className, ...r(c), text: c.textContent.replace(/\s+/g," ").trim().slice(0,30),
    jc: getComputedStyle(c).justifyContent, flex: getComputedStyle(c).flex }));
  const pills = [...foot.querySelectorAll(".cm-pill")].map((p) => ({ cls: p.className, ...r(p), text: p.textContent.trim() }));
  const gen = foot.parentElement.querySelector("button.cm-generate, .cm-generate");
  return JSON.stringify({ foot: r(foot), right: right ? r(right) : null, label: label ? { ...r(label), text: label.textContent.trim() } : null,
    kids, pills, gen: gen ? r(gen) : null, cs: { jc: getComputedStyle(foot).justifyContent, wrap: getComputedStyle(foot).flexWrap } }, null, 1);
})()
