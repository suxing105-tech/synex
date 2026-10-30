(() => {
  const panel = document.querySelector('.mp-panel');
  return panel ? (panel.querySelector("h3") ? panel.querySelector("h3").textContent : "open") : "closed";
})()
