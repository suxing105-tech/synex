# -*- coding: utf-8 -*-
"""Audio family on the frontend: clone.ts kinds/labels + Feed audio card badge swap."""
import io

def patch(path, pairs):
    text = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert text.count(old) == 1, (path, old[:80], text.count(old))
        text = text.replace(old, new, 1)
    io.open(path, "w", encoding="utf-8", newline="\n").write(text)
    print("patched", path, len(pairs), "edits")

L = "frontend/src/lib/clone.ts"
patch(L, [
    (
        '/** \u8fd9\u4efd\u5de5\u4f5c\u6d41\u51fa\u7684\u662f\u56fe\u8fd8\u662f\u7247\u5b50\u3002\u5b83\u51b3\u5b9a\u5f39\u7a97\u9ed8\u8ba4\u7ed9\u54ea\u4e00\u7c7b\u5361\u7247\u3001@ \u5f15\u7528\u63d2\u4ec0\u4e48\u6807\u7b7e\u3002 */\n'
        'export type MediaKind = "image" | "video";',
        '/**\n'
        ' * \u8fd9\u4efd\u5de5\u4f5c\u6d41\u51fa\u7684\u662f\u56fe\u3001\u7247\u5b50\u8fd8\u662f\u4e00\u6bb5\u58f0\u97f3\u3002\u5b83\u51b3\u5b9a\u5f39\u7a97\u9ed8\u8ba4\u7ed9\u54ea\u4e00\u65cf\u5361\u7247\u3001\n'
        ' * \u5de5\u4f5c\u6d41\u83dc\u5355\u91cc\u7684\u5f92\u6807\uff0c\u4ee5\u53ca @ \u5f15\u7528\u63d2\u4ec0\u4e48\u6807\u7b7e\uff08\u53ea\u6709 H3 \u90a3\u7c7b\u89c6\u9891\u5de5\u4f5c\u6d41\u8ba4\u5c16\u62ec\u53f7\uff09\u3002\n'
        ' */\n'
        'export type MediaKind = "image" | "video" | "audio";',
    ),
    (
        'export function isVideoTemplate(template: CloneTemplate | null | undefined): boolean {\n'
        '  return (template?.media_kind ?? "image") === "video";\n'
        '}',
        'export function isVideoTemplate(template: CloneTemplate | null | undefined): boolean {\n'
        '  return (template?.media_kind ?? "image") === "video";\n'
        '}\n'
        '\n'
        'export function isAudioTemplate(template: CloneTemplate | null | undefined): boolean {\n'
        '  return (template?.media_kind ?? "image") === "audio";\n'
        '}\n'
        '\n'
        '/** \u5de5\u4f5c\u6d41\u5c5e\u54ea\u4e00\u65cf\uff1b\u5e93\u91cc\u6ca1\u5e26 media_kind \u7684\u8001\u6a21\u677f\u4e00\u5f8b\u5f53\u56fe\u7247\uff08\u884c\u4e3a\u4e0e\u5386\u53f2\u4e00\u81f4\uff09\u3002 */\n'
        'export function templateMediaKind(template: CloneTemplate | null | undefined): MediaKind {\n'
        '  const kind = template?.media_kind ?? "image";\n'
        '  return kind === "video" || kind === "audio" ? kind : "image";\n'
        '}',
    ),
    (
        '    media_kind: raw.media_kind === "video" ? "video" : raw.media_kind === "image" ? "image" : "",',
        '    media_kind: ["image", "video", "audio"].includes(raw.media_kind) ? raw.media_kind : "",',
    ),
    (
        '  const counter = job.media_kind === "video" ? "\u6761" : "\u5f20";',
        '  // \u58f0\u97f3\u4e5f\u8bf4\u300c\u6761\u300d\uff1a\u4e00\u6bb5\u914d\u97f3\u8bf4\u300c\u4e00\u5f20\u300d\u6bd4\u8bf4\u300c\u4e00\u6761\u300d\u66f4\u522b\u626d\u3002\n'
        '  const counter = job.media_kind === "video" || job.media_kind === "audio" ? "\u6761" : "\u5f20";',
    ),
    (
        'const CLONE_VIDEO_MODE_LABELS: Record<CloneMode, string> = {\n'
        '  text: "\u6587\u751f\u89c6\u9891",\n'
        '  single: "\u56fe\u751f\u89c6\u9891",\n'
        '  multi: "\u591a\u53c2\u8003\u89c6\u9891",\n'
        '};\n'
        '\n'
        'export function modeLabel(mode: CloneMode, mediaKind: MediaKind | undefined = "image"): string {\n'
        '  const table = mediaKind === "video" ? CLONE_VIDEO_MODE_LABELS : CLONE_MODE_LABELS;\n'
        '  return table[mode] ?? mode;\n'
        '}',
        'const CLONE_VIDEO_MODE_LABELS: Record<CloneMode, string> = {\n'
        '  text: "\u6587\u751f\u89c6\u9891",\n'
        '  single: "\u56fe\u751f\u89c6\u9891",\n'
        '  multi: "\u591a\u53c2\u8003\u89c6\u9891",\n'
        '};\n'
        'const CLONE_AUDIO_MODE_LABELS: Record<CloneMode, string> = {\n'
        '  text: "\u6587\u672c\u914d\u97f3",\n'
        '  single: "\u53c2\u8003\u97f3\u8272\u514b\u9686",\n'
        '  multi: "\u591a\u53c2\u8003\u97f3\u9891",\n'
        '};\n'
        '\n'
        'export function modeLabel(mode: CloneMode, mediaKind: MediaKind | undefined = "image"): string {\n'
        '  const table = mediaKind === "video"\n'
        '    ? CLONE_VIDEO_MODE_LABELS\n'
        '    : mediaKind === "audio"\n'
        '      ? CLONE_AUDIO_MODE_LABELS\n'
        '      : CLONE_MODE_LABELS;\n'
        '  return table[mode] ?? mode;\n'
        '}',
    ),
    (
        '/** \u8fd9\u4efd\u5de5\u4f5c\u6d41\u662f\u4e0d\u662f\u53ea\u6709\u56fe\u7247\u4e00\u65cf\uff08\uff1d\u56fe\u7247\u4e00\u952e\u540c\u6b3e\u7684\u8001\u6837\u5b50\uff09\u3002 */\n'
        'export function isImageOnlyRefs(template: CloneTemplate | null | undefined): boolean {\n'
        '  const families = referenceFamilies(template);\n'
        '  return !isVideoTemplate(template) && families.length <= 1;\n'
        '}',
        '/** \u8fd9\u4efd\u5de5\u4f5c\u6d41\u662f\u4e0d\u662f\u53ea\u6709\u56fe\u7247\u4e00\u65cf\uff08\uff1d\u56fe\u7247\u4e00\u952e\u540c\u6b3e\u7684\u8001\u6837\u5b50\uff09\u3002 */\n'
        'export function isImageOnlyRefs(template: CloneTemplate | null | undefined): boolean {\n'
        '  const families = referenceFamilies(template);\n'
        '  if (families.some((family) => family !== "image")) return false;\n'
        '  return !isVideoTemplate(template) && !isAudioTemplate(template);\n'
        '}\n'
        '\n'
        '/** \u97f3\u9891\u5de5\u4f5c\u6d41\u4e14\u53ea\u6709\u97f3\u9891\u4e00\u65cf\uff1a\u53d9\u8ff0\u91cc\u76f4\u63a5\u8bf4\u300c\u53c2\u8003\u97f3\u9891/\u4e00\u6bb5\u300d\uff0c\u522b\u6cdb\u79f0\u300c\u53c2\u8003\u7d20\u6750\u300d\u3002 */\n'
        'export function isAudioOnlyRefs(template: CloneTemplate | null | undefined): boolean {\n'
        '  const families = referenceFamilies(template);\n'
        '  if (families.some((family) => family !== "audio")) return false;\n'
        '  return isAudioTemplate(template);\n'
        '}',
    ),
    (
        'export function referenceNoun(template: CloneTemplate | null | undefined): string {\n'
        '  return isImageOnlyRefs(template) ? "\u53c2\u8003\u56fe" : "\u53c2\u8003\u7d20\u6750";\n'
        '}',
        'export function referenceNoun(template: CloneTemplate | null | undefined): string {\n'
        '  if (isImageOnlyRefs(template)) return "\u53c2\u8003\u56fe";\n'
        '  if (isAudioOnlyRefs(template)) return "\u53c2\u8003\u97f3\u9891";\n'
        '  return "\u53c2\u8003\u7d20\u6750";\n'
        '}',
    ),
    (
        'export function referenceCounter(template: CloneTemplate | null | undefined): string {\n'
        '  return isImageOnlyRefs(template) ? "\u5f20" : "\u4efd";\n'
        '}',
        'export function referenceCounter(template: CloneTemplate | null | undefined): string {\n'
        '  if (isImageOnlyRefs(template)) return "\u5f20";\n'
        '  if (isAudioOnlyRefs(template)) return "\u6bb5";\n'
        '  return "\u4efd";\n'
        '}',
    ),
])
