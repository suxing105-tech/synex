# -*- coding: utf-8 -*-
p = r"outputs\audio_clone\patch_feed.py"
import io
t = io.open(p, encoding="utf-8-sig").read()
old = '    "{(it.kind === \\"image\\" || it.kind === \\"video\\") && footerTier > 0 ? \'is-cloneable \' : \'\'}",\n    "{(it.kind === \\"image\\" || it.kind === \\"video\\" || it.kind === \\"audio\\") && footerTier > 0 ? \'is-cloneable \' : \'\'}",'
new = '    "{(it.kind === \'image\' || it.kind === \'video\') && footerTier > 0 ? \'is-cloneable \' : \'\'}",\n    "{(it.kind === \'image\' || it.kind === \'video\' || it.kind === \'audio\') && footerTier > 0 ? \'is-cloneable \' : \'\'}",'
assert t.count(old) == 1, "anchor not found"
io.open(p, "w", encoding="utf-8-sig").write(t.replace(old, new, 1))
print("fixed patch script")
