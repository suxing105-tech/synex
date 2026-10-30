(() => {
  const foot = document.querySelector(".cm-foot-left");
  if (!foot) return JSON.stringify({ error: "no foot" });
  const fr = foot.getBoundingClientRect();
  const kids = [...foot.children].map((c) => {
    const r = c.getBoundingClientRect();
    return { cls: c.className, x: Math.round(r.left), w: Math.round(r.width) };
  });
  const panel = document.querySelector(".cm-panel");
  const body = document.querySelector(".cm-body") || panel;
  const g = document.querySelector("[role=radiogroup]");
  const modes = g ? [...g.querySelectorAll("button")].map((b) => {
    const cs = getComputedStyle(b);
    return { text: b.textContent.trim(), checked: b.getAttribute("aria-checked"), bg: cs.backgroundColor, shadow: cs.boxShadow, weight: cs.fontWeight };
  }) : null;
  return JSON.stringify({
    footX: Math.round(fr.left), footW: Math.round(fr.width),
    justify: getComputedStyle(foot).justifyContent,
    firstKidX: kids.length ? kids[0].x : null,
    bodyX: body ? Math.round(body.getBoundingClientRect().left) : null,
    panelX: panel ? Math.round(panel.getBoundingClientRect().left) : null,
    kids, modes,
  }, null, 1);
})()