# -*- coding: utf-8 -*-
import json, urllib.request, urllib.error
import gen_avatars as G
g = G.graph_for("Vivian", "dbg", 123456)
print("nodes:", sorted(g.keys(), key=lambda x: int(x)))
req = urllib.request.Request(G.COMFY + "/prompt", data=json.dumps({"prompt": g, "client_id": "dbg"}).encode("utf-8"),
                             headers={"Content-Type": "application/json"})
try:
    print(urllib.request.urlopen(req, timeout=60).read().decode("utf-8")[:2000])
except urllib.error.HTTPError as e:
    print("HTTP", e.code)
    print(e.read().decode("utf-8", "replace")[:3000])
