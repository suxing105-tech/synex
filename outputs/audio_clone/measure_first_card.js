(() => {
  const cards = [...document.querySelectorAll('.mp-card')];
  if (!cards.length) return "null";
  const r = cards[0].getBoundingClientRect();
  return JSON.stringify({ x: r.x + r.width / 2, y: r.y + 18, name: cards[0].getAttribute("aria-label") });
})()
