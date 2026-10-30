import json, urllib.request
def get(path):
    with urllib.request.urlopen("http://127.0.0.1:8897" + path, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))
t = get("/api/clone/templates")
for i in t["items"]:
    print(i["id"], i["name"], "| kind:", i.get("media_kind"), "| active:", i["is_active"],
          "| builtin:", i.get("is_builtin"), "| refs:", i.get("reference_count"), "| controls:", i.get("control_count"))
print("stats:", get("/api/stats").get("total_images"), "items")
s = get("/api/items?kind=audio&limit=5")
print("audio items:", [(x["id"], x["filename"]) for x in s.get("items", [])][:5])
