//! Outside integrations:
//!  * Discord Rich Presence — "Listening to …" on your Discord profile, over Discord's local IPC pipe
//!  * Scrobbling — Last.fm, Libre.fm (Last.fm-compatible API), ListenBrainz and a self-hosted Maloja
//! Settings (keys, tokens, sessions) live in DriftKord's local database. Scrobbles that fail (offline,
//! server down) are kept in a queue and sent later.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

use crate::library::Library;

const UA: &str = "DriftKord/1.0 (Windows music player)";
const CFG_KEY: &str = "integrations";
const QUEUE_KEY: &str = "scrobbleQueue";

// ============================================================================================ config
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LastfmCfg {
    pub enabled: bool,
    pub api_key: String,
    pub secret: String,
    pub session: String,
    pub user: String,
}
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ListenBrainzCfg {
    pub enabled: bool,
    pub token: String,
    pub user: String,
    /// API root, for self-hosted servers; empty = api.listenbrainz.org
    pub url: String,
}
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MalojaCfg {
    pub enabled: bool,
    pub url: String,
    pub key: String,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscordCfg {
    pub enabled: bool,
    pub app_id: String,
    /// look up album covers online (iTunes Search) for tracks without a web cover
    pub online_art: bool,
    pub show_when_paused: bool,
}
impl Default for DiscordCfg {
    fn default() -> Self {
        Self { enabled: false, app_id: String::new(), online_art: true, show_when_paused: false }
    }
}
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub discord: DiscordCfg,
    pub lastfm: LastfmCfg,
    pub librefm: LastfmCfg,
    pub listenbrainz: ListenBrainzCfg,
    pub maloja: MalojaCfg,
}

/// One play of a song, as sent to the scrobblers.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Play {
    pub artist: String,
    pub title: String,
    #[serde(default)]
    pub album: String,
    /// song length in seconds (0 = unknown)
    #[serde(default)]
    pub duration: u32,
    /// unix time the song started
    pub started_at: i64,
    /// where it came from: "local", "youtube", "spotify", …
    #[serde(default)]
    pub source: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Pending {
    service: String,
    play: Play,
}

pub struct Integrations {
    lib: Arc<Library>,
    cfg: Mutex<Config>,
    discord: Mutex<Option<DiscordConn>>,
    discord_last: Mutex<Option<String>>,
    art_cache: Mutex<std::collections::HashMap<String, Option<String>>>,
}

impl Integrations {
    pub fn new(lib: Arc<Library>) -> Arc<Self> {
        let cfg = lib.get_setting(CFG_KEY).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Arc::new(Self { lib, cfg: Mutex::new(cfg), discord: Mutex::new(None), discord_last: Mutex::new(None), art_cache: Mutex::new(Default::default()) })
    }
    pub fn config(&self) -> Config {
        self.cfg.lock().clone()
    }
    pub fn set_config(&self, c: Config) -> Result<(), String> {
        let discord_changed = {
            let old = self.cfg.lock();
            old.discord.app_id != c.discord.app_id || old.discord.enabled != c.discord.enabled
        };
        self.lib.set_setting(CFG_KEY, &serde_json::to_string(&c).map_err(|e| e.to_string())?)?;
        *self.cfg.lock() = c;
        if discord_changed {
            self.discord_clear();
            *self.discord.lock() = None;
        }
        Ok(())
    }
    fn save(&self) {
        let c = self.cfg.lock().clone();
        if let Ok(s) = serde_json::to_string(&c) {
            let _ = self.lib.set_setting(CFG_KEY, &s);
        }
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(12)).user_agent(UA).build()
}

fn http_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, r) => {
            let body = r.into_string().unwrap_or_default();
            // Last.fm style {"error":N,"message":"…"} or ListenBrainz {"error":"…"}
            let msg = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("message").or_else(|| v.get("error")).and_then(|m| m.as_str().map(String::from)))
                .unwrap_or_else(|| body.chars().take(160).collect());
            format!("HTTP {code}: {msg}")
        }
        ureq::Error::Transport(t) => format!("Network error: {t}"),
    }
}

// ============================================================================================ Last.fm / Libre.fm
struct LfmApi {
    root: &'static str,
    auth_page: &'static str,
}
const LASTFM: LfmApi = LfmApi { root: "https://ws.audioscrobbler.com/2.0/", auth_page: "https://www.last.fm/api/auth/" };
const LIBREFM: LfmApi = LfmApi { root: "https://libre.fm/2.0/", auth_page: "https://libre.fm/api/auth/" };
/// Libre.fm (GNU FM) accepts any 32-character key/secret pair, so DriftKord brings its own.
const LIBRE_KEY: &str = "d1f7c0de0a1b2c3d4e5f60718293a4b5";
const LIBRE_SECRET: &str = "5b4a3928170f6e5d4c3b2a1d0edc7f1d";

fn lfm_api(service: &str) -> Result<&'static LfmApi, String> {
    match service {
        "lastfm" => Ok(&LASTFM),
        "librefm" => Ok(&LIBREFM),
        _ => Err(format!("{service} doesn't use Last.fm-style sign-in")),
    }
}

fn lfm_sign(params: &[(&str, String)], secret: &str) -> String {
    let mut p: Vec<&(&str, String)> = params.iter().filter(|(k, _)| *k != "format" && *k != "callback").collect();
    p.sort_by(|a, b| a.0.cmp(b.0));
    let mut s = String::new();
    for (k, v) in p {
        s.push_str(k);
        s.push_str(v);
    }
    s.push_str(secret);
    format!("{:x}", md5::compute(s.as_bytes()))
}

fn lfm_call(api: &LfmApi, key: &str, secret: &str, mut params: Vec<(&str, String)>, post: bool) -> Result<serde_json::Value, String> {
    params.push(("api_key", key.to_string()));
    let sig = lfm_sign(&params, secret);
    params.push(("api_sig", sig));
    params.push(("format", "json".into()));
    let a = agent();
    let resp = if post {
        let form: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
        a.post(api.root).send_form(&form)
    } else {
        let mut req = a.get(api.root);
        for (k, v) in &params {
            req = req.query(k, v);
        }
        req.call()
    };
    let v: serde_json::Value = resp.map_err(http_err)?.into_json().map_err(|e| e.to_string())?;
    if let Some(code) = v.get("error") {
        return Err(format!("{} (error {code})", v.get("message").and_then(|m| m.as_str()).unwrap_or("request refused")));
    }
    Ok(v)
}

impl Integrations {
    fn lfm_keys(&self, service: &str) -> Result<(String, String), String> {
        let c = self.cfg.lock();
        if service == "librefm" {
            return Ok((LIBRE_KEY.into(), LIBRE_SECRET.into()));
        }
        let l = &c.lastfm;
        if l.api_key.trim().len() != 32 || l.secret.trim().len() != 32 {
            return Err("Enter your Last.fm API key and shared secret first (32 characters each).".into());
        }
        Ok((l.api_key.trim().into(), l.secret.trim().into()))
    }

    /// Step 1 of connecting: get a request token and the page where you approve DriftKord.
    pub fn lfm_begin(&self, service: &str) -> Result<(String, String), String> {
        let api = lfm_api(service)?;
        let (key, secret) = self.lfm_keys(service)?;
        let v = lfm_call(api, &key, &secret, vec![("method", "auth.getToken".into())], false)?;
        let token = v.get("token").and_then(|t| t.as_str()).ok_or("No token in reply")?.to_string();
        let url = format!("{}?api_key={}&token={}", api.auth_page, key, token);
        Ok((token, url))
    }

    /// Step 2: after you approved in the browser, swap the token for a permanent session.
    pub fn lfm_finish(&self, service: &str, token: &str) -> Result<String, String> {
        let api = lfm_api(service)?;
        let (key, secret) = self.lfm_keys(service)?;
        let v = lfm_call(api, &key, &secret, vec![("method", "auth.getSession".into()), ("token", token.into())], false)
            .map_err(|e| format!("{e}. Approve DriftKord in the browser page first, then press Finish."))?;
        let s = v.get("session").ok_or("No session in reply")?;
        let sk = s.get("key").and_then(|x| x.as_str()).ok_or("No session key")?.to_string();
        let name = s.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
        {
            let mut c = self.cfg.lock();
            let t = if service == "lastfm" { &mut c.lastfm } else { &mut c.librefm };
            t.session = sk;
            t.user = name.clone();
            t.enabled = true;
            if service == "librefm" {
                t.api_key = LIBRE_KEY.into();
                t.secret = LIBRE_SECRET.into();
            }
        }
        self.save();
        Ok(name)
    }

    fn lfm_track_params(p: &Play) -> Vec<(&'static str, String)> {
        let mut v = vec![("artist", p.artist.clone()), ("track", p.title.clone())];
        if !p.album.is_empty() {
            v.push(("album", p.album.clone()));
        }
        if p.duration > 0 {
            v.push(("duration", p.duration.to_string()));
        }
        v
    }

    fn lfm_send(&self, service: &str, p: &Play, now_playing: bool) -> Result<(), String> {
        let api = lfm_api(service)?;
        let (key, secret) = self.lfm_keys(service)?;
        let sk = {
            let c = self.cfg.lock();
            if service == "lastfm" { c.lastfm.session.clone() } else { c.librefm.session.clone() }
        };
        if sk.is_empty() {
            return Err("Not connected".into());
        }
        let mut params = Self::lfm_track_params(p);
        params.push(("sk", sk));
        if now_playing {
            params.push(("method", "track.updateNowPlaying".into()));
        } else {
            params.push(("method", "track.scrobble".into()));
            params.push(("timestamp", p.started_at.to_string()));
            params.push(("chosenByUser", "1".into()));
        }
        let v = lfm_call(api, &key, &secret, params, true)?;
        if !now_playing {
            // Last.fm answers 200 but may still ignore a scrobble (e.g. bad metadata)
            let ignored = v.pointer("/scrobbles/@attr/ignored").and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0);
            if ignored > 0 {
                let why = v.pointer("/scrobbles/scrobble/ignoredMessage/#text").and_then(|x| x.as_str()).unwrap_or("ignored by server");
                return Err(format!("Ignored: {why}"));
            }
        }
        Ok(())
    }
}

// ============================================================================================ ListenBrainz
impl Integrations {
    fn lb_root(&self) -> String {
        let u = self.cfg.lock().listenbrainz.url.trim().trim_end_matches('/').to_string();
        if u.is_empty() { "https://api.listenbrainz.org".into() } else { u }
    }
    pub fn lb_validate(&self, token: &str) -> Result<String, String> {
        let v: serde_json::Value = agent()
            .get(&format!("{}/1/validate-token", self.lb_root()))
            .set("Authorization", &format!("Token {}", token.trim()))
            .call()
            .map_err(http_err)?
            .into_json()
            .map_err(|e| e.to_string())?;
        if v.get("valid").and_then(|x| x.as_bool()) == Some(true) {
            Ok(v.get("user_name").and_then(|x| x.as_str()).unwrap_or("").to_string())
        } else {
            Err("ListenBrainz says this token isn't valid".into())
        }
    }
    fn lb_send(&self, p: &Play, now_playing: bool) -> Result<(), String> {
        let token = self.cfg.lock().listenbrainz.token.trim().to_string();
        if token.is_empty() {
            return Err("No ListenBrainz token".into());
        }
        let service_domain = match p.source.as_str() {
            "youtube" => Some("music.youtube.com"),
            "spotify" => Some("spotify.com"),
            "apple" => Some("music.apple.com"),
            "tidal" => Some("tidal.com"),
            "amazon" => Some("music.amazon.com"),
            _ => None,
        };
        let mut info = serde_json::json!({
            "media_player": "DriftKord",
            "submission_client": "DriftKord",
            "submission_client_version": env!("CARGO_PKG_VERSION"),
        });
        if p.duration > 0 {
            info["duration_ms"] = (p.duration as u64 * 1000).into();
        }
        if let Some(d) = service_domain {
            info["music_service"] = d.into();
        }
        let mut meta = serde_json::json!({ "artist_name": p.artist, "track_name": p.title, "additional_info": info });
        if !p.album.is_empty() {
            meta["release_name"] = p.album.clone().into();
        }
        let mut listen = serde_json::json!({ "track_metadata": meta });
        if !now_playing {
            listen["listened_at"] = p.started_at.into();
        }
        let body = serde_json::json!({ "listen_type": if now_playing { "playing_now" } else { "single" }, "payload": [listen] });
        agent()
            .post(&format!("{}/1/submit-listens", self.lb_root()))
            .set("Authorization", &format!("Token {token}"))
            .send_json(body)
            .map_err(http_err)?;
        Ok(())
    }
}

// ============================================================================================ Maloja
impl Integrations {
    fn maloja_root(&self) -> Result<(String, String), String> {
        let c = self.cfg.lock();
        let url = c.maloja.url.trim().trim_end_matches('/').to_string();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("Enter your Maloja server address, e.g. http://localhost:42010".into());
        }
        Ok((url, c.maloja.key.trim().to_string()))
    }
    pub fn maloja_test(&self) -> Result<String, String> {
        let (url, key) = self.maloja_root()?;
        let v: serde_json::Value = agent()
            .get(&format!("{url}/apis/mlj_1/test"))
            .query("key", &key)
            .call()
            .map_err(http_err)?
            .into_json()
            .map_err(|e| e.to_string())?;
        Ok(v.get("status").and_then(|s| s.as_str()).unwrap_or("ok").to_string())
    }
    fn maloja_send(&self, p: &Play, played: u32) -> Result<(), String> {
        let (url, key) = self.maloja_root()?;
        let mut body = serde_json::json!({ "key": key, "artists": [p.artist], "title": p.title, "time": p.started_at });
        if !p.album.is_empty() {
            body["album"] = p.album.clone().into();
        }
        if p.duration > 0 {
            body["length"] = p.duration.into();
        }
        if played > 0 {
            body["duration"] = played.into();
        }
        agent().post(&format!("{url}/apis/mlj_1/newscrobble")).send_json(body).map_err(http_err)?;
        Ok(())
    }
}

// ============================================================================================ dispatch + offline queue
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServiceResult {
    pub service: String,
    pub ok: bool,
    pub message: String,
}

impl Integrations {
    fn enabled_services(&self) -> Vec<&'static str> {
        let c = self.cfg.lock();
        let mut v = vec![];
        if c.lastfm.enabled && !c.lastfm.session.is_empty() { v.push("lastfm"); }
        if c.librefm.enabled && !c.librefm.session.is_empty() { v.push("librefm"); }
        if c.listenbrainz.enabled && !c.listenbrainz.token.is_empty() { v.push("listenbrainz"); }
        if c.maloja.enabled && !c.maloja.url.is_empty() { v.push("maloja"); }
        v
    }

    fn send_one(&self, service: &str, p: &Play, now_playing: bool, played: u32) -> Result<(), String> {
        match service {
            "lastfm" | "librefm" => self.lfm_send(service, p, now_playing),
            "listenbrainz" => self.lb_send(p, now_playing),
            "maloja" => if now_playing { Ok(()) } else { self.maloja_send(p, played) },
            _ => Err("unknown service".into()),
        }
    }

    pub fn now_playing(&self, p: &Play) -> Vec<ServiceResult> {
        self.enabled_services()
            .into_iter()
            .map(|s| {
                let r = self.send_one(s, p, true, 0);
                ServiceResult { service: s.into(), ok: r.is_ok(), message: r.err().unwrap_or_default() }
            })
            .collect()
    }

    pub fn scrobble(&self, p: &Play, played: u32) -> Vec<ServiceResult> {
        let mut out = vec![];
        for s in self.enabled_services() {
            let r = self.send_one(s, p, false, played);
            if let Err(e) = &r {
                // network/server trouble: keep it for later. Rejections (bad metadata) are dropped.
                if e.starts_with("Network error") || e.starts_with("HTTP 5") || e.contains("error 11") || e.contains("error 16") {
                    self.enqueue(s, p);
                }
            }
            out.push(ServiceResult { service: s.into(), ok: r.is_ok(), message: r.err().unwrap_or_default() });
        }
        out
    }

    fn load_queue(&self) -> Vec<Pending> {
        self.lib.get_setting(QUEUE_KEY).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }
    fn store_queue(&self, q: &[Pending]) {
        if let Ok(s) = serde_json::to_string(q) {
            let _ = self.lib.set_setting(QUEUE_KEY, &s);
        }
    }
    fn enqueue(&self, service: &str, p: &Play) {
        let mut q = self.load_queue();
        q.push(Pending { service: service.into(), play: p.clone() });
        let n = q.len();
        if n > 2000 {
            q.drain(0..n - 2000);
        }
        self.store_queue(&q);
    }
    pub fn queue_len(&self) -> usize {
        self.load_queue().len()
    }
    /// Retry queued scrobbles; returns how many are still waiting.
    pub fn flush(&self) -> usize {
        let q = self.load_queue();
        if q.is_empty() {
            return 0;
        }
        let enabled = self.enabled_services();
        let mut keep = vec![];
        let mut offline = false;
        for item in q {
            if !enabled.contains(&item.service.as_str()) {
                keep.push(item);
                continue;
            }
            if offline {
                keep.push(item);
                continue;
            }
            match self.send_one(&item.service, &item.play, false, 0) {
                Ok(()) => {}
                Err(e) if e.starts_with("Network error") || e.starts_with("HTTP 5") => {
                    offline = true;
                    keep.push(item);
                }
                Err(_) => {} // rejected for good
            }
        }
        self.store_queue(&keep);
        keep.len()
    }
}

// ============================================================================================ Discord Rich Presence
struct DiscordConn {
    pipe: std::fs::File,
}

impl DiscordConn {
    fn connect(app_id: &str) -> Result<Self, String> {
        let mut last = String::from("Discord isn't running");
        for i in 0..10 {
            let path = format!(r"\\.\pipe\discord-ipc-{i}");
            match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
                Ok(pipe) => {
                    let mut c = DiscordConn { pipe };
                    c.send(0, &serde_json::json!({ "v": 1, "client_id": app_id }))?;
                    let (op, reply) = c.recv()?;
                    if op == 2 || reply.get("evt").and_then(|e| e.as_str()) == Some("ERROR") {
                        return Err(format!("Discord refused the connection: {}", reply.pointer("/data/message").or(reply.get("message")).and_then(|m| m.as_str()).unwrap_or("check the Application ID")));
                    }
                    return Ok(c);
                }
                Err(e) => last = format!("Discord isn't running ({e})"),
            }
        }
        Err(last)
    }
    fn send(&mut self, op: u32, v: &serde_json::Value) -> Result<(), String> {
        let body = serde_json::to_vec(v).map_err(|e| e.to_string())?;
        let mut frame = Vec::with_capacity(8 + body.len());
        frame.extend_from_slice(&op.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);
        self.pipe.write_all(&frame).map_err(|e| e.to_string())
    }
    fn recv(&mut self) -> Result<(u32, serde_json::Value), String> {
        let mut head = [0u8; 8];
        self.pipe.read_exact(&mut head).map_err(|e| e.to_string())?;
        let op = u32::from_le_bytes(head[0..4].try_into().unwrap());
        let len = u32::from_le_bytes(head[4..8].try_into().unwrap()) as usize;
        if len > 1 << 20 {
            return Err("bad frame from Discord".into());
        }
        let mut body = vec![0u8; len];
        self.pipe.read_exact(&mut body).map_err(|e| e.to_string())?;
        Ok((op, serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null)))
    }
    fn command(&mut self, activity: serde_json::Value) -> Result<(), String> {
        let nonce = format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        self.send(1, &serde_json::json!({ "cmd": "SET_ACTIVITY", "args": { "pid": std::process::id(), "activity": activity }, "nonce": nonce }))?;
        let (_, reply) = self.recv()?;
        if reply.get("evt").and_then(|e| e.as_str()) == Some("ERROR") {
            return Err(reply.pointer("/data/message").and_then(|m| m.as_str()).unwrap_or("Discord rejected the update").to_string());
        }
        Ok(())
    }
}

/// What the player tells Discord.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    pub playing: bool,
    /// seconds into the song
    #[serde(default)]
    pub position: f64,
    #[serde(default)]
    pub duration: f64,
    /// https cover (streaming services) if known
    #[serde(default)]
    pub art_url: Option<String>,
    /// "local", "youtube", "spotify", …
    #[serde(default)]
    pub source: String,
}

fn clip(s: &str, max: usize) -> String {
    let t: String = s.chars().take(max).collect();
    if t.chars().count() < 2 { format!("{t}  ") } else { t }
}

impl Integrations {
    /// Cover from iTunes Search for songs that have no web cover (local files). Opt-in setting.
    fn lookup_art(&self, artist: &str, title: &str, album: &str) -> Option<String> {
        let key = format!("{artist}|{album}|{title}").to_lowercase();
        if let Some(hit) = self.art_cache.lock().get(&key) {
            return hit.clone();
        }
        let term = if album.is_empty() { format!("{artist} {title}") } else { format!("{artist} {album}") };
        let found = agent()
            .get("https://itunes.apple.com/search")
            .query("term", &term)
            .query("media", "music")
            .query("entity", if album.is_empty() { "song" } else { "album" })
            .query("limit", "1")
            .call()
            .ok()
            .and_then(|r| r.into_json::<serde_json::Value>().ok())
            .and_then(|v| v.pointer("/results/0/artworkUrl100").and_then(|u| u.as_str()).map(|u| u.replace("100x100bb", "512x512bb")));
        self.art_cache.lock().insert(key, found.clone());
        found
    }

    pub fn discord_update(&self, p: &Presence) -> Result<(), String> {
        let cfg = self.cfg.lock().discord.clone();
        if !cfg.enabled {
            return Ok(());
        }
        if cfg.app_id.trim().is_empty() || !cfg.app_id.trim().chars().all(|c| c.is_ascii_digit()) {
            return Err("Enter your Discord Application ID (a long number) in Settings → Integrations".into());
        }
        if !p.playing && !cfg.show_when_paused {
            self.discord_clear();
            return Ok(());
        }
        let art = p.art_url.clone().filter(|u| u.starts_with("https://"))
            .or_else(|| if cfg.online_art && !p.artist.is_empty() { self.lookup_art(&p.artist, &p.title, &p.album) } else { None });
        let source = match p.source.as_str() {
            "youtube" => "YouTube Music",
            "spotify" => "Spotify",
            "apple" => "Apple Music",
            "tidal" => "TIDAL",
            "amazon" => "Amazon Music",
            _ => "DriftKord",
        };
        let mut activity = serde_json::json!({
            "type": 2, // Listening to
            "details": clip(&p.title, 128),
            "state": clip(&if p.artist.is_empty() { source.to_string() } else { format!("by {}", p.artist) }, 128),
            "instance": false,
        });
        let mut assets = serde_json::Map::new();
        if let Some(u) = art {
            assets.insert("large_image".into(), u.into());
        }
        assets.insert(
            "large_text".into(),
            clip(&if p.album.is_empty() { format!("via {source}") } else { format!("{} · via {source}", p.album) }, 128).into(),
        );
        if !p.playing {
            assets.insert("small_text".into(), "Paused".into());
        }
        activity["assets"] = assets.into();
        if p.playing && p.duration > 0.0 {
            let ms_now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            let start = ms_now - (p.position * 1000.0) as i64;
            activity["timestamps"] = serde_json::json!({ "start": start, "end": start + (p.duration * 1000.0) as i64 });
        }
        // skip identical updates (Discord rate-limits to ~5 per 20 s)
        let sig = activity.to_string();
        let sig_cmp = sig.replace(|c: char| c.is_ascii_digit(), "");
        if self.discord_last.lock().as_deref() == Some(&sig_cmp) && p.duration <= 0.0 {
            return Ok(());
        }
        let mut guard = self.discord.lock();
        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(DiscordConn::connect(cfg.app_id.trim())?);
            }
            match guard.as_mut().unwrap().command(activity.clone()) {
                Ok(()) => {
                    *self.discord_last.lock() = Some(sig_cmp);
                    return Ok(());
                }
                Err(e) => {
                    *guard = None; // Discord restarted: reconnect once
                    if attempt == 1 {
                        return Err(e);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn discord_clear(&self) {
        *self.discord_last.lock() = None;
        let mut guard = self.discord.lock();
        if let Some(c) = guard.as_mut() {
            if c.command(serde_json::Value::Null).is_err() {
                *guard = None;
            }
        }
    }

    pub fn discord_test(&self) -> Result<(), String> {
        let id = self.cfg.lock().discord.app_id.trim().to_string();
        if id.is_empty() {
            return Err("Enter your Discord Application ID first".into());
        }
        *self.discord.lock() = None;
        let mut c = DiscordConn::connect(&id)?;
        c.command(serde_json::json!({ "type": 2, "details": "DriftKord is connected", "state": "Your music will show here", "instance": false }))?;
        *self.discord.lock() = Some(c);
        *self.discord_last.lock() = None;
        Ok(())
    }
}
