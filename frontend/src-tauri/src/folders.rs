use std::path::PathBuf;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

static PICKER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tauri::command]
pub async fn select_text_paths(window: WebviewWindow, directory: bool) -> Result<Vec<String>, String> {
    if window.label() != "main" { return Err("请从主窗口选择文本".into()); }
    let _guard = PICKER.try_lock().map_err(|_| "文件选择窗口已打开")?;
    let dialog = window.app_handle().dialog().file().set_parent(&window)
        .set_title(if directory { "选择文本文件夹" } else { "选择要关联的文本原文件" });
    let (send, receive) = tokio::sync::oneshot::channel();
    if directory {
        dialog.pick_folder(move |folder| { let _ = send.send(folder.map(|f| vec![f])); });
    } else {
        dialog.add_filter("文本", &["txt", "md", "markdown", "srt", "vtt"])
            .pick_files(move |files| { let _ = send.send(files); });
    }
    receive.await.map_err(|_| "文件选择窗口未返回结果")?.unwrap_or_default()
        .into_iter().map(|file| file.into_path().map_err(|_| "请选择本地路径".to_string())?
            .into_os_string().into_string().map_err(|_| "无法识别路径".to_string())).collect()
}

/// 「导入技能」那一个入口认的后缀。
///
/// 一整个文件夹不进这里：原生文件框挑不了文件夹，而技能包九成情况下点进目录
/// 选那颗 SKILL.md 就够了（后端会连着整包一起收）。真要整目录，拖进来。
const SKILL_SOURCE_FILTERS: &[&str] = &["md", "markdown", "txt", "zip"];

/// 后缀在不在名单里。这里只做最粗的一道拦一下（原生框能输 `*.*` 绕过筛子），
/// 是不是技能包、压缩包能不能读，判断在后端那一份，不在这里再写一遍。
fn accepts_skill_source(path: &str) -> bool {
    let name = path.trim().replace('\\', "/");
    let name = name.rsplit('/').next().unwrap_or("");
    match name.rfind('.') {
        Some(dot) => SKILL_SOURCE_FILTERS
            .iter()
            .any(|ext| name[dot + 1..].eq_ignore_ascii_case(ext)),
        None => false,
    }
}

/// 导入技能那一个入口：挑一份 md 或一个 .zip，只回路径。
///
/// 不在 Rust 这边读文件：扫盘、解压、解析、落盘都是后端的事，
/// 这里多读一遍等于把同一份内容搬两遍。
#[tauri::command]
pub async fn select_skill_source(window: WebviewWindow) -> Result<Option<String>, String> {
    if window.label() != "main" {
        return Err("请从主窗口选择技能文件".into());
    }
    let _guard = PICKER.try_lock().map_err(|_| "文件选择窗口已打开")?;
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .app_handle()
        .dialog()
        .file()
        .set_title("选择技能文件（SKILL.md / .md / .zip）")
        .set_parent(&window)
        .add_filter("技能文件", SKILL_SOURCE_FILTERS)
        .pick_files(move |files| {
            // 原生框本来就只能单选；多选走的是拖进来的那条路（一次最多 20 个来源）
            let _ = send.send(files.and_then(|list| list.into_iter().next()));
        });
    let result = receive
        .await
        .map_err(|_| "文件选择窗口未能返回结果，请重试")?;
    result
        .map(|file| {
            let path = file
                .into_path()
                .map_err(|_| "请选择本地路径".to_string())?
                .into_os_string()
                .into_string()
                .map_err(|_| "无法识别路径".to_string())?;
            if !accepts_skill_source(&path) {
                return Err("只能选 .md 或 .zip：一整个文件夹直接拖进这个窗口就行".to_string());
            }
            Ok(path)
        })
        .transpose()
}

/// 「导入工作流」那一个入口认的后缀。
///
/// 只认 .json：后端 inspect 只吃 ComfyUI「Export (API)」那一份 JSON，
/// 挑了 .txt / .yaml 只会换来一句「读不了」，在原生框这一道拦掉比事后报错省一轮。
const WORKFLOW_JSON_FILTERS: &[&str] = &["json"];

/// 后缀在不在名单里。同 `accepts_skill_source`：原生框里输 `*.*` 能绕过筛子，这里补一道。
fn accepts_workflow_json(path: &str) -> bool {
    let name = path.trim().replace('\\', "/");
    let name = name.rsplit('/').next().unwrap_or("");
    match name.rfind('.') {
        Some(dot) => WORKFLOW_JSON_FILTERS
            .iter()
            .any(|ext| name[dot + 1..].eq_ignore_ascii_case(ext)),
        None => false,
    }
}

/// 导入工作流那一个入口：挑一份 API 格式的 .json，只回路径。
///
/// 不在 Rust 这边读文件：解析、扫节点、检测槽位全是后端那一份的活，
/// 这里多读一遍等于把几十 MB 的工作流搬两遍。
#[tauri::command]
pub async fn select_workflow_json(window: WebviewWindow) -> Result<Option<String>, String> {
    if window.label() != "main" {
        return Err("请从主窗口选择工作流文件".into());
    }
    let _guard = PICKER.try_lock().map_err(|_| "文件选择窗口已打开")?;
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .app_handle()
        .dialog()
        .file()
        .set_title("选择工作流 JSON（ComfyUI → Workflow → Export API）")
        .set_parent(&window)
        .add_filter("工作流 JSON", WORKFLOW_JSON_FILTERS)
        .pick_files(move |files| {
            let _ = send.send(files.and_then(|list| list.into_iter().next()));
        });
    let result = receive
        .await
        .map_err(|_| "文件选择窗口未能返回结果，请重试")?;
    result
        .map(|file| {
            let path = file
                .into_path()
                .map_err(|_| "请选择本地路径".to_string())?
                .into_os_string()
                .into_string()
                .map_err(|_| "无法识别路径".to_string())?;
            if !accepts_workflow_json(&path) {
                return Err("只能选 .json：要的是 ComfyUI「Workflow → Export (API)」导出的那一份".to_string());
            }
            Ok(path)
        })
        .transpose()
}

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
    fn skill_source_only_takes_md_and_zip_suffixes() {
        assert!(accepts_skill_source("C:\\skills\\电商\\SKILL.md"));
        assert!(accepts_skill_source("/tmp/pack/SKILL.MD"));
        assert!(accepts_skill_source("C:\\a\\技能包.zip"));
        assert!(accepts_skill_source("note.markdown"));
        assert!(accepts_skill_source("plain.txt"));
        // 后缀以外的东西不许进来：压缩包只认 .zip，文件夹走拖拽
        assert!(!accepts_skill_source("C:\\a\\技能包.7z"));
        assert!(!accepts_skill_source("C:\\a\\技能包.rar"));
        assert!(!accepts_skill_source("C:\\a\\SKILL"));
        assert!(!accepts_skill_source(""));
        assert!(!accepts_skill_source("archive."));
    }
    #[test]
    fn workflow_json_only_takes_the_api_export_suffix() {
        assert!(accepts_workflow_json("C:\\常用\\Qwen-image-2.1多图编辑.json"));
        assert!(accepts_workflow_json("/tmp/H3/WORKFLOW.JSON"));
        // 界面格式那份也是 .json，筛子分不出这两种——认格式在后端，别在这儿装懂。
        // 但别的后缀必须当场拦住，省得挑了 .txt 再吃一句读不了。
        assert!(!accepts_workflow_json("C:\\a\\workflow.txt"));
        assert!(!accepts_workflow_json("C:\\a\\workflow.yaml"));
        assert!(!accepts_workflow_json("C:\\a\\workflow"));
        assert!(!accepts_workflow_json(""));
        assert!(!accepts_workflow_json("workflow."));
    }
    #[test]
    fn rejects_a_file_as_initial_directory() {
        let existing = std::env::current_exe().unwrap();
        assert!(initial_directory(Some(existing.display().to_string()), None).is_none());
    }
}
