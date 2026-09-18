/// Fix the native caption color independently of the Windows accent color.
#[cfg(windows)]
pub fn apply(window: &tauri::WebviewWindow) {
    use std::ffi::c_void;
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: *mut c_void, attribute: u32, value: *const c_void, size: u32) -> i32;
    }
    if let Ok(hwnd) = window.hwnd() {
        let caption: u32 = 0x00202020;
        let text: u32 = 0x00e8e8e8;
        // DWMWA_CAPTION_COLOR / DWMWA_TEXT_COLOR. Unsupported systems keep Dark theme.
        unsafe {
            DwmSetWindowAttribute(hwnd.0 as _, 35, &caption as *const _ as _, 4);
            DwmSetWindowAttribute(hwnd.0 as _, 36, &text as *const _ as _, 4);
        }
    }
}

#[cfg(not(windows))]
pub fn apply(_window: &tauri::WebviewWindow) {}
