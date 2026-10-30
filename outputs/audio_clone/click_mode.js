(() => {
  const g = document.querySelector("[role=radiogroup]");
  if (!g) return "no modes";
  const i = window.__mode || 0;
  const b = g.querySelectorAll("button")[i];
  if (!b) return "no button " + i;
  b.click();
  return "clicked " + i + ": " + b.textContent.trim();
})()