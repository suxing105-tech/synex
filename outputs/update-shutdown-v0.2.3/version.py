from pathlib import Path
root=Path.cwd()
for relative in ['frontend/package.json','frontend/src-tauri/tauri.conf.json','frontend/src-tauri/Cargo.toml','backend/pyproject.toml','backend/app/version.py']:
    p=root/relative
    s=p.read_text(encoding='utf-8').replace('"0.2.2"','"0.2.3"')
    p.write_text(s,encoding='utf-8')
p=root/'frontend/src-tauri/Cargo.lock'
s=p.read_text(encoding='utf-8').replace('name = "suxing-gallery"\nversion = "0.2.2"','name = "suxing-gallery"\nversion = "0.2.3"')
p.write_text(s,encoding='utf-8')
