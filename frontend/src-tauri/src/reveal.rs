// 在资源管理器里打开文件位置，并让那个窗口出现在最前面。
//
// 为什么要在 Rust 这一侧做：以前 reveal 由 sidecar（无窗口的后台进程）发起，
// Windows 的前台锁不允许后台进程把新窗口提到最前，资源管理器就开在应用后面，
// 用户以为「没反应」。前台权限属于当前持有它的进程，也就是我们自己的应用窗口，
// 所以这条命令必须在桌面壳里执行：先把自己拿到的前台权限让给 shell，
// 再用 shell 自己的 API 打开并选中文件。

use std::path::{Path, PathBuf};

/// 打开目标：选中某个文件，或者只打开某个目录。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RevealTarget {
    File(PathBuf),
    Folder(PathBuf),
}

/// 校验路径并判断该按文件还是目录打开。错误文案直接给用户看。
pub(crate) fn classify(raw: &str, select: bool) -> Result<RevealTarget, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("路径为空".into());
    }
    let path = Path::new(trimmed);
    let meta = std::fs::symlink_metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "文件已经不在这个位置了，可能被移动或删除".to_string()
        } else {
            format!("无法读取这个位置：{e}")
        }
    })?;
    if meta.is_dir() || !select {
        Ok(RevealTarget::Folder(path.to_path_buf()))
    } else {
        Ok(RevealTarget::File(path.to_path_buf()))
    }
}

/// 非 Windows 的命令行参数：macOS 用 `open -R` 选中，Linux 只能打开父目录。
#[cfg(not(windows))]
pub(crate) fn opener_args(target: &RevealTarget) -> (&'static str, Vec<String>) {
    #[cfg(target_os = "macos")]
    {
        match target {
            RevealTarget::File(p) => ("open", vec!["-R".into(), p.display().to_string()]),
            RevealTarget::Folder(p) => ("open", vec![p.display().to_string()]),
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let folder = match target {
            RevealTarget::File(p) => p.parent().unwrap_or(p).to_path_buf(),
            RevealTarget::Folder(p) => p.clone(),
        };
        ("xdg-open", vec![folder.display().to_string()])
    }
}

/// Windows：交给 shell 打开并选中。`SHParseDisplayName` + `SHOpenFolderAndSelectItems`
/// 是官方做法，`explorer.exe /select,` 只是次选（它会多开一个窗口）。
#[cfg(windows)]
pub(crate) fn open_with_shell(target: &RevealTarget) -> Result<(), String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    const ASFW_ANY: u32 = 0xFFFF_FFFF;

    #[link(name = "user32")]
    extern "system" {
        fn AllowSetForegroundWindow(dwProcessId: u32) -> i32;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHParseDisplayName(
            name: *const u16,
            bind_ctx: *mut c_void,
            pidl: *mut *mut c_void,
            reserved: u32,
            attrs: *mut u32,
        ) -> i32;
        fn SHOpenFolderAndSelectItems(
            folder: *mut c_void,
            count: u32,
            items: *const *mut c_void,
            flags: i32,
        ) -> i32;
        fn ILFree(pidl: *mut c_void);
    }

    let path = match target {
        // 传文件自己的 PIDL、子项数为 0：shell 会打开它的父目录并选中这个文件。
        RevealTarget::File(p) | RevealTarget::Folder(p) => p.clone(),
    };
    let wide: Vec<u16> = std::ffi::OsStr::new(&path).encode_wide().chain(std::iter::once(0)).collect();

    // 我们正是当前前台进程，把前台权限让出去，shell 才能把窗口提到最前面。
    unsafe { AllowSetForegroundWindow(ASFW_ANY) };

    let mut pidl: *mut c_void = std::ptr::null_mut();
    let hr = unsafe { SHParseDisplayName(wide.as_ptr(), std::ptr::null_mut(), &mut pidl, 0, std::ptr::null_mut()) };
    if hr != 0 || pidl.is_null() {
        return Err("资源管理器打不开这个位置".into());
    }
    let result = unsafe { SHOpenFolderAndSelectItems(pidl, 0, std::ptr::null(), 0) };
    unsafe { ILFree(pidl) };
    if result != 0 {
        return Err("资源管理器打不开这个位置".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn reveal_path(path: String, select: bool) -> Result<String, String> {
    let target = classify(&path, select)?;
    #[cfg(windows)]
    open_with_shell(&target)?;
    #[cfg(not(windows))]
    {
        let (program, args) = opener_args(&target);
        let mut command = std::process::Command::new(program);
        for arg in args {
            command.arg(arg);
        }
        command.spawn().map_err(|e| format!("打开所在文件夹失败：{e}"))?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_name(tag: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("seekx-reveal-test-{}-{tag}", std::process::id()));
        path
    }

    #[test]
    fn rejects_empty_path() {
        assert_eq!(classify("   ", true).unwrap_err(), "路径为空");
    }

    #[test]
    fn missing_file_says_it_moved() {
        let missing = temp_name("missing");
        let error = classify(missing.to_str().unwrap(), true).unwrap_err();
        assert!(error.contains("已经不在这个位置"), "{error}");
    }

    #[test]
    fn file_is_selected_but_folder_is_only_opened() {
        let file = temp_name("file.txt");
        let mut handle = std::fs::File::create(&file).unwrap();
        handle.write_all(b"x").unwrap();
        drop(handle);
        assert_eq!(classify(file.to_str().unwrap(), true), Ok(RevealTarget::File(file.clone())));
        assert_eq!(classify(file.to_str().unwrap(), false), Ok(RevealTarget::Folder(file.clone())));

        let dir = std::env::temp_dir();
        assert_eq!(classify(dir.to_str().unwrap(), true), Ok(RevealTarget::Folder(dir)));
        let _ = std::fs::remove_file(&file);
    }

    #[cfg(not(windows))]
    #[test]
    fn opener_reveals_the_file_and_just_opens_a_folder() {
        let file = PathBuf::from("/tmp/a/b.png");
        let (program, args) = opener_args(&RevealTarget::File(file));
        assert_eq!(args.len(), 2);
        assert!(args[1].ends_with("b.png"));
        let _ = program;
    }
}