# -*- coding: utf-8 -*-
"""Feed: the audio card's corner control becomes the same clone badge as image/video;
playback moves into the media area (hover or while playing)."""
import io

P = "frontend/src/components/Feed.svelte"
t = io.open(P, encoding="utf-8").read()

def rep(old, new, count=1):
    global t
    assert t.count(old) == count, (old[:70], t.count(old))
    t = t.replace(old, new, count)

# 1) openClone now accepts audio
rep(
    "  // \u56fe\u7247\u5361\u4e0e\u89c6\u9891\u5361\u5171\u7528\u540c\u4e00\u4e2a\u5165\u53e3\u3001\u540c\u4e00\u4e2a\u5f39\u7a97\uff1b\u97f3\u9891\u6ca1\u6709\u80fd\u5582\u7ed9\u5de5\u4f5c\u6d41\u7684\u52a0\u8f7d\u5668\uff0c\u4e0d\u7ed9\u5165\u53e3\u3002\n"
    "  let cloneTarget = $state<MediaFeedItem | null>(null);\n"
    "  function openClone(it: MediaFeedItem) {\n"
    "    if (it.kind !== \"image\" && it.kind !== \"video\") return;",
    "  // \u56fe\u7247\u5361\u3001\u89c6\u9891\u5361\u4e0e\u97f3\u9891\u5361\u5171\u7528\u540c\u4e00\u4e2a\u5165\u53e3\u3001\u540c\u4e00\u4e2a\u5f39\u7a97\uff1a\u53f3\u4e0b\u89d2\u90a3\u9897\u4e0d\u7ba1\u54ea\u4e00\u65cf\u90fd\u662f\u300c\u4e00\u952e\u540c\u6b3e\u300d\u3002\n"
    "  // \u4ece\u97f3\u9891\u5361\u6253\u5f00\u65f6\uff0c\u8fd9\u6bb5\u58f0\u97f3\u5148\u7ad9\u8fdb\u300c\u97f3\u9891 1\u300d\u5f53\u53c2\u8003\u97f3\u8272\u2014\u2014\u4e0e\u89c6\u9891\u5361\u628a\u81ea\u5df1\u653e\u8fdb\u300c\u89c6\u9891 1\u300d\u540c\u4e00\u5957\u903b\u8f91\u3002\n"
    "  let cloneTarget = $state<MediaFeedItem | null>(null);\n"
    "  function openClone(it: MediaFeedItem) {\n"
    "    if (it.kind !== \"image\" && it.kind !== \"video\" && it.kind !== \"audio\") return;",
)

# 2) clicking an audio output plays it instead of opening the lightbox
rep(
    "    if (kind === \"video\" || produced?.kind === \"video\") {",
    "    if (kind === \"audio\" || produced?.kind === \"audio\") {\n"
    "      if (!produced) {\n"
    "        notify(\"\u8fd9\u6bb5\u914d\u97f3\u8fd8\u6ca1\u51fa\u73b0\u5728\u5f53\u524d\u5217\u8868\u91cc\uff0c\u7a0d\u7b49\u4e00\u4e0b\u6216\u53bb\u56fe\u5e93\u91cc\u627e\u3002\");\n"
    "        return;\n"
    "      }\n"
    "      applySelection(items, id, \"none\");\n"
    "      playAudio(produced);\n"
    "      return;\n"
    "    }\n"
    "    if (kind === \"video\" || produced?.kind === \"video\") {",
)

# 3) context menu
rep(
    "        ...(t.kind === \"image\" || t.kind === \"video\" ? [{ label: \"\u4e00\u952e\u540c\u6b3e\", onClick: () => openClone(t) }] : []),",
    "        ...(t.kind === \"image\" || t.kind === \"video\" || t.kind === \"audio\"\n"
    "          ? [{ label: \"\u4e00\u952e\u540c\u6b3e\", onClick: () => openClone(t) }]\n"
    "          : []),",
)

# 4) footer padding hook applies to audio cards too now
rep(
    "{(it.kind === 'image' || it.kind === 'video') && footerTier > 0 ? 'is-cloneable ' : ''}",
    "{(it.kind === 'image' || it.kind === 'video' || it.kind === 'audio') && footerTier > 0 ? 'is-cloneable ' : ''}",
)

# 5) the corner badge: three kinds share it
rep(
    "                  {#if it.kind === \"image\" || it.kind === \"video\"}",
    "                  {#if it.kind === \"image\" || it.kind === \"video\" || it.kind === \"audio\"}",
)
rep(
    "                      aria-label={`\u7528\u540c\u6b3e\u5de5\u4f5c\u6d41\u518d\u751f\u6210${it.kind === \"video\" ? \"\u4e00\u6761\" : \"\u4e00\u5f20\"}`}",
    "                      aria-label={`\u7528\u540c\u6b3e\u5de5\u4f5c\u6d41\u518d\u751f\u6210${it.kind === \"image\" ? \"\u4e00\u5f20\" : \"\u4e00\u6761\"}`}",
)

# 6) lift the play badge out of the footer corner and into the media area
start = t.index('                {#if it.kind === "audio"}\n                  <div\n                    role="button"\n')
end = t.index("                {/if}\n              </button>", start) + len("                {/if}\n")
play_block = t[start:end]
t = t[:start] + t[end:]
inner = play_block.replace('                {#if it.kind === "audio"}\n', "", 1)
inner = inner[: inner.rindex("                {/if}\n")]
inner = "".join(("  " + line if line.strip() else line) + "\n" for line in inner.splitlines())
inner = inner.replace('class="audio-play-btn"', 'class="audio-play-btn audio-play-btn--media"', 1)
anchor = "                      <Icon name=\"comfyui\" size={15} />\n                    </div>\n                  {/if}\n"
assert t.count(anchor) == 1
moved = (
    anchor
    + "                  {#if it.kind === \"audio\" && (hoveredId === it.id || $playingAudio?.id === it.id)}\n"
    + "                    <!-- \u64ad\u653e\u4ece\u53f3\u4e0b\u89d2\u9000\u5230\u753b\u9762\u5de6\u4e0b\u89d2\uff1a\u90a3\u4e2a\u89d2\u843d\u73b0\u5728\u8ddf\u56fe\u7247\u5361\u3001\u89c6\u9891\u5361\u4e00\u6837\uff0c\u662f\u300c\u4e00\u952e\u540c\u6b3e\u300d\u7684\u3002\n"
    + "                         \u60ac\u505c\u6216\u6b63\u5728\u64ad\u653e\u65f6\u624d\u51fa\u73b0\uff0c\u4e0e\u89c6\u9891\u5361\u60ac\u505c\u5373\u64ad\u540c\u4e00\u5957\u4e60\u60ef\uff1b\u53cc\u51fb\u5361\u7247\u4ecd\u7136\u76f4\u63a5\u64ad\u3002 -->\n"
    + inner
    + "                  {/if}\n"
)
t = t.replace(anchor, moved, 1)

# 7) its new home styles
rep(
    "  .audio-play-icon {\n    width: 100%;",
    "  /* \u64ad\u653e\u632a\u8fdb\u753b\u9762\u5de6\u4e0b\u89d2\uff1a\u53f3\u4e0b\u89d2\u4ea4\u7ed9\u4e86\u4e0e\u56fe\u7247/\u89c6\u9891\u540c\u4e00\u9897\u300c\u4e00\u952e\u540c\u6b3e\u300d\u3002\n"
    "     \u5c3a\u5bf8\u6cbf\u7528 --audio-btn\uff0c\u4f4d\u7f6e\u6539\u6210\u8d34\u753b\u9762\u5de6\u4e0b\u89d2\uff0c\u4e0d\u518d\u53c2\u4e0e\u9875\u811a\u9ad8\u5ea6\u7684\u5782\u76f4\u5c45\u4e2d\u3002 */\n"
    "  .audio-play-btn--media {\n"
    "    left: 8px;\n"
    "    right: auto;\n"
    "    bottom: 8px;\n"
    "  }\n"
    "  .audio-play-icon {\n    width: 100%;",
)

io.open(P, "w", encoding="utf-8", newline="\n").write(t)
print("patched", P)
