use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(1);

/// 注入 ComfyUI 工作流窗口的两段脚本：面板宿主 + 工作流加载桥，顺序固定：面板在前、桥在后。
const PANEL_JS: &str = include_str!("comfyui_panel.js");
const BRIDGE_JS: &str = include_str!("comfyui_bridge.js");

/// 已经开出来的独立弹窗：去重键 -> 窗口 label。
/// 只有插件显式要求独立窗口（window.open 带尺寸，如 LoRA 管理器 Shift+点）才会走到这里。
fn popup_registry() -> &'static Mutex<HashMap<String, String>> {
    static POPUPS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    POPUPS.get_or_init(Default::default)
}

/// 同一个 ComfyUI 服务只开一个窗口：工作流在窗口内部当成标签来切，
/// 不再「每开一张图就多一个窗口」（表现和浏览器一致）。
fn workflow_windows() -> &'static Mutex<HashMap<String, String>> {
    static WINDOWS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    WINDOWS.get_or_init(Default::default)
}

/// 每次「把某个工作流装进窗口」都要等窗口里的脚本回执，键是请求 id。
fn pending_loads() -> &'static Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<(), String>>>> {
    static PENDING: OnceLock<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<(), String>>>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

static NEXT_LOAD_ID: AtomicU64 = AtomicU64::new(1);

fn next_load_id() -> u64 {
    NEXT_LOAD_ID.fetch_add(1, Ordering::Relaxed)
}

fn lock<T>(slot: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn register_load(id: u64) -> tokio::sync::oneshot::Receiver<Result<(), String>> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    lock(pending_loads()).insert(id, sender);
    receiver
}

fn resolve_load(id: u64, result: Result<(), String>) {
    if let Some(sender) = lock(pending_loads()).remove(&id) {
        let _ = sender.send(result);
    }
}

fn clear_load(id: u64) {
    lock(pending_loads()).remove(&id);
}

/// 窗口里的脚本用自定义协议回传结果（外部页面的 JS 拿不到 Tauri IPC）：
/// `suxing-workflow://loaded?id=7` / `suxing-workflow://failed?id=7&message=…`。
pub(crate) fn parse_ping(location: &Url) -> Option<(u64, Result<(), String>)> {
    if location.scheme() != "suxing-workflow" {
        return None;
    }
    let id = location
        .query_pairs()
        .find(|(key, _)| key == "id")
        .and_then(|(_, value)| value.parse::<u64>().ok())
        .unwrap_or(0);
    let result = match location.host_str() {
        Some("loaded") => Ok(()),
        _ => Err(location
            .query_pairs()
            .find(|(key, _)| key == "message")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_else(|| "工作流加载失败".to_string())),
    };
    Some((id, result))
}

/// 窗口按 ComfyUI 服务（origin）复用，不按工作流：换工作流只是换标签。
pub(crate) fn workflow_window_key(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// 拿到可复用的窗口；记录已经失效就顺手清掉。
fn reusable_window(app: &tauri::AppHandle, key: &str) -> Option<tauri::WebviewWindow> {
    let label = {
        let mut windows = lock(workflow_windows());
        match windows.get(key) {
            Some(label) if app.get_webview_window(label).is_some() => label.clone(),
            _ => {
                windows.remove(key);
                return None;
            }
        }
    };
    app.get_webview_window(&label)
}

/// 记住这个 origin 的窗口，同地址以后都回到这里。
fn remember_window(app: &tauri::AppHandle, key: &str, window: &tauri::WebviewWindow) {
    if app.get_webview_window(window.label()).is_some() {
        lock(workflow_windows()).insert(key.to_string(), window.label().to_string());
    }
}

/// 等窗口里的脚本回执。`secs` 秒没人回话就报超时（ComfyUI 冷启动很慢，别调太短）。
async fn await_load(id: u64, receiver: tokio::sync::oneshot::Receiver<Result<(), String>>, secs: u64) -> Result<(), String> {
    tokio::time::timeout(std::time::Duration::from_secs(secs), receiver)
        .await
        .map_err(|_| {
            clear_load(id);
            "ComfyUI 加载超时，请确认服务已启动".to_string()
        })?
        .map_err(|_| "ComfyUI 窗口已关闭".to_string())?
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

/// 把当前工作流窗口切到面板页面（同窗口页面模式，不再开新窗口）。
/// 脚本没注入成功或 webview 已经死了就返回 false，调用方回退到另开窗口。
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
    // 拖放 / 剪贴板同 open_comfy_workflow：交给 ComfyUI 页面自己处理
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.clone()))
        .title(&popup_title(&url))
        .theme(Some(tauri::Theme::Dark))
        .visible(false)
        .disable_drag_drop_handler()
        .enable_clipboard_access()
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

/// 把注册表里一条 `shell\open\command` 切成参数（引号里的内容算一段，路径带空格不会被切碎）。
fn split_command_line(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = text.trim().chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                // 参数里要真想带一个引号，按 Windows 命令行那套写两个（"" ）。
                if quoted && chars.peek() == Some(&'"') {
                    current.push('"');
                    chars.next();
                } else {
                    quoted = !quoted;
                }
            }
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// 注册表里那条「按 URL 关联打开程序」的命令行 → 能直接 spawn 的 (程序, 参数)。
///
/// 三种写法都见过：`"C:\...\msedge.exe" --single-argument %1`（Edge）、`"\...\chrome.exe" "%1"`
/// （Chrome，占位符整段带引号）、少数老 handler 用 `%l`（要的是带协议头的完整地址，
/// 我们传进去的本来就是完整地址，同一个替换法）。没有占位符那种（`"...\firefox.exe"`）
/// 把地址追加成最后一个参数。占位符两侧的引号在这儿已经被切掉了：spawn 不过 shell，
/// 引号留在参数里浏览器会当成地址的一部分。
fn open_command_of(command: &str, link: &str) -> Option<(String, Vec<String>)> {
    let mut tokens = split_command_line(command).into_iter();
    let exe = tokens.next()?.trim().to_string();
    if exe.is_empty() {
        return None;
    }
    let mut args: Vec<String> = Vec::new();
    let mut placed = false;
    for token in tokens {
        if matches!(token.to_ascii_lowercase().as_str(), "%1" | "%l" | "%?") {
            args.push(link.to_string());
            placed = true;
        } else {
            args.push(token);
        }
    }
    if !placed {
        args.push(link.to_string());
    }
    Some((exe, args))
}

/// 系统自己那条「用默认程序打开这个地址」：ShellExecuteW("open", url)。
///
/// 返回值是 HINSTANCE，>32 算成功。**它的 Ok 不能当「真的打开了」看**（见下面
/// open_in_default_browser 的实测记录），所以这一条现在只当备胎用。
/// CoInitialize 是 reveal.rs 踩过的同一脚：Shell 这套接口里有处理器要先有 COM，没有直接失败。
#[cfg(windows)]
fn shell_open(url: &str) -> Result<(), String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "ole32")]
    extern "system" {
        fn CoInitialize(preserved: *mut c_void) -> i32;
        fn CoUninitialize();
    }
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_cmd: i32,
        ) -> isize;
    }

    fn wide(text: &str) -> Vec<u16> {
        std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    const SW_SHOWNORMAL: i32 = 1;
    let operation = wide("open");
    let target = wide(url);
    // S_OK / S_FALSE 都算「这次是我初始化的」；本来就是开着的，收回那句就不该说。
    let initialized = unsafe { CoInitialize(std::ptr::null_mut()) } >= 0;
    let instance = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if initialized {
        unsafe { CoUninitialize() };
    }
    // <=32 是 SE_ERR_* 错误码（31 = 系统里没有能开它的程序）。
    if instance > 32 {
        Ok(())
    } else {
        Err(format!("ShellExecute 错误码 {instance}"))
    }
}

/// URL 这一族在注册表里登记的命令行（先问用户选的默认程序，再退回机器默认）。
#[cfg(windows)]
fn browser_open_command(scheme: &str, link: &str) -> Option<(String, Vec<String>)> {
    use winreg::{enums::*, RegKey};

    let progid = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            format!(
                "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\{scheme}\\UserChoice"
            ),
            KEY_READ,
        )
        .and_then(|key| key.get_value::<String, _>("ProgId"))
        .ok();
    let classes = RegKey::predef(HKEY_CLASSES_ROOT);
    let mut keys: Vec<String> = Vec::new();
    if let Some(id) = progid.as_deref() {
        if !id.trim().is_empty() {
            keys.push(format!("{id}\\shell\\open\\command"));
        }
    }
    keys.push(format!("{scheme}\\shell\\open\\command"));
    for key in keys {
        if let Ok(command) = classes
            .open_subkey_with_flags(&key, KEY_READ)
            .and_then(|sub| sub.get_value::<String, _>(""))
        {
            if let Some(parsed) = open_command_of(command.trim(), link) {
                return Some(parsed);
            }
        }
    }
    None
}

/// 把浏览器自己拉起来（脱离本进程，不等它退出）。
#[cfg(windows)]
fn spawn_detached(exe: &str, args: &[String]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW：万一那个 handler 是控制台程序，别在用户屏幕上闪一块黑。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new(exe)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// 用系统默认浏览器打开链接。不引入 opener/shell 依赖，其它平台用各自的 opener。
///
/// Windows 这一条为什么不是「一句 ShellExecuteW 就完事」，2026-11-17 在本机实测过三回：
/// ① `ShellExecuteW("open", <http URL>)` 返回 42（>32＝成功）却什么都不起来；同一进程里
///    `ShellExecuteW("open", "notepad.exe")` 起得来记事本，直接 spawn msedge.exe 也起得来，
///    被吞掉的只有「按 URL 关联打开程序」这一条；`rundll32 url.dll,FileProtocolHandler <URL>`
///    同样 rc=0、什么都没起来。② 上一版把这个记成「agent 沙箱的 job object 吞的」，是误诊：
///    普通进程里照样复现，而苏醒点的就是这条。③ 它连失败都不回——返回的是「成功」。
///    所以「点了没反应、界面上连一句错都没有」是必然表现，而不是运气。
/// 于是主路改成自己做关联那一步：从注册表读出 URL 关联的命令行（HKCU 里用户选的默认程序优先，
/// 退回 HKCR 机器默认），自己 spawn。这条能被验证（起不来就是 spawn 报错），做的又是同一件事
/// ——注册表里那行 `"C:\...\msedge.exe" --single-argument %1` 本来就是 Shell 要去执行的。
/// ShellExecute 留在后面当备胎，认不出关联时至少还试一次系统那条路。
#[cfg(windows)]
pub(crate) fn open_in_default_browser(url: &str) -> Result<(), String> {
    let scheme = url
        .split_once(':')
        .map(|(head, _)| head.to_ascii_lowercase())
        .unwrap_or_default();
    let mut notes: Vec<String> = Vec::new();
    match browser_open_command(&scheme, url) {
        Some((exe, args)) => match spawn_detached(&exe, &args) {
            Ok(()) => return Ok(()),
            Err(error) => notes.push(format!("起 {exe} 失败：{error}")),
        },
        None => notes.push("注册表里没认出这个地址该用哪个程序".to_string()),
    }
    shell_open(url).map_err(|error| {
        notes.push(format!("系统那条按关联打开的路也没成：{error}（它回的是成功还是失败都可能没真打开）"));
        notes.join("；")
    })
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

/// 把另一个工作流塞进已经开着的窗口。页面还没准备好（比如正停在 LoRA 管理器那种
/// 插件页面）就返回 Err，让调用方改走新建窗口，别把用户晾在原地。
fn push_workflow_to_window(
    window: &tauri::WebviewWindow,
    id: u64,
    name: &str,
    workflow: &serde_json::Value,
) -> Result<tokio::sync::oneshot::Receiver<Result<(), String>>, String> {
    let receiver = register_load(id);
    let payload = serde_json::json!({ "id": id, "name": name, "workflow": workflow });
    let script = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    // 页面正在跳转时控制器可能还没挂上，这种情况给用户一句能照着做的话，
    // 而不是把 JS 内部的 TypeError 甩到界面上。
    let js = format!(
        "(() => {{ const payload = {script}; const ctrl = window.__seekxWorkflow; \
           if (ctrl && typeof ctrl.load === 'function') {{ \
             try {{ ctrl.load(payload); return; }} catch (error) {{ \
               location.href = 'suxing-workflow://failed?id=' + payload.id + '&message=' \
                 + encodeURIComponent(String((error && error.message) || error)); \
               return; \
             }} \
           }} \
           location.href = 'suxing-workflow://failed?id=' + payload.id + '&message=' \
             + encodeURIComponent('ComfyUI 页面还没准备好，请再点一次'); \
         }})();"
    );
    if let Err(e) = window.eval(&js) {
        clear_load(id);
        return Err(e.to_string());
    }
    Ok(receiver)
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
    let key = workflow_window_key(&target);
    // 先复用同地址的窗口：第二个工作流应该变成窗口里的新标签，不是第二个窗口。
    if let Some(window) = reusable_window(&app, &key) {
        let id = next_load_id();
        let label = window.label().to_string();
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        match push_workflow_to_window(&window, id, &name, &workflow) {
            Ok(receiver) => return await_load(id, receiver, 60).await,
            Err(e) => {
                log::warn!("[comfyui] reuse {label} failed ({e}); opening a new window");
                lock(workflow_windows()).remove(&key);
            }
        }
    }
    open_workflow_window(app, target, key, name, workflow).await
}

/// 首次打开：建窗口 + 默认最大化 + 等首次装载回执。
async fn open_workflow_window(
    app: tauri::AppHandle,
    target: tauri::Url,
    key: String,
    name: String,
    workflow: serde_json::Value,
) -> Result<(), String> {
    let id = next_load_id();
    let receiver = register_load(id);
    let request = serde_json::json!({ "id": id, "origin": target.origin().ascii_serialization(), "base": target.as_str(), "name": name, "workflow": workflow });
    // 面板宿主 + 工作流桥共用同一个 request 作用域；面板必须在前。
    let script = format!("(() => {{ const request = {}; {PANEL_JS} {BRIDGE_JS} }})();", request);
    let label = format!("comfy-workflow-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let opener = target.clone();
    let panel_label = label.clone();
    // 拖放和剪贴板必须交回网页本身，否则 ComfyUI 里「把图拖进 Load Image 节点」和
    // Ctrl+V 贴图都没反应：Tauri 默认给每个 webview 装 drag-drop handler，文件 drop 只会
    // 变成 Rust 事件，页面拿不到 File；WebView2 默认也不批准 PermissionRequested(CLIPBOARD_READ)，
    // navigator.clipboard.read() 直接失败。两个 flag 只在 ComfyUI 窗口上设置，
    // 主窗口的导入拖拽要用 Tauri 事件，保持默认。
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(target))
        .title(workflow_window_title(&name))
        .theme(Some(tauri::Theme::Dark))
        .visible(false)
        // 画布工作流是「看着大图摆节点」的东西，小窗打开每次都要手动最大化，
        // 所以默认就铺满工作区。
        .maximized(true)
        .disable_drag_drop_handler()
        .enable_clipboard_access()
        .inner_size(1280.0, 900.0)
        .initialization_script(&script)
        .on_new_window(new_window_policy(app.clone(), opener, Some(panel_label)))
        .on_navigation(move |location| match parse_ping(location) {
            Some((ping_id, result)) => {
                resolve_load(ping_id, result);
                false
            }
            None => true,
        })
        .build().map_err(|e| { clear_load(id); e.to_string() })?;
    crate::window_style::apply(&window);
    window.show().map_err(|e| e.to_string())?;
    remember_window(&app, &key, &window);
    await_load(id, receiver, 90).await
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
    fn one_window_per_comfyui_service_keyed_by_origin() {
        assert_eq!(workflow_window_key(&url("http://127.0.0.1:8188/?t=1")), "http://127.0.0.1:8188");
        assert_eq!(workflow_window_key(&url("http://127.0.0.1:8188/loras")), "http://127.0.0.1:8188");
        // 端口不同就是另一台 ComfyUI，该各开一个窗口
        assert_ne!(workflow_window_key(&url("http://127.0.0.1:8188/")), workflow_window_key(&url("http://127.0.0.1:8189/")));
    }

    #[test]
    fn ping_carries_the_request_id() {
        let loaded = parse_ping(&url("suxing-workflow://loaded?id=7")).unwrap();
        assert_eq!(loaded.0, 7);
        assert!(loaded.1.is_ok());

        let failed = parse_ping(&url("suxing-workflow://failed?id=9&message=%E7%BC%BA%E8%8A%82%E7%82%B9")).unwrap();
        assert_eq!(failed.0, 9);
        assert_eq!(failed.1.unwrap_err(), "缺节点");

        // 老格式（没有 id）仍然算首次装载的回执
        let legacy = parse_ping(&url("suxing-workflow://loaded")).unwrap();
        assert_eq!(legacy.0, 0);
        assert!(legacy.1.is_ok());
    }

    #[test]
    fn ordinary_navigation_is_left_alone() {
        assert!(parse_ping(&url("http://127.0.0.1:8188/loras")).is_none());
    }

    #[test]
    fn every_load_gets_its_own_id() {
        let first = next_load_id();
        let second = next_load_id();
        assert_ne!(first, second);
        let (id, result) = parse_ping(&url(&format!("suxing-workflow://failed?id={second}&message=x"))).unwrap();
        assert_eq!(id, second);
        assert_eq!(result.unwrap_err(), "x");
    }

    #[test]
    fn external_opener_denies_non_http_but_still_uses_browser_for_links() {
        let opener = url("http://tauri.localhost/index.html");
        assert_eq!(popup_target(&opener, &url("http://127.0.0.1:8188/"), false), PopupTarget::ExternalBrowser);
        assert_eq!(popup_target(&opener, &url("mailto:me@example.com"), false), PopupTarget::Deny);
    }

    #[test]
    fn open_command_of_fills_the_registered_placeholder() {
        // Edge 与 Chrome 各自那两种写法（占位符裸着写 / 整段带引号），加上老 handler 的 %l
        let edge = open_command_of(
            r#""C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --single-argument %1"#,
            "https://example.com/a?b=1",
        )
        .expect("Edge 那条要认得");
        assert_eq!(edge.0, r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe");
        assert_eq!(edge.1, vec!["--single-argument", "https://example.com/a?b=1"]);

        let chrome = open_command_of(r#""C:\Program Files\Google\Chrome\Application\chrome.exe" "%1""#, "https://example.com/")
            .expect("Chrome 那条要认得");
        assert_eq!(chrome.1, vec!["https://example.com/"]);

        let legacy = open_command_of(r#""C:\Old Browser\browser.exe" -u %l"#, "http://example.com/").unwrap();
        assert_eq!(legacy.1, vec!["-u", "http://example.com/"]);

        // 没有占位符：地址追加成最后一个参数，别把它丢了（丢了就是「打开一个空白浏览器窗口」）
        let bare = open_command_of(r#""C:\Firefox\firefox.exe""#, "https://example.com/x").unwrap();
        assert_eq!(bare.1, vec!["https://example.com/x"]);

        // 空格切不进路径：带空格的可执行文件必须是一整段
        assert_eq!(split_command_line(r#""C:\A B\x.exe" -flag"#), vec![r"C:\A B\x.exe", "-flag"]);

        // 空命令行认不出程序：返回 None，交回给调用方去走备胎，不要 spawn 一个空字符串
        assert!(open_command_of("   ", "https://example.com/").is_none());
    }

    #[test]
    #[ignore = "读这台机器的真注册表，换一台机器结果不一样；排查外链打不开时手动跑"]
    fn reads_this_machines_url_association() {
        // 只读注册表，不拿它去起浏览器（起起来会真弹一个窗口）。
        // 「点了没反应」先跑这条：读得到地址，起不来才是 spawn 的事；读不到就是关联本身没认出来。
        let (exe, args) = browser_open_command("https", "https://example.com/")
            .expect("这台机器上 https 关联应该读得出命令行");
        assert!(
            exe.to_ascii_lowercase().ends_with(".exe"),
            "程序该是个可执行文件，实际读到：{exe}"
        );
        assert_eq!(
            args.last().map(|one| one.as_str()),
            Some("https://example.com/"),
            "地址要原样落在参数里，参数：{args:?}"
        );
    }

    #[test]
    fn bridge_fits_the_loaded_graph_into_the_viewport() {
        // 载入完要把图缩放到窗口正中：优先走 ComfyUI 自己的命令，后面几条是版本兜底
        assert!(BRIDGE_JS.contains("Comfy.Canvas.FitView"));
        assert!(BRIDGE_JS.contains("commandManager"));
        assert!(BRIDGE_JS.contains("zoomToFit"));
        assert!(BRIDGE_JS.contains("centerOnView"));
        // 只在载入后自动 fit；用户一动手就不再抢视角
        assert!(BRIDGE_JS.contains("pointerdown"));
        // 兜底靠模拟「.」快捷键，绑定目标必须是画布容器
        assert!(BRIDGE_JS.contains("graph-canvas-container"));
        assert!(BRIDGE_JS.contains("app.canvasContainer"));
        // 改窗口大小 / 折叠侧栏同样要重新适应视图（防抖后补一次 fit）
        assert!(BRIDGE_JS.contains("addEventListener('resize'"));
        assert!(BRIDGE_JS.contains("ResizeObserver"));
        assert!(BRIDGE_JS.contains("watchViewport()"));
        let load_at = BRIDGE_JS.find("if (!(await load()))").expect("load step");
        let fit_at = BRIDGE_JS.find("const fitOnce").expect("fit helper");
        let loaded_at = BRIDGE_JS.find("suxing-workflow://loaded").expect("loaded ping");
        let auto_at = BRIDGE_JS.find("autoFit()").expect("autoFit call");
        assert!(load_at < fit_at, "fit helper must be defined after the load step");
        assert!(loaded_at < auto_at, "fit must run after the loaded ping");
    }

    #[test]
    fn panel_script_keeps_the_sidebar_labels() {
        // ComfyUI 的侧栏尺寸默认值按窗口宽度算（<1536 就 small，small 连标签都不渲染）。
        // 应用内窗口够不到那个宽度，必须补一次 normal，且不能覆盖用户自己的选择。
        assert!(PANEL_JS.contains("Comfy.Sidebar.Size"));
        assert!(PANEL_JS.contains("/api/settings"));
        assert!(PANEL_JS.contains("settingsValues"));
        assert!(PANEL_JS.contains("setSettingValueAsync"));
        assert!(PANEL_JS.contains("\"normal\""));
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
    fn bridge_only_takes_over_the_canvas_document() {
        // 插件页面（/loras 等）与画布同源：认不出画布 app 就不能 import scripts/app.js，
        // 否则会把插件的初始化链一起带坏（LoRA 管理器点了没反应）
        assert!(BRIDGE_JS.contains("pagePath === canvasPath"));
        assert!(BRIDGE_JS.contains("canvasDoc || !!liveApp()"));
        assert!(BRIDGE_JS.contains("if (!app && canvasDoc && document.readyState === 'complete')"));
        // 画布文档的 URL 会被 ComfyUI 的路由改掉（/workflows/xxx），不能只按路径判断，
        // 否则会去导航一个正常画布 = 浏览器弹「是否离开网站？」
        assert!(BRIDGE_JS.contains("typeof app.loadGraphData === 'function' ? app : null"));
        assert!(!PANEL_JS.contains("loadGraphData"));
        // 页面模式的返回靠这两个键，键名撞车会让返回地址被深度值覆盖
        assert!(PANEL_JS.contains("RETURN_KEY = \"SeekX.PanelReturn\""));
        assert!(PANEL_JS.contains("DEPTH_KEY = \"SeekX.PanelDepth\""));
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

    #[test]
    fn comfyui_windows_hand_drops_and_clipboard_to_the_page() {
        // 这两个 webview flag 只在运行时生效，单元测试跑不出来，所以监住源码：
        // 工作流窗口和弹窗窗口都必须同时关掉 Tauri 拖拽、打开剪贴板读取。
        // 按行数，别按字节串找：Windows 上 core.autocrlf=true，工作区是 CRLF，
        // 写死 "\n        .xxx()\n" 这种模式一个都匹配不上（仓库在 LF 下提交，工作区是 CRLF）。
        let source = include_str!("comfyui.rs");
        let count_calls = |needle: &str| {
            source.lines().filter(|line| line.trim() == needle).count()
        };
        let drops = count_calls(".disable_drag_drop_handler()");
        let clipboard = count_calls(".enable_clipboard_access()");
        assert_eq!(drops, 2, "ComfyUI 窗口丢了 disable_drag_drop_handler");
        assert_eq!(clipboard, 2, "ComfyUI 窗口丢了 enable_clipboard_access");
    }

    #[test]
    fn bridge_loads_every_requested_workflow_in_one_window() {
        // 一台 ComfyUI 一个窗口：桌面壳复用窗口，桥接把每个请求变成窗口里的一个标签。
        assert!(BRIDGE_JS.contains(r#"window.__seekxWorkflow = { load: (payload) => deliver(payload) };"#));
        // 标签名用媒体名，用户才能在标签条上认出是哪张图；全空才退回 ComfyUI
        assert!(BRIDGE_JS.contains("const FALLBACK_TAB = 'ComfyUI';"));
        assert!(BRIDGE_JS.contains("const tabFileName = (raw) => {"));
        // 回话必须带请求 id，否则复用窗口时桌面壳分不清是哪一次装载的回执
        assert!(BRIDGE_JS.contains("'suxing-workflow://loaded?id=' + id"));
        assert!(BRIDGE_JS.contains("'suxing-workflow://failed?id=' + id"));
        // 停在插件页（/loras）时不能碰 app.js：存一份待载请求，跳回画布再装
        assert!(BRIDGE_JS.contains("const PENDING_KEY = 'SeekX.Request';"));
        assert!(BRIDGE_JS.contains("write(session, PENDING_KEY, JSON.stringify(task))"));
        // 每次导航都会重跑注入脚本，当前工作流以 SeekX.Active 为准，别把第一个糊回去
        assert!(BRIDGE_JS.contains("const ACTIVE_KEY = 'SeekX.Active';"));
        assert!(BRIDGE_JS.contains("readJson(session, ACTIVE_KEY) || request"));
        // 控制器不在位时要有中文提示，不能把 JS 报错甩给用户
        let source = include_str!("comfyui.rs");
        assert!(source.contains("ComfyUI 页面还没准备好，请再点一次"));
    }

    #[test]
    fn workflow_tab_never_waits_for_a_restored_tab() {
        // 「工作流不见了」的成因：桥接把「已有活动工作流标签」当成前提，
        // 而 ComfyUI 的标签恢复一旦被我们留下的野路径带坏就永远等不到标签。
        // 现在只等画布可用，标签我们自己开，同名复用。
        assert!(BRIDGE_JS.contains("const FALLBACK_TAB = 'ComfyUI';"));
        assert!(BRIDGE_JS.contains("const existing = (store.openWorkflows || []).find("));
        assert!(BRIDGE_JS.contains("if (app.canvas && app.graph && !app.configuringGraph) break;"));
        assert!(BRIDGE_JS.contains("createNewTemporary"));
        assert!(BRIDGE_JS.contains("const tab = existing || store.createNewTemporary(fileName);"));
        // 不再改 ComfyUI 的标签持久化键，除了「有记录却一个标签都没恢复出来」时的自愈
        assert!(!BRIDGE_JS.contains("localStorage.setItem"));
        let source = include_str!("comfyui.rs");
        // 注入脚本只剩 panel + bridge 两段：会改写 ComfyUI 标签持久化的清理脚本删掉了，别再加回来
        assert_eq!(source.matches("include_str!(\"comfyui_").count(), 2, "注入脚本数量变了，检查是否又把标签清理塞回去");
        assert!(source.contains("{PANEL_JS} {BRIDGE_JS}"));
    }
}
