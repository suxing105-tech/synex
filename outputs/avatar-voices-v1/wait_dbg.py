# -*- coding: utf-8 -*-
import json, os, urllib.request
import gen_avatars as G
pid = "4474eadd-7bea-4a6c-9462-b6f33b77995c"
entry = G.wait(pid, timeout=900)
files = G.fetch(entry, "Vivian", "dbg")
print("files:", files, [os.path.getsize(f) // 1024 if os.path.exists(f) else None for f in files])
