# -*- coding: utf-8 -*-
import io

def patch(path, pairs):
    t = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert t.count(old) == 1, (path, old[:70], t.count(old))
        t = t.replace(old, new, 1)
    io.open(path, "w", encoding="utf-8", newline="\n").write(t)
    print("patched", path)

patch("frontend/src/lib/clone.ts", [(
    'export function templateDisplayName(name: string | null | undefined): string {',
    '/** \u5de5\u4f5c\u6d41\u5f92\u6807\u4e0e\u5f39\u7a97\u83dc\u5355\u91cc\u79f0\u547c\u4e00\u65cf\uff1b\u4e09\u65cf\u5e76\u5217\u65f6\u4e0d\u80fd\u53ea\u6709\u300c\u56fe\u7247/\u89c6\u9891\u300d\u4e24\u4e2a\u8bcd\u3002 */\n'
    'export const WF_KIND_WORDS: Record<MediaKind, string> = { image: "\u56fe\u7247", video: "\u89c6\u9891", audio: "\u97f3\u9891" };\n'
    'export const WF_OUTPUT_WORDS: Record<MediaKind, string> = { image: "\u51fa\u56fe", video: "\u51fa\u7247", audio: "\u51fa\u58f0\u97f3" };\n'
    '\n'
    'export function templateDisplayName(name: string | null | undefined): string {',
)])

patch("frontend/src/components/CloneModal.svelte", [(
    "    REF_KIND_COUNTERS, REF_KIND_NAMES, templateDisplayName, templateMediaKind,",
    "    REF_KIND_COUNTERS, REF_KIND_NAMES, templateDisplayName, templateMediaKind,\n    WF_KIND_WORDS, WF_OUTPUT_WORDS,",
)])
