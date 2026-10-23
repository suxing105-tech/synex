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

/// 把库里的路径变成 shell 认的 Windows 写法：正斜杠换反斜杠、去掉多余的结尾分隔符。
///
/// `ILCreateFromPathW` 只吃 Win32 形式的路径，库里存的是 `C:/SeekX-Data/a.png`
/// 这种正斜杠写法，直接丢给它会返回 NULL —— 用户看到的就是一句「认不出这个路径」。
pub(crate) fn win_path(raw: &str) -> String {
    let mut text = raw.trim().replace('/', "\\");
    while text.len() > 3 && text.ends_with('\\') {
        text.pop();
    }
    text
}

/// `explorer.exe` 的参数：`/select,` 打开父目录并选中文件，单独一个路径就是打开目录。
pub(crate) fn explorer_args(target: &RevealTarget) -> Vec<String> {
    let path = match target {
        RevealTarget::File(p) | RevealTarget::Folder(p) => win_path(&p.display().to_string()),
    };
    match target {
        RevealTarget::File(_) => vec![format!("/select,{path}")],
        RevealTarget::Folder(_) => vec![path],
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

/// Windows：交给 shell 打开并选中。
///
/// 这里照抄后端 `windows_reveal.py` 那套已经验证过的组合：`CoInitialize` +
/// `ILCreateFromPathW` + `SHOpenFolderAndSelectItems`（PIDL 传文件自己、子项数 0
/// = 打开父目录并选中它）。少了 `CoInitialize` 是最容易踩的一脚：shell 的这些接口
/// 都是 COM 接口，Tauri 命令跑在 tokio 工作线程上，没初始化 COM 就直接失败
/// （0x800401F0），用户看到的就是「打开所在文件夹失败」。
#[cfg(windows)]
pub(crate) fn open_with_shell(target: &RevealTarget) -> Result<(), String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    const ASFW_ANY: u32 = 0xFFFF_FFFF;

    #[link(name = "user32")]
    extern "system" {
        fn AllowSetForegroundWindow(dwProcessId: u32) -> i32;
    }
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitialize(preserved: *mut c_void) -> i32;
        fn CoUninitialize();
    }
    #[link(name = "shell32")]
    extern "system" {
        fn ILCreateFromPathW(path: *const u16) -> *mut c_void;
        fn SHOpenFolderAndSelectItems(
            folder: *mut c_void,
            count: u32,
            items: *const *mut c_void,
            reserved: i32,
        ) -> i32;
        fn ILFree(pidl: *mut c_void);
    }

    let path = match target {
        RevealTarget::File(p) | RevealTarget::Folder(p) => p.clone(),
    };
    let normalised = win_path(&path.display().to_string());
    let wide: Vec<u16> = std::ffi::OsStr::new(&normalised)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // S_OK/S_FALSE 才算我们持有这一次初始化；已经是别的模型初始化过就别去反初始化。
    let initialized = unsafe { CoInitialize(std::ptr::null_mut()) } >= 0;
    // 我们正是当前前台进程，把前台权限让出去，shell 才能把资源管理器提到最前面。
    unsafe { AllowSetForegroundWindow(ASFW_ANY) };
    let pidl = unsafe { ILCreateFromPathW(wide.as_ptr()) };
    let opened = if pidl.is_null() {
        // shell 不肯解析这个路径（网络盘、库别名之类都可能）：交给 explorer 自己办
        Err("shell 认不出这个路径".to_string())
    } else {
        let code = unsafe { SHOpenFolderAndSelectItems(pidl, 0, std::ptr::null(), 0) };
        unsafe { ILFree(pidl) };
        if code < 0 {
            Err(format!("shell 打不开这个位置（{:#x}）", code as u32))
        } else {
            Ok(())
        }
    };
    if initialized {
        unsafe { CoUninitialize() };
    }
    opened.or_else(|reason| {
        // 兜底走 explorer.exe：它自己解析路径，也照样开父目录并选中文件。
        // 注意 explorer 成功时也返回退出码 1，所以只看能不能启动。
        let args = explorer_args(target);
        let mut command = std::process::Command::new("explorer.exe");
        for arg in &args {
            command.arg(arg);
        }
        match command.spawn() {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("资源管理器打不开这个位置：{reason}（{e}）")),
        }
    })
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
    fn slashes_are_normalised_for_the_shell() {
        // 库里存的是正斜杠；ILCreateFromPathW 只认反斜杠，不转换就返回 NULL
        assert_eq!(win_path("C:/SeekX-Data/inbox/a.png"), "C:\\SeekX-Data\\inbox\\a.png");
        assert_eq!(win_path("D:/ComfyUI/output/"), "D:\\ComfyUI\\output");
        assert_eq!(win_path("C:/"), "C:\\");
        assert_eq!(win_path("\\\\nas\\share\\目录"), "\\\\nas\\share\\目录");
    }

    #[test]
    fn explorer_fallback_selects_files_and_just_opens_folders() {
        let file = explorer_args(&RevealTarget::File(PathBuf::from("C:/a/b.png")));
        assert_eq!(file, vec!["/select,C:\\a\\b.png".to_string()]);
        let folder = explorer_args(&RevealTarget::Folder(PathBuf::from("C:/a/b")));
        assert_eq!(folder, vec!["C:\\a\\b".to_string()]);
    }

    #[test]
    fn shell_calls_are_com_initialised() {
        // COM 没初始化 = 「打开所在文件夹失败」，这条只能钉源码
        let source = include_str!("reveal.rs");
        assert!(source.contains("fn CoInitialize(preserved: *mut c_void) -> i32;"));
        assert!(source.contains("CoInitialize(std::ptr::null_mut())"));
        assert!(source.contains("CoUninitialize()"));
        assert!(source.contains("ILCreateFromPathW"));
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