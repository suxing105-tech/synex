from pathlib import Path
p=Path('frontend/src/components/HeaderBar.svelte');s=p.read_text(encoding='utf-8').replace('    <span>苏醒图库</span>\n','');p.write_text(s,encoding='utf-8')
