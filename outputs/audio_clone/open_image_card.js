(() => {
  const cards = [...document.querySelectorAll('.media-card.is-cloneable')];
  const card = cards.find((c) => !c.classList.contains('is-audio') && !c.querySelector('video'));
  if (!card) return "no image card";
  card.scrollIntoView({ block: 'center' });
  card.querySelector('.media-clone-btn').click();
  return card.querySelector('.media-card-name').textContent;
})()
