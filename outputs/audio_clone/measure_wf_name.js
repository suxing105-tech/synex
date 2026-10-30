(() => {
  const pills = [...document.querySelectorAll(".cm-pill")];
  const b = pills.find((x) => x.getAttribute("aria-label") === "同款工作流");
  const g = document.querySelector("[role=radiogroup]");
  const on = g ? [...g.querySelectorAll("button")].filter((x) => x.getAttribute("aria-checked") === "true").map((x) => x.textContent.trim()) : [];
  return JSON.stringify({ wf: b ? b.textContent.trim() : null, modeOn: on, popOpen: !!document.querySelector(".cm-pop-wf") });
})()