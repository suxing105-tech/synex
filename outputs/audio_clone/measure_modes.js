(() => {
  const g = document.querySelector('[role=radiogroup][aria-label*=音频模式]');
  if (!g) return JSON.stringify({ group: null });
  const items = [...g.querySelectorAll("button")].map((b) => ({
    text: b.textContent.trim(), checked: b.getAttribute("aria-checked"), title: b.title,
    rect: b.getBoundingClientRect().toJSON(),
  }));
  const cs = getComputedStyle(g.querySelectorAll("button")[0]);
  const box = g.closest(".cm-modal, .cm-form, form") || g.parentElement;
  return JSON.stringify({ items, style: { bg: cs.backgroundColor, radius: cs.borderRadius, padding: cs.padding },
    groupText: g.previousElementSibling ? g.previousElementSibling.textContent : null,
    groups: [...document.querySelectorAll("[role=group]")].map((x)=>x.getAttribute("aria-label")),
    note: (document.querySelector(".cm-note")||{}).textContent });
})()
