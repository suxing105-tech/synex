use std::path::PathBuf;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

static PICKER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn initial_directory(current: Option<String>, previous: Option<String>) -> Option<PathBuf> {
    [current, previous]
        .into_iter()
        .flatten()
        .map(|p| PathBuf::from(p.trim()))
        .find(|p| p.is_absolute() && p.is_dir())
}

#[tauri::command]
pub async fn select_import_directory(
    window: WebviewWindow,
    current: Option<String>,
    previous: Option<String>,
) -> Result<Option<String>, String> {
    if window.label() != "main" {
        return Err("请从图库主窗口选择文件夹".into());
    }
    let _guard = PICKER.try_lock().map_err(|_| "文件夹选择窗口已打开")?;
    let initial =
        tauri::async_runtime::spawn_blocking(move || initial_directory(current, previous))
            .await
            .map_err(|_| "无法读取初始目录")?;
    let mut dialog = window
        .app_handle()
        .dialog()
        .file()
        .set_title("选择 ComfyUI 输出文件夹")
        .set_parent(&window);
    if let Some(path) = initial {
        dialog = dialog.set_directory(path);
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    dialog.pick_folder(move |folder| {
        let _ = send.send(folder);
    });
    let result = receive
        .await
        .map_err(|_| "文件夹选择窗口未能返回结果，请重试")?;
    result
        .map(|file| {
            file.into_path()
                .map_err(|_| "请选择本机可访问的文件夹".to_string())?
                .into_os_string()
                .into_string()
                .map_err(|_| "无法识别该文件夹路径".to_string())
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ignores_invalid_and_relative_initial_paths() {
        let existing = std::env::temp_dir();
        assert_eq!(
            initial_directory(
                Some("missing-directory".into()),
                Some(existing.display().to_string())
            ),
            Some(existing.clone())
        );
        assert_eq!(
            initial_directory(Some(existing.display().to_string()), None),
            Some(existing)
        );
        assert!(initial_directory(Some(".".into()), Some("".into())).is_none());
    }
    #[test]
    fn rejects_a_file_as_initial_directory() {
        let existing = std::env::current_exe().unwrap();
        assert!(initial_directory(Some(existing.display().to_string()), None).is_none());
    }
}
