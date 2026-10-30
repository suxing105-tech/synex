(() => {
  const want = window.__want || "image";
  const cards = [...document.querySelectorAll(".media-card.is-cloneable")];
  const imgExt = /\.(png|jpe?g|webp|bmp)$/i;
  const vidExt = /\.(mp4|mov|webm|mkv)$/i;
  const audExt = /\.(flac|mp3|wav|ogg|m4a|aac)$/i;
  const card = cards.find((c) => {
    const n = ((c.querySelector(".media-card-name") || {}).textContent || "").trim();
    if (want === "image") return imgExt.test(n);
    if (want === "video") return vidExt.test(n);
    return audExt.test(n);
  });
  if (!card) return "no " + want + " card";
  card.scrollIntoView({ block: "center" });
  card.querySelector(".media-clone-btn").click();
  return ((card.querySelector(".media-card-name") || {}).textContent || "").trim();
})()