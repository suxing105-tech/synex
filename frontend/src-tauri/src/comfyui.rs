use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(1);

/// 注入 ComfyUI 窗口的两段脚本：面板宿主 + 工作流加载桥。
const PANEL_JS: &str = include_str!("comfyui_panel.js");
const BRIDGE_JS: &str = include_str!("comfyui_bridge.js");

/// 已经开出来的独立弹窗：去重键 -> 窗口 label。
/// 只有插件显式要求独立窗口（window.open 带尺寸，如 LoRA 管理器 Shift+点）才会走到这里。
fn popup_registry() -> &'static Mutex<HashMap<String, String>> {
    static POPUPS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    POPUPS.get_or_init(Default::default)
}

/// ComfyUI 页面要开新页面时的落点。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PopupTarget {
    /// 同源且没有显式窗口尺寸 -> 当前 ComfyUI 窗口内的面板（页面模式，不新开窗口）
    InWindowPanel,
    /// 同源但页面显式要求独立窗口 -> 应用内新窗口
    InAppWindow,
    /// 外部站点（Civitai、文档等）-> 系统默认浏览器
    ExternalBrowser,
    /// 其它协议（`javascript:`、`file:` 等）-> 不放行
    Deny,
}

/// 落点策略。`explicit_size` 取自 window.open 的第三参（width=/height=），
/// 它是「用户/插件确实想要一个单独窗口」的唯一可靠信号：
/// LoRA 管理器的普通点击是 `window.open(url, "_blank")`，
/// Shift+点才是 `window.open(url, "_blank", "width=1200,height=800,...")`。
pub(crate) fn popup_target(opener: &Url, target: &Url, explicit_size: bool) -> PopupTarget {
    if !matches!(target.scheme(), "http" | "https") {
        return PopupTarget::Deny;
    }
    if !matches!(opener.scheme(), "http" | "https") || target.origin() != opener.origin() {
        return PopupTarget::ExternalBrowser;
    }
    if explicit_size {
        PopupTarget::InAppWindow
    } else {
        PopupTarget::InWindowPanel
    }
}

/// 弹窗去重键：同源 + 同路径算同一个窗口（忽略 query / hash，插件常在里面塞状态）。
pub(crate) fn popup_key(url: &Url) -> String {
    format!("{}{}", url.origin().ascii_serialization(), url.path())
}

/// 独立弹窗也想要「面板模式」能力，但没有工作流请求对象，
/// 所以给它一个只有 origin 的 request，让面板脚本照常生效。
pub(crate) fn panel_script_for(url: &Url) -> String {
    let origin = serde_json::to_string(&url.origin().ascii_serialization()).unwrap_or_else(|_| "\"null\"".into());
    format!("(() => {{ const request = {{ origin: {origin} }}; {PANEL_JS} }})();")
}

/// 弹窗窗口标题：路径末段比整条 URL 好认，页面自己有 `<title>` 时会立刻覆盖。
fn popup_title(url: &Url) -> String {
    match url.path_segments().and_then(|s| s.last()) {
        Some(last) if !last.is_empty() => format!("ComfyUI \u{00b7} {last}"),
        _ => url.host_str().unwrap_or("ComfyUI").to_string(),
    }
}

/// 打开当前窗口内的面板。脚本没装好（页面没加载完 / 被插件覆盖）就返回 false，
/// 让调用方退回独立窗口，不要出现「点了什么都不知道」。
fn open_panel_in_window(app: &tauri::AppHandle, label: &str, url: &Url) -> bool {
    let Some(window) = app.get_webview_window(label) else {
        return false;
    };
    let Ok(payload) = serde_json::to_string(url.as_str()) else {
        return false;
    };
    let js = format!("window.__seekxPanel && window.__seekxPanel.open({payload});");
    match window.eval(&js) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("[comfyui] panel eval failed: {e}");
            false
        }
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

fn open_in_app_window(
    app: &tauri::AppHandle,
    url: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
    let key = popup_key(&url);
    if reuse_popup(app, &key) {
        return NewWindowResponse::Deny;
    }
    let label = format!("comfy-popup-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    // window_features 必须带上：Windows 上 Create 响应要求新 webview 与来源 webview
    // 共用同一个 WebView2 environment，否则拿不到窗口。
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.clone()))
        .title(&popup_title(&url))
        .theme(Some(tauri::Theme::Dark))
        .visible(false)
        .inner_size(1200.0, 800.0)
        .window_features(features)
        .initialization_script(&panel_script_for(&url))
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        });
    let opener = url.clone();
    let builder = builder.on_new_window(new_window_policy(app.clone(), opener, Some(label.clone())));
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

type PopupHandler = Box<dyn Fn(Url, NewWindowFeatures) -> NewWindowResponse<tauri::Wry> + Send + 'static>;

/// `window.open` 处理器。WebView2 在没人接手时会把新窗口请求直接吞掉
/// （`SetHandled(true)` 且不创建窗口），表现就是「点了 LoRA 管理器没反应」。
/// 页面侧脚本已经尽量把同源弹窗改成同窗口面板，这里是兜底与外链分流。
fn new_window_policy(
    app: tauri::AppHandle,
    opener: Url,
    panel_label: Option<String>,
) -> PopupHandler {
    Box::new(move |url, features| {
        let explicit_size = features.size().is_some();
        match popup_target(&opener, &url, explicit_size) {
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
            PopupTarget::InWindowPanel => {
                if let Some(label) = &panel_label {
                    if open_panel_in_window(&app, label, &url) {
                        return NewWindowResponse::Deny;
                    }
                }
                open_in_app_window(&app, url, features)
            }
            PopupTarget::InAppWindow => open_in_app_window(&app, url, features),
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

/// 打开工作流的应用内窗口标题。
/// 工作流名仍然会传给 ComfyUI（写进工作流名称），但不再进标题：
/// 用户会同时开多个工作流窗口，任务栏 / Alt-Tab 里统一显示 ComfyUI 更好认。
fn workflow_window_title(_workflow_name: &str) -> String {
    "ComfyUI".to_string()
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
    // 面板宿主 + 工作流桥共用同一个 request 作用域；面板必须在前。
    let script = format!("(() => {{ const request = {}; {PANEL_JS} {BRIDGE_JS} }})();", request);
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let label = format!("comfy-workflow-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let opener = target.clone();
    let panel_label = label.clone();
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(target))
        .title(workflow_window_title(&name))
        .theme(Some(tauri::Theme::Dark))
        .visible(false)
        .inner_size(1280.0, 900.0)
        .initialization_script(&script)
        .on_new_window(new_window_policy(app.clone(), opener, Some(panel_label)))
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
    fn same_origin_popup_becomes_in_window_panel() {
        // LoRA 管理器普通点击：window.open('/loras 全地址', '_blank')，无窗口尺寸
        let opener = url("http://127.0.0.1:8188/?t=1");
        assert_eq!(popup_target(&opener, &url("http://127.0.0.1:8188/loras"), false), PopupTarget::InWindowPanel);
        assert_eq!(popup_target(&opener, &url("http://127.0.0.1:8188/loras/#/detail"), false), PopupTarget::InWindowPanel);
    }

    #[test]
    fn explicit_window_features_still_open_a_window() {
        // LoRA 管理器 Shift+点：features 带 width/height -> 保留独立窗口能力
        let opener = url("http://127.0.0.1:8188/");
        assert_eq!(popup_target(&opener, &url("http://127.0.0.1:8188/loras"), true), PopupTarget::InAppWindow);
    }

    #[test]
    fn cross_origin_popup_goes_to_browser() {
        let opener = url("http://127.0.0.1:8188/");
        assert_eq!(popup_target(&opener, &url("https://civitai.com/models/1"), false), PopupTarget::ExternalBrowser);
        // 端口/host 不同就是另一个 origin，不能塞进 ComfyUI 窗口
        assert_eq!(popup_target(&opener, &url("http://127.0.0.1:8189/loras"), false), PopupTarget::ExternalBrowser);
        assert_eq!(popup_target(&opener, &url("http://localhost:8188/loras"), true), PopupTarget::ExternalBrowser);
    }

    #[test]
    fn non_http_scheme_is_denied() {
        let opener = url("http://127.0.0.1:8188/");
        assert_eq!(popup_target(&opener, &url("file:///C:/Windows/win.ini"), false), PopupTarget::Deny);
        assert_eq!(popup_target(&opener, &url("javascript:alert(1)"), true), PopupTarget::Deny);
    }

    #[test]
    fn external_opener_denies_non_http_but_still_uses_browser_for_links() {
        let opener = url("http://tauri.localhost/index.html");
        assert_eq!(popup_target(&opener, &url("http://127.0.0.1:8188/"), false), PopupTarget::ExternalBrowser);
        assert_eq!(popup_target(&opener, &url("mailto:me@example.com"), false), PopupTarget::Deny);
    }

    #[test]
    fn panel_script_and_bridge_share_the_injected_scope() {
        // 两段脚本都靠 request.origin 判断生效范围，注入顺序必须是面板在前、桥在后
        assert!(PANEL_JS.contains("window.__seekxPanel"));
        assert!(PANEL_JS.contains("request.origin"));
        assert!(PANEL_JS.contains("location.origin === request.origin"));
        assert!(BRIDGE_JS.contains("location.origin === request.origin"));
        let combined = format!("{PANEL_JS}{BRIDGE_JS}");
        assert!(combined.find("__seekxPanel").unwrap() < combined.find("comfyAPI").unwrap());
    }

    #[test]
    fn standalone_popup_gets_a_panel_host_too() {
        let script = panel_script_for(&url("http://127.0.0.1:8188/loras"));
        assert!(script.contains("const request = { origin: \"http://127.0.0.1:8188\" }"));
        assert!(script.contains("__seekxPanel"));
        // 独立弹窗不加载工作流桥，避免把图灌进插件页面
        assert!(!script.contains("loadGraphData"));
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

    #[test]
    fn workflow_window_title_is_always_comfyui() {
        // 用户要求：无论从哪个缩略图打开工作流，标题统一显示 ComfyUI
        assert_eq!(workflow_window_title("一采_00083_"), "ComfyUI");
        assert_eq!(workflow_window_title("高清_00019_"), "ComfyUI");
        assert_eq!(workflow_window_title(""), "ComfyUI");
    }
}
