(() => {
  const cards = [...document.querySelectorAll('.media-card.is-cloneable.is-audio')];
  if (!cards.length) return 'no audio card';
  const card = cards[0];
  card.scrollIntoView({ block: 'center' });
  card.querySelector('.media-clone-btn').click();
  return card.querySelector('.media-card-name').textContent;
})()
