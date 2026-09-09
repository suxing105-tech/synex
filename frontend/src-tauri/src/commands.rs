// Tauri commands — 前端可通过 `invoke('xxx')` 调用

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::sidecar::{SidecarState, SidecarStatus};

#[tauri::command]
pub fn get_sidecar_status(state: State<'_, Arc<SidecarState>>) -> SidecarStatus {
    state.status()
}

/// Only restart this application's owned backend; never kill a port's unknown owner.
#[tauri::command]
pub async fn restart_sidecar(
    app: AppHandle,
    state: State<'_, Arc<SidecarState>>,
    updates: State<'_, crate::updates::Updates>,
) -> Result<SidecarStatus, String> {
    let _guard = updates
        .operation
        .try_lock()
        .map_err(|_| "更新正在进行，请稍后再试")?;
    state.kill();
    crate::sidecar::spawn(app, state.inner().clone())
        .await
        .map_err(|e| e.to_string())?;
    Ok(state.status())
}
