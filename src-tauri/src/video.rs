//! Music-video view: a muted youtube.com page embedded in the main window that shows only the video
//! for the song you're listening to (from any source). DriftKord searches for the official video,
//! opens it, places the view over the Now Playing stage or the full-screen player, and keeps it in
//! sync with the music. The view is muted at the WebView2 level, so it never makes a sound.

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

pub const LABEL: &str = "dk-video";
/// A search waiting for the page to finish loading (query, tag); re-sent after each navigation
/// until its results come back.
static PENDING: parking_lot::Mutex<Option<(String, String)>> = parking_lot::Mutex::new(None);
const WARM_URL: &str = "https://www.youtube.com/watch?v=4NRXx6U8ABQ";

// ---- one page load at a time. Starting a second load while one is in flight cancels the first
// and can leave an empty page, so requests made during a load wait and run when it completes.
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering::SeqCst};
/// When the current page load started (ms since epoch), 0 = idle. A load that never reports back is
/// treated as finished after 12 s so the view can't get stuck.
static LOAD_AT: AtomicU64 = AtomicU64::new(0);
static RETRIES: AtomicU32 = AtomicU32::new(0);
fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
fn loading() -> bool {
    let at = LOAD_AT.load(SeqCst);
    at != 0 && now_ms().saturating_sub(at) < 12_000
}
/// A video to open once the current page load has finished (id, start seconds).
static PENDING_OPEN: parking_lot::Mutex<Option<(String, f64)>> = parking_lot::Mutex::new(None);

fn go(v: &tauri::Webview, url: &str) -> Result<(), String> {
    LOAD_AT.store(now_ms(), SeqCst);
    v.navigate(tauri::Url::parse(url).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn watch_url(id: &str) -> String {
    format!("https://www.youtube.com/watch?v={id}")
}
/// Switch the existing player to another video; YouTube builds its player shortly after the page
/// loads, so keep trying for a few seconds before falling back to loading the page.
fn load_script(id: &str, start: f64) -> String {
    format!(
        "(function t(n){{if(window.__DKV&&__DKV.load({id},{start}))return;if(n>30){{location.assign({url});return}}setTimeout(function(){{t(n+1)}},200)}})(0)",
        id = js_str(id),
        start = start.max(0.0),
        url = js_str(&watch_url(id))
    )
}
const INJECT: &str = include_str!("video_inject.js");


fn nav_ok(u: &tauri::Url) -> bool {
    if u.as_str() == "about:blank" {
        return true;
    }
    let h = u.host_str().unwrap_or("");
    ["youtube.com", "google.com", "gstatic.com", "youtu.be", "ggpht.com", "ytimg.com"].iter().any(|d| h == *d || h.ends_with(&format!(".{d}")))
}

fn ensure(app: &AppHandle) -> Result<tauri::Webview, String> {
    static CREATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _g = CREATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(v) = app.get_webview(LABEL) {
        return Ok(v);
    }
    let main = app.get_window("main").ok_or("Main window not found")?;
    // Created blank; YouTube's player page is loaded once DriftKord's page script is registered (see
    // install), so even the first page has ads removed from the start. Requests made meanwhile wait
    // (LOAD_AT) and run as soon as that first load completes.
    let blank = tauri::Url::parse("about:blank").map_err(|e| e.to_string())?;
    LOAD_AT.store(now_ms(), SeqCst);
    let builder = tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(blank)).on_navigation(nav_ok);
    let v = main
        .add_child(builder, tauri::LogicalPosition::new(-4000.0, -4000.0), tauri::LogicalSize::new(640.0, 360.0))
        .map_err(|e| e.to_string())?;
    install(app.clone(), &v);
    Ok(v)
}

fn install(app: AppHandle, w: &tauri::Webview) {
    let app = Arc::new(app);
    let _ = w.with_webview(move |pv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::{take_pwstr, AddScriptToExecuteOnDocumentCreatedCompletedHandler, ExecuteScriptCompletedHandler, NavigationCompletedEventHandler, WebMessageReceivedEventHandler};
        use windows::core::{Interface, HSTRING, PWSTR};
        let Ok(core) = pv.controller().CoreWebView2() else { return };
        // never make a sound: the music comes from your real source
        if let Ok(c8) = core.cast::<ICoreWebView2_8>() {
            let _ = c8.SetIsMuted(true);
        }
        // No request blocking in this view: when YouTube schedules an ad, a blocked ad leaves the player
        // stuck on an empty ad forever. Ads instead play muted out of sight and are skipped at once by
        // the page script; the video is only shown once the real video is playing.
        let core_first = core.clone();
        let _ = core.AddScriptToExecuteOnDocumentCreated(
            &HSTRING::from(INJECT),
            &AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |_, _| {
                // the script is in place: now load the player page
                LOAD_AT.store(now_ms(), SeqCst);
                let _ = core_first.Navigate(&HSTRING::from(WARM_URL));
                Ok(())
            })),
        );
        let core_nav = core.clone();
        let mut t2 = 0i64;
        let _ = core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                let mut ok = windows::core::BOOL::default();
                let success = args.as_ref().map(|a| a.IsSuccess(&mut ok).is_ok() && ok.as_bool()).unwrap_or(true);
                let mut src = PWSTR::null();
                let on_yt = core_nav.Source(&mut src).is_ok() && take_pwstr(src).contains("youtube.com");
                if !success {
                    // A load that was cancelled was replaced by a newer one: leave that one alone
                    // (re-navigating here would cancel it in turn). Retry only real failures.
                    let mut st = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                    let cancelled = args.as_ref().map(|a| a.WebErrorStatus(&mut st).is_ok() && st == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED).unwrap_or(false);
                    if cancelled {
                        return Ok(());
                    }
                    LOAD_AT.store(0, SeqCst);
                    let wanted = PENDING_OPEN.lock().clone().map(|(id, _)| watch_url(&id)).or_else(|| PENDING.lock().as_ref().map(|_| WARM_URL.to_string()));
                    if let Some(url) = wanted {
                        if RETRIES.fetch_add(1, SeqCst) < 2 {
                            LOAD_AT.store(now_ms(), SeqCst);
                            let _ = core_nav.Navigate(&HSTRING::from(url));
                        }
                    }
                    return Ok(());
                }
                let _ = core_nav.ExecuteScript(&HSTRING::from(INJECT), &ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))));
                if !on_yt {
                    return Ok(());
                }
                LOAD_AT.store(0, SeqCst);
                RETRIES.store(0, SeqCst);
                if let Some((id, start)) = PENDING_OPEN.lock().take() {
                    let _ = core_nav.ExecuteScript(&HSTRING::from(load_script(&id, start)), &ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))));
                }
                if let Some((q, t)) = PENDING.lock().clone() {
                    let js = format!("setTimeout(function(){{window.__DKV&&__DKV.search({},{})}},250)", js_str(&q), js_str(&t));
                    let _ = core_nav.ExecuteScript(&HSTRING::from(js), &ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))));
                }
                Ok(())
            })),
            &mut t2,
        );
        let mut t3 = 0i64;
        let _ = core.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut msg = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut msg).is_err() {
                    return Ok(());
                }
                let msg = take_pwstr(msg);
                if let Some(json) = msg.strip_prefix("DKV:") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
                        if v.get("kind").and_then(|k| k.as_str()) == Some("results") {
                            let tag = v.get("tag").and_then(|t| t.as_str()).unwrap_or("");
                            let mut p = PENDING.lock();
                            if p.as_ref().map(|(_, t)| t == tag).unwrap_or(false) {
                                *p = None;
                            }
                        }
                        let _ = app.emit_to("main", "video-event", v);
                    }
                }
                Ok(())
            })),
            &mut t3,
        );
    });
}

fn on_youtube(v: &tauri::Webview) -> bool {
    v.url().map(|u| u.host_str().map(|h| h.ends_with("youtube.com")).unwrap_or(false)).unwrap_or(false)
}
fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Search YouTube for videos; results arrive as a `video-event` of kind "results".
/// Fast path: a data request from inside the already-open page. First time: load the results page.
pub fn search(app: &AppHandle, query: &str, tag: &str, cont: &str) -> Result<(), String> {
    let v = ensure(app)?;
    if on_youtube(&v) && !loading() && !cont.is_empty() {
        // "more results" for a search that already ran
        return v.eval(&format!("window.__DKV&&__DKV.search({}, {}, {})", js_str(query), js_str(tag), js_str(cont))).map_err(|e| e.to_string());
    }
    *PENDING.lock() = Some((query.to_string(), tag.to_string()));
    if loading() {
        return Ok(()); // runs as soon as the current load completes
    }
    if on_youtube(&v) {
        return v.eval(&format!("window.__DKV&&__DKV.search({}, {})", js_str(query), js_str(tag))).map_err(|e| e.to_string());
    }
    // first use: load the player page; the pending search runs as soon as it has loaded
    go(&v, WARM_URL)
}

/// Load YouTube's player once in the background so the first video starts quickly.
pub fn warm(app: &AppHandle) -> Result<(), String> {
    let v = ensure(app)?;
    if loading() || on_youtube(&v) {
        return Ok(());
    }
    go(&v, WARM_URL)
}

/// Open a video (muted, paused until DriftKord tells it to play).
pub fn open(app: &AppHandle, id: &str, start: f64) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') || id.len() > 20 {
        return Err("bad video id".into());
    }
    let v = ensure(app)?;
    if loading() {
        // a page is loading: open this video as soon as it's done (latest request wins)
        *PENDING_OPEN.lock() = Some((id.to_string(), start));
        return Ok(());
    }
    // already on a watch page: switch videos in place (instant); otherwise load the page
    let is_watch = v.url().map(|u| u.path() == "/watch" && u.host_str().map(|h| h.ends_with("youtube.com")).unwrap_or(false)).unwrap_or(false);
    if is_watch {
        return v.eval(&load_script(id, start)).map_err(|e| e.to_string());
    }
    RETRIES.store(0, SeqCst);
    // the page opens on this video; once loaded, the pending open seeks it to the right spot
    *PENDING_OPEN.lock() = Some((id.to_string(), start));
    go(&v, &watch_url(id))
}

pub fn show_at(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let v = app.get_webview(LABEL).ok_or("video not loaded")?;
    v.set_bounds(tauri::Rect {
        position: tauri::LogicalPosition::new(x.max(0.0), y.max(0.0)).into(),
        size: tauri::LogicalSize::new(w.max(1.0), h.max(1.0)).into(),
    })
    .map_err(|e| e.to_string())?;
    v.show().map_err(|e| e.to_string())
}

/// Move the view out of sight (kept alive so it resumes instantly).
pub fn hide(app: &AppHandle) {
    if let Some(v) = app.get_webview(LABEL) {
        let _ = v.set_bounds(tauri::Rect {
            position: tauri::LogicalPosition::new(-4000.0, -4000.0).into(),
            size: tauri::LogicalSize::new(640.0, 360.0).into(),
        });
    }
}

pub fn control(app: &AppHandle, cmd: &str, arg: Option<f64>) -> Result<(), String> {
    let Some(v) = app.get_webview(LABEL) else { return Ok(()) };
    let js = match cmd {
        "play" => "window.__DKV&&__DKV.play()".to_string(),
        "pause" => "window.__DKV&&__DKV.pause()".to_string(),
        "seek" => format!("window.__DKV&&__DKV.seek({})", arg.unwrap_or(0.0)),
        "rate" => format!("window.__DKV&&__DKV.rate({})", arg.unwrap_or(1.0)),
        _ => return Err(format!("unknown video command {cmd}")),
    };
    v.eval(&js).map_err(|e| e.to_string())
}

/// Video quality: "auto" | "max" | YouTube level ("hd1080", "hd720", "large" = 480p…).
pub fn quality(app: &AppHandle, q: &str) -> Result<(), String> {
    let Some(v) = app.get_webview(LABEL) else { return Ok(()) };
    v.eval(&format!("window.__DKV&&__DKV.quality({})", js_str(q))).map_err(|e| e.to_string())
}

pub fn close(app: &AppHandle) {
    if let Some(v) = app.get_webview(LABEL) {
        let _ = v.close();
    }
}
