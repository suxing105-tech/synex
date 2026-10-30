import sqlite3, json, io, os
src = r"F:\SeekX-Data\db.sqlite"
out = io.open(r"outputs\audio-modes-v1\installed_templates.txt", "w", encoding="utf-8")
con = sqlite3.connect("file:%s?mode=ro" % src.replace("\\", "/"), uri=True)
con.row_factory = sqlite3.Row
tabs = [r[0] for r in con.execute("select name from sqlite_master where type='table' order by name")]
out.write("tables=%s\n\n" % [t for t in tabs if "clone" in t or "meta" in t])
out.write("== clone_templates ==\n")
cols = [r[1] for r in con.execute("pragma table_info(clone_templates)")]
out.write("cols=%s\n" % cols)
for r in con.execute("select id,name,media_kind,is_active,bundled_key,substr(bundled_sha,1,12) as sha,updated_at from clone_templates order by id"):
    out.write(json.dumps(dict(r), ensure_ascii=False) + "\n")
out.write("\n== meta keys (clone/bundled) ==\n")
for r in con.execute("select key,substr(value,1,400) as v from meta where key like '%clone%' or key like '%bundled%' or key like '%dismiss%'"):
    out.write(json.dumps(dict(r), ensure_ascii=False) + "\n")
out.close()
print("written")
