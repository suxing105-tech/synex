# -*- coding: utf-8 -*-
"""Verify the exact update feed installed clients read, without credentials.

    python frontend/scripts/verify-public-release.py --version 0.2.21 --dir outputs/release-0.2.21

Downloads latest.json plus the installer from GitHub, checks the signed
installer checksum and the .sig against the feed, and compares the download
with the local asset. Fails loudly if the public latest feed still points at an
older version.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import httpx

REPO = "suxing105-tech/synex"
FEED = "https://github.com/" + REPO + "/releases/latest/download/latest.json"


def verify(version: str, asset_dir: str) -> dict:
    root = Path(asset_dir).resolve()
    name = "suxing-gallery_%s_x64-setup.exe" % version
    download_dir = root / "download-verification"
    download_dir.mkdir(exist_ok=True)
    target = download_dir / name
    digest = hashlib.sha256()
    with httpx.Client(follow_redirects=True, timeout=180) as client:
        response = client.get(FEED)
        response.raise_for_status()
        feed = response.json()
        if feed["version"] != version:
            raise RuntimeError("Public latest feed has not updated")
        platform = feed["platforms"]["windows-x86_64"]
        expected_url = "https://github.com/" + REPO + "/releases/download/v%s/%s" % (version, name)
        if platform["url"] != expected_url:
            raise RuntimeError("Public feed points elsewhere: " + platform["url"])
        with client.stream("GET", platform["url"]) as download:
            download.raise_for_status()
            if download.url.scheme != "https":
                raise RuntimeError("Asset is not served over https")
            with target.open("wb") as stream:
                for chunk in download.iter_bytes():
                    digest.update(chunk)
                    stream.write(chunk)
        signature = client.get(platform["url"] + ".sig")
        signature.raise_for_status()
        if signature.text.strip() != platform["signature"].strip():
            raise RuntimeError("Feed signature differs from the published .sig")
    local = root / name
    result = {"version": feed["version"], "url": platform["url"], "downloaded_bytes": target.stat().st_size,
              "sha256": digest.hexdigest(), "matches_local": local.is_file() and hashlib.sha256(local.read_bytes()).hexdigest() == digest.hexdigest()}
    (download_dir / "public-verification.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--version", required=True)
    parser.add_argument("--dir", required=True)
    args = parser.parse_args()
    try:
        summary = verify(args.version, args.dir)
    except (RuntimeError, httpx.HTTPError) as error:
        print("public verification failed: %s" % error, file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if not summary["matches_local"]:
        print("warning: downloaded installer differs from the local asset", file=sys.stderr)
        raise SystemExit(1)