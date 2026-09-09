//! Only these application commands may install updates; plugin IPC stays disabled.
use crate::sidecar::{self, SidecarState};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub automatic: bool,
    pub last_check: u64,
    pub last_attempt: u64,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            automatic: true,
            last_check: 0,
            last_attempt: 0,
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
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\苏醒图库",
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
        Ok(Self {
            status: Mutex::new(Status {
                current_version: app.package_info().version.to_string(),
                configured: enabled,
                installable: install_dir.is_some(),
                phase: "idle".into(),
                message: if enabled {
                    "可检查新版本"
                } else {
                    "更新服务尚未启用"
                }
                .into(),
                version: None,
                notes: String::new(),
                downloaded: 0,
                total: None,
                automatic: preferences.automatic,
                last_check: preferences.last_check,
            }),
            preferences: Mutex::new(preferences),
            prefs_path,
            operation: tokio::sync::Mutex::new(()),
            update: Mutex::new(None),
            bytes: Mutex::new(None),
            install_dir,
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
    fn save(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&*self.preferences.lock().unwrap())
            .map_err(|e| e.to_string())?;
        std::fs::write(&self.prefs_path, bytes).map_err(|e| format!("无法保存更新设置：{e}"))
    }
}
fn due(p: &Preferences, time: u64) -> bool {
    p.automatic
        && time.saturating_sub(p.last_check) >= 86400
        && time.saturating_sub(p.last_attempt) >= 900
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
        && (!due(&state.preferences.lock().unwrap(), now())
            || state.update.lock().unwrap().is_some())
    {
        return Ok(state.snapshot());
    }
    state.preferences.lock().unwrap().last_attempt = now();
    state.save()?;
    state.set(&app, "checking", "正在检查新版本…");
    let result = async {
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
    .await;
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
        }
        Err(e) => state.set(
            &app,
            "error",
            format!("暂时无法检查更新，请稍后重试。首次发布前可能尚无更新信息。{e}"),
        ),
    }
    Ok(state.snapshot())
}
#[tauri::command]
pub async fn download_update(app: AppHandle, state: State<'_, Updates>) -> Result<Status, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "更新正在进行，请稍后再试")?;
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
    fn checks_daily_and_retries_after_fifteen_minutes() {
        let mut p = Preferences::default();
        assert!(due(&p, 100000));
        p.last_attempt = 99999;
        assert!(!due(&p, 100000));
        assert!(due(&p, 100900));
        p.last_check = 100000;
        assert!(!due(&p, 100900));
        assert!(due(&p, 186400));
        p.automatic = false;
        assert!(!due(&p, 999999));
    }
    #[test]
    fn future_clock_does_not_trigger_repeated_checks() {
        let p = Preferences {
            automatic: true,
            last_check: 200000,
            last_attempt: 200000,
        };
        assert!(!due(&p, 100000));
    }
}
