(() => {
  const x = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().left) : null; };
  const foot = document.querySelector(".cm-foot-left");
  const first = foot && foot.children[0] ? Math.round(foot.children[0].getBoundingClientRect().left) : null;
  const ta = document.querySelector("textarea");
  return JSON.stringify({
    footLeft: foot ? Math.round(foot.getBoundingClientRect().left) : null,
    firstPillLeft: first,
    textareaLeft: ta ? Math.round(ta.getBoundingClientRect().left) : null,
    formLeft: x(".cm-form"),
    titleLeft: x(".cm-title"),
    panelLeft: x(".cm-panel"),
  });
})()