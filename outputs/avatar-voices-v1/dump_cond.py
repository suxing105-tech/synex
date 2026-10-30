# -*- coding: utf-8 -*-
import json, urllib.request
h = json.loads(urllib.request.urlopen("http://127.0.0.1:8188/history?max_items=5", timeout=30).read())
for pid, e in h.items():
    t = e.get("outputs", {}).get("288", {}).get("text")
    if not t:
        continue
    print("=== prompt", pid)
    for s in t:
        print(repr(s)[:4000])
        print("   [len]", len(s))
