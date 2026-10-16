use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(1);

/// 已经开出来的 ComfyUI 插件弹窗：去重键 -> 窗口 label。
/// 反复点同一个面板（例如 LoRA 管理器）时复用已有窗口，不堆一叠。
fn popup_registry() -> &'static Mutex<HashMap<String, String>> {
    static POPUPS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    POPUPS.get_or_init(Default::default)
}

/// ComfyUI 页面调用 `window.open` 时，这个链接该开在哪里。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PopupTarget {
    /// 同源页面（ComfyUI 自己的插件界面，如 LoRA 管理器的 `/loras`）-> 应用内新窗口
    InApp,
    /// 外部站点（Civitai、文档等）-> 系统默认浏览器
    ExternalBrowser,
    /// 其它协议（`javascript:`、`file:` 等）-> 不放行
    Deny,
}

/// 弹窗落点策略。判断只看来源页与目标页的 origin，不看具体插件，
/// 所以任何自定义节点的「在新窗口打开面板」都能落到应用内窗口。
pub(crate) fn popup_target(opener: &Url, target: &Url) -> PopupTarget {
    if !matches!(target.scheme(), "http" | "https") {
        return PopupTarget::Deny;
    }
    if matches!(opener.scheme(), "http" | "https") && target.origin() == opener.origin() {
        PopupTarget::InApp
    } else {
        PopupTarget::ExternalBrowser
    }
}

/// 弹窗去重键：同源 + 同路径算同一个面板（忽略 query / hash，插件常在里面塞状态）。
pub(crate) fn popup_key(url: &Url) -> String {
    format!("{}{}", url.origin().ascii_serialization(), url.path())
}

/// 弹窗窗口标题：路径末段比整条 URL 好认，页面自己有 `<title>` 时会立刻覆盖。
fn popup_title(url: &Url) -> String {
    match url.path_segments().and_then(|s| s.last()) {
        Some(last) if !last.is_empty() => format!("ComfyUI \u{00b7} {last}"),
        _ => url.host_str().unwrap_or("ComfyUI").to_string(),
    }
}

/// 复用已存在的同类弹窗窗口；命中返回 true。
fn reuse_popup(app: &tauri::AppHandle, key: &str) -> bool {
    let existing = {
        let mut popups = popup_registry().lock().unwrap_or_else(|e| e.into_inner());
        match popups.get(key) {
            Some(label) if app.get_webview_window(label).is_some() => Some(label.clone()),
            _ => {
                popups.remove(key);
                None
            }
        }
    };
    let Some(label) = existing else { return false };
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    true
}

type PopupHandler = Box<dyn Fn(Url, NewWindowFeatures) -> NewWindowResponse<tauri::Wry> + Send + 'static>;

/// `window.open` 处理器。WebView2 在没人接手时会把新窗口请求直接吞掉
/// （`SetHandled(true)` 且不创建窗口），表现就是「点了 LoRA 管理器没反应」。
/// 这里显式接管：同源 -> 应用内窗口，外链 -> 默认浏览器，其它 -> 拒绝。
///
/// 新建的应用内窗口会带上同一个处理器（弹窗里的弹窗也走得通），
/// 但**不带**工作流注入脚本 —— 脚本按 origin 匹配，同源插件页面会被误加载工作流。
fn new_window_policy(app: tauri::AppHandle, opener: Url) -> PopupHandler {
    Box::new(move |url, features| match popup_target(&opener, &url) {
        PopupTarget::Deny => {
            log::warn!("[comfyui] blocked popup {url}");
            NewWindowResponse::Deny
        }
        PopupTarget::ExternalBrowser => {
            if let Err(e) = open_in_default_browser(url.as_str()) {
                log::error!("[comfyui] open external link failed {url}: {e}");
            }
            NewWindowResponse::Deny
        }
        PopupTarget::InApp => {
            let key = popup_key(&url);
            if reuse_popup(&app, &key) {
                return NewWindowResponse::Deny;
            }
            let label = format!("comfy-popup-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
            // window_features 必须带上：Windows 上 Create 响应要求新 webview
            // 与来源 webview 共用同一个 WebView2 environment，否则拿不到窗口。
            let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url.clone()))
                .title(&popup_title(&url))
                .theme(Some(tauri::Theme::Dark))
                .visible(false)
                .inner_size(1200.0, 800.0)
                .window_features(features)
                .on_document_title_changed(|window, title| {
                    let _ = window.set_title(&title);
                })
                .on_new_window(new_window_policy(app.clone(), url.clone()));
            match builder.build() {
                Ok(window) => {
                    crate::window_style::apply(&window);
                    let _ = window.show();
                    popup_registry()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(key, label);
                    NewWindowResponse::Create { window }
                }
                Err(e) => {
                    log::error!("[comfyui] popup window failed {url}: {e}");
                    NewWindowResponse::Deny
                }
            }
        }
    })
}

/// 用系统默认浏览器打开链接。不引入 opener/shell 依赖：
/// Windows 走 explorer.exe（无控制台窗口），其它平台用各自的 opener。
#[cfg(windows)]
pub(crate) fn open_in_default_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
pub(crate) fn open_in_default_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn open_in_default_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 主窗口等应用内页面调 `window.open` 时（WebView2 同样会吞），
/// 由前端显式改走这条命令：交给系统默认浏览器。
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|_| "链接无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("只允许打开 http/https 链接".into());
    }
    open_in_default_browser(parsed.as_str())
}

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
    let opener = target.clone();
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(target))
        .title(format!("ComfyUI \u{00b7} {}", name))
        .theme(Some(tauri::Theme::Dark))
        .visible(false)
        .inner_size(1280.0, 900.0)
        .initialization_script(&script)
        .on_new_window(new_window_policy(app.clone(), opener))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        raw.parse().expect("测试用 URL 必须合法")
    }

    #[test]
    fn same_origin_popup_opens_in_app() {
        // LoRA 管理器：从 ComfyUI 页面开自己的 /loras 面板
        let opener = url("http://127.0.0.1:8188/?t=1");
        assert_eq!(popup_target(&opener, &url("http://127.0.0.1:8188/loras")), PopupTarget::InApp);
        assert_eq!(popup_target(&opener, &url("http://127.0.0.1:8188/loras/#/detail")), PopupTarget::InApp);
    }

    #[test]
    fn cross_origin_popup_goes_to_browser() {
        let opener = url("http://127.0.0.1:8188/");
        assert_eq!(popup_target(&opener, &url("https://civitai.com/models/1")), PopupTarget::ExternalBrowser);
        // 端口不同就是另一个 origin，不能塞进应用内窗口
        assert_eq!(popup_target(&opener, &url("http://127.0.0.1:8189/loras")), PopupTarget::ExternalBrowser);
        assert_eq!(popup_target(&opener, &url("http://localhost:8188/loras")), PopupTarget::ExternalBrowser);
    }

    #[test]
    fn non_http_scheme_is_denied() {
        let opener = url("http://127.0.0.1:8188/");
        assert_eq!(popup_target(&opener, &url("file:///C:/Windows/win.ini")), PopupTarget::Deny);
        assert_eq!(popup_target(&opener, &url("javascript:alert(1)")), PopupTarget::Deny);
    }

    #[test]
    fn external_opener_denies_non_http_but_still_uses_browser_for_links() {
        let opener = url("http://tauri.localhost/index.html");
        assert_eq!(popup_target(&opener, &url("http://127.0.0.1:8188/")), PopupTarget::ExternalBrowser);
        assert_eq!(popup_target(&opener, &url("mailto:me@example.com")), PopupTarget::Deny);
    }

    #[test]
    fn popup_key_ignores_query_and_hash_but_keeps_path() {
        assert_eq!(
            popup_key(&url("http://127.0.0.1:8188/loras?tab=image#x")),
            popup_key(&url("http://127.0.0.1:8188/loras"))
        );
        assert_ne!(
            popup_key(&url("http://127.0.0.1:8188/loras")),
            popup_key(&url("http://127.0.0.1:8188/"))
        );
        assert_ne!(
            popup_key(&url("http://127.0.0.1:8188/loras")),
            popup_key(&url("http://127.0.0.1:8189/loras"))
        );
    }

    #[test]
    fn popup_title_uses_last_path_segment() {
        assert_eq!(popup_title(&url("http://127.0.0.1:8188/loras")), "ComfyUI \u{00b7} loras");
        assert_eq!(popup_title(&url("http://127.0.0.1:8188/")), "127.0.0.1");
    }
}
