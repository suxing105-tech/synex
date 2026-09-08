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
use std::sync::atomic::{AtomicBool, Ordering};
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
                let in_resource_binaries = resource_dir
                    .join("binaries")
                    .join("python-backend.exe");
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

        // 3. 数据目录：dev 走 <project>/backend/data/，prod 走 %APPDATA%\苏醒图库\data\
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

        Ok(Self { exe_path, port, data_dir })
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
#[derive(Debug)]
pub struct SidecarState {
    pub cfg: SidecarConfig,
    child: Mutex<Option<Child>>,
    ready: AtomicBool,
    last_error: Mutex<Option<String>>,
}

impl SidecarState {
    pub fn new(cfg: SidecarConfig) -> Self {
        Self {
            cfg,
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
        self.ready.store(true, Ordering::SeqCst);
    }

    pub fn set_error(&self, msg: String) {
        if let Ok(mut g) = self.last_error.lock() {
            *g = Some(msg);
        }
    }

    pub fn kill(&self) {
        if let Ok(mut g) = self.child.lock() {
            if let Some(mut c) = g.take() {
                let _ = c.start_kill();
            }
        }
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
}

/// spawn sidecar，等待 READY（或超时）
pub async fn spawn(app: AppHandle, state: Arc<SidecarState>) -> Result<(), SidecarError> {
    let cfg = state.cfg.clone();

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
        .env("SUXING_FRONTEND_ORIGIN", "tauri")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

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
            log::info!("[sidecar:stdout] {line}");
            if let Some(rest) = line.strip_prefix("READY ") {
                match serde_json::from_str::<serde_json::Value>(rest) {
                    Ok(v) => {
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
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log::warn!("[sidecar:stderr] {line}");
        }
        log::warn!("[sidecar] stderr EOF");
    });

    // 主动等 READY（带超时）
    let timeout_secs = 30u64;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < deadline {
        if state.ready.load(Ordering::SeqCst) {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    Err(SidecarError::Timeout(timeout_secs))
}

/// 向前端发 died 事件
pub fn emit_died(app: &AppHandle, reason: &str) {
    let _ = app.emit("sidecar-died", serde_json::json!({ "reason": reason }));
}
