(() => {
  const rows = [...document.querySelectorAll('.ct-row, tr, li')].filter((r) => /闪寻/.test(r.textContent));
  return JSON.stringify(rows.map((r) => ({
    text: r.textContent.replace(/\s+/g, " ").trim().slice(0, 90),
    badges: [...r.querySelectorAll(".ct-kind, .ct-badge, .ct-bundled")].map((b) => b.textContent.trim()),
  })), null, 1);
})()
