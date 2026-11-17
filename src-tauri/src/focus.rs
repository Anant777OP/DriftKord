//! Game & Focus Ducking Telemetry.
//!
//! Polls (1 Hz, negligible CPU):
//!  * `SHQueryUserNotificationState` – exclusive D3D full-screen games, presentation mode, busy apps
//!  * borderless-fullscreen detection – foreground window covering its whole monitor
//!  * microphone in use (voice/video call) – Windows privacy "CapabilityAccessManager" consent store
//! and smoothly ducks the engine while emitting `focus-state` so the UI can switch to the HUD.

use crate::audio::Engine;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FocusConfig {
    pub enabled: bool,
    pub game_duck: f32,
    pub call_duck: f32,
    pub auto_hud: bool,
}

impl Default for FocusConfig {
    fn default() -> Self {
        Self { enabled: true, game_duck: 0.45, call_duck: 0.12, auto_hud: true }
    }
}

#[derive(Clone, Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FocusState {
    pub game: bool,
    pub fullscreen_app: String,
    pub call: bool,
    pub call_app: String,
    pub duck: f32,
}

pub struct FocusMonitor {
    pub config: Mutex<FocusConfig>,
    pub state: Mutex<FocusState>,
}

impl FocusMonitor {
    pub fn start(app: AppHandle, engine: Arc<Engine>) -> Arc<Self> {
        let me = Arc::new(Self { config: Mutex::new(FocusConfig::default()), state: Mutex::new(FocusState::default()) });
        let m = me.clone();
        std::thread::Builder::new()
            .name("focus-monitor".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_millis(1000));
                let cfg = m.config.lock().clone();
                let (game, fs_app) = if cfg.enabled { detect_fullscreen() } else { (false, String::new()) };
                let (call, call_app) = if cfg.enabled { detect_mic_in_use() } else { (false, String::new()) };
                let duck = if call {
                    cfg.call_duck
                } else if game {
                    cfg.game_duck
                } else {
                    1.0
                };
                engine.set_duck(duck);
                let st = FocusState { game, fullscreen_app: fs_app, call, call_app, duck };
                let changed = *m.state.lock() != st;
                if changed {
                    *m.state.lock() = st.clone();
                    // Low-CPU mode while gaming: 10 fps visual frames.
                    engine.set_frame_rate(if game || call { 10 } else { 60 });
                    let _ = app.emit("focus-state", st);
                }
            })
            .expect("spawn focus thread");
        me
    }
}

fn own_pid() -> u32 {
    std::process::id()
}

/// Returns (is_fullscreen_game_or_app, exe name)
fn detect_fullscreen() -> (bool, String) {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
    };
    unsafe {
        let state = SHQueryUserNotificationState().unwrap_or_default();
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() {
            return (false, String::new());
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == own_pid() {
            return (false, String::new());
        }
        let name = process_name(pid);
        if state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE {
            return (true, name);
        }
        // Borderless full-screen: window rect == monitor rect, not the desktop/shell.
        let mut cls = [0u16; 128];
        let n = GetClassNameW(hwnd, &mut cls);
        let class = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
        if ["Progman", "WorkerW", "Shell_TrayWnd", "Windows.UI.Core.CoreWindow"].contains(&class.as_str()) {
            return (false, String::new());
        }
        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_err() {
            return (false, String::new());
        }
        let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut mi).as_bool() {
            return (false, String::new());
        }
        let m = mi.rcMonitor;
        // Maximized normal windows also cover the monitor — only count caption-less, non-maximized
        // windows (how borderless-fullscreen games present themselves).
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, IsZoomed, GWL_STYLE, WS_CAPTION};
        if IsZoomed(hwnd).as_bool() || (GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_CAPTION.0) == WS_CAPTION.0 {
            return (false, String::new());
        }
        let covers = r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom;
        // Browsers/video players in full screen count too only when the shell says "busy".
        let browserish = ["chrome.exe", "msedge.exe", "firefox.exe", "explorer.exe", "vlc.exe"]
            .contains(&name.to_lowercase().as_str());
        if covers && (!browserish || state == QUNS_BUSY) {
            return (true, name);
        }
        (false, String::new())
    }
}

fn process_name(pid: u32) -> String {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return String::new();
        }
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        full.rsplit('\\').next().unwrap_or("").to_string()
    }
}

/// Any app currently holding the microphone (LastUsedTimeStop == 0) → probably a call.
fn detect_mic_in_use() -> (bool, String) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let base = "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
    let Ok(root) = hkcu.open_subkey(base) else { return (false, String::new()) };
    let check = |k: &RegKey| -> bool {
        let start: u64 = k.get_value("LastUsedTimeStart").unwrap_or(0);
        let stop: u64 = k.get_value("LastUsedTimeStop").unwrap_or(1);
        start > 0 && stop == 0
    };
    let me = std::env::current_exe()
        .map(|p| p.to_string_lossy().replace('\\', "#").to_lowercase())
        .unwrap_or_default();
    for name in root.enum_keys().filter_map(Result::ok) {
        if name == "NonPackaged" {
            if let Ok(np) = root.open_subkey(&name) {
                for sub in np.enum_keys().filter_map(Result::ok) {
                    if sub.to_lowercase() == me {
                        continue;
                    }
                    if let Ok(k) = np.open_subkey(&sub) {
                        if check(&k) {
                            let exe = sub.rsplit('#').next().unwrap_or(&sub).to_string();
                            return (true, exe);
                        }
                    }
                }
            }
        } else if let Ok(k) = root.open_subkey(&name) {
            if check(&k) {
                let app = name.split('_').next().unwrap_or(&name).to_string();
                return (true, app);
            }
        }
    }
    (false, String::new())
}
