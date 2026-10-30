(() => {
  const pills = [...document.querySelectorAll(".cm-pill")];
  const b = pills.find((x) => x.getAttribute("aria-label") === "同款工作流");
  const h = document.querySelector(".cm-title");
  const g = document.querySelector("[role=radiogroup]");
  const on = g ? [...g.querySelectorAll("button")].filter((x) => x.getAttribute("aria-checked") === "true").map((x) => x.textContent.trim())[0] : null;
  const foot = document.querySelector(".cm-foot-left");
  const first = foot && foot.children[0] ? Math.round(foot.children[0].getBoundingClientRect().left) : null;
  const ta = document.querySelector("textarea");
  return JSON.stringify({
    pill: b ? b.textContent.trim() : null,
    pillTitle: b ? b.getAttribute("title") : null,
    title: h ? h.textContent.trim() : null,
    titleTip: h ? h.getAttribute("title") : null,
    modeOn: on || null,
    footFirstLeft: first,
    textareaLeft: ta ? Math.round(ta.getBoundingClientRect().left) : null,
  });
})()