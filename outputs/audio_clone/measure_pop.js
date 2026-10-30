(() => {
  const pop = document.querySelector('.cm-pop');
  if (!pop) return null;
  return [...pop.querySelectorAll('.cm-ratio')].map((b) => {
    const lab = b.querySelector('.cm-ratio-label');
    return (lab ? lab.textContent : '?') + '<-' + b.getAttribute('aria-label');
  }).join(String.fromCharCode(32) + "|" + String.fromCharCode(32));
})()
