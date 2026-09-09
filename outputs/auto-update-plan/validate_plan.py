"""只核对规划依赖的当前项目事实和文件引用；不代表更新功能测试通过。"""
import json
from pathlib import Path
import tomllib

root = Path(__file__).resolve().parents[2]
doc = Path(__file__).with_name("自动更新实施方案.md").read_text(encoding="utf-8")
config = json.loads((root / "frontend/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
cargo = tomllib.loads((root / "frontend/src-tauri/Cargo.toml").read_text(encoding="utf-8"))
package = json.loads((root / "frontend/package.json").read_text(encoding="utf-8"))
assert config["version"] == cargo["package"]["version"] == package["version"] == "0.1.0"
assert config["identifier"] == "com.suxing.gallery"
assert config["bundle"]["windows"]["nsis"]["installMode"] == "perMachine"
assert "tauri-plugin-updater" not in cargo["dependencies"]
assert "tauri-plugin-single-instance" not in cargo["dependencies"]
assert 'let port: u16 = 8765;' in (root / "frontend/src-tauri/src/sidecar.rs").read_text(encoding="utf-8")
for line in doc.splitlines():
    if line.startswith("- `") and line.endswith("`"):
        source = line[3:-1]
        assert (root / source).is_file(), f"规划引用了不存在的现有文件：{source}"
print("PASS: plan facts match current versions, installer mode, app identity, plugins, port and source files. Documentation validation only.")
