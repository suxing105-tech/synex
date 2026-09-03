"""Re-parse prompts for every indexed image and update positive/negative/parameters
fields in the DB. Run after parser.py changes that fix prompt extraction, to
rewrite stored data without nuking the DB (preserves favorites, FTS, thumbs).

Usage (from repo root):
    cd backend && .venv/Scripts/python scripts/reindex_prompts.py
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

# Allow running this script directly without setting PYTHONPATH.
_HERE = Path(__file__).resolve().parent
_BACKEND_ROOT = _HERE.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.parser import parse_metadata


def reindex(db_path: Path, *, only_stale: bool = True, batch: int = 200) -> None:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    if only_stale:
        # Only re-parse rows that look broken: prompt is short, starts with "[",
        # or is empty. Adjust as needed.
        cur.execute(
            """
            SELECT id, path FROM images

            WHERE positive_prompt IN ('', '[]')
               OR substr(positive_prompt, 1, 1) = '['
            ORDER BY id
            """
        )
    else:
        cur.execute("SELECT id, path FROM images ORDER BY id")

    rows = cur.fetchall()
    total = len(rows)
    if total == 0:
        print("Nothing to update.")
        con.close()
        return

    print(f"Re-indexing {total} images...")
    updated = 0
    skipped = 0
    failed = 0

    for row in rows:
        path = Path(row["path"])
        if not path.exists():
            skipped += 1
            continue
        try:
            meta = parse_metadata(path)
        except Exception as e:
            print(f"  [{row['id']}] FAIL parse: {e}")
            failed += 1
            continue

        new_pos = meta.get("positive_prompt") or ""
        new_neg = meta.get("negative_prompt") or ""
        new_seed = meta.get("seed")
        new_sampler = meta.get("sampler") or ""
        new_steps = meta.get("steps")
        new_cfg = meta.get("cfg")
        new_model = meta.get("model") or ""

        # Skip if no prompt content (don't blank out anything that was already filled).
        if not new_pos and not new_neg:
            skipped += 1
            continue

        cur.execute(
            """
            UPDATE images
               SET positive_prompt = ?,
                   negative_prompt = ?,
                   seed = COALESCE(?, seed),
                   sampler = COALESCE(NULLIF(?, ''), sampler),
                   steps = COALESCE(?, steps),
                   cfg = COALESCE(?, cfg),
                   model = COALESCE(NULLIF(?, ''), model)
             WHERE id = ?
            """,
            (new_pos, new_neg, new_seed, new_sampler, new_steps, new_cfg, new_model, row["id"]),
        )
        updated += 1
        if updated % batch == 0:
            con.commit()
            print(f"  committed {updated}/{total}")

    con.commit()
    print(f"Done. updated={updated} skipped={skipped} failed={failed} total={total}")
    con.close()


def main() -> None:
    here = Path(__file__).resolve().parent.parent
    default_db = here / "data" / "db.sqlite"

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=default_db, help="Path to SQLite DB")
    parser.add_argument("--all", action="store_true", help="Re-parse every image (not just broken-looking rows)")
    args = parser.parse_args()

    if not args.db.exists():
        raise SystemExit(f"DB not found: {args.db}")

    reindex(args.db, only_stale=not args.all)


if __name__ == "__main__":
    main()
