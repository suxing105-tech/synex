// Sidecar 生命周期管理
//
// 流程：
//   1. Rust 主进程从 `binaries/python-backend-*.exe` 找到 sidecar exe
//   2. spawn 子进程，注入 SUXING_PORT / SUXING_DATA_DIR / SUXING_PARENT_PID
//   3. 监听 stdout，匹配首行 `READY {...}` 后 emit `sidecar-ready`
//   4. 监听 stderr，每行转发到 log::warn!
//   5. 退出码 !=0 时 emit `sidecar-died`
//   6. 关窗口时 kill 子进程

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// Sidecar 启动配置
#[derive(Debug, Clone)]
pub struct SidecarConfig {
    pub exe_path: PathBuf,
    pub port: u16,
    pub data_dir: PathBuf,
}

impl SidecarConfig {
    /// 从 Tauri AppHandle 推导配置
    pub fn from_app(app: &AppHandle) -> Result<Self, String> {
        // 1. exe 路径：
        //    dev 走 <CARGO_MANIFEST_DIR>/binaries/python-backend-<triple>.exe
        //    prod 走 main exe 同目录的 python-backend.exe（Tauri 2 NSIS bundler
        //    把 externalBin 去 triple 后缀放到 install root；fallback 到
        //    resource_dir/binaries/python-backend.exe 兼容其他 bundle 形式）
        let target_triple = current_target_triple();
        let exe_path = if cfg!(debug_assertions) {
            let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            manifest_dir
                .join("binaries")
                .join(format!("python-backend-{target_triple}.exe"))
        } else {
            let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
            let install_dir = exe
                .parent()
                .ok_or_else(|| "current_exe has no parent dir".to_string())?;
            let next_to_main = install_dir.join("python-backend.exe");
            if next_to_main.exists() {
                next_to_main
            } else {
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .map_err(|e| format!("resolve resource_dir: {e}"))?;
                let in_resource_binaries = resource_dir.join("binaries").join("python-backend.exe");
                if in_resource_binaries.exists() {
                    in_resource_binaries
                } else {
                    resource_dir.join("python-backend.exe")
                }
            }
        };

        // 2. 端口：写死 8765（与前端 vite proxy / FastAPI 一致）
        // P1 优化：Rust 选空闲端口，通过 READY 消息告诉前端
        let port: u16 = 8765;

        // 3. 数据目录：dev 走 <project>/backend/data/，prod 走 app_data_dir()（基于 identifier com.suxing.gallery）\data\
        let data_dir = if cfg!(debug_assertions) {
            let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            manifest_dir
                .ancestors()
                .nth(2) // src-tauri -> frontend -> repo root
                .unwrap()
                .join("backend")
                .join("data")
        } else {
            app.path()
                .app_data_dir()
                .map_err(|e| format!("resolve app_data_dir: {e}"))?
                .join("data")
        };

        Ok(Self {
            exe_path,
            port,
            data_dir,
        })
    }
}

fn current_target_triple() -> &'static str {
    "x86_64-pc-windows-msvc"
}

#[derive(Debug, Serialize, Clone)]
pub struct SidecarStatus {
    pub ready: bool,
    pub port: u16,
    pub data_dir: String,
    pub pid: Option<u32>,
    pub last_error: Option<String>,
}

/// 共享状态：前端通过 invoke('get_sidecar_status') 读
pub struct SidecarState {
    pub cfg: SidecarConfig,
    token: String,
    epoch: AtomicU64,
    child: Mutex<Option<Child>>,
    ready: AtomicBool,
    last_error: Mutex<Option<String>>,
}

impl SidecarState {
    pub fn new(cfg: SidecarConfig) -> Self {
        Self {
            cfg,
            token: uuid::Uuid::new_v4().to_string(),
            epoch: AtomicU64::new(0),
            child: Mutex::new(None),
            ready: AtomicBool::new(false),
            last_error: Mutex::new(None),
        }
    }

    pub fn status(&self) -> SidecarStatus {
        let pid = self
            .child
            .lock()
            .ok()
            .and_then(|g| g.as_ref().and_then(|c| c.id().map(|p| p as u32)));
        SidecarStatus {
            ready: self.ready.load(Ordering::SeqCst),
            port: self.cfg.port,
            data_dir: self.cfg.data_dir.display().to_string(),
            pid,
            last_error: self.last_error.lock().ok().and_then(|g| g.clone()),
        }
    }

    pub fn mark_ready(&self) {
        if let Ok(mut g) = self.last_error.lock() {
            *g = None;
        }
        self.ready.store(true, Ordering::SeqCst);
    }

    pub fn set_error(&self, msg: String) {
        self.ready.store(false, Ordering::SeqCst);
        if let Ok(mut g) = self.last_error.lock() {
            *g = Some(msg);
        }
    }

    pub fn kill(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.ready.store(false, Ordering::SeqCst);
        if let Ok(mut g) = self.child.lock() {
            if let Some(mut c) = g.take() {
                let _ = c.start_kill();
            }
        }
    }
    pub async fn control(&self, action: &str) -> Result<serde_json::Value, String> {
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|e| e.to_string())?
            .post(format!(
                "http://127.0.0.1:{}/api/desktop/{action}",
                self.cfg.port
            ))
            .header("x-suxing-control", &self.token)
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| format!("无法联系图库后台：{e}"))?;
        let status = response.status();
        let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(body["detail"].as_str().unwrap_or("后台更新准备失败").into());
        }
        Ok(body)
    }

    pub async fn stop_for_update(&self) -> Result<(), String> {
        self.control("shutdown").await?;
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.ready.store(false, Ordering::SeqCst);
        for _ in 0..150 {
            let done = {
                let mut guard = self.child.lock().unwrap();
                match guard.as_mut() {
                    Some(child) => child.try_wait().map_err(|e| e.to_string())?.is_some(),
                    None => true,
                }
            };
            if done && check_port(self.cfg.port).is_ok() {
                self.child.lock().unwrap().take();
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        Err("后台尚未完全退出，已取消安装。请关闭图库后重试。".into())
    }
}

#[derive(Debug, Error)]
pub enum SidecarError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("not ready within {0}s")]
    Timeout(u64),
    #[error("exe not found at {0}")]
    ExeNotFound(PathBuf),
    #[error("{0}")]
    Startup(String),
}

fn check_port(port: u16) -> Result<(), SidecarError> {
    std::net::TcpListener::bind(("127.0.0.1", port))
        .map(|listener| drop(listener))
        .map_err(|e| {
            SidecarError::Startup(format!(
                "无法使用本地端口 {port}，请关闭其他图库窗口或占用该端口的程序后重试：{e}"
            ))
        })
}

/// spawn sidecar，等待 READY（或超时）
pub async fn spawn(app: AppHandle, state: Arc<SidecarState>) -> Result<(), SidecarError> {
    let epoch = state.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    *state.last_error.lock().unwrap() = None;
    let cfg = state.cfg.clone();
    // PyInstaller's parent watcher may need a moment to release the prior socket.
    for _ in 0..30 {
        if check_port(cfg.port).is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    if let Err(e) = check_port(cfg.port) {
        state.set_error(e.to_string());
        return Err(e);
    }

    if !cfg.exe_path.exists() {
        let _msg = format!(
            "sidecar exe not found: {}\n请先在 frontend 目录执行 scripts\\build-sidecar.ps1 构建 sidecar。",
            cfg.exe_path.display()
        );
        state.set_error(format!("sidecar exe not found: {}", cfg.exe_path.display()));
        return Err(SidecarError::ExeNotFound(cfg.exe_path.clone()));
    }

    if let Err(e) = std::fs::create_dir_all(&cfg.data_dir) {
        state.set_error(format!("create data_dir {}: {e}", cfg.data_dir.display()));
        return Err(SidecarError::Io(e));
    }

    log::info!(
        "[sidecar] spawning exe={} port={} data_dir={}",
        cfg.exe_path.display(),
        cfg.port,
        cfg.data_dir.display(),
    );

    let mut cmd = Command::new(&cfg.exe_path);
    cmd.env("SUXING_PORT", cfg.port.to_string())
        .env("SUXING_DATA_DIR", &cfg.data_dir)
        .env("SUXING_PARENT_PID", std::process::id().to_string())
        .env("SUXING_CONTROL_TOKEN", &state.token)
        .env("SUXING_FRONTEND_ORIGIN", "tauri")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true);

    // 隐藏 PyInstaller 控制台窗口（spec 仍 console=True 以保留 stdout pipe）
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn()?;
    let pid = child.id();
    log::info!("[sidecar] child pid={:?}", pid);

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    {
        let mut g = state.child.lock().expect("child lock");
        *g = Some(child);
    }

    // task A：stdout，匹配 READY
    let app_a = app.clone();
    let state_a = state.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if state_a.epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            log::info!("[sidecar:stdout] {line}");
            if let Some(rest) = line.strip_prefix("READY ") {
                match serde_json::from_str::<serde_json::Value>(rest) {
                    Ok(v) => {
                        if v["version"].as_str() != Some(env!("CARGO_PKG_VERSION"))
                            || v["protocol"].as_u64() != Some(1)
                        {
                            state_a
                                .set_error("图库与后台版本不一致，请使用完整安装包重新安装".into());
                            return;
                        }
                        log::info!("[sidecar] READY payload={v}");
                        state_a.mark_ready();
                        let _ = app_a.emit("sidecar-ready", v);
                    }
                    Err(e) => {
                        log::warn!("[sidecar] READY parse failed: {e} raw={rest}");
                    }
                }
            }
        }
        log::warn!("[sidecar] stdout EOF");
    });

    // task B：stderr，全部 warn
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let tail_writer = stderr_tail.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log::warn!("[sidecar:stderr] {line}");
            if let Ok(mut tail) = tail_writer.lock() {
                *tail = line;
            }
        }
        log::warn!("[sidecar] stderr EOF");
    });

    // 进程提前退出时立即报告，并在 READY 后继续监控崩溃。
    let monitor_state = state.clone();
    let monitor_app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if monitor_state.epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            let exited = {
                let mut guard = monitor_state.child.lock().expect("child lock");
                match guard.as_mut() {
                    Some(child) => child.try_wait(),
                    None => return,
                }
            };
            let reason = match exited {
                Ok(Some(code)) => Some(format!(
                    "后端进程已退出（{code}）：{}",
                    stderr_tail.lock().unwrap()
                )),
                Err(e) => Some(format!("无法读取后端进程状态：{e}")),
                Ok(None) => None,
            };
            if let Some(reason) = reason {
                monitor_state.set_error(reason.clone());
                emit_died(&monitor_app, &reason);
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    });

    // 主动等 READY（带超时）
    let timeout_secs = 30u64;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < deadline {
        if let Some(reason) = state.status().last_error {
            return Err(SidecarError::Startup(reason));
        }
        if state.ready.load(Ordering::SeqCst) {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    state.kill();
    let error = SidecarError::Timeout(timeout_secs);
    state.set_error(error.to_string());
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn occupied_port_reports_conflict_without_waiting() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let error = check_port(listener.local_addr().unwrap().port()).unwrap_err();
        assert!(error.to_string().contains("端口"));
    }

    #[test]
    fn failure_and_shutdown_clear_ready_state() {
        let state = SidecarState::new(SidecarConfig {
            exe_path: PathBuf::new(),
            port: 8765,
            data_dir: PathBuf::new(),
        });
        state.mark_ready();
        state.set_error("exited".into());
        assert!(!state.status().ready);
        assert_eq!(state.status().last_error.as_deref(), Some("exited"));
        state.mark_ready();
        assert!(state.status().last_error.is_none());
        state.kill();
        assert!(!state.status().ready);
    }
}

/// 向前端发 died 事件
pub fn emit_died(app: &AppHandle, reason: &str) {
    let _ = app.emit("sidecar-died", serde_json::json!({ "reason": reason }));
}
