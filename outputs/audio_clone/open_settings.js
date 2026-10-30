(() => {
  const btn = document.querySelector('button[aria-label=设置]');
  if (!btn) return "no settings button";
  btn.click();
  return 'clicked';
})()
