# -*- coding: utf-8 -*-
import io
P = "frontend/src/components/CloneTemplates.svelte"
t = io.open(P, encoding="utf-8").read()

def rep(old, new):
    global t
    assert t.count(old) == 1, (old[:80], t.count(old))
    t = t.replace(old, new, 1)

rep(
    "    familyCells, isVideoTemplate, referenceFamilies, REF_KIND_NAMES,",
    "    familyCells, isAudioTemplate, isVideoTemplate, referenceFamilies, REF_KIND_NAMES,\n"
    "    templateMediaKind, WF_KIND_WORDS, WF_OUTPUT_WORDS,",
)
rep(
    "  if (fams.length === 1 && fams[0] === \"image\" && !isVideoTemplate(tpl)) return `${cells.length} \u4e2a\u53c2\u8003\u4f4d`;",
    "  if (fams.length === 1 && fams[0] === \"image\" && !isVideoTemplate(tpl) && !isAudioTemplate(tpl)) return `${cells.length} \u4e2a\u53c2\u8003\u4f4d`;",
)
rep(
    "  if (fams.length > 1 || isVideoTemplate(tpl)) {",
    "  if (fams.length > 1 || isVideoTemplate(tpl) || isAudioTemplate(tpl)) {",
)
rep(
    'notice = `\u5df2\u5bfc\u5165\u300c${templateDisplayName(saved.name)}\u300d\uff1a${refSummary(saved)}\u3002${isVideoTemplate(saved) ? "\u89c6\u9891" : "\u56fe\u7247"}\u5361\u53f3\u4e0b\u89d2\u7684\u56fe\u6807\u5c31\u662f\u5b83\u3002`;',
    'notice = `\u5df2\u5bfc\u5165\u300c${templateDisplayName(saved.name)}\u300d\uff1a${refSummary(saved)}\u3002` \n'
    '        + `${WF_KIND_WORDS[templateMediaKind(saved)]}\u5361\u53f3\u4e0b\u89d2\u7684\u56fe\u6807\u5c31\u662f\u5b83\u3002`;',
)
rep(
    'description="\u56fe\u7247\u5361\u4e0e\u89c6\u9891\u5361\u53f3\u4e0b\u89d2\u7684\u56fe\u6807\u90fd\u662f\u8fd9\u4e2a\u5165\u53e3\uff1a\u56fe\u7247\u5361\u7528\u51fa\u56fe\u7684\u5de5\u4f5c\u6d41\uff0c\u89c6\u9891\u5361\u7528\u51fa\u7247\u7684\u5de5\u4f5c\u6d41\uff0c\u4e24\u65cf\u5404\u81ea\u8bb0\u4f4f\u300c\u5f53\u524d\u300d\u90a3\u4e00\u6761\u3002\u5bfc\u4e00\u6b21 ComfyUI \u7684 API \u683c\u5f0f\u5de5\u4f5c\u6d41\uff0c\u4e4b\u540e\u968f\u65f6\u66ff\u6362\u3002"',
    'description="\u56fe\u7247\u5361\u3001\u89c6\u9891\u5361\u4e0e\u97f3\u9891\u5361\u53f3\u4e0b\u89d2\u7684\u56fe\u6807\u90fd\u662f\u8fd9\u4e2a\u5165\u53e3\uff1a\u6bcf\u4e00\u65cf\u5404\u81ea\u8bb0\u4f4f\u300c\u5f53\u524d\u300d\u90a3\u4e00\u6761\u2014\u2014\u56fe\u7247\u5361\u7528\u51fa\u56fe\u7684\uff0c\u89c6\u9891\u5361\u7528\u51fa\u7247\u7684\uff0c\u97f3\u9891\u5361\u7528\u51fa\u58f0\u97f3\u7684\u3002\u5bfc\u4e00\u6b21 ComfyUI \u7684 API \u683c\u5f0f\u5de5\u4f5c\u6d41\uff0c\u4e4b\u540e\u968f\u65f6\u66ff\u6362\u3002"',
)
rep(
    '                <span class="clone-tpl-kind" class:is-video={isVideoTemplate(tpl)}>{isVideoTemplate(tpl) ? "\u89c6\u9891" : "\u56fe\u7247"}</span>',
    '                <span class="clone-tpl-kind" class:is-video={templateMediaKind(tpl) === "video"}\n'
    '                  class:is-audio={templateMediaKind(tpl) === "audio"}>{WF_KIND_WORDS[templateMediaKind(tpl)]}</span>',
)
rep(
    '                title="\u51fa\u7247\u7684\u6302\u5230\u89c6\u9891\u5361\uff0c\u51fa\u56fe\u7684\u6302\u5230\u56fe\u7247\u5361\u3002\u81ea\u52a8\u5224\u5b9a\u9519\u4e86\u5c31\u5728\u8fd9\u513f\u6539\u3002"\n'
    '                value={isVideoTemplate(tpl) ? "video" : "image"} disabled={busy}\n'
    '                onchange={(e) => void run(async () => {\n'
    '                  await cloneApi.update(tpl.id, { media_kind: (e.target as HTMLSelectElement).value === "video" ? "video" : "image" });\n'
    '                  await reload(true);\n'
    '                }, "\u5df2\u6539\u5224\u4ea7\u51fa\u7c7b\u578b\uff1a\u56fe\u7247\u5361\u4e0e\u89c6\u9891\u5361\u5404\u8ba4\u81ea\u5df1\u90a3\u4e00\u65cf\u7684\u300c\u5f53\u524d\u300d\u5de5\u4f5c\u6d41\u3002")}>\n'
    '                <option value="image">\u51fa\u56fe</option>\n'
    '                <option value="video">\u51fa\u7247</option>',
    '                title="\u51fa\u56fe\u7684\u6302\u5230\u56fe\u7247\u5361\uff0c\u51fa\u7247\u7684\u6302\u5230\u89c6\u9891\u5361\uff0c\u51fa\u58f0\u97f3\u7684\u6302\u5230\u97f3\u9891\u5361\u3002\u81ea\u52a8\u5224\u5b9a\u9519\u4e86\u5c31\u5728\u8fd9\u513f\u6539\u3002"\n'
    '                value={templateMediaKind(tpl)} disabled={busy}\n'
    '                onchange={(e) => void run(async () => {\n'
    '                  await cloneApi.update(tpl.id, { media_kind: templateMediaKind({ media_kind: (e.target as HTMLSelectElement).value }) });\n'
    '                  await reload(true);\n'
    '                }, "\u5df2\u6539\u5224\u4ea7\u51fa\u7c7b\u578b\uff1a\u4e09\u7c7b\u5361\u7247\u5404\u8ba4\u81ea\u5df1\u90a3\u4e00\u65cf\u7684\u300c\u5f53\u524d\u300d\u5de5\u4f5c\u6d41\u3002")}>\n'
    '                <option value="image">{WF_OUTPUT_WORDS.image}</option>\n'
    '                <option value="video">{WF_OUTPUT_WORDS.video}</option>\n'
    '                <option value="audio">{WF_OUTPUT_WORDS.audio}</option>',
)
rep(
    "  .clone-tpl-kind.is-video { background: rgb(245 158 11 / 16%); color: #fbbf24; }",
    "  .clone-tpl-kind.is-video { background: rgb(245 158 11 / 16%); color: #fbbf24; }\n"
    "  .clone-tpl-kind.is-audio { background: rgb(139 92 246 / 16%); color: #c4b5fd; }",
)
io.open(P, "w", encoding="utf-8", newline="\n").write(t)
print("patched", P)
