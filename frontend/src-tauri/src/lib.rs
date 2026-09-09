// 苏醒图库 — Tauri run() 实现

use std::sync::Arc;

use tauri::Manager;

mod commands;
mod sidecar;

use sidecar::{SidecarConfig, SidecarState};

pub fn run() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let cfg = SidecarConfig::from_app(app.handle())?;
            let state = Arc::new(SidecarState::new(cfg.clone()));
            app.manage(state.clone());

            let handle = app.handle().clone();
            let state_for_task = state.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sidecar::spawn(handle.clone(), state_for_task.clone()).await {
                    state_for_task.set_error(e.to_string());
                    log::error!("[sidecar] spawn failed: {e}");
                    sidecar::emit_died(&handle, &format!("spawn failed: {e}"));
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_sidecar_status,
            commands::restart_sidecar,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.app_handle().try_state::<Arc<SidecarState>>() {
                    log::info!("[main] window close requested, killing sidecar");
                    state.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
