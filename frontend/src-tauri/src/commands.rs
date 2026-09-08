// Tauri commands — 前端可通过 `invoke('xxx')` 调用

use std::sync::Arc;

use tauri::State;

use crate::sidecar::{SidecarState, SidecarStatus};

#[tauri::command]
pub fn get_sidecar_status(state: State<'_, Arc<SidecarState>>) -> SidecarStatus {
    state.status()
}

/// 重启 sidecar（M0 暂不实现，TODO P1）
/// 当前为占位：先 kill 再 spawn。
#[tauri::command]
pub async fn restart_sidecar(
    state: State<'_, Arc<SidecarState>>,
) -> Result<SidecarStatus, String> {
    // TODO P1：清 state、子进程 kill 后重新 spawn
    // 这里先返回当前状态
    state.kill();
    Ok(state.status())
}
