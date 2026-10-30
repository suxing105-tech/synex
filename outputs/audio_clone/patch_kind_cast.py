# -*- coding: utf-8 -*-
import io
p = "frontend/src/lib/clone.ts"
t = io.open(p, encoding="utf-8").read()
old = '    media_kind: ["image", "video", "audio"].includes(raw.media_kind) ? raw.media_kind : "",'
new = '    media_kind: asOutputKind(raw.media_kind),'
assert t.count(old) == 1
t = t.replace(old, new, 1)
anchor = 'export function templateDisplayName(name: string | null | undefined): string {'
helper = ('/** \u540e\u7aef\u56de\u7684\u4ea7\u51fa\u65cf\u522b\u53ea\u8ba4\u8fd9\u4e09\u4e2a\u503c\uff0c\u5176\u5b9e\u4e0d\u662f\u5c31\u5f53\u672a\u77e5\uff08\u7a7a\u4e32\uff09\u3002 */\n'
          'function asOutputKind(value: unknown): MediaKind | "" {\n'
          '  return value === "image" || value === "video" || value === "audio" ? value : "";\n'
          '}\n\n')
assert t.count(anchor) == 1
t = t.replace(anchor, helper + anchor, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(t)
print("ok")
