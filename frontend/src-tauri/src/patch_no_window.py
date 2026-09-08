p = r'C:\Users\Administrator\Documents\ChatGPT\苏醒图库\frontend\src-tauri\src\sidecar.rs'
src = open(p, 'r', encoding='utf-8').read()
old = '''    let mut cmd = Command::new(&cfg.exe_path);
    cmd.env("SUXING_PORT", cfg.port.to_string())
        .env("SUXING_DATA_DIR", &cfg.data_dir)
        .env("SUXING_PARENT_PID", std::process::id().to_string())
        .env("SUXING_FRONTEND_ORIGIN", "tauri")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());'''
new = '''    let mut cmd = Command::new(&cfg.exe_path);
    cmd.env("SUXING_PORT", cfg.port.to_string())
        .env("SUXING_DATA_DIR", &cfg.data_dir)
        .env("SUXING_PARENT_PID", std::process::id().to_string())
        .env("SUXING_FRONTEND_ORIGIN", "tauri")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // 隐藏 PyInstaller 控制台窗口（spec 仍 console=True 以保留 stdout pipe）
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW'''
assert old in src, 'old not found'
open(p, 'w', encoding='utf-8').write(src.replace(old, new))
print('patched')
