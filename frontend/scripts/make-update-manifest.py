"""Create the static Tauri release feed from an already signed NSIS installer."""
import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote


def manifest(version: str, repository: str, installer: Path, notes: str) -> dict:
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("第一版仅发布 x.y.z 格式的稳定版本")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("仓库必须为 owner/repo")
    if not installer.is_file() or installer.suffix.lower() != ".exe":
        raise ValueError("缺少 NSIS 安装包")
    signature = Path(str(installer) + ".sig").read_text(encoding="utf-8").strip()
    if not signature:
        raise ValueError("签名为空，禁止发布")
    return {"version": version, "notes": notes, "pub_date": datetime.now(timezone.utc).isoformat(),
            "platforms": {"windows-x86_64": {
                "signature": signature,
                "url": f"https://github.com/{repository}/releases/download/v{version}/{quote(installer.name)}"}}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--repository", default="suxing105-tech/synex")
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--notes", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = manifest(args.version, args.repository, args.installer, args.notes.read_text(encoding="utf-8"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
