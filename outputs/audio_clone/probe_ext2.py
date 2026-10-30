import io, re
from pathlib import Path
pat = re.compile(r"flac")
for p in Path("app").rglob("*.py"):
    for i, l in enumerate(io.open(p, encoding="utf-8").read().splitlines()):
        if pat.search(l):
            print(p, i+1, l.strip()[:150])
