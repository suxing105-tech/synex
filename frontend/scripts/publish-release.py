# -*- coding: utf-8 -*-
"""Publish release assets to GitHub through the REST API. Credentials are never logged.

    python frontend/scripts/publish-release.py plan    --version 0.2.21 --dir outputs/release-0.2.21
    python frontend/scripts/publish-release.py prepare --version 0.2.21 --dir outputs/release-0.2.21
    python frontend/scripts/publish-release.py publish --version 0.2.21 --dir outputs/release-0.2.21

plan    checks the local assets and prints what would be uploaded (no network);
prepare creates a draft release and uploads the assets, refusing to overwrite
        an asset whose checksum differs;
publish re-checks every checksum and then makes the draft the latest release.

Push the release commit and the tag before prepare: the draft pins
target_commitish to the commit that is HEAD when this runs.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import httpx

REPO = "suxing105-tech/synex"


def asset_names(version: str) -> list:
    return ["suxing-gallery_%s_x64-setup.exe" % version,
            "suxing-gallery_%s_x64-setup.exe.sig" % version,
            "latest.json"]


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def current_commit(root: Path) -> str:
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(root), text=True,
                          capture_output=True, check=True).stdout.strip()


def token() -> str:
    result = subprocess.run(["git", "credential", "fill"],
                            input="protocol=https\nhost=github.com\n\n",
                            text=True, capture_output=True, check=False,
                            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    if result.returncode:
        raise RuntimeError("Existing GitHub credentials are unavailable.")
    secret = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line).get("password")
    if not secret:
        raise RuntimeError("Existing GitHub credentials are unavailable.")
    return secret


def plan(root: Path, version: str) -> dict:
    entries = []
    for name in asset_names(version):
        path = root / name
        if not path.is_file():
            raise RuntimeError("Missing asset: " + name)
        entries.append({"name": name, "bytes": path.stat().st_size, "sha256": digest(path)[7:]})
    return {"repo": REPO, "tag": "v" + version, "commit": current_commit(Path(__file__).resolve().parents[2]),
            "notes": (root / "release-notes.md").read_text(encoding="utf-8") if (root / "release-notes.md").is_file() else "",
            "assets": entries}


def main(mode: str, asset_dir: str, version: str) -> int:
    root = Path(asset_dir).resolve()
    repo_root = Path(__file__).resolve().parents[2]
    tag = "v" + version
    if mode == "plan":
        print(json.dumps(plan(root, version), ensure_ascii=False, indent=2))
        return 0
    secret = token()
    with httpx.Client(headers={"Authorization": "Bearer " + secret,
                               "Accept": "application/vnd.github+json",
                               "X-GitHub-Api-Version": "2022-11-28"}, timeout=300) as client:
        def request(method, path, **kwargs):
            response = client.request(method, "https://api.github.com/repos/" + REPO + path, **kwargs)
            if response.status_code >= 400:
                raise RuntimeError("GitHub request failed (%s) for %s %s" % (response.status_code, method, path))
            return response.json()

        matching = [r for r in request("GET", "/releases") if r["tag_name"] == tag]
        if len(matching) > 1:
            raise RuntimeError("Ambiguous release state")
        release = matching[0] if matching else None
        files = asset_names(version)

        if mode == "prepare":
            if not release:
                release = request("POST", "/releases", json={
                    "tag_name": tag, "target_commitish": current_commit(repo_root),
                    "name": "闪寻空间 (Seek-X) %s" % version,
                    "body": (root / "release-notes.md").read_text(encoding="utf-8"),
                    "draft": True, "prerelease": False})
            if not release["draft"]:
                raise RuntimeError("Release already public; refusing to alter assets")
            for name in files:
                path = root / name
                if not path.is_file():
                    raise RuntimeError("Missing asset: " + name)
                existing = [a for a in release["assets"] if a["name"] == name]
                if existing:
                    if existing[0].get("digest") == digest(path):
                        continue
                    raise RuntimeError("Existing asset differs; refusing to overwrite")
                with path.open("rb") as stream:
                    response = client.post(release["upload_url"].split("{")[0], params={"name": name},
                                           headers={"Content-Type": "application/octet-stream",
                                                    "Content-Length": str(path.stat().st_size)},
                                           content=stream)
                if response.status_code != 201:
                    raise RuntimeError("Asset upload failed (%s) for %s" % (response.status_code, name))
            release = request("GET", "/releases/%s" % release["id"])
        elif mode == "publish":
            if not release:
                raise RuntimeError("Draft not found")
            assets = {a["name"]: a for a in release["assets"]}
            for name in files:
                if name not in assets:
                    raise RuntimeError("Incomplete release assets")
                if assets[name].get("digest") != digest(root / name):
                    raise RuntimeError("Remote asset checksum mismatch")
            release = request("PATCH", "/releases/%s" % release["id"], json={"draft": False, "make_latest": "true"})

    summary = {"id": release["id"], "tag": release["tag_name"], "draft": release["draft"],
               "commit": current_commit(repo_root), "url": release["html_url"],
               "assets": [{"name": a["name"], "size": a["size"], "digest": a.get("digest"),
                           "url": a["browser_download_url"]} for a in release["assets"]]}
    (root / "release-status.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=["plan", "prepare", "publish"])
    parser.add_argument("--version", required=True, help="bare version, for example 0.2.21")
    parser.add_argument("--dir", required=True, help="directory holding the signed installer, .sig and latest.json")
    args = parser.parse_args()
    try:
        raise SystemExit(main(args.mode, args.dir, args.version))
    except (RuntimeError, subprocess.CalledProcessError, httpx.HTTPError) as error:
        print("release step failed: %s" % error, file=sys.stderr)
        raise SystemExit(1)