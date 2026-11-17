//! Windows System Media Transport Controls: media keys, the Win11 volume-flyout media card,
//! lock-screen controls. Button presses are forwarded to the UI as `media-key` events
//! (the unified queue lives in the frontend).

use base64::Engine as _;
use parking_lot::Mutex;
use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

struct Holder(MediaControls);
// SAFETY: SMTC objects are agile WinRT objects; access is serialised by the mutex.
unsafe impl Send for Holder {}

static CONTROLS: Mutex<Option<Holder>> = Mutex::new(None);

pub fn init(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let Ok(hwnd) = win.hwnd() else { return };
    let cfg = PlatformConfig {
        display_name: "DriftKord",
        dbus_name: "driftkord",
        hwnd: Some(hwnd.0 as *mut std::ffi::c_void),
    };
    let Ok(mut controls) = MediaControls::new(cfg) else { return };
    let a = app.clone();
    let _ = controls.attach(move |ev: MediaControlEvent| {
        let name = match ev {
            MediaControlEvent::Play => "play".to_string(),
            MediaControlEvent::Pause => "pause".to_string(),
            MediaControlEvent::Toggle => "toggle".to_string(),
            MediaControlEvent::Next => "next".to_string(),
            MediaControlEvent::Previous => "prev".to_string(),
            MediaControlEvent::Stop => "stop".to_string(),
            MediaControlEvent::SetPosition(MediaPosition(d)) => format!("seek:{}", d.as_secs_f64()),
            _ => return,
        };
        let _ = a.emit("media-key", name);
    });
    *CONTROLS.lock() = Some(Holder(controls));
}

pub fn update(
    title: &str,
    artist: &str,
    album: &str,
    cover_data_url: Option<&str>,
    duration: f64,
    position: f64,
    playing: bool,
) -> Result<(), String> {
    let mut g = CONTROLS.lock();
    let Some(Holder(c)) = g.as_mut() else { return Ok(()) };
    // SMTC wants a URL; write data: covers to a temp file.
    let cover_url = cover_data_url.and_then(|d| {
        let (_, b64) = d.split_once(";base64,")?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
        let p = std::env::temp_dir().join("driftkord_cover.jpg");
        std::fs::write(&p, bytes).ok()?;
        Some(format!("file:///{}", p.to_string_lossy().replace('\\', "/")))
    });
    c.set_metadata(MediaMetadata {
        title: Some(title),
        artist: Some(artist),
        album: Some(album),
        cover_url: cover_url.as_deref(),
        duration: if duration > 0.0 { Some(Duration::from_secs_f64(duration)) } else { None },
    })
    .map_err(|e| format!("{e:?}"))?;
    let progress = Some(MediaPosition(Duration::from_secs_f64(position.max(0.0))));
    c.set_playback(if playing { MediaPlayback::Playing { progress } } else { MediaPlayback::Paused { progress } })
        .map_err(|e| format!("{e:?}"))
}
