# -*- coding: utf-8 -*-
import io
p = "gen_avatars.py"
lines = io.open(p, encoding="utf-8-sig").read().split("\n")
keep = []
for ln in lines:
    if "KreaHintFix" in ln or ln.strip().startswith("del g["):
        continue
    keep.append(ln)
io.open(p, "w", encoding="utf-8").write("\n".join(keep))
print("removed", len(lines) - len(keep))
