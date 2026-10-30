(() => JSON.stringify({
  filled: document.querySelectorAll('.cm-ref-row .cm-tile.media-chip').length,
  add: !!document.querySelector('.cm-tile-add'),
  picker: !!document.querySelector('.mp-panel'),
  caption: [...document.querySelectorAll('.cm-ref-caption')].map((e) => e.textContent + (e.classList.contains('cm-ref-caption-empty') ? '*' : '')).join(','),
}))()
