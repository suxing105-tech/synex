"""核对本次规划所引用的现有实现；不将规划冒充功能测试。"""
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sources = [
    "frontend/src/components/OnboardingModal.svelte",
    "frontend/src/lib/tauri.ts",
    "frontend/src-tauri/Cargo.toml",
    "frontend/src-tauri/src/lib.rs",
    "frontend/src-tauri/src/commands.rs",
    "backend/app/routes/settings.py",
    "backend/app/indexer.py",
    "frontend/src/lib/api.ts",
    "frontend/src/components/SettingsModal.svelte",
]
for source in sources:
    assert (root / source).is_file(), f"方案引用了不存在的文件：{source}"
modal = (root / sources[0]).read_text(encoding="utf-8")
assert "watch_dirs: [path.trim()]" in modal, "需重新核实覆盖监听目录的判断"
assert "scanApi.start(path.trim())" in modal
assert "tauri-plugin-dialog" not in (root / sources[2]).read_text(encoding="utf-8")
routes = (root / "backend/app/routes/settings.py").read_text(encoding="utf-8")
assert "target.exists()" in routes and "target.is_dir()" in routes
plan = (Path(__file__).parent / "文件夹选择功能方案.md").read_text(encoding="utf-8")
assert "状态：规划，尚未修改应用功能" in plan
print("PASS：9 个现有文件引用及当前导入行为核对通过；本次为方案验证，未运行新增功能测试。")
