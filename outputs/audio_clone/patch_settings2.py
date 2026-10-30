# -*- coding: utf-8 -*-
import io
P = "frontend/src/components/CloneTemplates.svelte"
t = io.open(P, encoding="utf-8").read()
old = '                  await cloneApi.update(tpl.id, { media_kind: templateMediaKind({ media_kind: (e.target as HTMLSelectElement).value }) });'
new = ('                  const picked = (e.target as HTMLSelectElement).value;\n'
       '                  await cloneApi.update(tpl.id, {\n'
       '                    media_kind: picked === "video" || picked === "audio" ? picked : "image",\n'
       '                  });')
assert t.count(old) == 1
io.open(P, "w", encoding="utf-8", newline="\n").write(t.replace(old, new, 1))
print("ok")
