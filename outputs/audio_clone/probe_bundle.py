import json, io
from app import clone_bundled
for e in clone_bundled.entries():
    print("KEY", e["key"], "|", e["label"], "|legacy", e.get("legacy_labels"), "|kind", e.get("media_kind"))
    print("  nodes:", {k: v["class_type"] for k, v in e["workflow"].items()})
    for s in e["slots"]:
        print("   slot", {k: s.get(k) for k in ("kind","node","input","label","options","value")})
    print("  cells:", [(c["key"], c["kind"], c["label"]) for c in e.get("reference_cells", [])])
