(() => {
  const pills = [...document.querySelectorAll(".cm-pill")];
  const b = pills.find((x) => x.getAttribute("aria-label") === "同款工作流");
  if (!b) return "no wf pill";
  const r = b.getBoundingClientRect().toJSON();
  b.click();
  return JSON.stringify({ clicked: true, rect: r, name: b.textContent.trim() });
})()