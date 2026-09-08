p = r'C:\Users\Administrator\Documents\ChatGPT\苏醒图库\frontend\pyinstaller\python-backend.spec'
src = open(p, 'r', encoding='utf-8').read()
old = '    console=True,'
new = '    console=False,  # hide PyInstaller console window (stdout/stderr still piped to Tauri)'
assert old in src, 'old not found'
open(p, 'w', encoding='utf-8').write(src.replace(old, new))
print('patched console=True -> console=False')
