(() => {
  const tabs = [...document.querySelectorAll('button')].filter((b) => /一键同款/.test(b.textContent));
  if (!tabs.length) return 'no tab';
  tabs[0].click();
  return 'tab: ' + tabs[0].textContent.trim();
})()
