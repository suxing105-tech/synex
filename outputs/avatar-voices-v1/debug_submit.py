# -*- coding: utf-8 -*-
import json, urllib.request
import gen_avatars as G

graph = G.base_graph()
print("nodes sent:", len(graph), sorted(graph.keys(), key=lambda x: int(x)))
graph["245"]["inputs"]["文本"] = "TEST 一个年轻女性头像"
graph["282"]["inputs"]["seed"] = 12345
resp = G.http(G.COMFY + "/prompt", {"prompt": graph, "client_id": "debug1"})
print(json.dumps({k: v for k, v in resp.items()}, ensure_ascii=False)[:3000])
