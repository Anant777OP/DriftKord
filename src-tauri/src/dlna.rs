//! UPnP / DLNA casting: find network players (MediaRenderers), serve the track over HTTP from this
//! PC and drive the player with AVTransport / RenderingControl.
//!
//! Files the renderer can play natively are served byte-for-byte (bit-perfect: the renderer decodes
//! the original FLAC/WAV/ALAC/…). Anything else — CUE-sheet tracks, DSD, APE, Dolby, SACD images —
//! is decoded here and streamed as lossless 24-bit WAV.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Renderer {
    /// description URL (unique per device)
    pub id: String,
    pub name: String,
    pub model: String,
    pub av_url: String,
    pub rc_url: String,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CastStatus {
    pub state: String,
    pub position: f64,
    pub duration: f64,
}

fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let i = xml.find(&open)? + open.len();
    let j = xml[i..].find(&format!("</{name}>"))? + i;
    Some(xml[i..j].trim())
}

fn join_url(base: &str, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    let origin = match base.find("://").and_then(|i| base[i + 3..].find('/').map(|j| i + 3 + j)) {
        Some(k) => &base[..k],
        None => base.trim_end_matches('/'),
    };
    if path.starts_with('/') {
        format!("{origin}{path}")
    } else {
        format!("{origin}/{path}")
    }
}

/// Look for MediaRenderers on the local network (takes ~2.5 s).
pub fn discover() -> Vec<Renderer> {
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return Vec::new() };
    let _ = sock.set_read_timeout(Some(Duration::from_millis(300)));
    let _ = sock.set_multicast_ttl_v4(2);
    for st in ["urn:schemas-upnp-org:device:MediaRenderer:1", "urn:schemas-upnp-org:service:AVTransport:1"] {
        let msg = format!("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {st}\r\n\r\n");
        let _ = sock.send_to(msg.as_bytes(), "239.255.255.250:1900");
    }
    let mut locations = Vec::new();
    let end = std::time::Instant::now() + Duration::from_millis(2600);
    let mut buf = [0u8; 4096];
    while std::time::Instant::now() < end {
        if let Ok((n, _)) = sock.recv_from(&mut buf) {
            let txt = String::from_utf8_lossy(&buf[..n]);
            for line in txt.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    if k.trim().eq_ignore_ascii_case("location") {
                        let v = v.trim().to_string();
                        if !locations.contains(&v) {
                            locations.push(v);
                        }
                    }
                }
            }
        }
    }
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(3)).build();
    let mut out = Vec::new();
    for loc in locations {
        let Ok(resp) = agent.get(&loc).call() else { continue };
        let Ok(xml) = resp.into_string() else { continue };
        let base = tag(&xml, "URLBase").map(|s| s.to_string()).unwrap_or_else(|| loc.clone());
        let (mut av, mut rc) = (String::new(), String::new());
        for svc in xml.split("<service>").skip(1) {
            let ty = tag(svc, "serviceType").unwrap_or("");
            let ctl = tag(svc, "controlURL").unwrap_or("");
            if ty.contains("AVTransport") && av.is_empty() {
                av = join_url(&base, ctl);
            } else if ty.contains("RenderingControl") && rc.is_empty() {
                rc = join_url(&base, ctl);
            }
        }
        if av.is_empty() {
            continue;
        }
        out.push(Renderer {
            id: loc.clone(),
            name: tag(&xml, "friendlyName").unwrap_or("Network player").to_string(),
            model: tag(&xml, "modelName").unwrap_or("").to_string(),
            av_url: av,
            rc_url: rc,
        });
    }
    out
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn soap(url: &str, service: &str, action: &str, args: &str) -> Result<String, String> {
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"urn:schemas-upnp-org:service:{service}:1\">{args}</u:{action}></s:Body></s:Envelope>"
    );
    let r = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(5))
        .build()
        .post(url)
        .set("Content-Type", "text/xml; charset=\"utf-8\"")
        .set("SOAPAction", &format!("\"urn:schemas-upnp-org:service:{service}:1#{action}\""))
        .send_string(&body);
    match r {
        Ok(resp) => resp.into_string().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, resp)) => {
            let t = resp.into_string().unwrap_or_default();
            Err(format!("{action} failed ({code}) {}", tag(&t, "errorDescription").unwrap_or("")))
        }
        Err(e) => Err(format!("{action}: {e}")),
    }
}

fn hms(s: f64) -> String {
    let s = s.max(0.0) as u64;
    format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}
fn parse_hms(s: &str) -> f64 {
    let p: Vec<f64> = s.split(':').filter_map(|x| x.trim().parse().ok()).collect();
    match p.len() {
        3 => p[0] * 3600.0 + p[1] * 60.0 + p[2],
        2 => p[0] * 60.0 + p[1],
        _ => 0.0,
    }
}

// ---------------------------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------------------------

struct Served {
    path: String,
    transcode: bool,
    mime: String,
}

static SERVED: Mutex<Option<HashMap<String, Served>>> = Mutex::new(None);
static PORT: Mutex<u16> = Mutex::new(0);

fn ensure_server() -> Result<u16, String> {
    let mut port = PORT.lock();
    if *port != 0 {
        return Ok(*port);
    }
    let l = TcpListener::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    *port = l.local_addr().map_err(|e| e.to_string())?.port();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            std::thread::spawn(move || {
                let _ = serve(s);
            });
        }
    });
    Ok(*port)
}

fn native_mime(path: &str) -> Option<&'static str> {
    let ext = std::path::Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "flac" => "audio/flac",
        "wav" | "wave" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" | "alac" | "aac" => "audio/mp4",
        "ogg" | "oga" => "audio/ogg",
        "aif" | "aiff" | "aifc" => "audio/aiff",
        _ => return None,
    })
}

fn serve(mut s: TcpStream) -> std::io::Result<()> {
    s.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut r = BufReader::new(s.try_clone()?);
    let mut first = String::new();
    r.read_line(&mut first)?;
    let mut range: Option<(u64, Option<u64>)> = None;
    loop {
        let mut h = String::new();
        if r.read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                if let Some(b) = v.trim().strip_prefix("bytes=") {
                    let (a, z) = b.split_once('-').unwrap_or((b, ""));
                    range = a.parse().ok().map(|a| (a, z.trim().parse().ok()));
                }
            }
        }
    }
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let (route, query) = target.split_once('?').unwrap_or((&target, ""));
    let token = route.trim_start_matches('/').trim_start_matches("t/").split('.').next().unwrap_or("").to_string();
    let start: f64 = query.split('&').find_map(|kv| kv.strip_prefix("start=")).and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let item = SERVED.lock().as_ref().and_then(|m| m.get(&token).map(|x| (x.path.clone(), x.transcode, x.mime.clone())));
    let Some((path, transcode, mime)) = item else {
        s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
        return Ok(());
    };
    let dlna = "transferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n";
    if !transcode {
        let mut f = std::fs::File::open(&path)?;
        let len = f.metadata()?.len();
        let (a, z) = match range {
            Some((a, z)) => (a.min(len), z.unwrap_or(len - 1).min(len - 1)),
            None => (0, len.saturating_sub(1)),
        };
        let n = z + 1 - a;
        let head = if range.is_some() {
            format!("HTTP/1.1 206 Partial Content\r\nContent-Type: {mime}\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {a}-{z}/{len}\r\nContent-Length: {n}\r\n{dlna}Connection: close\r\n\r\n")
        } else {
            format!("HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nAccept-Ranges: bytes\r\nContent-Length: {len}\r\n{dlna}Connection: close\r\n\r\n")
        };
        s.write_all(head.as_bytes())?;
        if method == "HEAD" {
            return Ok(());
        }
        f.seek(SeekFrom::Start(a))?;
        std::io::copy(&mut f.take(n), &mut s)?;
        return Ok(());
    }
    // decode -> 24-bit WAV stream
    let mut src = crate::formats::probing(|| crate::decoder::open(std::path::Path::new(&path), false)).map_err(std::io::Error::other)?;
    let info = src.info().clone();
    let rate = info.sample_rate.max(8_000);
    if start > 0.0 {
        src.seek(start);
    }
    let frames = ((info.duration - start).max(0.0) * rate as f64) as u64;
    let data_len = if frames > 0 { (frames * 6).min(u32::MAX as u64 - 64) as u32 } else { u32::MAX - 64 };
    let mut hdr = Vec::with_capacity(44);
    hdr.extend_from_slice(b"RIFF");
    hdr.extend_from_slice(&(data_len + 36).to_le_bytes());
    hdr.extend_from_slice(b"WAVEfmt ");
    hdr.extend_from_slice(&16u32.to_le_bytes());
    hdr.extend_from_slice(&1u16.to_le_bytes());
    hdr.extend_from_slice(&2u16.to_le_bytes());
    hdr.extend_from_slice(&rate.to_le_bytes());
    hdr.extend_from_slice(&(rate * 6).to_le_bytes());
    hdr.extend_from_slice(&6u16.to_le_bytes());
    hdr.extend_from_slice(&24u16.to_le_bytes());
    hdr.extend_from_slice(b"data");
    hdr.extend_from_slice(&data_len.to_le_bytes());
    let head = format!("HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\n{dlna}Connection: close\r\n\r\n", data_len as u64 + 44);
    s.write_all(head.as_bytes())?;
    if method == "HEAD" {
        return Ok(());
    }
    s.write_all(&hdr)?;
    let mut sent = 0u64;
    let mut buf = Vec::new();
    let mut bytes = Vec::new();
    while sent < data_len as u64 {
        buf.clear();
        if !src.decode_more(&mut buf) {
            break;
        }
        bytes.clear();
        for &x in &buf {
            let v = (x as f64 * 8_388_608.0).round().clamp(-8_388_608.0, 8_388_607.0) as i32;
            bytes.extend_from_slice(&v.to_le_bytes()[0..3]);
        }
        let take = (bytes.len() as u64).min(data_len as u64 - sent) as usize;
        s.write_all(&bytes[..take])?;
        sent += take as u64;
    }
    // pad to the promised length so the renderer doesn't wait
    while sent < data_len as u64 {
        let n = (data_len as u64 - sent).min(65_536) as usize;
        s.write_all(&vec![0u8; n])?;
        sent += n as u64;
    }
    Ok(())
}

fn local_ip_for(url: &str) -> Option<IpAddr> {
    let host = url.split("://").nth(1)?.split('/').next()?;
    let addr: SocketAddr = std::net::ToSocketAddrs::to_socket_addrs(&(if host.contains(':') { host.to_string() } else { format!("{host}:80") }))
        .ok()?
        .next()?;
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect(addr).ok()?;
    Some(s.local_addr().ok()?.ip())
}

/// Cast a track (local path, CUE/ISO virtual path, anything the engine plays) to a renderer.
pub fn play(r: &Renderer, path: &str, title: &str, artist: &str, album: &str, start: f64) -> Result<(), String> {
    let port = ensure_server()?;
    let ip = local_ip_for(&r.av_url).ok_or("Can't reach that player from this PC")?;
    let native = if path.contains('?') { None } else { native_mime(path) };
    let token = format!("{:016x}", {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        path.hash(&mut h);
        h.finish()
    });
    let mime = native.unwrap_or("audio/wav").to_string();
    let ext = if native.is_some() { std::path::Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("bin").to_string() } else { "wav".into() };
    SERVED.lock().get_or_insert_with(HashMap::new).insert(token.clone(), Served { path: path.to_string(), transcode: native.is_none(), mime: mime.clone() });
    let start_q = if native.is_none() && start > 0.5 { format!("?start={start:.2}") } else { String::new() };
    let url = format!("http://{ip}:{port}/t/{token}.{ext}{start_q}");
    let didl = format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"1\" parentID=\"0\" restricted=\"1\"><dc:title>{}</dc:title><upnp:artist>{}</upnp:artist><upnp:album>{}</upnp:album><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo=\"http-get:*:{mime}:*\">{}</res></item></DIDL-Lite>",
        esc(title),
        esc(artist),
        esc(album),
        esc(&url)
    );
    let _ = soap(&r.av_url, "AVTransport", "Stop", "<InstanceID>0</InstanceID>");
    soap(&r.av_url, "AVTransport", "SetAVTransportURI", &format!("<InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI><CurrentURIMetaData>{}</CurrentURIMetaData>", esc(&url), esc(&didl)))?;
    soap(&r.av_url, "AVTransport", "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>")?;
    if native.is_some() && start > 0.5 {
        std::thread::sleep(Duration::from_millis(700));
        let _ = seek(r, start);
    }
    Ok(())
}

pub fn seek(r: &Renderer, secs: f64) -> Result<(), String> {
    soap(&r.av_url, "AVTransport", "Seek", &format!("<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{}</Target>", hms(secs))).map(|_| ())
}

pub fn control(r: &Renderer, cmd: &str, arg: Option<f64>) -> Result<(), String> {
    match cmd {
        "play" => soap(&r.av_url, "AVTransport", "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>").map(|_| ()),
        "pause" => soap(&r.av_url, "AVTransport", "Pause", "<InstanceID>0</InstanceID>").map(|_| ()),
        "stop" => soap(&r.av_url, "AVTransport", "Stop", "<InstanceID>0</InstanceID>").map(|_| ()),
        "seek" => seek(r, arg.unwrap_or(0.0)),
        "volume" => {
            if r.rc_url.is_empty() {
                return Ok(());
            }
            let v = (arg.unwrap_or(0.5).clamp(0.0, 1.0) * 100.0).round() as u32;
            soap(&r.rc_url, "RenderingControl", "SetVolume", &format!("<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>{v}</DesiredVolume>")).map(|_| ())
        }
        _ => Err(format!("unknown cast command {cmd}")),
    }
}

pub fn status(r: &Renderer) -> Result<CastStatus, String> {
    let pos = soap(&r.av_url, "AVTransport", "GetPositionInfo", "<InstanceID>0</InstanceID>")?;
    let st = soap(&r.av_url, "AVTransport", "GetTransportInfo", "<InstanceID>0</InstanceID>").unwrap_or_default();
    Ok(CastStatus {
        state: tag(&st, "CurrentTransportState").unwrap_or("UNKNOWN").to_string(),
        position: tag(&pos, "RelTime").map(parse_hms).unwrap_or(0.0),
        duration: tag(&pos, "TrackDuration").map(parse_hms).unwrap_or(0.0),
    })
}
