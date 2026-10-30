import io, re
from pathlib import Path
for p in Path("app/routes").glob("*.py"):
    src = io.open(p, encoding="utf-8").read().splitlines()
    for i, l in enumerate(src):
        if re.search(r'@router\.(get|post)\("/items|kind: str|kind=|def list_items|scope', l) and p.name in ("items.py", "images.py"):
            print(p.name, i+1, l.strip()[:140])
