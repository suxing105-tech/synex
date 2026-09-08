p = r'C:\Users\Administrator\Documents\ChatGPT\苏醒图库\frontend\pyinstaller\python-backend.spec'
src = open(p, 'r', encoding='utf-8').read()
old = '    console=False,  # hide PyInstaller console window (stdout/stderr still piped to Tauri)'
new = '    console=True,   # 保留 stdout pipe 让 Rust 检测 READY；窗口隐藏由 Rust 用 CREATE_NO_WINDOW 实现'
assert old in src, 'old not found'
open(p, 'w', encoding='utf-8').write(src.replace(old, new))
print('reverted')
