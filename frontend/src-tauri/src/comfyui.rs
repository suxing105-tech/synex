use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{WebviewUrl, WebviewWindowBuilder};
static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(1);

#[tauri::command]
pub async fn open_comfy_workflow(app: tauri::AppHandle, url: String, name: String, workflow: serde_json::Value) -> Result<(), String> {
    let target: tauri::Url = url.parse().map_err(|_| "ComfyUI 地址无效")?;
    if !matches!(target.scheme(), "http" | "https") || target.host_str().is_none() {
        return Err("ComfyUI 地址必须是 HTTP 或 HTTPS".into());
    }
    if !workflow.get("nodes").is_some_and(|n| n.is_array()) {
        return Err("图片没有可加载的 ComfyUI 画布工作流".into());
    }
    let request = serde_json::json!({ "origin": target.origin().ascii_serialization(), "base": target.as_str(), "name": name, "workflow": workflow });
    let script = format!("(() => {{ const request = {}; {} }})();", request, include_str!("comfyui_bridge.js"));
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let label = format!("comfy-workflow-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(target))
        .title(format!("ComfyUI · {}", name))
        .theme(Some(tauri::Theme::Dark))
        .visible(false)
        .inner_size(1280.0, 900.0)
        .initialization_script(&script)
        .on_navigation(move |location| {
            if location.scheme() == "suxing-workflow" {
                let result = if location.host_str() == Some("loaded") { Ok(()) } else {
                    Err(location.query_pairs().find(|(key, _)| key == "message").map(|(_, value)| value.into_owned()).unwrap_or("工作流加载失败".into()))
                };
                if let Some(send) = sender.lock().unwrap().take() { let _ = send.send(result); }
                false
            } else { true }
        })
        .build().map_err(|e| e.to_string())?;
    crate::window_style::apply(&window);
    window.show().map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(90), receiver).await
        .map_err(|_| "ComfyUI 加载超时，请确认服务已启动".to_string())?
        .map_err(|_| "ComfyUI 窗口已关闭".to_string())?
}
