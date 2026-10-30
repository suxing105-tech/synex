# -*- coding: utf-8 -*-
"""拿用户真实库的一份副本演「装上 0.2.32 第一次启动」，看参考音色会不会自己长回来。

只读 F:/SeekX-Data/db.sqlite（mode=ro + backup API），写的是 outputs 下的副本。
"""
import importlib
import json
import os
import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))
SRC = r"F:\SeekX-Data\db.sqlite"
MIRROR = REPO / "outputs" / "audio-modes-v1" / "seekx_copy"
MIRROR.mkdir(parents=True, exist_ok=True)
DST = MIRROR / "db.sqlite"
if DST.exists():
    DST.unlink()
src = sqlite3.connect("file:%s?mode=ro" % SRC.replace("\\", "/"), uri=True)
dst = sqlite3.connect(str(DST))
src.backup(dst)
dst.close()
src.close()

os.environ["SUXING_GALLERY_DATA_DIR"] = str(MIRROR)
os.environ["SUXING_SEED_BUNDLED_TEMPLATES"] = "1"
from app import config, db, clone_bundled, clone_templates  # noqa: E402

importlib.reload(config)
importlib.reload(db)
pool = db.init_pool()
pool.initialize()          # 这就是升级后第一次启动
out = io_open = open(REPO / "outputs" / "audio-modes-v1" / "upgrade_dry_run.txt", "w", encoding="utf-8")
conn = pool.main()
out.write("dismissed=%s\n" % sorted(clone_bundled.dismissed(conn)))
for r in conn.execute("SELECT id,name,media_kind,is_active,bundled_key FROM clone_templates ORDER BY id"):
    out.write(json.dumps(list(r), ensure_ascii=False) + "\n")
out.close()
print("done")