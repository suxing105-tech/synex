use std::path::PathBuf;

fn original_paths(paths: Vec<String>) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() || paths.len() > 2000 {
        return Err("请选择要拖出的图片".into());
    }
    paths.into_iter().map(|path| {
        let path = PathBuf::from(path);
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        if !path.is_absolute() || !path.is_file() || !["png", "webp", "jpg", "jpeg"].contains(&ext.as_str()) {
            return Err("原图片不存在或格式不支持".into());
        }
        Ok(path)
    }).collect()
}

#[tauri::command]
pub async fn drag_original_images(window: tauri::WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    let files = original_paths(paths)?;
    #[cfg(windows)]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        let drag_window = window.clone();
        window.run_on_main_thread(move || {
            let result = drag::start_drag(
                &drag_window,
                drag::DragItem::Files(files),
                drag::Image::Raw(include_bytes!("../icons/32x32.png").to_vec()),
                |_, _| {},
                drag::Options { mode: drag::DragMode::Copy, ..Default::default() },
            ).map_err(|error| error.to_string());
            let _ = send.send(result);
        }).map_err(|error| error.to_string())?;
        receive.await.map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    { let _ = (window, files); Err("当前系统暂不支持原生拖出".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_urls_missing_files_and_empty_selection() {
        assert!(original_paths(vec![]).is_err());
        assert!(original_paths(vec!["http://localhost/api/images/1/file?max=1024".into()]).is_err());
        assert!(original_paths(vec!["missing.png".into()]).is_err());
    }
    #[test]
    fn preserves_exact_original_file_path() {
        let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons/32x32.png");
        assert_eq!(original_paths(vec![file.to_string_lossy().into_owned()]).unwrap(), vec![file]);
    }
}
