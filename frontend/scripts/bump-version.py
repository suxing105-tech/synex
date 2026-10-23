# -*- coding: utf-8 -*-
"""Bump the app version everywhere it is written.

Six places carry the version. When the desktop shell and the sidecar disagree an
installed app used to refuse to start, so the invariant is locked by
backend/tests/test_version_consistency.py. This script keeps it reachable:

    python frontend/scripts/bump-version.py --to 0.2.21 [--from 0.2.20] [--root DIR]

--from defaults to the version in tauri.conf.json. --root exists for tests.
"""
import argparse
import io
import json
import sys
from pathlib import Path

# Plain text files that hold exactly one copy of the version string.
SIMPLE_FILES = [
    "frontend/src-tauri/tauri.conf.json",
    "frontend/src-tauri/Cargo.toml",
    "frontend/package.json",
    "backend/pyproject.toml",
    "backend/app/version.py",
]
LOCK_FILE = "frontend/src-tauri/Cargo.lock"
LOCK_BLOCK = 'name = "suxing-gallery"\nversion = "%s"'


class BumpError(Exception):
    pass


def read(path: Path) -> str:
    with io.open(str(path), encoding="utf-8", newline="") as handle:
        return handle.read()


def write(path: Path, text: str) -> None:
    with io.open(str(path), "w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def current_version(root: Path) -> str:
    conf = json.loads(read(root / "frontend/src-tauri/tauri.conf.json"))
    return conf["version"]


def bump(root: Path, old: str, new: str) -> list:
    """Rewrite every version source, or change nothing at all.

    Every file is read and validated before the first write, so a stale copy
    cannot leave the tree half-bumped (that is the state that bricks installs).
    """
    if not old or not new or old == new:
        raise BumpError("refusing to bump from %r to %r" % (old, new))
    staged = []
    for rel in SIMPLE_FILES:
        text = read(root / rel)
        hits = text.count(old)
        if hits != 1:
            raise BumpError("%s contains %d copies of %s, expected 1" % (rel, hits, old))
        staged.append((rel, text.replace(old, new)))

    # Cargo.lock lists many packages; only the app entry may move.
    text = read(root / LOCK_FILE)
    block_lf = LOCK_BLOCK % old
    block_crlf = block_lf.replace("\n", "\r\n")
    hits = text.count(block_lf) + text.count(block_crlf)
    if hits != 1:
        raise BumpError("%s has %d suxing-gallery entries for %s, expected 1" % (LOCK_FILE, hits, old))
    staged.append((LOCK_FILE,
                   text.replace(block_lf, block_lf.replace(old, new))
                       .replace(block_crlf, block_crlf.replace(old, new))))

    for rel, text in staged:
        write(root / rel, text)
    return [rel for rel, _ in staged]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--to", required=True, help="new version, for example 0.2.21")
    parser.add_argument("--from", dest="old", default="", help="current version, defaults to tauri.conf.json")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[2]),
                        help="repository root, defaults to the checkout holding this script")
    args = parser.parse_args(argv)
    root = Path(args.root)
    try:
        old = args.old or current_version(root)
        changed = bump(root, old, args.to)
    except (BumpError, FileNotFoundError, KeyError, ValueError) as error:
        print("version bump aborted: %s" % error, file=sys.stderr)
        return 1
    print("%s -> %s" % (old, args.to))
    for rel in changed:
        print("  bumped %s" % rel)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())