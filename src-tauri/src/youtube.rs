//! Embedded YouTube Music window with an AdGuard-style blocker:
//!  * network level: WebView2 `WebResourceRequested` interception — ad/tracker requests are
//!    answered locally with HTTP 403 before they leave the machine
//!  * cosmetic + scriptlet level: `yt_inject.js` (JSON pruning, CSS hiding, ad-skip fallback)
//!  * bridge: the page posts now-playing state which is re-emitted to the main UI as `yt-state`
//! The YouTube window gets **no** Tauri IPC permissions (see capabilities/default.json).

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

pub const LABEL: &str = "youtube";
const INJECT: &str = include_str!("yt_inject.js");

/// AudioWorklet that captures YouTube's audio on the browser's real-time audio thread
/// (glitch-free, unlike main-thread capture) and hands 100 ms PCM blocks to the page.
const CAPTURE_WORKLET: &str = r#"
class DKCapture extends AudioWorkletProcessor {
  constructor() { super(); this.size = 4800; this.buf = new Int16Array(this.size * 2); this.n = 0; }
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp.length) {
      const L = inp[0], R = inp[1] || inp[0];
      for (let i = 0; i < L.length; i++) {
        let l = L[i], r = R[i];
        l = l < -1 ? -1 : l > 1 ? 1 : l;
        r = r < -1 ? -1 : r > 1 ? 1 : r;
        this.buf[this.n++] = l < 0 ? l * 32768 : l * 32767;
        this.buf[this.n++] = r < 0 ? r * 32768 : r * 32767;
        if (this.n >= this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Int16Array(this.size * 2);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('dk-capture', DKCapture);
"#;
const WORKLET_PATH: &str = "/__driftkord__/capture.js";

pub static BLOCKED: AtomicU64 = AtomicU64::new(0);
/// Live audio buffer while YouTube Music is routed through DriftKord's engine.
pub static STREAM: parking_lot::Mutex<Option<Arc<crate::decoder::StreamBuf>>> = parking_lot::Mutex::new(None);
pub static INSPECTED: AtomicU64 = AtomicU64::new(0);

/// Host suffixes blocked outright.
const BLOCK_HOSTS: &[&str] = &[
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "google-analytics.com",
    "googletagmanager.com",
    "googletagservices.com",
    "adservice.google.com",
    "imasdk.googleapis.com",
    "pagead2.googlesyndication.com",
    "ade.googlesyndication.com",
    "2mdn.net",
    "adsrvr.org",
    "scorecardresearch.com",
    "moatads.com",
    "innovid.com",
    "serving-sys.com",
    "adnxs.com",
    "amazon-adsystem.com",
    "criteo.com",
    "taboola.com",
    "outbrain.com",
];

/// Path fragments blocked on YouTube/Google hosts.
const BLOCK_PATHS: &[&str] = &[
    "/pagead/",
    "/api/stats/ads",
    "/get_midroll_",
    "/ptracking",
    "/youtubei/v1/log_event",
    "/generate_204",
    "/csi_204",
    "/ad_break",
    "/pcs/activeview",
    "/adview",
    "/el/adunit",
    "/log?format=json",
    "&ad_type=",
    "/get_video_info?*adformat",
];

pub fn is_blocked(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    let host = lower
        .split("://")
        .nth(1)
        .and_then(|r| r.split(['/', '?', ':']).next())
        .unwrap_or("");
    if BLOCK_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}"))) {
        return true;
    }
    let google = host.ends_with("youtube.com") || host.ends_with("google.com") || host.ends_with("googlevideo.com");
    if google && BLOCK_PATHS.iter().any(|p| lower.contains(p)) {
        return true;
    }
    // googlevideo ad streams carry ctier=L / oad= / adformat markers
    if host.ends_with("googlevideo.com") && (lower.contains("&oad=") || lower.contains("&adformat=")) {
        return true;
    }
    false
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AdblockStats {
    pub blocked: u64,
    pub inspected: u64,
}

pub fn stats() -> AdblockStats {
    AdblockStats { blocked: BLOCKED.load(Ordering::Relaxed), inspected: INSPECTED.load(Ordering::Relaxed) }
}

fn allowed_url(u: &str) -> bool {
    u.starts_with("https://music.youtube.com/") || u.starts_with("https://www.youtube.com/") || u == "https://music.youtube.com"
}

/// Label of the YouTube Music view embedded *inside* the main window.
pub const EMBED: &str = "yt-embed";
const HOME: &str = "https://music.youtube.com/";
const STREAM_INJECT: &str = include_str!("stream_inject.js");

/// A streaming service shown in the Streaming tab, each in its own embedded view.
pub struct Service {
    pub id: &'static str,
    label: &'static str,
    home: &'static str,
    /// sites the view may navigate to (the service itself plus its sign-in providers)
    hosts: &'static [&'static str],
}

const SIGN_IN: [&str; 6] = ["google.com", "gstatic.com", "facebook.com", "apple.com", "appleid.apple.com", "recaptcha.net"];

pub static SERVICES: &[Service] = &[
    Service { id: "youtube", label: EMBED, home: HOME, hosts: &["youtube.com", "google.com", "gstatic.com", "youtu.be"] },
    Service { id: "spotify", label: "stream-spotify", home: "https://open.spotify.com/", hosts: &["spotify.com", "scdn.co", "spotifycdn.com", "spotify.link"] },
    Service { id: "apple", label: "stream-apple", home: "https://music.apple.com/", hosts: &["apple.com", "icloud.com", "mzstatic.com", "itunes.com"] },
    Service { id: "tidal", label: "stream-tidal", home: "https://listen.tidal.com/", hosts: &["tidal.com", "tidalhifi.com"] },
    Service {
        id: "amazon",
        label: "stream-amazon",
        home: "https://music.amazon.com/",
        hosts: &[
            "amazon.com", "amazon.in", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.it", "amazon.es", "amazon.ca",
            "amazon.co.jp", "amazon.com.au", "amazon.com.br", "amazon.com.mx", "amazonmusic.com", "media-amazon.com",
            "ssl-images-amazon.com", "amazon.dev",
        ],
    },
];

fn service(id: &str) -> Result<&'static Service, String> {
    SERVICES.iter().find(|s| s.id == id).ok_or_else(|| format!("Unknown streaming service {id}"))
}

fn host_in(h: &str, list: &[&str]) -> bool {
    list.iter().any(|d| h == *d || h.ends_with(&format!(".{d}")))
}

fn nav_ok(svc: &Service, u: &tauri::Url) -> bool {
    // keep each view on its own service (sign-in pages included); everything else is refused
    if u.as_str() == "about:blank" {
        return true;
    }
    let h = u.host_str().unwrap_or("");
    host_in(h, svc.hosts) || (svc.id != "youtube" && host_in(h, &SIGN_IN))
}

/// The service DriftKord's player bar currently controls (the one that last started playing).
static ACTIVE: parking_lot::Mutex<&'static str> = parking_lot::Mutex::new("youtube");

/// A service started playing: it becomes the controlled one and any other service is paused,
/// so two streams never play over each other.
fn set_active(app: &AppHandle, id: &str) {
    let Ok(svc) = service(id) else { return };
    let prev = std::mem::replace(&mut *ACTIVE.lock(), svc.id);
    if prev != svc.id {
        if let Some(v) = service(prev).ok().and_then(|p| app.get_webview(p.label)) {
            let _ = v.eval("window.__WA&&__WA.pause()");
        }
    }
}

/// Create a service's embedded view once (hidden until the Streaming page shows it).
/// It lives for the rest of the session, so music keeps playing while you browse other pages.
fn ensure_embed(app: &AppHandle, svc: &'static Service, first_url: &tauri::Url) -> Result<(tauri::Webview, bool), String> {
    // Commands run on a thread pool: serialise creation so two callers (e.g. "play a YouTube
    // track" and "show the YouTube page") can never build the view twice at the same moment.
    static CREATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = CREATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(v) = app.get_webview(svc.label) {
        return Ok((v, false));
    }
    let main = app.get_window("main").ok_or("Main window not found")?;
    let blank = tauri::Url::parse("about:blank").map_err(|e| e.to_string())?;
    let builder = tauri::webview::WebviewBuilder::new(svc.label, WebviewUrl::External(blank)).on_navigation(move |u| nav_ok(svc, u));
    let v = main
        .add_child(builder, tauri::LogicalPosition::new(-4000.0, -4000.0), tauri::LogicalSize::new(800.0, 600.0))
        .map_err(|e| e.to_string())?;
    // stays visible but parked off-screen: a hidden WebView2 stalls media loading, so songs started
    // from the queue / Auto-Play would never begin until the Streaming tab was opened
    install_interceptor(app.clone(), &v, svc);
    // with_webview runs before this navigation on the main thread, so the scripts are in place first
    v.navigate(first_url.clone()).map_err(|e| e.to_string())?;
    Ok((v, true))
}

/// Load a URL of a service in its embedded view (creating it if needed). Does not change visibility.
pub fn open(app: &AppHandle, id: &str, url: Option<String>) -> Result<(), String> {
    let svc = service(id)?;
    let target = url.unwrap_or_else(|| svc.home.into());
    let parsed = tauri::Url::parse(&target).map_err(|e| e.to_string())?;
    let ok = if svc.id == "youtube" { allowed_url(&target) } else { parsed.scheme() == "https" && nav_ok(svc, &parsed) };
    if !ok {
        return Err(format!("That address doesn't belong to {}", svc.id));
    }
    let (v, created) = ensure_embed(app, svc, &parsed)?;
    if !created {
        v.navigate(parsed).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Place a service's view over the Streaming page's content area (logical pixels) and show it;
/// every other service view is parked out of sight.
pub fn show_at(app: &AppHandle, id: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let svc = service(id)?;
    let home = tauri::Url::parse(svc.home).map_err(|e| e.to_string())?;
    let (v, _) = ensure_embed(app, svc, &home)?;
    for other in SERVICES.iter().filter(|s| s.id != svc.id) {
        park(app, other);
    }
    v.set_bounds(tauri::Rect {
        position: tauri::LogicalPosition::new(x.max(0.0), y.max(0.0)).into(),
        size: tauri::LogicalSize::new(w.max(1.0), h.max(1.0)).into(),
    })
    .map_err(|e| e.to_string())?;
    v.show().map_err(|e| e.to_string())
}

fn park(app: &AppHandle, svc: &Service) {
    // Park it out of sight rather than hide(): a hidden WebView2 counts as a background page and
    // throttles audio (and YouTube's capture that feeds DriftKord's engine).
    if let Some(v) = app.get_webview(svc.label) {
        let _ = v.set_bounds(tauri::Rect {
            position: tauri::LogicalPosition::new(-4000.0, -4000.0).into(),
            size: tauri::LogicalSize::new(800.0, 600.0).into(),
        });
    }
}

/// Hide all service views (playback continues in the background).
pub fn hide_embed(app: &AppHandle) {
    for s in SERVICES {
        park(app, s);
    }
}

/// Close a service's view entirely to free memory (sign-in is kept: cookies live in the profile).
pub fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    let svc = service(id)?;
    if let Some(v) = app.get_webview(svc.label) {
        v.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Which service views are currently loaded.
pub fn loaded(app: &AppHandle) -> Vec<String> {
    SERVICES.iter().filter(|s| app.get_webview(s.label).is_some()).map(|s| s.id.to_string()).collect()
}

fn install_interceptor(app: AppHandle, w: &tauri::Webview, svc: &'static Service) {
    if svc.id != "youtube" {
        install_bridge(app, w, svc);
        return;
    }
    let app = Arc::new(app);
    let _ = w.with_webview(move |pv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::{take_pwstr, WebMessageReceivedEventHandler, WebResourceRequestedEventHandler};
        use windows::core::{HSTRING, PWSTR};

        let Ok(core) = pv.controller().CoreWebView2() else { return };
        let env = pv.environment();
        // Include requests made by YouTube's service worker (it fronts most of the site); without this
        // the ad blocker and the capture-worklet route never see them.
        {
            use windows::core::Interface;
            match core.cast::<ICoreWebView2_22>() {
                Ok(core22) => {
                    let _ = core22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                        &HSTRING::from("*"),
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                    );
                }
                Err(_) => {
                    let _ = core.AddWebResourceRequestedFilter(&HSTRING::from("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
                }
            }
        }

        // Companion script (bridge, remote control, scriptlets, cosmetic filters).
        // Tauri doesn't apply initialization scripts to views embedded with add_child, so register it
        // with WebView2 directly: at the start of every document, plus a re-run after each navigation
        // completes as a safety net (the script is idempotent).
        {
            use webview2_com::{AddScriptToExecuteOnDocumentCreatedCompletedHandler, ExecuteScriptCompletedHandler, NavigationCompletedEventHandler};
            let _ = core.AddScriptToExecuteOnDocumentCreated(
                &HSTRING::from(INJECT),
                &AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(|_, _| Ok(()))),
            );
            let core_nav = core.clone();
            let mut nav_token = 0i64;
            let _ = core.add_NavigationCompleted(
                &NavigationCompletedEventHandler::create(Box::new(move |_, _| {
                    let _ = core_nav.ExecuteScript(&HSTRING::from(INJECT), &ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))));
                    Ok(())
                })),
                &mut nav_token,
            );
        }
        let mut token = 0i64;
        let app_a = app.clone();
        let mut last_emit = std::time::Instant::now();
        let _ = core.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let req = args.Request()?;
                let mut uri = PWSTR::null();
                req.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                // serve the capture worklet from YouTube's own origin so the page's CSP allows it
                if uri.starts_with("https://music.youtube.com") && uri.contains(WORKLET_PATH) {
                    use windows::Win32::UI::Shell::SHCreateMemStream;
                    if let Some(stream) = SHCreateMemStream(Some(CAPTURE_WORKLET.as_bytes())) {
                        let resp = env.CreateWebResourceResponse(
                            &stream,
                            200,
                            &HSTRING::from("OK"),
                            &HSTRING::from("Content-Type: application/javascript\r\nCache-Control: no-store"),
                        )?;
                        args.SetResponse(&resp)?;
                    }
                    return Ok(());
                }
                INSPECTED.fetch_add(1, Ordering::Relaxed);
                if is_blocked(&uri) {
                    let resp = env.CreateWebResourceResponse(None, 403, &HSTRING::from("Blocked by DriftKord"), &HSTRING::from(""))?;
                    args.SetResponse(&resp)?;
                    BLOCKED.fetch_add(1, Ordering::Relaxed);
                    if last_emit.elapsed().as_millis() > 500 {
                        last_emit = std::time::Instant::now();
                        let _ = app_a.emit("adblock-stats", stats());
                    }
                }
                Ok(())
            })),
            &mut token,
        );
        let app_b = app.clone();
        let mut token2 = 0i64;
        let _ = core.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut msg = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut msg).is_err() {
                    return Ok(());
                }
                let msg = take_pwstr(msg);
                // captured audio for the engine (sent ~12 times a second)
                if let Some(b64) = msg.strip_prefix("WAPCM:") {
                    use base64::Engine as _;
                    let stream = STREAM.lock().clone();
                    if let (Some(s), Ok(bytes)) = (stream, base64::engine::general_purpose::STANDARD.decode(b64)) {
                        let samples: Vec<f32> = bytes.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
                        s.push(&samples);
                    }
                    return Ok(());
                }
                if msg == "WAPCMFLUSH" {
                    if let Some(s) = STREAM.lock().clone() {
                        s.flush();
                    }
                    return Ok(());
                }
                if let Some(json) = msg.strip_prefix("WAYT:") {
                    forward_state(&app_b, "youtube", json);
                }
                Ok(())
            })),
            &mut token2,
        );
    });
}

/// Re-emit a page's now-playing report to the main UI as `yt-state`, tagged with its service.
fn forward_state(app: &AppHandle, id: &str, json: &str) {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(json) else { return };
    if let Some(o) = v.as_object_mut() {
        o.insert("service".into(), serde_json::Value::String(id.into()));
        if o.get("kind").and_then(|k| k.as_str()) == Some("play") {
            set_active(app, id);
        }
    }
    let _ = app.emit("yt-state", v);
}

/// Spotify / Apple Music / TIDAL / Amazon Music: inject the now-playing + remote-control bridge
/// and listen to what it reports. No request interception: these pages are left as they are.
fn install_bridge(app: AppHandle, w: &tauri::Webview, svc: &'static Service) {
    let script = format!("window.__DK_SERVICE={:?};\n{}", svc.id, STREAM_INJECT);
    let id = svc.id;
    let _ = w.with_webview(move |pv| unsafe {
        use webview2_com::{take_pwstr, AddScriptToExecuteOnDocumentCreatedCompletedHandler, ExecuteScriptCompletedHandler, NavigationCompletedEventHandler, WebMessageReceivedEventHandler};
        use windows::core::{HSTRING, PWSTR};
        let Ok(core) = pv.controller().CoreWebView2() else { return };
        let _ = core.AddScriptToExecuteOnDocumentCreated(
            &HSTRING::from(script.as_str()),
            &AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(|_, _| Ok(()))),
        );
        let core_nav = core.clone();
        let script_nav = script.clone();
        let mut nav_token = 0i64;
        let _ = core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, _| {
                let _ = core_nav.ExecuteScript(&HSTRING::from(script_nav.as_str()), &ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))));
                Ok(())
            })),
            &mut nav_token,
        );
        let mut token = 0i64;
        let _ = core.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut msg = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut msg).is_err() {
                    return Ok(());
                }
                let msg = take_pwstr(msg);
                if let Some(json) = msg.strip_prefix("WAYT:") {
                    forward_state(&app, id, json);
                }
                Ok(())
            })),
            &mut token,
        );
    });
}

/// Run a control command inside a service's page (`None` = the service that is currently playing).
pub fn control_in(app: &AppHandle, id: Option<&str>, cmd: &str, arg: Option<f64>) -> Result<(), String> {
    let svc = match id {
        Some(i) => service(i)?,
        None => service(*ACTIVE.lock())?,
    };
    if svc.id != "youtube" && cmd == "route" {
        return Ok(()); // DRM-protected services can't be routed
    }
    let w = app.get_webview(svc.label).ok_or_else(|| format!("{} is not loaded yet", svc.id))?;
    let js = match cmd {
        "play" => "window.__WA&&__WA.play()".to_string(),
        "pause" => "window.__WA&&__WA.pause()".to_string(),
        "toggle" => "window.__WA&&__WA.toggle()".to_string(),
        "next" => "window.__WA&&__WA.next()".to_string(),
        "prev" => "window.__WA&&__WA.prev()".to_string(),
        "seek" => format!("window.__WA&&__WA.seek({})", arg.unwrap_or(0.0)),
        "volume" => format!("window.__WA&&__WA.volume({})", arg.unwrap_or(1.0)),
        "fadeIn" => format!("window.__WA&&__WA.fade(1,{})", arg.unwrap_or(4000.0)),
        "fadeOut" => format!("window.__WA&&__WA.fade(0,{})", arg.unwrap_or(4000.0)),
        "startSilent" => "window.__WA&&__WA.startSilent()".to_string(),
        "report" => "window.__WA&&__WA.report('state')".to_string(),
        "hide" => {
            let _ = w.hide();
            return Ok(());
        }
        "back" => "history.back()".to_string(),
        "forward" => "history.forward()".to_string(),
        "reload" => "location.reload()".to_string(),
        "route" => format!("window.__WA&&__WA.route({})", arg.unwrap_or(1.0) > 0.5),
        "integrated" if svc.id == "youtube" => format!("document.documentElement.classList.toggle('wa-integrated', {})", arg.unwrap_or(1.0) > 0.5),
        "integrated" => format!("window.__WA&&__WA.integrate({})", arg.unwrap_or(1.0) > 0.5),
        _ => return Err(format!("Unknown command {cmd}")),
    };
    w.eval(&js).map_err(|e| e.to_string())
}
