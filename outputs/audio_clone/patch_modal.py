# -*- coding: utf-8 -*-
"""CloneModal: third family (audio) — hero player, template picking, badges, copy."""
import io

P = "frontend/src/components/CloneModal.svelte"
t = io.open(P, encoding="utf-8").read()

def rep(old, new):
    global t
    assert t.count(old) == 1, (old[:80], t.count(old))
    t = t.replace(old, new, 1)

rep(
    "    familyCells, isVideoTemplate, referenceCounter, referenceFamilies, referenceNoun, REF_KIND_COUNTERS, REF_KIND_NAMES,\n"
    "    templateDisplayName,",
    "    familyCells, isAudioTemplate, isVideoTemplate, referenceCounter, referenceFamilies, referenceNoun,\n"
    "    REF_KIND_COUNTERS, REF_KIND_NAMES, templateDisplayName, templateMediaKind,",
)

rep(
    "  /** \u70b9\u5f00\u8fd9\u5f20\u5361\u7684\u662f\u56fe\u7247\u8fd8\u662f\u89c6\u9891\uff1a\u51b3\u5b9a\u7d20\u6750\u9ed8\u8ba4\u843d\u54ea\u4e00\u683c\u3001@ \u51fa\u53bb\u63d2\u54ea\u79cd\u6807\u7b7e\u3001\u4ea7\u51fa\u600e\u4e48\u79f0\u547c\u3002 */\n"
    '  const cardKind = $derived<RefKind>(image?.kind === "video" ? "video" : "image");\n'
    "  const isVideoWf = $derived(isVideoTemplate(template));\n"
    '  const mediaKind = $derived<MediaKind>(isVideoWf ? "video" : "image");',
    "  /** \u70b9\u5f00\u8fd9\u5f20\u5361\u7684\u662f\u54ea\u4e00\u65cf\uff1a\u56fe\u7247 / \u89c6\u9891 / \u97f3\u9891\u3002\u51b3\u5b9a\u7d20\u6750\u9ed8\u8ba4\u843d\u54ea\u4e00\u683c\u4e0e\u4ea7\u51fa\u600e\u4e48\u79f0\u547c\u3002 */\n"
    '  const cardKind = $derived<RefKind>(\n'
    '    image?.kind === "video" ? "video" : image?.kind === "audio" ? "audio" : "image",\n'
    "  );\n"
    "  /** \u53d9\u8ff0\u8fd9\u4e00\u4efd\u7d20\u6750\u7684\u91cf\u8bcd + \u540d\u8bcd\uff1a\u300c\u8fd9\u5f20\u89c6\u9891\u300d\u300c\u8fd9\u6bb5\u97f3\u9891\u300d\u522b\u7edf\u79f0\u6210\u56fe\u3002 */\n"
    '  const cardLabel = $derived(\n'
    '    cardKind === "video" ? "\u8fd9\u6761\u89c6\u9891" : cardKind === "audio" ? "\u8fd9\u6bb5\u97f3\u9891" : "\u8fd9\u5f20\u56fe",\n'
    "  );\n"
    "  const isVideoWf = $derived(isVideoTemplate(template));\n"
    "  // \u5f39\u7a97\u7684\u884c\u4e3a\u8ddf\u5de5\u4f5c\u6d41\u8d70\uff0c\u4e0d\u8ddf\u5361\u7247\u8d70\uff1a\u5728\u56fe\u7247\u5361\u4e0a\u6362\u6210\u97f3\u9891\u5de5\u4f5c\u6d41\uff0c\n"
    "  // @ \u5f15\u7528\u4e5f\u4e0d\u8be5\u7a81\u7136\u5f00\u59cb\u63d2 H3 \u7684\u5c16\u62ec\u53f7\u6807\u7b7e\u3002\n"
    "  const mediaKind = $derived<MediaKind>(templateMediaKind(template));",
)

rep(
    "    const wantVideo = image?.kind === \"video\";\n"
    "    const mine = items.filter((item) => isVideoTemplate(item) === wantVideo);",
    "    // \u6309\u5361\u7247\u90a3\u4e00\u65cf\u9009\u5f53\u524d\u5de5\u4f5c\u6d41\uff1a\u97f3\u9891\u5361\u9ed8\u8ba4\u5403\u51fa\u58f0\u97f3\u7684\u90a3\u6761\uff0c\u4e0d\u662f\u300c\u975e\u89c6\u9891\u5c31\u7b97\u56fe\u7247\u300d\u3002\n"
    "    const want: MediaKind = image?.kind === \"video\" ? \"video\" : image?.kind === \"audio\" ? \"audio\" : \"image\";\n"
    "    const mine = items.filter((item) => templateMediaKind(item) === want);",
)

rep(
    "    const refs = fams.length === 1 && fams[0] === \"image\" && !isVideoTemplate(tpl)",
    "    const refs = fams.length === 1 && fams[0] === \"image\" && !isVideoTemplate(tpl) && !isAudioTemplate(tpl)",
)

rep(
    "          {:else if image?.original_url || image?.thumbnail_url}\n"
    '            <img class="cm-hero" src={backendUrl(image.original_url || image.thumbnail_url!)} alt={image.filename} />\n',
    "          {:else if image?.kind === \"audio\"}\n"
    "            <!-- \u97f3\u9891\u5361\u7684\u5de6\u8fb9\uff1a\u6ce2\u5f62 + \u4e00\u6761\u539f\u751f\u64ad\u653e\u5668\u3002\u5199\u63d0\u793a\u8bcd\u65f6\u80fd\u5c31\u5730\u542c\u8fd9\u6bb5\u53c2\u8003\u97f3\u8272\uff0c\n"
    "                 \u4e0d\u7528\u56de\u56fe\u5e93\u653e\u4e00\u904d\u518d\u56de\u6765\uff1b\u6ce2\u5f62\u662f\u540e\u7aef\u753b\u597d\u7684\u90a3\u5f20\uff08thumbnail_url\uff09\u3002 -->\n"
    "            {#if image.thumbnail_url}\n"
    '              <img class="cm-hero cm-hero-wave" src={backendUrl(image.thumbnail_url)} alt={image.filename} />\n'
    "            {/if}\n"
    "            {#if image.playable !== false && (image.play_url || image.original_url)}\n"
    "              <!-- svelte-ignore a11y_media_has_caption -->\n"
    "              <audio\n"
    '                class="cm-hero-audio"\n'
    '                src={backendUrl(image.play_url || image.original_url!)}\n'
    "                controls\n"
    '                preload="metadata"\n'
    '                aria-label={`\u9884\u89c8${image.filename}`}\n'
    "              ></audio>\n"
    "            {/if}\n"
    "          {:else if image?.original_url || image?.thumbnail_url}\n"
    '            <img class="cm-hero" src={backendUrl(image.original_url || image.thumbnail_url!)} alt={image.filename} />\n',
)

rep(
    '              <p>\u8fd8\u6ca1\u6709\u540c\u6b3e\u5de5\u4f5c\u6d41\u3002\u5bfc\u51fa\u4e00\u4efd ComfyUI \u7684 API \u683c\u5f0f\u5de5\u4f5c\u6d41 JSON\uff0c{cardKind === "video" ? "\u4e4b\u540e\u6bcf\u6761\u7247\u5b50\u70b9\u4e00\u4e0b\u5c31\u80fd\u51fa\u540c\u6b3e\u3002" : "\u4e4b\u540e\u6bcf\u5f20\u56fe\u70b9\u4e00\u4e0b\u5c31\u80fd\u51fa\u540c\u6b3e\u3002"}</p>',
    '              <p>\u8fd8\u6ca1\u6709\u540c\u6b3e\u5de5\u4f5c\u6d41\u3002\u5bfc\u51fa\u4e00\u4efd ComfyUI \u7684 API \u683c\u5f0f\u5de5\u4f5c\u6d41 JSON\uff0c{cardKind === "video" ? "\u4e4b\u540e\u6bcf\u6761\u7247\u5b50\u70b9\u4e00\u4e0b\u5c31\u80fd\u51fa\u540c\u6b3e\u3002" : cardKind === "audio" ? "\u4e4b\u540e\u6bcf\u6bb5\u914d\u97f3\u70b9\u4e00\u4e0b\u5c31\u80fd\u6362\u8bcd\u91cd\u914d\u3002" : "\u4e4b\u540e\u6bcf\u5f20\u56fe\u70b9\u4e00\u4e0b\u5c31\u80fd\u51fa\u540c\u6b3e\u3002"}</p>',
)

rep(
    '                <p class="cm-note">\u8fd9\u5f20{cardKind === "video" ? "\u89c6\u9891" : "\u56fe"}\u5f53\u521d\u8fd8\u7528\u4e86 {sources.dropped} {refCounter}{refNoun}\uff0c\u5df2\u7ecf\u4e0d\u5728\u56fe\u5e93\u91cc\u4e86\uff0c\u91cd\u65b0\u751f\u6210\u524d\u8865\u4e0a\u3002</p>',
    '                <p class="cm-note">{cardLabel}\u5f53\u521d\u8fd8\u7528\u4e86 {sources.dropped} {refCounter}{refNoun}\uff0c\u5df2\u7ecf\u4e0d\u5728\u56fe\u5e93\u91cc\u4e86\uff0c\u91cd\u65b0\u751f\u6210\u524d\u8865\u4e0a\u3002</p>',
)
rep(
    '                <p class="cm-note">\u6ca1\u627e\u5230\u8fd9\u5f20{cardKind === "video" ? "\u89c6\u9891" : "\u56fe"}\u5f53\u521d\u7528\u7684{refNoun}\uff0c\u5148\u653e\u4e86\u5b83\u81ea\u5df1\u5f53\u53c2\u8003\u3002\u8981\u539f\u6765\u90a3\u51e0\u4efd\uff0c\u624b\u52a8\u6362\u4e00\u4e0b\u3002</p>',
    '                <p class="cm-note">\u6ca1\u627e\u5230{cardLabel}\u5f53\u521d\u7528\u7684{refNoun}\uff0c\u5148\u653e\u4e86\u5b83\u81ea\u5df1\u5f53\u53c2\u8003\u3002\u8981\u539f\u6765\u90a3\u51e0\u4efd\uff0c\u624b\u52a8\u6362\u4e00\u4e0b\u3002</p>',
)

rep(
    '                            title={`${templateDisplayName(item.name)} \u00b7 ${isVideoTemplate(item) ? "\u51fa\u7247" : "\u51fa\u56fe"} \u00b7 ${item.node_count} \u4e2a\u8282\u70b9 \u00b7 ${item.control_count} \u4e2a\u53c2\u6570`}',
    '                            title={`${templateDisplayName(item.name)} \u00b7 ${WF_OUTPUT_WORDS[templateMediaKind(item)]} \u00b7 ${item.node_count} \u4e2a\u8282\u70b9 \u00b7 ${item.control_count} \u4e2a\u53c2\u6570`}',
)
rep(
    '                            <span class="cm-wf-kind" class:cm-wf-kind-video={isVideoTemplate(item)}>{isVideoTemplate(item) ? "\u89c6\u9891" : "\u56fe\u7247"}</span>',
    '                            <span class="cm-wf-kind" class:cm-wf-kind-video={templateMediaKind(item) === "video"}\n'
    '                              class:cm-wf-kind-audio={templateMediaKind(item) === "audio"}>{WF_KIND_WORDS[templateMediaKind(item)]}</span>',
)

rep(
    '                  <button class="cm-chip media-chip" class:cm-chip-video={out.kind === "video"} title={out.filename}\n'
    '                    aria-label={`\u6253\u5f00\u751f\u6210\u7684\u7b2c ${out.id} ${out.kind === "video" ? "\u6761" : "\u5f20"}`} onclick={() => onOpenImage?.(out.id, out.kind)}>\n'
    '                    <img src={backendUrl(out.thumbnail_url)} alt="" />\n'
    '                    {#if out.kind === "video"}<span class="cm-chip-play" aria-hidden="true"><Icon name="play" size={12} /></span>{/if}',
    '                  <button class="cm-chip media-chip" class:cm-chip-video={out.kind !== "image"} title={out.filename}\n'
    '                    aria-label={`\u6253\u5f00\u751f\u6210\u7684\u7b2c ${out.id} ${out.kind === "image" ? "\u5f20" : "\u6761"}`} onclick={() => onOpenImage?.(out.id, out.kind)}>\n'
    '                    <img src={backendUrl(out.thumbnail_url)} alt="" />\n'
    '                    {#if out.kind !== "image"}<span class="cm-chip-play" aria-hidden="true"><Icon name="play" size={12} /></span>{/if}',
)

rep(
    "  .cm-wf-kind-video { color: #fbbf24; background: rgb(245 158 11 / 16%); }",
    "  .cm-wf-kind-video { color: #fbbf24; background: rgb(245 158 11 / 16%); }\n"
    "  .cm-wf-kind-audio { color: #c4b5fd; background: rgb(139 92 246 / 16%); }",
)
rep(
    "  .cm-hero-empty { display: flex;",
    "  /* \u6ce2\u5f62\u662f\u4e00\u5f20\u6241\u7684\u540e\u7aef PNG\uff1a\u7167\u642c cm-hero \u7684 contain \u4f1a\u628a\u5b83\u62c9\u6210\u4e00\u5927\u5757\u6a21\u7cca\uff0c\u8fd9\u91cc\u9501\u4f4f\u9ad8\u5ea6\u3002 */\n"
    "  .cm-hero-wave { width: 100%; height: clamp(88px, 18vh, 148px); object-fit: cover; }\n"
    "  .cm-hero-audio { width: 100%; margin-top: 10px; height: 36px; }\n"
    "  .cm-hero-empty { display: flex;",
)

io.open(P, "w", encoding="utf-8", newline="\n").write(t)
print("patched", P)
