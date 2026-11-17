// DriftKord — Tauri v2 backend entry point.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analysis;
mod asio;
mod audio;
mod decoder;
mod dlna;
mod dsp;
mod stretch;
mod formats;
mod focus;
mod integrations;
mod mods;
mod video;
mod library;
mod metadata;
mod shell;
mod smtc;
mod youtube;

use audio::{AudioStatus, DeviceInfo, Engine, OutputConfig, ReplayGainInfo};
use dsp::DspParams;
use library::{Library, Playlist, QueueItem, Track};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

type R<T> = Result<T, String>;

pub struct AppState {
    engine: Arc<Engine>,
    lib: Arc<Library>,
    integ: Arc<integrations::Integrations>,
    focus: Arc<focus::FocusMonitor>,
    launch_args: Vec<String>,
}

static ANALYZING: AtomicBool = AtomicBool::new(false);
static SCANNING: AtomicBool = AtomicBool::new(false);

fn rg_for(lib: &Library, path: &str) -> ReplayGainInfo {
    match lib.track_by_path(path) {
        Some(t) => ReplayGainInfo {
            track_gain: t.rg_track_gain.map(|v| v as f32),
            track_peak: t.rg_track_peak.map(|v| v as f32),
            album_gain: t.rg_album_gain.map(|v| v as f32),
            album_peak: t.rg_album_peak.map(|v| v as f32),
        },
        None => {
            let b = metadata::read_basic(std::path::Path::new(path));
            ReplayGainInfo {
                track_gain: b.rg_track_gain.map(|v| v as f32),
                track_peak: b.rg_track_peak.map(|v| v as f32),
                album_gain: b.rg_album_gain.map(|v| v as f32),
                album_peak: b.rg_album_peak.map(|v| v as f32),
            }
        }
    }
}

// ============================================================================================
// Audio
// ============================================================================================

#[tauri::command]
async fn list_devices() -> R<Vec<DeviceInfo>> {
    audio::list_devices()
}

#[tauri::command]
fn list_asio_devices() -> Vec<String> {
    asio::list_asio().unwrap_or_default()
}

#[tauri::command]
fn asio_available() -> bool {
    true
}

#[tauri::command]
fn asio_control_panel(name: String) -> R<()> {
    asio::control_panel(&name)
}

#[tauri::command]
fn get_output(s: State<AppState>) -> OutputConfig {
    s.engine.shared.output_cfg.lock().clone()
}

#[tauri::command]
async fn set_output(s: State<'_, AppState>, cfg: OutputConfig) -> R<()> {
    s.engine.set_output(cfg.clone());
    s.lib.set_setting("output", &serde_json::to_string(&cfg).map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn play_file(s: State<'_, AppState>, path: String, track_id: Option<i64>, start_at: Option<f64>) -> R<decoder::StreamInfo> {
    let rg = rg_for(&s.lib, &path);
    s.engine.play(&path, track_id, rg, start_at.unwrap_or(0.0))
}

#[tauri::command]
async fn set_next(
    s: State<'_, AppState>,
    path: Option<String>,
    track_id: Option<i64>,
    xfade: Option<f64>,
    tempo: Option<f64>,
    start_at: Option<f64>,
) -> R<()> {
    let rg = path.as_deref().map(|p| rg_for(&s.lib, p)).unwrap_or_default();
    s.engine.set_next(
        path.as_deref(),
        track_id,
        rg,
        xfade.unwrap_or(0.0),
        tempo.unwrap_or(1.0),
        start_at.unwrap_or(0.0),
    )
}

#[tauri::command]
fn pause(s: State<AppState>, paused: bool) {
    s.engine.pause(paused);
}

#[tauri::command]
fn stop(s: State<AppState>) {
    s.engine.stop();
}

#[tauri::command]
fn seek(s: State<AppState>, secs: f64) {
    s.engine.seek(secs);
}

#[tauri::command]
async fn set_volume(s: State<'_, AppState>, volume: f32) -> R<()> {
    s.engine.set_volume(volume);
    let p = s.engine.shared.player.lock().dsp.params.clone();
    let _ = s.lib.set_setting("dsp", &serde_json::to_string(&p).unwrap_or_default());
    Ok(())
}

#[tauri::command]
fn get_dsp(s: State<AppState>) -> DspParams {
    s.engine.shared.player.lock().dsp.params.clone()
}

#[tauri::command]
async fn set_dsp(s: State<'_, AppState>, params: DspParams) -> R<()> {
    s.engine.set_dsp(params.clone());
    s.lib.set_setting("dsp", &serde_json::to_string(&params).map_err(|e| e.to_string())?)
}

#[tauri::command]
fn get_status(s: State<AppState>) -> AudioStatus {
    s.engine.status()
}

#[tauri::command]
fn set_loopback(s: State<AppState>, on: bool) {
    s.engine.set_loopback(on);
}

#[tauri::command]
fn set_frame_rate(s: State<AppState>, fps: u32) {
    s.engine.set_frame_rate(fps);
}

// ============================================================================================
// Library
// ============================================================================================

fn spawn_scan(app: AppHandle, lib: Arc<Library>, roots: Vec<String>) {
    if SCANNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let a = app.clone();
        let _ = lib.scan(&roots, |p| {
            let _ = a.emit("scan-progress", p);
        });
        SCANNING.store(false, Ordering::SeqCst);
        let _ = app.emit("library-changed", ());
        spawn_analysis(app, lib);
    });
}

fn spawn_analysis(app: AppHandle, lib: Arc<Library>) {
    if ANALYZING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("library-analysis".into())
        .spawn(move || {
            #[derive(Serialize, Clone)]
            #[serde(rename_all = "camelCase")]
            struct P {
                done: usize,
                total: usize,
                current: String,
                finished: bool,
            }
            let todo = lib.unanalyzed_ids();
            let total = todo.len();
            for (i, (id, path)) in todo.into_iter().enumerate() {
                let _ = app.emit("analysis-progress", P { done: i, total, current: path.clone(), finished: false });
                match analysis::analyze_file(std::path::Path::new(&path)) {
                    Ok(a) => {
                        let _ = lib.save_analysis(id, &a);
                    }
                    Err(_) => {
                        // mark as analysed with empty data so we don't retry forever
                        let _ = lib.save_analysis(id, &analysis::TrackAnalysis { verdict: "Unreadable".into(), ..Default::default() });
                    }
                }
                if i % 20 == 19 {
                    let _ = app.emit("library-changed", ());
                }
            }
            ANALYZING.store(false, Ordering::SeqCst);
            let _ = app.emit("analysis-progress", P { done: total, total, current: String::new(), finished: true });
            let _ = app.emit("library-changed", ());
        })
        .ok();
}

#[tauri::command]
fn library_folders(s: State<AppState>) -> R<Vec<String>> {
    s.lib.folders()
}

#[tauri::command]
async fn library_add_folder(app: AppHandle, s: State<'_, AppState>, path: String) -> R<()> {
    s.lib.add_folder(&path)?;
    spawn_scan(app, s.lib.clone(), vec![path]);
    Ok(())
}

#[tauri::command]
fn library_remove_folder(app: AppHandle, s: State<AppState>, path: String) -> R<()> {
    s.lib.remove_folder(&path)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
async fn library_rescan(app: AppHandle, s: State<'_, AppState>) -> R<()> {
    let roots = s.lib.folders()?;
    spawn_scan(app, s.lib.clone(), roots);
    Ok(())
}

#[tauri::command]
async fn library_tracks(s: State<'_, AppState>) -> R<Vec<Track>> {
    s.lib.tracks()
}

#[tauri::command]
fn library_track(s: State<AppState>, id: i64) -> Option<Track> {
    s.lib.track_by_id(id)
}

/// Add loose files (drag & drop, Explorer "Open with") to the library and return them.
#[tauri::command]
async fn import_paths(app: AppHandle, s: State<'_, AppState>, paths: Vec<String>) -> R<Vec<Track>> {
    let mut out = Vec::new();
    for p in paths {
        let path = std::path::Path::new(&p);
        if path.is_dir() {
            s.lib.add_folder(&p)?;
            spawn_scan(app.clone(), s.lib.clone(), vec![p.clone()]);
            continue;
        }
        let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
        if ext == "cue" || ext == "iso" {
            for id in s.lib.upsert_image(path)? {
                if let Some(t) = s.lib.track_by_id(id) {
                    out.push(t);
                }
            }
            continue;
        }
        if !decoder::is_importable(path) {
            continue;
        }
        if s.lib.track_by_path(&p).is_none() {
            let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            s.lib.upsert_file(path, mtime, meta.len() as i64)?;
        }
        if let Some(t) = s.lib.track_by_path(&p) {
            out.push(t);
        }
    }
    let _ = app.emit("library-changed", ());
    spawn_analysis(app, s.lib.clone());
    Ok(out)
}

#[tauri::command]
fn set_cast_mute(on: bool) {
    audio::CAST_MUTE.store(on, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
async fn dlna_discover() -> Vec<dlna::Renderer> {
    tauri::async_runtime::spawn_blocking(dlna::discover).await.unwrap_or_default()
}

#[tauri::command]
async fn dlna_play(renderer: dlna::Renderer, path: String, title: String, artist: String, album: String, start: f64) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || dlna::play(&renderer, &path, &title, &artist, &album, start))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn dlna_control(renderer: dlna::Renderer, cmd: String, arg: Option<f64>) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || dlna::control(&renderer, &cmd, arg)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn dlna_status(renderer: dlna::Renderer) -> R<dlna::CastStatus> {
    tauri::async_runtime::spawn_blocking(move || dlna::status(&renderer)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_engine_options() -> formats::EngineOptions {
    formats::options()
}

#[tauri::command]
fn set_engine_options(s: State<AppState>, options: formats::EngineOptions) -> R<()> {
    s.lib.set_setting("engineOptions", &serde_json::to_string(&options).map_err(|e| e.to_string())?)?;
    formats::set_options(options);
    Ok(())
}

/// What the optional FFmpeg path found (for Settings).
#[tauri::command]
fn ffmpeg_status() -> Option<String> {
    formats::find_ffmpeg().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn analyze_library(app: AppHandle, s: State<AppState>) {
    spawn_analysis(app, s.lib.clone());
}

#[tauri::command]
async fn analyze_track(s: State<'_, AppState>, id: i64) -> R<analysis::TrackAnalysis> {
    let t = s.lib.track_by_id(id).ok_or("Unknown track")?;
    let lib = s.lib.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let a = analysis::analyze_file(std::path::Path::new(&t.path))?;
        lib.save_analysis(id, &a)?;
        Ok(a)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn record_play(s: State<AppState>, id: i64) -> R<()> {
    s.lib.record_play(id)
}

#[tauri::command]
fn set_rating(s: State<AppState>, id: i64, rating: i64) -> R<()> {
    s.lib.set_rating(id, rating)
}

#[tauri::command]
async fn playlists_list(s: State<'_, AppState>) -> R<Vec<Playlist>> {
    s.lib.playlists()
}

#[tauri::command]
fn playlist_create(s: State<AppState>, name: String) -> R<i64> {
    s.lib.playlist_create(&name)
}

#[tauri::command]
fn playlist_rename(s: State<AppState>, id: i64, name: String) -> R<()> {
    s.lib.playlist_rename(id, &name)
}

#[tauri::command]
fn playlist_delete(s: State<AppState>, id: i64) -> R<()> {
    s.lib.playlist_delete(id)
}

#[tauri::command]
async fn playlist_items(s: State<'_, AppState>, id: i64) -> R<Vec<QueueItem>> {
    s.lib.playlist_items(id)
}

#[tauri::command]
async fn playlist_set_items(s: State<'_, AppState>, id: i64, items: Vec<QueueItem>) -> R<()> {
    s.lib.playlist_set_items(id, &items)
}

// ============================================================================================
// Integrations: Discord Rich Presence + scrobbling (network calls run off the UI thread)
// ============================================================================================
// Music video view (muted YouTube page synced to whatever is playing). Window/webview work must be
// async on Windows, or creating the view from a command deadlocks the UI thread.
#[tauri::command]
async fn video_search(app: AppHandle, query: String, tag: Option<String>) -> R<()> {
    video::search(&app, &query, tag.as_deref().unwrap_or(""))
}
#[tauri::command]
async fn video_warm(app: AppHandle) -> R<()> {
    video::warm(&app)
}
#[tauri::command]
async fn video_open(app: AppHandle, id: String, start: f64) -> R<()> {
    video::open(&app, &id, start)
}
#[tauri::command]
async fn video_show_at(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> R<()> {
    video::show_at(&app, x, y, w, h)
}
#[tauri::command]
async fn video_hide(app: AppHandle) -> R<()> {
    video::hide(&app);
    Ok(())
}
#[tauri::command]
fn video_cmd(app: AppHandle, cmd: String, arg: Option<f64>) -> R<()> {
    video::control(&app, &cmd, arg)
}
#[tauri::command]
async fn video_close(app: AppHandle) -> R<()> {
    video::close(&app);
    Ok(())
}

// ============================================================================================
// Local mods (CSS / JS / theme presets in the app's mods folder)
fn data_dir(app: &AppHandle) -> R<std::path::PathBuf> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}
#[tauri::command]
fn mods_list(app: AppHandle) -> R<Vec<mods::ModInfo>> {
    mods::list(&data_dir(&app)?)
}
#[tauri::command]
fn mods_import(app: AppHandle, paths: Vec<String>) -> R<Vec<String>> {
    mods::import(&data_dir(&app)?, &paths)
}
#[tauri::command]
fn mods_read(app: AppHandle, file: String) -> R<String> {
    mods::read(&data_dir(&app)?, &file)
}
#[tauri::command]
fn mods_write(app: AppHandle, file: String, text: String) -> R<()> {
    mods::write(&data_dir(&app)?, &file, &text)
}
#[tauri::command]
fn mods_remove(app: AppHandle, file: String) -> R<()> {
    mods::remove(&data_dir(&app)?, &file)
}
#[tauri::command]
fn mods_open_folder(app: AppHandle) -> R<()> {
    mods::open_folder(&data_dir(&app)?)
}
/** Save a theme / mod the user exports to a place they picked in the save dialog. */
#[tauri::command]
fn save_text_file(path: String, text: String) -> R<()> {
    let lower = path.to_ascii_lowercase();
    if !(lower.ends_with(".json") || lower.ends_with(".dktheme") || lower.ends_with(".css")) {
        return Err("Only .dktheme, .json or .css files can be saved here".into());
    }
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn integrations_get(s: State<AppState>) -> integrations::Config {
    s.integ.config()
}
#[tauri::command]
fn integrations_set(s: State<AppState>, config: integrations::Config) -> R<()> {
    s.integ.set_config(config)
}
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> R<T> + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}
/// Open an https page in the default browser (sign-in / developer pages).
#[tauri::command]
fn open_url(url: String) -> R<()> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened".into());
    }
    std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
async fn lfm_begin(s: State<'_, AppState>, service: String) -> R<(String, String)> {
    let i = s.integ.clone();
    let (token, url) = blocking(move || i.lfm_begin(&service)).await?;
    open_url(url.clone())?;
    Ok((token, url))
}
#[tauri::command]
async fn lfm_finish(s: State<'_, AppState>, service: String, token: String) -> R<String> {
    let i = s.integ.clone();
    blocking(move || i.lfm_finish(&service, &token)).await
}
#[tauri::command]
async fn lb_validate(s: State<'_, AppState>, token: String) -> R<String> {
    let i = s.integ.clone();
    blocking(move || i.lb_validate(&token)).await
}
#[tauri::command]
async fn maloja_test(s: State<'_, AppState>) -> R<String> {
    let i = s.integ.clone();
    blocking(move || i.maloja_test()).await
}
#[tauri::command]
async fn scrobble_now_playing(s: State<'_, AppState>, play: integrations::Play) -> R<Vec<integrations::ServiceResult>> {
    let i = s.integ.clone();
    blocking(move || Ok(i.now_playing(&play))).await
}
#[tauri::command]
async fn scrobble_submit(s: State<'_, AppState>, play: integrations::Play, played: u32) -> R<Vec<integrations::ServiceResult>> {
    let i = s.integ.clone();
    blocking(move || Ok(i.scrobble(&play, played))).await
}
#[tauri::command]
async fn scrobble_flush(s: State<'_, AppState>) -> R<usize> {
    let i = s.integ.clone();
    blocking(move || Ok(i.flush())).await
}
#[tauri::command]
fn scrobble_queue_len(s: State<AppState>) -> usize {
    s.integ.queue_len()
}
#[tauri::command]
async fn discord_update(s: State<'_, AppState>, presence: integrations::Presence) -> R<()> {
    let i = s.integ.clone();
    blocking(move || i.discord_update(&presence)).await
}
#[tauri::command]
async fn discord_clear(s: State<'_, AppState>) -> R<()> {
    let i = s.integ.clone();
    blocking(move || { i.discord_clear(); Ok(()) }).await
}
#[tauri::command]
async fn discord_test(s: State<'_, AppState>) -> R<()> {
    let i = s.integ.clone();
    blocking(move || i.discord_test()).await
}

#[tauri::command]
fn get_setting(s: State<AppState>, key: String) -> Option<String> {
    s.lib.get_setting(&key)
}

#[tauri::command]
fn set_setting(s: State<AppState>, key: String, value: String) -> R<()> {
    s.lib.set_setting(&key, &value)
}

// ============================================================================================
// Metadata
// ============================================================================================

#[tauri::command]
async fn read_tags(path: String) -> R<metadata::TagData> {
    metadata::read_tags(&path)
}

#[tauri::command]
async fn write_tags(app: AppHandle, s: State<'_, AppState>, paths: Vec<String>, patch: metadata::TagPatch) -> R<usize> {
    let n = metadata::write_tags(&paths, &patch)?;
    s.lib.refresh_paths(&paths)?;
    let _ = app.emit("library-changed", ());
    Ok(n)
}

#[tauri::command]
async fn get_cover(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || metadata::get_cover(&path)).await.ok().flatten()
}

#[tauri::command]
async fn set_cover(app: AppHandle, s: State<'_, AppState>, paths: Vec<String>, image: String) -> R<()> {
    metadata::set_cover(&paths, &image)?;
    s.lib.refresh_paths(&paths)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
async fn remove_cover(app: AppHandle, s: State<'_, AppState>, paths: Vec<String>) -> R<()> {
    metadata::remove_cover(&paths)?;
    s.lib.refresh_paths(&paths)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
async fn tags_from_filename(paths: Vec<String>, pattern: String) -> Vec<(String, metadata::TagPatch)> {
    metadata::tags_from_filename(&paths, &pattern)
}

#[tauri::command]
async fn get_lyrics(path: String) -> Option<String> {
    metadata::get_lyrics(&path)
}

#[tauri::command]
async fn save_lyrics(path: String, text: String) -> R<()> {
    metadata::save_lyrics(&path, &text)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RgResult {
    path: String,
    lufs: f32,
    track_gain: f64,
    track_peak: f64,
    album_gain: Option<f64>,
    album_peak: Option<f64>,
}

/// EBU R128 scan → ReplayGain 2.0 (-18 LUFS). `album` treats all paths as one album.
#[tauri::command]
async fn compute_replaygain(app: AppHandle, s: State<'_, AppState>, paths: Vec<String>, album: bool, write: bool) -> R<Vec<RgResult>> {
    let lib = s.lib.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> R<Vec<RgResult>> {
        let mut per = Vec::new();
        let mut all_blocks = Vec::new();
        let mut album_peak = 0f32;
        for (i, p) in paths.iter().enumerate() {
            let _ = app.emit("rg-progress", (i, paths.len(), p.clone()));
            let a = analysis::analyze_file(std::path::Path::new(p))?;
            album_peak = album_peak.max(a.peak);
            all_blocks.extend(a.loudness_blocks.iter().copied());
            per.push((p.clone(), a));
        }
        let album_lufs = analysis::integrated_lufs(&all_blocks);
        let mut out = Vec::new();
        for (p, a) in per {
            let tg = (-18.0 - a.lufs) as f64;
            let tp = a.peak as f64;
            let (ag, ap) = if album { (Some((-18.0 - album_lufs) as f64), Some(album_peak as f64)) } else { (None, None) };
            if write {
                metadata::write_replaygain(&p, tg, tp, ag, ap)?;
                lib.save_replaygain(&p, tg, tp, ag, ap)?;
            }
            out.push(RgResult { path: p, lufs: a.lufs, track_gain: tg, track_peak: tp, album_gain: ag, album_peak: ap });
        }
        let _ = app.emit("library-changed", ());
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(res)
}

#[tauri::command]
async fn reveal_in_explorer(path: String) -> R<()> {
    let path = path.split('?').next().unwrap_or(&path).to_string();
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{path}"))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ============================================================================================
// Shell, YouTube, focus, SMTC
// ============================================================================================

#[tauri::command]
fn shell_status() -> shell::ShellStatus {
    shell::status()
}

#[tauri::command]
async fn shell_register() -> R<()> {
    shell::register()
}

#[tauri::command]
async fn shell_unregister() -> R<()> {
    shell::unregister()
}

#[tauri::command]
fn open_default_apps() -> R<()> {
    shell::open_default_apps()
}

/// Show the embedded YouTube Music view over the given area of the main window (logical px).
#[tauri::command]
async fn yt_show_at(app: AppHandle, service: Option<String>, x: f64, y: f64, w: f64, h: f64) -> R<()> {
    youtube::show_at(&app, service.as_deref().unwrap_or("youtube"), x, y, w, h)
}

/// Route YouTube Music's audio through DriftKord's engine (DSP, volume, ducking, output device) or not.
#[tauri::command]
async fn yt_route(app: AppHandle, s: State<'_, AppState>, on: bool) -> R<()> {
    if on {
        let buf = decoder::StreamBuf::new();
        *youtube::STREAM.lock() = Some(buf.clone());
        s.engine.play_stream(buf);
        youtube::control_in(&app, Some("youtube"), "route", Some(1.0))
    } else {
        *youtube::STREAM.lock() = None;
        s.engine.stop_stream();
        youtube::control_in(&app, Some("youtube"), "route", Some(0.0))
    }
}

/// Diagnostics for the routed YouTube stream: dropouts so far and current cushion (ms).
#[tauri::command]
fn yt_stream_stats() -> (u64, f64) {
    let buffered = youtube::STREAM.lock().as_ref().map(|s| s.buf.lock().len() as f64 / 2.0 / decoder::STREAM_RATE as f64 * 1000.0).unwrap_or(0.0);
    (decoder::STREAM_UNDERRUNS.load(std::sync::atomic::Ordering::Relaxed), buffered)
}

#[tauri::command]
async fn yt_hide(app: AppHandle) -> R<()> {
    youtube::hide_embed(&app);
    Ok(())
}

#[tauri::command]
async fn yt_open(app: AppHandle, url: Option<String>, service: Option<String>) -> R<()> {
    youtube::open(&app, service.as_deref().unwrap_or("youtube"), url)
}

/// Close a streaming service's embedded view to free memory (sign-in is kept).
#[tauri::command]
async fn stream_close(app: AppHandle, service: String) -> R<()> {
    youtube::close(&app, &service)
}

/// Streaming services whose views are currently loaded.
#[tauri::command]
fn stream_loaded(app: AppHandle) -> Vec<String> {
    youtube::loaded(&app)
}

#[tauri::command]
fn yt_control(app: AppHandle, cmd: String, arg: Option<f64>, service: Option<String>) -> R<()> {
    youtube::control_in(&app, service.as_deref(), &cmd, arg)
}

#[tauri::command]
fn adblock_stats() -> youtube::AdblockStats {
    youtube::stats()
}

#[tauri::command]
fn get_focus_config(s: State<AppState>) -> focus::FocusConfig {
    s.focus.config.lock().clone()
}

#[tauri::command]
fn set_focus_config(s: State<AppState>, cfg: focus::FocusConfig) -> R<()> {
    *s.focus.config.lock() = cfg.clone();
    s.lib.set_setting("focus", &serde_json::to_string(&cfg).map_err(|e| e.to_string())?)
}

#[tauri::command]
fn get_focus_state(s: State<AppState>) -> focus::FocusState {
    s.focus.state.lock().clone()
}

/// Scale the HUD window (base 400×140 logical px); the HUD page zooms its content to match.
#[tauri::command]
async fn set_hud_scale(app: AppHandle, scale: f64) -> R<()> {
    let s = scale.clamp(0.6, 2.0);
    if let Some(w) = app.get_webview_window("hud") {
        w.set_size(tauri::LogicalSize::new(400.0 * s, 140.0 * s)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// async: creating a window from a synchronous command deadlocks on Windows
#[tauri::command]
async fn show_hud(app: AppHandle, show: bool) -> R<()> {
    if let Some(w) = app.get_webview_window("hud") {
        if show {
            let _ = w.show();
        } else {
            let _ = w.hide();
        }
        return Ok(());
    }
    if !show {
        return Ok(());
    }
    let (x, y) = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .map(|mon| {
            let sz = mon.size();
            let sf = mon.scale_factor();
            (sz.width as f64 / sf - 420.0, 24.0)
        })
        .unwrap_or((1200.0, 24.0));
    WebviewWindowBuilder::new(&app, "hud", WebviewUrl::App("index.html".into()))
        .title("DriftKord HUD")
        .inner_size(400.0, 140.0)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .shadow(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn smtc_update(
    title: String,
    artist: String,
    album: String,
    cover: Option<String>,
    duration: f64,
    position: f64,
    playing: bool,
) -> R<()> {
    smtc::update(&title, &artist, &album, cover.as_deref(), duration, position, playing)
}

#[tauri::command]
fn get_launch_args(s: State<AppState>) -> Vec<String> {
    s.launch_args.clone()
}

// ============================================================================================

/// Data folder of builds made before the app id became `com.driftkord.app`.
const PREVIOUS_ID: &str = "com.walkmanaudiophile.player";
const APP_ID: &str = "com.driftkord.app";

/// How much a library holds: (tracks, total plays, settings) — read-only, never modified.
fn library_weight(dir: &std::path::Path) -> (i64, i64, i64) {
    let db = dir.join("library.db");
    if !db.is_file() {
        return (0, 0, 0);
    }
    let Ok(conn) = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { return (0, 0, 0) };
    let q = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, Option<i64>>(0)).ok().flatten().unwrap_or(0);
    (q("SELECT COUNT(*) FROM tracks"), q("SELECT SUM(play_count) FROM tracks"), q("SELECT COUNT(*) FROM settings"))
}

/// One-time move of the library, settings and web sign-ins from the previous app id's folders
/// (Roaming + Local). If both ids have data, the bigger library wins and the other set of folders
/// is kept as a dated backup next to it — nothing is deleted.
fn migrate_data_dirs() {
    let (Some(roaming), Some(local)) = (std::env::var_os("APPDATA"), std::env::var_os("LOCALAPPDATA")) else { return };
    let roots = [std::path::PathBuf::from(roaming), std::path::PathBuf::from(local)];
    if !roots.iter().any(|r| r.join(PREVIOUS_ID).is_dir()) {
        return;
    }
    let old_w = library_weight(&roots[0].join(PREVIOUS_ID));
    let new_w = library_weight(&roots[0].join(APP_ID));
    if roots[0].join(APP_ID).is_dir() && new_w >= old_w {
        return; // the current folders already hold the library
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    for root in &roots {
        let (old, new) = (root.join(PREVIOUS_ID), root.join(APP_ID));
        if !old.is_dir() {
            continue;
        }
        let backup = root.join(format!("{APP_ID}.backup-{stamp}"));
        let moved_aside = new.is_dir();
        if moved_aside && std::fs::rename(&new, &backup).is_err() {
            continue;
        }
        if std::fs::rename(&old, &new).is_err() && moved_aside {
            // the old folders are in use (an older DriftKord still running): leave everything as it
            // was and try again on the next launch
            let _ = std::fs::rename(&backup, &new);
        }
    }
}

fn main() {
    migrate_data_dirs();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let rest: Vec<String> = args.into_iter().skip(1).collect();
            let _ = app.emit("open-args", rest);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["hud", youtube::LABEL])
                .build(),
        )
        .on_window_event(|window, event| {
            // Closing the main window quits the whole app (no orphaned YouTube/HUD windows in the background).
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let lib = Arc::new(Library::open(&data_dir.join("library.db")).map_err(|e| e.to_string())?);
            let engine = Engine::start(handle.clone());
            if let Some(cfg) = lib.get_setting("output").and_then(|j| serde_json::from_str::<OutputConfig>(&j).ok()) {
                engine.set_output(cfg);
            }
            if let Some(p) = lib.get_setting("dsp").and_then(|j| serde_json::from_str::<DspParams>(&j).ok()) {
                engine.set_dsp(p);
            }
            formats::set_options(lib.get_setting("engineOptions").and_then(|j| serde_json::from_str::<formats::EngineOptions>(&j).ok()).unwrap_or_default());
            let focus = focus::FocusMonitor::start(handle.clone(), engine.clone());
            if let Some(c) = lib.get_setting("focus").and_then(|j| serde_json::from_str::<focus::FocusConfig>(&j).ok()) {
                *focus.config.lock() = c;
            }
            smtc::init(&handle);
            let launch_args: Vec<String> = std::env::args().skip(1).collect();
            let integ = integrations::Integrations::new(lib.clone());
            app.manage(AppState { engine, lib, integ, focus, launch_args });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_engine_options,
            set_engine_options,
            dlna_discover,
            set_cast_mute,
            dlna_play,
            dlna_control,
            dlna_status,
            ffmpeg_status,
            list_devices,
            list_asio_devices,
            asio_available,
            asio_control_panel,
            get_output,
            set_output,
            play_file,
            set_next,
            pause,
            stop,
            seek,
            set_volume,
            get_dsp,
            set_dsp,
            get_status,
            set_frame_rate,
            set_hud_scale,
            set_loopback,
            library_folders,
            library_add_folder,
            library_remove_folder,
            library_rescan,
            library_tracks,
            library_track,
            import_paths,
            analyze_library,
            analyze_track,
            record_play,
            set_rating,
            playlists_list,
            playlist_create,
            playlist_rename,
            playlist_delete,
            playlist_items,
            playlist_set_items,
            get_setting,
            set_setting,
            read_tags,
            write_tags,
            get_cover,
            set_cover,
            remove_cover,
            tags_from_filename,
            get_lyrics,
            save_lyrics,
            compute_replaygain,
            reveal_in_explorer,
            shell_status,
            shell_register,
            shell_unregister,
            open_default_apps,
            yt_open,
            yt_show_at,
            yt_hide,
            yt_route,
            yt_stream_stats,
            yt_control,
            video_search,
            video_warm,
            video_open,
            video_show_at,
            video_hide,
            video_cmd,
            video_close,
            mods_list,
            mods_import,
            mods_read,
            mods_write,
            mods_remove,
            mods_open_folder,
            save_text_file,
            integrations_get,
            integrations_set,
            open_url,
            lfm_begin,
            lfm_finish,
            lb_validate,
            maloja_test,
            scrobble_now_playing,
            scrobble_submit,
            scrobble_flush,
            scrobble_queue_len,
            discord_update,
            discord_clear,
            discord_test,
            stream_close,
            stream_loaded,
            adblock_stats,
            get_focus_config,
            set_focus_config,
            get_focus_state,
            show_hud,
            smtc_update,
            get_launch_args,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DriftKord");
}
