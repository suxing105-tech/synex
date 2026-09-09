import importlib.util
from pathlib import Path
import pytest

script = Path(__file__).resolve().parents[2] / "frontend/scripts/make-update-manifest.py"
spec = importlib.util.spec_from_file_location("update_manifest", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def test_feed_encodes_asset_name_and_signature(tmp_path):
    installer = tmp_path / "苏醒图库_0.2.0_x64-setup.exe"
    installer.write_bytes(b"fixture")
    Path(str(installer) + ".sig").write_text("signature\n")
    feed = module.manifest("0.2.0", "suxing105-tech/synex", installer, "更新说明")
    asset = feed["platforms"]["windows-x86_64"]
    assert "/releases/download/v0.2.0/%E8%8B%8F" in asset["url"]
    assert asset["signature"] == "signature"
    assert feed["notes"] == "更新说明"

def test_feed_rejects_unsigned_installer(tmp_path):
    installer = tmp_path / "installer.exe"
    installer.write_bytes(b"fixture")
    with pytest.raises(FileNotFoundError): module.manifest("0.2.0", "owner/repo", installer, "")

@pytest.mark.parametrize("version,repo", [("0.2.0-beta", "owner/repo"), ("garbage", "owner/repo"), ("0.2.0", "../bad/path")])
def test_feed_rejects_invalid_release_metadata(tmp_path, version, repo):
    with pytest.raises(ValueError): module.manifest(version, repo, tmp_path / "setup.exe", "")
