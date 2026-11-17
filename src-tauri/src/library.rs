//! SQLite music library: tracks, analysis results, playlists (local + YouTube items),
//! watched folders, play statistics and key/value settings.

use crate::analysis::TrackAnalysis;
use crate::decoder::is_audio_file;
use crate::metadata;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::UNIX_EPOCH;

pub struct Library {
    pub conn: Mutex<Connection>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub path: String,
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
    pub file_size: i64,
    pub rg_track_gain: Option<f64>,
    pub rg_track_peak: Option<f64>,
    pub rg_album_gain: Option<f64>,
    pub rg_album_peak: Option<f64>,
    pub has_cover: bool,
    pub bpm: Option<f64>,
    pub first_beat: Option<f64>,
    pub musical_key: Option<String>,
    pub camelot: Option<String>,
    pub energy: Option<f64>,
    pub brightness: Option<f64>,
    pub lufs: Option<f64>,
    pub dr: Option<f64>,
    pub cutoff_hz: Option<f64>,
    pub verdict: Option<String>,
    pub play_count: i64,
    pub last_played: Option<i64>,
    pub rating: i64,
    pub added_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub count: i64,
    pub created_at: i64,
}

/// A queue/playlist entry — either a local track or a YouTube Music video.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    /// "local" | "youtube"
    pub kind: String,
    pub track_id: Option<i64>,
    pub path: Option<String>,
    pub video_id: Option<String>,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration: Option<f64>,
    pub art_url: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub done: usize,
    pub total: usize,
    pub current: String,
    pub finished: bool,
    pub added: usize,
    pub removed: usize,
}

/// Virtual tracks of a CUE sheet or SACD disc image: (path, tags, mtime, size).
pub fn expand_image(img: &Path) -> Result<Vec<(String, metadata::Basic, i64, i64)>, String> {
    let meta = std::fs::metadata(img).map_err(|e| e.to_string())?;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
    let ext = img.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    let mut out = Vec::new();
    if ext == "cue" {
        let sheet = crate::formats::parse_cue(img)?;
        // technical details (rate, bits, codec) + the image's own tags, read once per audio file
        let mut base_info: std::collections::HashMap<String, metadata::Basic> = std::collections::HashMap::new();
        for t in &sheet.tracks {
            let file_info = base_info.entry(t.file.clone()).or_insert_with(|| metadata::read_basic(Path::new(&t.file))).clone();
            let size = std::fs::metadata(&t.file).map(|m| m.len() as i64).unwrap_or(0);
            let mut b = file_info.clone();
            b.title = t.title.clone();
            b.artist = if t.performer.is_empty() { file_info.artist.clone() } else { t.performer.clone() };
            b.album = if sheet.title.is_empty() { file_info.album.clone() } else { sheet.title.clone() };
            b.album_artist = if sheet.performer.is_empty() { b.artist.clone() } else { sheet.performer.clone() };
            if !sheet.genre.is_empty() {
                b.genre = sheet.genre.clone();
            }
            if let Some(y) = sheet.date.get(0..4).and_then(|y| y.parse().ok()) {
                b.year = Some(y);
            }
            b.track_no = Some(t.number as i64);
            b.duration = match t.end {
                Some(e) => e - t.start,
                None => (file_info.duration - t.start).max(0.0),
            };
            // whole-file ReplayGain values don't apply to one track
            b.rg_track_gain = None;
            b.rg_track_peak = None;
            out.push((crate::formats::cue_track_path(t), b, mtime, size));
        }
    } else if ext == "iso" {
        let disc = crate::formats::sacd_disc(img)?;
        if disc.dst {
            return Err("DST-compressed SACD image".into());
        }
        let stem = img.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        for t in disc.tracks {
            let b = metadata::Basic {
                title: t.title,
                artist: if t.artist.is_empty() { disc.artist.clone() } else { t.artist },
                album: if disc.album.is_empty() { stem.clone() } else { disc.album.clone() },
                album_artist: disc.artist.clone(),
                track_no: Some(t.number as i64),
                duration: t.duration,
                sample_rate: 2_822_400,
                bit_depth: 1,
                channels: 2,
                codec: "SACD DSD64".into(),
                ..Default::default()
            };
            out.push((format!("{}?sacd={}", img.to_string_lossy(), t.number), b, mtime, meta.len() as i64));
        }
    }
    Ok(out)
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

const TRACK_COLS: &str = "id, path, title, artist, album, album_artist, genre, year, track_no, disc_no, duration, \
    sample_rate, bit_depth, channels, codec, bitrate, file_size, rg_track_gain, rg_track_peak, rg_album_gain, \
    rg_album_peak, has_cover, bpm, first_beat, musical_key, camelot, energy, brightness, lufs, dr, cutoff_hz, \
    verdict, play_count, last_played, rating, added_at";

fn row_to_track(r: &rusqlite::Row) -> rusqlite::Result<Track> {
    Ok(Track {
        id: r.get(0)?,
        path: r.get(1)?,
        title: r.get(2)?,
        artist: r.get(3)?,
        album: r.get(4)?,
        album_artist: r.get(5)?,
        genre: r.get(6)?,
        year: r.get(7)?,
        track_no: r.get(8)?,
        disc_no: r.get(9)?,
        duration: r.get(10)?,
        sample_rate: r.get(11)?,
        bit_depth: r.get(12)?,
        channels: r.get(13)?,
        codec: r.get(14)?,
        bitrate: r.get(15)?,
        file_size: r.get(16)?,
        rg_track_gain: r.get(17)?,
        rg_track_peak: r.get(18)?,
        rg_album_gain: r.get(19)?,
        rg_album_peak: r.get(20)?,
        has_cover: r.get::<_, i64>(21)? != 0,
        bpm: r.get(22)?,
        first_beat: r.get(23)?,
        musical_key: r.get(24)?,
        camelot: r.get(25)?,
        energy: r.get(26)?,
        brightness: r.get(27)?,
        lufs: r.get(28)?,
        dr: r.get(29)?,
        cutoff_hz: r.get(30)?,
        verdict: r.get(31)?,
        play_count: r.get(32)?,
        last_played: r.get(33)?,
        rating: r.get(34)?,
        added_at: r.get(35)?,
    })
}

fn e<T: std::fmt::Display>(x: T) -> String {
    x.to_string()
}

impl Library {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(e)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS tracks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL DEFAULT '',
                artist TEXT NOT NULL DEFAULT '',
                album TEXT NOT NULL DEFAULT '',
                album_artist TEXT NOT NULL DEFAULT '',
                genre TEXT NOT NULL DEFAULT '',
                year INTEGER, track_no INTEGER, disc_no INTEGER,
                duration REAL NOT NULL DEFAULT 0,
                sample_rate INTEGER NOT NULL DEFAULT 0,
                bit_depth INTEGER NOT NULL DEFAULT 0,
                channels INTEGER NOT NULL DEFAULT 2,
                codec TEXT NOT NULL DEFAULT '',
                bitrate INTEGER NOT NULL DEFAULT 0,
                file_size INTEGER NOT NULL DEFAULT 0,
                mtime INTEGER NOT NULL DEFAULT 0,
                rg_track_gain REAL, rg_track_peak REAL, rg_album_gain REAL, rg_album_peak REAL,
                has_cover INTEGER NOT NULL DEFAULT 0,
                bpm REAL, first_beat REAL, musical_key TEXT, camelot TEXT, energy REAL, brightness REAL,
                lufs REAL, dr REAL, cutoff_hz REAL, verdict TEXT, analyzed_at INTEGER,
                play_count INTEGER NOT NULL DEFAULT 0,
                last_played INTEGER,
                rating INTEGER NOT NULL DEFAULT 0,
                added_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_artist, album, disc_no, track_no);
            CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
            CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS playlist_items (
                playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                item_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_pl_items ON playlist_items(playlist_id, position);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            "#,
        )
        .map_err(e)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    // ---- settings ------------------------------------------------------------------------

    pub fn get_setting(&self, key: &str) -> Option<String> {
        self.conn
            .lock()
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .lock()
            .execute(
                "INSERT INTO settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map(|_| ())
            .map_err(e)
    }

    // ---- folders -------------------------------------------------------------------------

    pub fn folders(&self) -> Result<Vec<String>, String> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT path FROM folders ORDER BY path").map_err(e)?;
        let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(e)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn add_folder(&self, path: &str) -> Result<(), String> {
        self.conn
            .lock()
            .execute("INSERT OR IGNORE INTO folders(path, added_at) VALUES(?1, ?2)", params![path, now()])
            .map(|_| ())
            .map_err(e)
    }

    pub fn remove_folder(&self, path: &str) -> Result<(), String> {
        let c = self.conn.lock();
        c.execute("DELETE FROM folders WHERE path = ?1", params![path]).map_err(e)?;
        let like = format!("{}%", path.trim_end_matches('\\'));
        c.execute("DELETE FROM tracks WHERE path LIKE ?1", params![like]).map_err(e)?;
        Ok(())
    }

    // ---- scanning ------------------------------------------------------------------------

    /// Scan all watched folders (or a specific list), upserting changed files and pruning missing ones.
    pub fn scan(&self, roots: &[String], mut progress: impl FnMut(ScanProgress)) -> Result<(usize, usize), String> {
        let mut files = Vec::new();
        let mut images = Vec::new();
        for root in roots {
            for entry in walkdir::WalkDir::new(root).follow_links(true).into_iter().filter_map(Result::ok) {
                if !entry.file_type().is_file() {
                    continue;
                }
                let ext = entry.path().extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
                if ext == "cue" || ext == "iso" {
                    images.push(entry.path().to_path_buf());
                } else if is_audio_file(entry.path()) {
                    files.push(entry.path().to_path_buf());
                }
            }
        }
        // album images: the CUE sheet's tracks replace the single big file
        let mut virtual_tracks: Vec<(String, metadata::Basic, i64, i64)> = Vec::new();
        let mut covered = std::collections::HashSet::new();
        for img in &images {
            if let Ok(v) = expand_image(img) {
                for (p, b, m, s) in v {
                    if let Some((base, _)) = p.split_once('?') {
                        covered.insert(base.to_string());
                    }
                    virtual_tracks.push((p, b, m, s));
                }
            }
        }
        files.retain(|f| !covered.contains(&f.to_string_lossy().to_string()));
        let total = files.len();
        let existing: std::collections::HashMap<String, i64> = {
            let c = self.conn.lock();
            let mut st = c.prepare("SELECT path, mtime FROM tracks").map_err(e)?;
            let rows = st
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(e)?;
            rows.filter_map(Result::ok).collect()
        };
        let mut added = 0;
        let mut seen = std::collections::HashSet::new();
        for (i, f) in files.iter().enumerate() {
            let path = f.to_string_lossy().to_string();
            seen.insert(path.clone());
            let meta = std::fs::metadata(f);
            let mtime = meta
                .as_ref()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            if existing.get(&path) == Some(&mtime) {
                if i % 50 == 0 {
                    progress(ScanProgress { done: i, total, current: path, finished: false, added, removed: 0 });
                }
                continue;
            }
            let size = meta.map(|m| m.len() as i64).unwrap_or(0);
            if self.upsert_file(f, mtime, size).is_ok() && !existing.contains_key(&path) {
                added += 1;
            }
            if i % 10 == 0 {
                progress(ScanProgress { done: i, total, current: path, finished: false, added, removed: 0 });
            }
        }
        for (p, b, mtime, size) in virtual_tracks {
            seen.insert(p.clone());
            if existing.get(&p) == Some(&mtime) {
                continue;
            }
            if self.upsert_meta(&p, &b, mtime, size).is_ok() && !existing.contains_key(&p) {
                added += 1;
            }
        }
        // prune files that vanished (only under scanned roots); album images now listed as tracks
        let mut removed = 0;
        {
            let c = self.conn.lock();
            for p in covered.iter() {
                if c.execute("DELETE FROM tracks WHERE path = ?1", params![p]).unwrap_or(0) > 0 {
                    removed += 1;
                }
            }
            for (p, _) in existing.iter() {
                let under_root = roots.iter().any(|r| p.starts_with(r.as_str()));
                if under_root && !seen.contains(p) && !Path::new(p).exists() {
                    if c.execute("DELETE FROM tracks WHERE path = ?1", params![p]).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
        progress(ScanProgress { done: total, total, current: String::new(), finished: true, added, removed });
        Ok((added, removed))
    }

    pub fn upsert_file(&self, f: &Path, mtime: i64, size: i64) -> Result<i64, String> {
        let m = metadata::read_basic(f);
        self.upsert_meta(&f.to_string_lossy(), &m, mtime, size)
    }

    /// Add the tracks of a CUE sheet or SACD image; returns their ids.
    pub fn upsert_image(&self, img: &Path) -> Result<Vec<i64>, String> {
        let mut ids = Vec::new();
        for (p, b, mtime, size) in expand_image(img)? {
            ids.push(self.upsert_meta(&p, &b, mtime, size)?);
        }
        Ok(ids)
    }

    pub fn upsert_meta(&self, path: &str, m: &metadata::Basic, mtime: i64, size: i64) -> Result<i64, String> {
        let path = path.to_string();
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO tracks(path, title, artist, album, album_artist, genre, year, track_no, disc_no, duration,
                sample_rate, bit_depth, channels, codec, bitrate, file_size, mtime, rg_track_gain, rg_track_peak,
                rg_album_gain, rg_album_peak, has_cover, added_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)
             ON CONFLICT(path) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album,
                album_artist=excluded.album_artist, genre=excluded.genre, year=excluded.year, track_no=excluded.track_no,
                disc_no=excluded.disc_no, duration=excluded.duration, sample_rate=excluded.sample_rate,
                bit_depth=excluded.bit_depth, channels=excluded.channels, codec=excluded.codec, bitrate=excluded.bitrate,
                file_size=excluded.file_size, mtime=excluded.mtime, rg_track_gain=excluded.rg_track_gain,
                rg_track_peak=excluded.rg_track_peak, rg_album_gain=excluded.rg_album_gain,
                rg_album_peak=excluded.rg_album_peak, has_cover=excluded.has_cover",
            params![
                path,
                m.title,
                m.artist,
                m.album,
                m.album_artist,
                m.genre,
                m.year,
                m.track_no,
                m.disc_no,
                m.duration,
                m.sample_rate,
                m.bit_depth,
                m.channels,
                m.codec,
                m.bitrate,
                size,
                mtime,
                m.rg_track_gain,
                m.rg_track_peak,
                m.rg_album_gain,
                m.rg_album_peak,
                m.has_cover as i64,
                now()
            ],
        )
        .map_err(e)?;
        c.query_row("SELECT id FROM tracks WHERE path = ?1", params![path], |r| r.get(0)).map_err(e)
    }

    /// Re-read tags for specific paths (after the metadata editor wrote them).
    pub fn refresh_paths(&self, paths: &[String]) -> Result<(), String> {
        for p in paths {
            if p.contains('?') {
                continue; // tracks of an album image keep the sheet's tags
            }
            let f = Path::new(p);
            let meta = std::fs::metadata(f).map_err(e)?;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            self.upsert_file(f, mtime, meta.len() as i64)?;
        }
        Ok(())
    }

    // ---- queries -------------------------------------------------------------------------

    pub fn tracks(&self) -> Result<Vec<Track>, String> {
        let c = self.conn.lock();
        let sql = format!(
            "SELECT {TRACK_COLS} FROM tracks ORDER BY album_artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE"
        );
        let mut st = c.prepare(&sql).map_err(e)?;
        let rows = st.query_map([], row_to_track).map_err(e)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn track_by_id(&self, id: i64) -> Option<Track> {
        let c = self.conn.lock();
        let sql = format!("SELECT {TRACK_COLS} FROM tracks WHERE id = ?1");
        c.query_row(&sql, params![id], row_to_track).optional().ok().flatten()
    }

    pub fn track_by_path(&self, path: &str) -> Option<Track> {
        let c = self.conn.lock();
        let sql = format!("SELECT {TRACK_COLS} FROM tracks WHERE path = ?1");
        c.query_row(&sql, params![path], row_to_track).optional().ok().flatten()
    }

    pub fn unanalyzed_ids(&self) -> Vec<(i64, String)> {
        let c = self.conn.lock();
        let Ok(mut st) = c.prepare("SELECT id, path FROM tracks WHERE analyzed_at IS NULL") else { return vec![] };
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)));
        match rows {
            Ok(r) => r.filter_map(Result::ok).collect(),
            Err(_) => vec![],
        }
    }

    pub fn save_analysis(&self, id: i64, a: &TrackAnalysis) -> Result<(), String> {
        self.conn
            .lock()
            .execute(
                "UPDATE tracks SET bpm=?2, first_beat=?3, musical_key=?4, camelot=?5, energy=?6, brightness=?7,
                    lufs=?8, dr=?9, cutoff_hz=?10, verdict=?11, analyzed_at=?12 WHERE id=?1",
                params![
                    id,
                    a.bpm as f64,
                    a.first_beat as f64,
                    a.key,
                    a.camelot,
                    a.energy as f64,
                    a.brightness as f64,
                    a.lufs as f64,
                    a.dr as f64,
                    a.cutoff_hz as f64,
                    a.verdict,
                    now()
                ],
            )
            .map(|_| ())
            .map_err(e)
    }

    pub fn save_replaygain(&self, path: &str, tg: f64, tp: f64, ag: Option<f64>, ap: Option<f64>) -> Result<(), String> {
        self.conn
            .lock()
            .execute(
                "UPDATE tracks SET rg_track_gain=?2, rg_track_peak=?3, rg_album_gain=?4, rg_album_peak=?5 WHERE path=?1",
                params![path, tg, tp, ag, ap],
            )
            .map(|_| ())
            .map_err(e)
    }

    pub fn record_play(&self, id: i64) -> Result<(), String> {
        self.conn
            .lock()
            .execute(
                "UPDATE tracks SET play_count = play_count + 1, last_played = ?2 WHERE id = ?1",
                params![id, now()],
            )
            .map(|_| ())
            .map_err(e)
    }

    pub fn set_rating(&self, id: i64, rating: i64) -> Result<(), String> {
        self.conn
            .lock()
            .execute("UPDATE tracks SET rating = ?2 WHERE id = ?1", params![id, rating.clamp(0, 5)])
            .map(|_| ())
            .map_err(e)
    }

    // ---- playlists -----------------------------------------------------------------------

    pub fn playlists(&self) -> Result<Vec<Playlist>, String> {
        let c = self.conn.lock();
        let mut st = c
            .prepare(
                "SELECT p.id, p.name, p.created_at, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id)
                 FROM playlists p ORDER BY p.name COLLATE NOCASE",
            )
            .map_err(e)?;
        let rows = st
            .query_map([], |r| {
                Ok(Playlist { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, count: r.get(3)? })
            })
            .map_err(e)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn playlist_create(&self, name: &str) -> Result<i64, String> {
        let c = self.conn.lock();
        c.execute("INSERT INTO playlists(name, created_at) VALUES(?1, ?2)", params![name, now()]).map_err(e)?;
        Ok(c.last_insert_rowid())
    }

    pub fn playlist_rename(&self, id: i64, name: &str) -> Result<(), String> {
        self.conn
            .lock()
            .execute("UPDATE playlists SET name = ?2 WHERE id = ?1", params![id, name])
            .map(|_| ())
            .map_err(e)
    }

    pub fn playlist_delete(&self, id: i64) -> Result<(), String> {
        self.conn
            .lock()
            .execute("DELETE FROM playlists WHERE id = ?1", params![id])
            .map(|_| ())
            .map_err(e)
    }

    pub fn playlist_items(&self, id: i64) -> Result<Vec<QueueItem>, String> {
        let c = self.conn.lock();
        let mut st = c
            .prepare("SELECT item_json FROM playlist_items WHERE playlist_id = ?1 ORDER BY position")
            .map_err(e)?;
        let rows = st.query_map(params![id], |r| r.get::<_, String>(0)).map_err(e)?;
        Ok(rows
            .filter_map(Result::ok)
            .filter_map(|j| serde_json::from_str::<QueueItem>(&j).ok())
            .collect())
    }

    pub fn playlist_set_items(&self, id: i64, items: &[QueueItem]) -> Result<(), String> {
        let mut c = self.conn.lock();
        let tx = c.transaction().map_err(e)?;
        tx.execute("DELETE FROM playlist_items WHERE playlist_id = ?1", params![id]).map_err(e)?;
        for (i, it) in items.iter().enumerate() {
            let j = serde_json::to_string(it).map_err(e)?;
            tx.execute(
                "INSERT INTO playlist_items(playlist_id, position, item_json) VALUES(?1, ?2, ?3)",
                params![id, i as i64, j],
            )
            .map_err(e)?;
        }
        tx.commit().map_err(e)
    }
}
