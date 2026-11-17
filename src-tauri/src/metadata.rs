//! Metadata tooling built on lofty: tag reading for the library scanner, a batch tag editor,
//! cover art get/set/remove, tag-from-filename parsing, lyrics (embedded + .lrc sidecar)
//! and ReplayGain 2.0 tagging (EBU R128, −18 LUFS reference).

use base64::Engine as _;
use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::Tag;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Default, Debug, Clone)]
pub struct Basic {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub year: Option<i64>,
    pub track_no: Option<i64>,
    pub disc_no: Option<i64>,
    pub duration: f64,
    pub sample_rate: i64,
    pub bit_depth: i64,
    pub channels: i64,
    pub codec: String,
    pub bitrate: i64,
    pub rg_track_gain: Option<f64>,
    pub rg_track_peak: Option<f64>,
    pub rg_album_gain: Option<f64>,
    pub rg_album_peak: Option<f64>,
    pub has_cover: bool,
}

fn parse_db(s: &str) -> Option<f64> {
    s.trim().trim_end_matches("dB").trim_end_matches("db").trim().parse::<f64>().ok()
}

fn parse_num(s: &str) -> Option<i64> {
    s.split('/').next().and_then(|v| v.trim().parse::<i64>().ok())
}

fn stem(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
}

/// Read what the library needs. Never fails: falls back to the decoder + filename.
pub fn read_basic(path: &Path) -> Basic {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_uppercase();
    let mut b = Basic { title: stem(path), codec: ext.clone(), ..Default::default() };
    if let Ok(tf) = lofty::read_from_path(path) {
        let p = tf.properties();
        b.duration = p.duration().as_secs_f64();
        b.sample_rate = p.sample_rate().unwrap_or(0) as i64;
        b.bit_depth = p.bit_depth().unwrap_or(0) as i64;
        b.channels = p.channels().unwrap_or(2) as i64;
        b.bitrate = p.audio_bitrate().unwrap_or(0) as i64;
        if let Some(t) = tf.primary_tag().or_else(|| tf.first_tag()) {
            if let Some(v) = t.title() {
                if !v.trim().is_empty() {
                    b.title = v.to_string();
                }
            }
            b.artist = t.artist().map(|s| s.to_string()).unwrap_or_default();
            b.album = t.album().map(|s| s.to_string()).unwrap_or_default();
            b.genre = t.genre().map(|s| s.to_string()).unwrap_or_default();
            b.album_artist = t.get_string(&ItemKey::AlbumArtist).unwrap_or("").to_string();
            b.year = t.year().map(|y| y as i64).or_else(|| {
                t.get_string(&ItemKey::RecordingDate).and_then(|d| d.get(0..4)).and_then(|y| y.parse().ok())
            });
            b.track_no = t.track().map(|v| v as i64);
            b.disc_no = t.get_string(&ItemKey::DiscNumber).and_then(parse_num);
            b.rg_track_gain = t.get_string(&ItemKey::ReplayGainTrackGain).and_then(parse_db);
            b.rg_track_peak = t.get_string(&ItemKey::ReplayGainTrackPeak).and_then(parse_db);
            b.rg_album_gain = t.get_string(&ItemKey::ReplayGainAlbumGain).and_then(parse_db);
            b.rg_album_peak = t.get_string(&ItemKey::ReplayGainAlbumPeak).and_then(parse_db);
            b.has_cover = !t.pictures().is_empty();
        }
    }
    if b.album_artist.is_empty() {
        b.album_artist = b.artist.clone();
    }
    // codec + precise format from the decoder (also covers DSF/DFF/ISO/Dolby which lofty can't read)
    if let Ok(src) = crate::formats::probing(|| crate::decoder::open(path, false)) {
        let i = src.info();
        b.codec = i.codec.clone();
        if b.duration <= 0.0 {
            b.duration = i.duration;
        }
        if i.dsd {
            b.sample_rate = i.dsd_rate as i64;
            b.bit_depth = 1;
        } else {
            if b.sample_rate == 0 {
                b.sample_rate = i.sample_rate as i64;
            }
            if b.bit_depth == 0 {
                b.bit_depth = i.bits as i64;
            }
        }
    }
    b
}

// ---------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TagData {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub year: Option<u32>,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
    pub comment: String,
    pub composer: String,
    pub lyrics: String,
    pub conductor: String,
    pub label: String,
    pub publisher: String,
    pub lyricist: String,
    pub remixer: String,
    pub work: String,
    pub isrc: String,
    pub catalog: String,
    pub mood: String,
    pub bpm: String,
    pub initial_key: String,
    pub copyright: String,
    pub dynamic_range: String,
    pub tag_type: String,
    pub has_cover: bool,
    pub format: String,
}

/// Fields set to `Some` are written; `None` leaves the field untouched (batch editing).
#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TagPatch {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub track_no: Option<String>,
    pub disc_no: Option<String>,
    pub comment: Option<String>,
    pub composer: Option<String>,
    pub lyrics: Option<String>,
    pub conductor: Option<String>,
    pub label: Option<String>,
    pub publisher: Option<String>,
    pub lyricist: Option<String>,
    pub remixer: Option<String>,
    pub work: Option<String>,
    pub isrc: Option<String>,
    pub catalog: Option<String>,
    pub mood: Option<String>,
    pub bpm: Option<String>,
    pub initial_key: Option<String>,
    pub copyright: Option<String>,
    pub dynamic_range: Option<String>,
}

fn dr_key() -> ItemKey {
    ItemKey::Unknown("DYNAMIC RANGE".to_string())
}

pub fn read_tags(path: &str) -> Result<TagData, String> {
    let tf = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    let p = tf.properties();
    let mut d = TagData {
        path: path.to_string(),
        format: format!(
            "{:?} · {} Hz · {} bit · {} ch · {} kbps",
            tf.file_type(),
            p.sample_rate().unwrap_or(0),
            p.bit_depth().unwrap_or(0),
            p.channels().unwrap_or(0),
            p.audio_bitrate().unwrap_or(0)
        ),
        tag_type: format!("{:?}", tf.primary_tag_type()),
        ..Default::default()
    };
    if let Some(t) = tf.primary_tag().or_else(|| tf.first_tag()) {
        d.title = t.title().map(|s| s.to_string()).unwrap_or_default();
        d.artist = t.artist().map(|s| s.to_string()).unwrap_or_default();
        d.album = t.album().map(|s| s.to_string()).unwrap_or_default();
        d.genre = t.genre().map(|s| s.to_string()).unwrap_or_default();
        d.comment = t.comment().map(|s| s.to_string()).unwrap_or_default();
        d.album_artist = t.get_string(&ItemKey::AlbumArtist).unwrap_or("").to_string();
        d.composer = t.get_string(&ItemKey::Composer).unwrap_or("").to_string();
        d.lyrics = t.get_string(&ItemKey::Lyrics).unwrap_or("").to_string();
        let g = |k: ItemKey| t.get_string(&k).unwrap_or("").to_string();
        d.conductor = g(ItemKey::Conductor);
        d.label = g(ItemKey::Label);
        d.publisher = g(ItemKey::Publisher);
        d.lyricist = g(ItemKey::Lyricist);
        d.remixer = g(ItemKey::Remixer);
        d.work = g(ItemKey::Work);
        d.isrc = g(ItemKey::Isrc);
        d.catalog = g(ItemKey::CatalogNumber);
        d.mood = g(ItemKey::Mood);
        d.bpm = { let b = g(ItemKey::Bpm); if b.is_empty() { g(ItemKey::IntegerBpm) } else { b } };
        d.initial_key = g(ItemKey::InitialKey);
        d.copyright = g(ItemKey::CopyrightMessage);
        d.dynamic_range = g(dr_key());
        d.year = t.year();
        d.track_no = t.track();
        d.disc_no = t.get_string(&ItemKey::DiscNumber).and_then(parse_num).map(|v| v as u32);
        d.has_cover = !t.pictures().is_empty();
    }
    Ok(d)
}

fn with_tag<F: FnOnce(&mut Tag) -> Result<(), String>>(path: &str, f: F) -> Result<(), String> {
    let mut tf = lofty::read_from_path(path).map_err(|e| format!("{path}: {e}"))?;
    let tt = tf.primary_tag_type();
    if tf.primary_tag().is_none() {
        tf.insert_tag(Tag::new(tt));
    }
    let tag = tf.primary_tag_mut().ok_or("Cannot create tag")?;
    f(tag)?;
    tag.save_to_path(path, WriteOptions::default()).map_err(|e| format!("{path}: {e}"))
}

pub fn write_tags(paths: &[String], patch: &TagPatch) -> Result<usize, String> {
    let mut n = 0;
    for p in paths {
        with_tag(p, |t| {
            let set = |t: &mut Tag, key: ItemKey, v: &Option<String>| {
                if let Some(v) = v {
                    if v.is_empty() {
                        t.remove_key(&key);
                    } else {
                        t.insert_text(key, v.clone());
                    }
                }
            };
            if let Some(v) = &patch.title {
                t.set_title(v.clone());
            }
            if let Some(v) = &patch.artist {
                t.set_artist(v.clone());
            }
            if let Some(v) = &patch.album {
                t.set_album(v.clone());
            }
            if let Some(v) = &patch.genre {
                t.set_genre(v.clone());
            }
            if let Some(v) = &patch.comment {
                t.set_comment(v.clone());
            }
            if let Some(v) = &patch.year {
                match v.trim().parse::<u32>() {
                    Ok(y) => t.set_year(y),
                    Err(_) => t.remove_year(),
                }
            }
            if let Some(v) = &patch.track_no {
                match v.trim().parse::<u32>() {
                    Ok(y) => t.set_track(y),
                    Err(_) => t.remove_track(),
                }
            }
            set(t, ItemKey::AlbumArtist, &patch.album_artist);
            set(t, ItemKey::DiscNumber, &patch.disc_no);
            set(t, ItemKey::Composer, &patch.composer);
            set(t, ItemKey::Lyrics, &patch.lyrics);
            set(t, ItemKey::Conductor, &patch.conductor);
            set(t, ItemKey::Label, &patch.label);
            set(t, ItemKey::Publisher, &patch.publisher);
            set(t, ItemKey::Lyricist, &patch.lyricist);
            set(t, ItemKey::Remixer, &patch.remixer);
            set(t, ItemKey::Work, &patch.work);
            set(t, ItemKey::Isrc, &patch.isrc);
            set(t, ItemKey::CatalogNumber, &patch.catalog);
            set(t, ItemKey::Mood, &patch.mood);
            set(t, ItemKey::Bpm, &patch.bpm);
            set(t, ItemKey::InitialKey, &patch.initial_key);
            set(t, ItemKey::CopyrightMessage, &patch.copyright);
            set(t, dr_key(), &patch.dynamic_range);
            Ok(())
        })?;
        n += 1;
    }
    Ok(n)
}

/// Parse tags from file names. Pattern tokens: %artist% %title% %album% %track% %year% %disc%.
pub fn tags_from_filename(paths: &[String], pattern: &str) -> Vec<(String, TagPatch)> {
    // Build a tokenised matcher: literals between tokens act as separators.
    let mut parts: Vec<(bool, String)> = Vec::new(); // (is_token, text)
    let mut rest = pattern;
    while let Some(start) = rest.find('%') {
        if start > 0 {
            parts.push((false, rest[..start].to_string()));
        }
        let after = &rest[start + 1..];
        if let Some(end) = after.find('%') {
            parts.push((true, after[..end].to_lowercase()));
            rest = &after[end + 1..];
        } else {
            parts.push((false, rest[start..].to_string()));
            rest = "";
            break;
        }
    }
    if !rest.is_empty() {
        parts.push((false, rest.to_string()));
    }
    paths
        .iter()
        .map(|p| {
            let name = stem(Path::new(p));
            let mut patch = TagPatch::default();
            let mut s = name.as_str();
            let mut i = 0;
            while i < parts.len() {
                let (is_tok, text) = &parts[i];
                if !*is_tok {
                    if let Some(rest) = s.strip_prefix(text.as_str()) {
                        s = rest;
                    }
                    i += 1;
                    continue;
                }
                // token value runs until the next literal (or end)
                let value = match parts.get(i + 1) {
                    Some((false, lit)) if !lit.is_empty() => match s.find(lit.as_str()) {
                        Some(pos) => {
                            let v = &s[..pos];
                            s = &s[pos..];
                            v
                        }
                        None => {
                            let v = s;
                            s = "";
                            v
                        }
                    },
                    _ => {
                        let v = s;
                        s = "";
                        v
                    }
                };
                let v = Some(value.trim().to_string());
                match text.as_str() {
                    "artist" => patch.artist = v,
                    "title" => patch.title = v,
                    "album" => patch.album = v,
                    "track" => patch.track_no = v,
                    "year" => patch.year = v,
                    "disc" => patch.disc_no = v,
                    "albumartist" => patch.album_artist = v,
                    "genre" => patch.genre = v,
                    _ => {}
                }
                i += 1;
            }
            (p.clone(), patch)
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Cover art
// ---------------------------------------------------------------------------------------------

fn folder_cover(path: &Path) -> Option<(Vec<u8>, &'static str)> {
    let dir = path.parent()?;
    for name in ["cover.jpg", "folder.jpg", "front.jpg", "cover.png", "folder.png", "album.jpg", "Cover.jpg", "Folder.jpg"] {
        let p = dir.join(name);
        if let Ok(data) = std::fs::read(&p) {
            let mime = if name.ends_with("png") { "image/png" } else { "image/jpeg" };
            return Some((data, mime));
        }
    }
    None
}

/// Returns a `data:` URL for the embedded (or folder) cover.
pub fn get_cover(path: &str) -> Option<String> {
    // a track of a CUE/SACD album image: the image's (or folder's) cover
    let path = path.split('?').next().unwrap_or(path);
    let p = Path::new(path);
    let embedded = lofty::read_from_path(p).ok().and_then(|tf| {
        let tag = tf.primary_tag().or_else(|| tf.first_tag())?;
        let pic = tag
            .pictures()
            .iter()
            .find(|p| p.pic_type() == PictureType::CoverFront)
            .or_else(|| tag.pictures().first())?;
        let mime = match pic.mime_type() {
            Some(MimeType::Png) => "image/png",
            Some(MimeType::Gif) => "image/gif",
            Some(MimeType::Bmp) => "image/bmp",
            _ => "image/jpeg",
        };
        Some((pic.data().to_vec(), mime))
    });
    let (data, mime) = embedded.or_else(|| folder_cover(p))?;
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(data)))
}

pub fn set_cover(paths: &[String], image_path: &str) -> Result<(), String> {
    let data = std::fs::read(image_path).map_err(|e| e.to_string())?;
    let mime = if image_path.to_ascii_lowercase().ends_with(".png") { MimeType::Png } else { MimeType::Jpeg };
    for p in paths {
        let d = data.clone();
        let m = mime.clone();
        with_tag(p, move |t| {
            t.remove_picture_type(PictureType::CoverFront);
            t.push_picture(Picture::new_unchecked(PictureType::CoverFront, Some(m), None, d));
            Ok(())
        })?;
    }
    Ok(())
}

pub fn remove_cover(paths: &[String]) -> Result<(), String> {
    for p in paths {
        with_tag(p, |t| {
            t.remove_picture_type(PictureType::CoverFront);
            Ok(())
        })?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------------------------

pub fn get_lyrics(path: &str) -> Option<String> {
    if path.contains('?') {
        return None; // one track of an album image: lyrics come from the online search
    }
    let lrc = Path::new(path).with_extension("lrc");
    if let Ok(bytes) = std::fs::read(&lrc) {
        let s = decode_text(&bytes);
        if !s.trim().is_empty() {
            return Some(s);
        }
    }
    let tf = lofty::read_from_path(path).ok()?;
    let t = tf.primary_tag().or_else(|| tf.first_tag())?;
    t.get_string(&ItemKey::Lyrics).map(|s| s.to_string()).filter(|s| !s.trim().is_empty())
}

/// Decode a text file saved by any common Windows editor: UTF-8 (with/without BOM) or UTF-16 LE/BE
/// (Notepad's "Unicode"), so Hindi and other non-Latin .lrc files load correctly.
fn decode_text(b: &[u8]) -> String {
    let utf16 = |le: bool, data: &[u8]| -> String {
        let units: Vec<u16> = data
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        String::from_utf16_lossy(&units)
    };
    if b.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&b[3..]).into_owned();
    }
    if b.starts_with(&[0xFF, 0xFE]) {
        return utf16(true, &b[2..]);
    }
    if b.starts_with(&[0xFE, 0xFF]) {
        return utf16(false, &b[2..]);
    }
    // BOM-less UTF-16 LE: every other byte is zero for ASCII-heavy text
    if b.len() >= 4 && b[1] == 0 && b[3] == 0 {
        return utf16(true, b);
    }
    String::from_utf8_lossy(b).into_owned()
}

pub fn save_lyrics(path: &str, text: &str) -> Result<(), String> {
    let lrc = Path::new(path).with_extension("lrc");
    std::fs::write(lrc, text).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------
// ReplayGain
// ---------------------------------------------------------------------------------------------

pub fn write_replaygain(path: &str, tg: f64, tp: f64, ag: Option<f64>, ap: Option<f64>) -> Result<(), String> {
    with_tag(path, |t| {
        t.insert_text(ItemKey::ReplayGainTrackGain, format!("{tg:+.2} dB"));
        t.insert_text(ItemKey::ReplayGainTrackPeak, format!("{tp:.6}"));
        if let (Some(ag), Some(ap)) = (ag, ap) {
            t.insert_text(ItemKey::ReplayGainAlbumGain, format!("{ag:+.2} dB"));
            t.insert_text(ItemKey::ReplayGainAlbumPeak, format!("{ap:.6}"));
        }
        Ok(())
    })
}
