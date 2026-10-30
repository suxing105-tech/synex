(() => {
  const pop = document.querySelector(".cm-pop-wf");
  if (!pop) return JSON.stringify({ error: "no workflow popover" });
  const rows = [...pop.querySelectorAll(".cm-wf-row")].map((r) => {
    const b = r.querySelector(".cm-wf");
    const kind = r.querySelector(".cm-wf-kind");
    const name = r.querySelector(".cm-wf-name");
    const tag = r.querySelector(".cm-wf-tag");
    return {
      kind: kind ? kind.textContent.trim() : null,
      name: name ? name.textContent.trim() : null,
      tag: tag ? tag.textContent.trim() : null,
      checked: b.getAttribute("aria-checked"),
      del: !!r.querySelector(".cm-wf-del"),
      title: b.getAttribute("title"),
    };
  });
  const delCount = pop.querySelectorAll(".cm-wf-del").length;
  const add = pop.querySelector(".cm-wf-add");
  return JSON.stringify({ rows, delCount, add: add ? add.textContent.trim() : null }, null, 1);
})()