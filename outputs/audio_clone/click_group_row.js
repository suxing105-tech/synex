(() => {
  const pop = document.querySelector(".cm-pop-wf");
  if (!pop) return "no pop";
  const rows = [...pop.querySelectorAll(".cm-wf")];
  const hit = rows.find((r) => r.textContent.includes("闪寻音频"));
  if (!hit) return "no collapsed row";
  hit.click();
  return "clicked collapsed row";
})()