# -*- coding: utf-8 -*-
import io
p = "gen_avatars.py"
s = io.open(p, encoding="utf-8-sig").read()
anchor = '    req = urllib.request.Request(url, data=data,'
patch = '    if isinstance(data, (dict, list)):\n        data = json.dumps(data).encode("utf-8")\n' + anchor
assert anchor in s, "anchor missing"
if "isinstance(data" not in s:
    s = s.replace(anchor, patch, 1)
io.open(p, "w", encoding="utf-8").write(s)
print("ok", "isinstance(data" in s)
