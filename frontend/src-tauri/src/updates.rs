//! Only these application commands may install updates; plugin IPC stays disabled.
use crate::sidecar::{self, SidecarState};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub automatic: bool,
    /// 发现新版本后自动下载并安装（会关闭并重启图库）。默认关，必须由用户打开。
    /// 老版本偏好文件里没有这个键，靠 #[serde(default)] 读成 false。
    pub auto_update: bool,
    pub last_check: u64,
    pub last_attempt: u64,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            automatic: true,
            auto_update: false,
            last_check: 0,
            last_attempt: 0,
        }
    }
}
/// 上一次成功检查的结果。侧栏入口不该因为应用重启就消失，
/// 所以「有可用更新」要落盘：启动时先按缓存显示，再在后台补一次检查。
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct CachedCheck {
    current_version: String,
    phase: String,
    version: Option<String>,
    notes: String,
    checked_at: u64,
}
impl Default for CachedCheck {
    fn default() -> Self {
        Self {
            current_version: String::new(),
            phase: String::new(),
            version: None,
            notes: String::new(),
            checked_at: 0,
        }
    }
}
#[derive(Clone, Serialize)]
pub struct Status {
    pub current_version: String,
    pub configured: bool,
    pub installable: bool,
    pub phase: String,
    pub message: String,
    pub version: Option<String>,
    pub notes: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub automatic: bool,
    pub auto_update: bool,
    pub last_check: u64,
}
pub struct Updates {
    status: Mutex<Status>,
    preferences: Mutex<Preferences>,
    prefs_path: PathBuf,
    pub operation: tokio::sync::Mutex<()>,
    update: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
    install_dir: Option<PathBuf>,
    /// 本次启动是否已经成功检查过：没检查成之前，自动检查不受每日节流限制。
    checked_this_run: AtomicBool,
    /// 本次启动连续失败的检查次数：用来退避，避免断网时每分钟死磕更新服务器。
    failed_this_run: AtomicU32,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn https(value: &str) -> bool {
    value
        .parse::<reqwest::Url>()
        .map(|u| {
            u.scheme() == "https"
                && u.host_str().is_some()
                && u.username().is_empty()
                && u.password().is_none()
        })
        .unwrap_or(false)
}
fn configured(app: &AppHandle) -> bool {
    let Some(c) = app.config().plugins.0.get("updater") else {
        return false;
    };
    !c["pubkey"].as_str().unwrap_or("").trim().is_empty()
        && c["endpoints"]
            .as_array()
            .is_some_and(|a| !a.is_empty() && a.iter().all(|v| https(v.as_str().unwrap_or(""))))
}
fn installed_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use winreg::{enums::*, RegKey};
        let current = std::env::current_exe()
            .ok()?
            .parent()?
            .canonicalize()
            .ok()?;
        let mut found = Vec::new();
        for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
                if let Ok(key) = RegKey::predef(hive).open_subkey_with_flags(
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\闪寻空间",
                    KEY_READ | view,
                ) {
                    if let Ok(location) = key.get_value::<String, _>("InstallLocation") {
                        if let Ok(path) = PathBuf::from(location.trim_matches('"')).canonicalize() {
                            if !found.contains(&path) {
                                found.push(path);
                            }
                        }
                    }
                }
            }
        }
        if found.len() == 1 && found[0] == current && current.join("uninstall.exe").exists() {
            return Some(current);
        }
    }
    None
}
impl Updates {
    pub fn record_healthy_start(&self, app: &AppHandle) {
        let path = self.prefs_path.with_file_name("pending-update.json");
        let Some(mut record) = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        else {
            return;
        };
        if record["to"].as_str() == Some(self.snapshot().current_version.as_str())
            && record["completed_at"].is_null()
        {
            record["completed_at"] = now().into();
            if std::fs::write(&path, serde_json::to_vec_pretty(&record).unwrap()).is_ok() {
                let _ = std::fs::remove_file(self.cache_path());
                self.set(app, "idle", "更新完成，图库后台已正常启动");
            }
        }
    }
    pub fn installing(&self) -> bool {
        self.snapshot().phase == "installing"
    }
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let prefs_path = dir.join("update-preferences.json");
        let preferences: Preferences = std::fs::read(&prefs_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let enabled = configured(app);
        let install_dir = installed_directory();
        let current_version = app.package_info().version.to_string();
        // 缓存只在同一个应用版本下有效，升级完成后旧缓存自然失效。
        let cached = read_cache(&cache_path_of(&prefs_path)).filter(|c| {
            c.current_version == current_version && c.phase == "available" && c.version.is_some()
        });
        let restored = cached.is_some();
        Ok(Self {
            status: Mutex::new(Status {
                current_version,
                configured: enabled,
                installable: install_dir.is_some(),
                phase: if restored { "available".into() } else { "idle".into() },
                message: if !enabled {
                    "更新服务尚未启用".into()
                } else if restored {
                    "发现新版本，可下载后选择安装时间".into()
                } else {
                    "可检查新版本".into()
                },
                version: cached.as_ref().and_then(|c| c.version.clone()),
                notes: cached.as_ref().map(|c| c.notes.clone()).unwrap_or_default(),
                downloaded: 0,
                total: None,
                automatic: preferences.automatic,
                auto_update: preferences.auto_update,
                last_check: preferences.last_check,
            }),
            preferences: Mutex::new(preferences),
            prefs_path,
            operation: tokio::sync::Mutex::new(()),
            update: Mutex::new(None),
            bytes: Mutex::new(None),
            install_dir,
            checked_this_run: AtomicBool::new(false),
            failed_this_run: AtomicU32::new(0),
        })
    }
    fn snapshot(&self) -> Status {
        self.status.lock().unwrap().clone()
    }
    fn set(&self, app: &AppHandle, phase: &str, message: impl Into<String>) {
        let mut s = self.status.lock().unwrap();
        s.phase = phase.into();
        s.message = message.into();
        let _ = app.emit("update-status", s.clone());
    }
    fn cache_path(&self) -> PathBuf {
        cache_path_of(&self.prefs_path)
    }
    fn save_cache(&self, phase: &str) {
        let status = self.snapshot();
        let cache = CachedCheck {
            current_version: status.current_version.clone(),
            phase: phase.into(),
            version: status.version.clone(),
            notes: status.notes.clone(),
            checked_at: status.last_check,
        };
        if let Ok(bytes) = serde_json::to_vec_pretty(&cache) {
            let _ = std::fs::write(self.cache_path(), bytes);
        }
    }
    fn save(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&*self.preferences.lock().unwrap())
            .map_err(|e| e.to_string())?;
        std::fs::write(&self.prefs_path, bytes).map_err(|e| format!("无法保存更新设置：{e}"))
    }
}
fn cache_path_of(prefs_path: &PathBuf) -> PathBuf {
    prefs_path.with_file_name("update-cache.json")
}
fn read_cache(path: &PathBuf) -> Option<CachedCheck> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CachedCheck>(&bytes).ok())
}
/// 每日节流只限制「已经检查成功之后」的重复请求。
/// 本次启动还没检查成功过就放行，否则当天检查过一次、晚上才发布的新版本
/// 要等第二天才会出现在侧栏，用户只能去设置里手动点检查更新。
/// 还没成功之前允许快速重试，但连续失败 3 次后退避到 15 分钟，
/// 免得网络不通（GitHub 抽风、离线）时每分钟发一次请求打到超时。
fn due(p: &Preferences, time: u64, checked_this_run: bool, failures: u32) -> bool {
    if !p.automatic {
        return false;
    }
    if checked_this_run {
        return time.saturating_sub(p.last_check) >= 86400;
    }
    let retry_after = if failures >= 3 { 900 } else { 60 };
    time.saturating_sub(p.last_attempt) >= retry_after
}
#[tauri::command]
pub fn get_update_status(state: State<'_, Updates>) -> Status {
    state.snapshot()
}
#[tauri::command]
pub async fn set_update_automatic(
    app: AppHandle,
    state: State<'_, Updates>,
    enabled: bool,
) -> Result<Status, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "更新正在进行，请稍后再试")?;
    state.preferences.lock().unwrap().automatic = enabled;
    state.save()?;
    state.status.lock().unwrap().automatic = enabled;
    let _ = app.emit("update-status", state.snapshot());
    Ok(state.snapshot())
}
/// 自动更新开关。打开后，检查到新版本的下载与安装由前端 watcher 自动串起来
/// （复用手动更新那条已经跑过的 download_update → install_update 链路），
/// Rust 侧只负责把开关持久化并广播给界面。
#[tauri::command]
pub async fn set_update_auto_update(
    app: AppHandle,
    state: State<'_, Updates>,
    enabled: bool,
) -> Result<Status, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "更新正在进行，请稍后再试")?;
    state.preferences.lock().unwrap().auto_update = enabled;
    state.save()?;
    state.status.lock().unwrap().auto_update = enabled;
    let _ = app.emit("update-status", state.snapshot());
    Ok(state.snapshot())
}
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, Updates>,
    automatic: bool,
) -> Result<Status, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "更新正在进行，请稍后再试")?;
    if !state.snapshot().configured {
        return Ok(state.snapshot());
    }
    if automatic
        && (!due(
            &state.preferences.lock().unwrap(),
            now(),
            state.checked_this_run.load(Ordering::Relaxed),
            state.failed_this_run.load(Ordering::Relaxed),
        ) || state.update.lock().unwrap().is_some())
    {
        return Ok(state.snapshot());
    }
    state.preferences.lock().unwrap().last_attempt = now();
    state.save()?;
    state.set(&app, "checking", "正在检查新版本…");
    let result = fetch_update(&app, &state).await;
    match result {
        Ok(update) => {
            if let Some(u) = &update {
                if !https(u.download_url.as_str()) {
                    state.set(&app, "error", "更新包地址必须使用 HTTPS");
                    return Ok(state.snapshot());
                }
            }
            let checked = now();
            state.preferences.lock().unwrap().last_check = checked;
            state.save()?;
            {
                let mut s = state.status.lock().unwrap();
                s.last_check = checked;
                s.version = update.as_ref().map(|u| u.version.clone());
                s.notes = update
                    .as_ref()
                    .and_then(|u| u.body.clone())
                    .unwrap_or_default();
                s.downloaded = 0;
                s.total = None;
            }
            let found = update.is_some();
            *state.update.lock().unwrap() = update;
            *state.bytes.lock().unwrap() = None;
            state.set(
                &app,
                if found { "available" } else { "latest" },
                if found {
                    "发现新版本，可下载后选择安装时间"
                } else {
                    "当前已是最新版本"
                },
            );
            state.failed_this_run.store(0, Ordering::Relaxed);
            state.checked_this_run.store(true, Ordering::Relaxed);
            state.save_cache(if found { "available" } else { "latest" });
        }
        Err(e) => {
            state.failed_this_run.fetch_add(1, Ordering::Relaxed);
            state.set(
                &app,
                "error",
                format!("暂时无法检查更新，请稍后重试。首次发布前可能尚无更新信息。{e}"),
            );
        }
    }
    Ok(state.snapshot())
}
/// 拉取更新清单。检查与「点击更新时补检查」共用，避免两处逻辑漂移。
async fn fetch_update(app: &AppHandle, state: &Updates) -> Result<Option<Update>, String> {
    let mut builder = app
        .updater_builder()
        .on_before_exit(|| {})
        .configure_client(|client| client.https_only(true))
        .timeout(Duration::from_secs(25));
    if let Some(dir) = &state.install_dir {
        builder = builder.installer_arg(format!(
            "/D={}",
            dir.display().to_string().trim_start_matches(r"\\?\")
        ));
    }
    builder
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn download_update(app: AppHandle, state: State<'_, Updates>) -> Result<Status, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "更新正在进行，请稍后再试")?;
    if state.update.lock().unwrap().is_none() {
        if let Some(found) = fetch_update(&app, &state).await? {
            let checked = now();
            {
                let mut prefs = state.preferences.lock().unwrap();
                prefs.last_check = checked;
                prefs.last_attempt = checked;
            }
            let _ = state.save();
            {
                let mut s = state.status.lock().unwrap();
                s.last_check = checked;
                s.version = Some(found.version.clone());
                s.notes = found.body.clone().unwrap_or_default();
            }
            state.checked_this_run.store(true, Ordering::Relaxed);
            *state.update.lock().unwrap() = Some(found);
        } else {
            state.checked_this_run.store(true, Ordering::Relaxed);
            state.save_cache("latest");
            state.set(&app, "latest", "当前已是最新版本");
            return Err("没有可用的更新，请重新检查".into());
        }
    }
    let mut update = state.update.lock().unwrap().clone().ok_or("请先检查更新")?;
    update.timeout = Some(Duration::from_secs(1800));
    *state.bytes.lock().unwrap() = None;
    state.status.lock().unwrap().downloaded = 0;
    state.set(&app, "downloading", "正在下载并校验更新包…");
    let result = tokio::time::timeout(
        Duration::from_secs(1800),
        update.download(
            |size, total| {
                let mut s = state.status.lock().unwrap();
                s.downloaded += size as u64;
                s.total = total;
                let _ = app.emit("update-status", s.clone());
            },
            || {},
        ),
    )
    .await;
    match result {
        Ok(Ok(bytes)) => {
            *state.bytes.lock().unwrap() = Some(bytes);
            state.set(
                &app,
                "ready",
                "下载和签名校验完成。安装会备份图库数据并关闭应用。",
            );
        }
        Ok(Err(e)) => state.set(
            &app,
            "error",
            format!("下载或签名校验失败，未安装任何内容：{e}"),
        ),
        Err(_) => state.set(&app, "error", "下载超时，请重试"),
    }
    Ok(state.snapshot())
}
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, Updates>,
    backend: State<'_, Arc<SidecarState>>,
) -> Result<Status, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "更新正在进行，请稍后再试")?;
    if state.install_dir.is_none() || installed_directory() != state.install_dir {
        return Err("当前为便携版或存在多个安装位置，请使用安装包手动升级".into());
    }
    let update = state.update.lock().unwrap().clone().ok_or("请先下载更新")?;
    let bytes = state
        .bytes
        .lock()
        .unwrap()
        .take()
        .ok_or("请先下载并校验更新包")?;
    state.set(&app, "installing", "正在备份图库数据并准备安装，请稍候…");
    let mut stopped = false;
    let result: Result<(), String> = async {
        let prepared = backend.control("prepare-update").await?;
        let marker = serde_json::json!({"from":state.snapshot().current_version,"to":update.version,"backup":prepared["backup"],"time":now()});
        std::fs::write(state.prefs_path.with_file_name("pending-update.json"), serde_json::to_vec_pretty(&marker).unwrap()).map_err(|e| e.to_string())?;
        backend.stop_for_update().await?;
        stopped = true;
        update.install(&bytes).map_err(|e| e.to_string())
    }.await;
    if let Err(error) = result {
        let recovery = if stopped {
            sidecar::spawn(app.clone(), backend.inner().clone())
                .await
                .map_err(|e| e.to_string())
        } else {
            backend.control("cancel-update").await.map(|_| ())
        };
        *state.bytes.lock().unwrap() = Some(bytes);
        state.set(
            &app,
            "ready",
            format!(
                "安装未完成：{error}{}",
                recovery
                    .err()
                    .map(|e| format!("；后台恢复失败，请重启图库：{e}"))
                    .unwrap_or_default()
            ),
        );
    }
    Ok(state.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_insecure_or_invalid_urls() {
        assert!(https(
            "https://github.com/suxing105-tech/synex/releases/latest/download/latest.json"
        ));
        for url in [
            "http://example.org/a",
            "file:///tmp/a",
            "https://user:pass@example.org",
            "no-url",
        ] {
            assert!(!https(url));
        }
    }
    #[test]
    fn first_check_each_startup_ignores_the_daily_throttle() {
        let mut p = Preferences::default();
        p.last_check = 100000;
        p.last_attempt = 100000;
        // 当天检查过但本次启动还没成功检查：满 60 秒间隔就放行
        assert!(due(&p, 100060, false, 0));
        assert!(!due(&p, 100030, false, 0));
        // 本次已经检查成功，恢复每日一次
        assert!(!due(&p, 100060, true, 0));
        assert!(due(&p, 186400, true, 0));
        p.automatic = false;
        assert!(!due(&p, 999999, false, 0));
    }
    #[test]
    fn failed_startup_check_retries_in_a_minute_not_a_day() {
        let mut p = Preferences::default();
        p.last_check = 100000;
        p.last_attempt = 100000;
        assert!(!due(&p, 100060, true, 0));
        assert!(due(&p, 100060, false, 0));
    }
    #[test]
    fn repeated_failures_back_off_to_fifteen_minutes() {
        let mut p = Preferences::default();
        p.last_check = 100000;
        p.last_attempt = 100000;
        // 前 3 次失败：1 分钟就能重试
        assert!(due(&p, 100060, false, 2));
        // 连续失败 3 次以上：退避到 15 分钟，别在断网时每分钟死磕
        assert!(!due(&p, 100060, false, 3));
        assert!(!due(&p, 100859, false, 5));
        assert!(due(&p, 100900, false, 5));
    }
    #[test]
    fn future_clock_does_not_trigger_repeated_checks() {
        let p = Preferences {
            automatic: true,
            auto_update: false,
            last_check: 200000,
            last_attempt: 200000,
        };
        assert!(!due(&p, 100000, false, 0));
        assert!(!due(&p, 100000, true, 0));
    }
    #[test]
    fn auto_update_is_off_by_default_and_old_preference_files_still_load() {
        assert!(!Preferences::default().auto_update);
        // 0.2.23 及更早的 update-preferences.json 里没有 auto_update 这个键。
        let legacy = r#"{ "automatic": true, "last_check": 5, "last_attempt": 7 }"#;
        let parsed: Preferences = serde_json::from_str(legacy).unwrap();
        assert!(!parsed.auto_update);
        assert_eq!(parsed.last_check, 5);
    }
    #[test]
    fn cached_available_update_survives_restart_only_for_same_version() {
        let dir = std::env::temp_dir().join(format!("seekx-update-cache-{}-{}", now(), std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cache = cache_path_of(&dir.join("update-preferences.json"));
        let bytes = serde_json::to_vec(&CachedCheck {
            current_version: "0.2.14".into(),
            phase: "available".into(),
            version: Some("0.2.15".into()),
            notes: "说明".into(),
            checked_at: 123,
        })
        .unwrap();
        std::fs::write(&cache, &bytes).unwrap();
        let restored = read_cache(&cache).filter(|c| c.current_version == "0.2.14" && c.phase == "available");
        assert_eq!(
            restored.as_ref().and_then(|c| c.version.clone()).as_deref(),
            Some("0.2.15")
        );
        let after_upgrade = read_cache(&cache).filter(|c| c.current_version == "0.2.15" && c.phase == "available");
        assert!(after_upgrade.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
