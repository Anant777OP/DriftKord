//! Extra formats and playback options on top of `decoder`:
//!
//! * RAM playback: the whole file is read into memory before decoding starts (no disk reads while
//!   playing).
//! * DSDIFF (.dff) and SACD disc images (.iso, plain-DSD stereo area) — DoP or DSD→PCM.
//! * Monkey's Audio (.ape).
//! * Virtual tracks: a time range of a file (CUE sheets) or one track of an SACD image, addressed as
//!   `C:\path\file.flac?t=12.5-245.3` / `C:\path\disc.iso?sacd=3` (`?` can't appear in Windows paths).
//! * Dolby Digital / Dolby Digital Plus (incl. Dolby Atmos in E-AC-3) through Windows' own decoder
//!   (Media Foundation), and anything else (TrueHD Atmos, DTS, WavPack, Opus…) through FFmpeg when
//!   one is installed.
//! * A spatial renderer that turns multichannel / Atmos beds into binaural stereo for headphones
//!   (or a standard stereo downmix).

use crate::decoder::{Source, StreamInfo};
use crate::dsp::{Biquad, Reverb};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineOptions {
    /// Load each track (and the next one) fully into memory before it plays.
    pub ram_buffer: bool,
    /// Largest file loaded into memory, in MB.
    pub ram_limit_mb: u32,
    /// "sinc" (high precision windowed-sinc) | "fast" (4-point Hermite)
    pub resampler: String,
    /// "binaural" (headphones) | "stereo" (speakers downmix)
    pub spatial: String,
    /// Full path to ffmpeg.exe; empty = look for one automatically.
    pub ffmpeg_path: String,
}

impl Default for EngineOptions {
    fn default() -> Self {
        Self { ram_buffer: true, ram_limit_mb: 1024, resampler: "sinc".into(), spatial: "binaural".into(), ffmpeg_path: String::new() }
    }
}

static OPTIONS: Mutex<Option<EngineOptions>> = Mutex::new(None);

thread_local!(static PROBING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });

/// Run `f` with RAM loading off (scanning tags/durations shouldn't read whole files into memory).
pub fn probing<R>(f: impl FnOnce() -> R) -> R {
    PROBING.with(|p| p.set(true));
    let r = f();
    PROBING.with(|p| p.set(false));
    r
}

pub fn options() -> EngineOptions {
    OPTIONS.lock().clone().unwrap_or_default()
}
pub fn set_options(o: EngineOptions) {
    *FFMPEG.lock() = None; // look again (the path may have changed)
    *OPTIONS.lock() = Some(o);
}

// ---------------------------------------------------------------------------------------------
// Input (file or RAM)
// ---------------------------------------------------------------------------------------------

pub trait ReadSeek: Read + Seek + Send + Sync {}
impl<T: Read + Seek + Send + Sync> ReadSeek for T {}

/// Open a file for decoding: fully in memory when RAM playback is on (and it fits), else buffered.
pub fn open_input(path: &Path) -> Result<(Box<dyn ReadSeek>, u64), String> {
    let mut f = File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let o = options();
    if o.ram_buffer && !PROBING.with(|p| p.get()) && len > 0 && len <= o.ram_limit_mb as u64 * 1024 * 1024 {
        let mut v = Vec::with_capacity(len as usize);
        if f.read_to_end(&mut v).is_ok() {
            return Ok((Box::new(Cursor::new(v)), len));
        }
        f.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    }
    Ok((Box::new(BufReader::with_capacity(1 << 16, f)), len))
}

/// Adapter so Symphonia can read from our input.
pub struct MsInput {
    inner: Box<dyn ReadSeek>,
    len: u64,
}
impl MsInput {
    pub fn open(path: &Path) -> Result<Self, String> {
        let (inner, len) = open_input(path)?;
        Ok(Self { inner, len })
    }
}
impl Read for MsInput {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.read(buf)
    }
}
impl Seek for MsInput {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}
impl symphonia::core::io::MediaSource for MsInput {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
}

// ---------------------------------------------------------------------------------------------
// Virtual tracks
// ---------------------------------------------------------------------------------------------

/// `base?t=START-END` or `base?sacd=N`
pub fn open_virtual(base: &str, query: &str, dop: bool) -> Result<Box<dyn Source>, String> {
    let mut start = 0.0;
    let mut end: Option<f64> = None;
    for part in query.split('&') {
        let (k, v) = part.split_once('=').unwrap_or((part, ""));
        match k {
            "sacd" => {
                let n: usize = v.parse().map_err(|_| "bad SACD track number")?;
                return Ok(Box::new(SacdIsoSource::open(Path::new(base), n, dop)?));
            }
            "t" => {
                let (a, b) = v.split_once('-').unwrap_or((v, ""));
                start = a.parse().unwrap_or(0.0);
                end = b.parse().ok().filter(|e: &f64| *e > start);
            }
            _ => {}
        }
    }
    let inner = crate::decoder::open(Path::new(base), dop)?;
    Ok(Box::new(Segment::new(inner, start, end)))
}

/// A time range of another source (one track of a CUE-sheet album image).
pub struct Segment {
    inner: Box<dyn Source>,
    info: StreamInfo,
    start: f64,
    /// frames still allowed before the end of the range (u64::MAX = to the end)
    left: u64,
    len_frames: u64,
}
impl Segment {
    pub fn new(mut inner: Box<dyn Source>, start: f64, end: Option<f64>) -> Self {
        let mut info = inner.info().clone();
        let total = info.duration;
        let end = end.unwrap_or(total).max(start);
        let actual = if start > 0.0 { inner.seek(start) } else { 0.0 };
        info.duration = if end > 0.0 { end - start } else { 0.0 };
        let rate = info.sample_rate.max(1) as f64;
        let len_frames = if info.duration > 0.0 { (info.duration * rate).round() as u64 } else { u64::MAX };
        let _ = actual;
        Self { inner, info, start, left: len_frames, len_frames }
    }
}
impl Source for Segment {
    fn info(&self) -> &StreamInfo {
        &self.info
    }
    fn decode_more(&mut self, out: &mut Vec<f32>) -> bool {
        if self.left == 0 {
            return false;
        }
        let before = out.len();
        if !self.inner.decode_more(out) {
            return false;
        }
        let frames = ((out.len() - before) / 2) as u64;
        if frames > self.left {
            out.truncate(before + self.left as usize * 2);
            self.left = 0;
        } else if self.left != u64::MAX {
            self.left -= frames;
        }
        true
    }
    fn seek(&mut self, secs: f64) -> f64 {
        let secs = secs.clamp(0.0, self.info.duration.max(0.0));
        let actual = self.inner.seek(self.start + secs) - self.start;
        let rate = self.info.sample_rate.max(1) as f64;
        if self.len_frames != u64::MAX {
            self.left = self.len_frames.saturating_sub((actual.max(0.0) * rate) as u64);
        }
        actual.max(0.0)
    }
}

// ---------------------------------------------------------------------------------------------
// DSD helpers (shared by DFF and SACD images; DSF has its own block-based reader in `decoder`)
// ---------------------------------------------------------------------------------------------

/// Turns per-channel DSD bytes (MSB first) into DoP frames or PCM.
struct DsdConv {
    dop: bool,
    marker: bool,
    prev: [u32; 2],
    lp: [[f64; 4]; 2],
    coef: [f64; 5],
    pend: [Vec<u8>; 2],
}
impl DsdConv {
    /// Returns the converter and the PCM rate it produces.
    fn new(dsd_rate: u32, dop: bool) -> (Self, u32) {
        let rate = if dop { dsd_rate / 16 } else { dsd_rate / 32 };
        let fs = rate as f64;
        let w0 = 2.0 * std::f64::consts::PI * 30_000f64.min(fs * 0.45) / fs;
        let alpha = w0.sin() / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
        let c = w0.cos();
        let a0 = 1.0 + alpha;
        let coef = [(1.0 - c) / 2.0 / a0, (1.0 - c) / a0, (1.0 - c) / 2.0 / a0, -2.0 * c / a0, (1.0 - alpha) / a0];
        (Self { dop, marker: false, prev: [0x6969_6969; 2], lp: [[0.0; 4]; 2], coef, pend: [Vec::new(), Vec::new()] }, rate)
    }
    fn reset(&mut self) {
        self.marker = false;
        self.pend[0].clear();
        self.pend[1].clear();
    }
    fn push(&mut self, l: &[u8], r: &[u8], out: &mut Vec<f32>) {
        self.pend[0].extend_from_slice(l);
        self.pend[1].extend_from_slice(r);
        let n = self.pend[0].len().min(self.pend[1].len());
        let step = if self.dop { 2 } else { 4 };
        let usable = n / step * step;
        let mut i = 0;
        while i < usable {
            if self.dop {
                let marker: u32 = if self.marker { 0xFA } else { 0x05 };
                self.marker = !self.marker;
                for c in 0..2 {
                    let w = (marker << 16) | ((self.pend[c][i] as u32) << 8) | self.pend[c][i + 1] as u32;
                    let s = if w & 0x80_0000 != 0 { w as i32 - 0x100_0000 } else { w as i32 };
                    out.push(s as f32 / 8_388_608.0);
                }
            } else {
                for c in 0..2 {
                    let p = &self.pend[c];
                    let w = ((p[i] as u32) << 24) | ((p[i + 1] as u32) << 16) | ((p[i + 2] as u32) << 8) | p[i + 3] as u32;
                    let prev = self.prev[c];
                    self.prev[c] = w;
                    let mut acc = 0i32;
                    for bit in 0..32 {
                        let bp = if (prev >> (31 - bit)) & 1 == 1 { 1 } else { -1 };
                        let bc = if (w >> (31 - bit)) & 1 == 1 { 1 } else { -1 };
                        acc += bp * (bit + 1) as i32 + bc * (32 - bit) as i32;
                    }
                    let x = acc as f64 / (33.0 * 32.0);
                    let k = &self.coef;
                    let st = &mut self.lp[c];
                    let y = k[0] * x + k[1] * st[0] + k[2] * st[1] - k[3] * st[2] - k[4] * st[3];
                    st[1] = st[0];
                    st[0] = x;
                    st[3] = st[2];
                    st[2] = y;
                    out.push((y * 0.5) as f32);
                }
            }
            i += step;
        }
        self.pend[0].drain(..usable);
        self.pend[1].drain(..usable);
    }
}

fn dsd_info(codec: &str, dsd_rate: u32, rate: u32, channels: u16, duration: f64, dop: bool) -> StreamInfo {
    StreamInfo {
        codec: format!("{codec} DSD{}", dsd_rate / 44_100),
        sample_rate: rate,
        bits: 24,
        channels,
        duration,
        lossless: true,
        dsd: true,
        dop,
        dsd_rate,
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------------------------
// DSDIFF (.dff)
// ---------------------------------------------------------------------------------------------

pub struct DffSource {
    input: Box<dyn ReadSeek>,
    info: StreamInfo,
    conv: DsdConv,
    channels: usize,
    data_start: u64,
    data_len: u64,
    pos: u64,
    buf: Vec<u8>,
}

impl DffSource {
    pub fn open(path: &Path, dop: bool) -> Result<Self, String> {
        let (mut f, _) = open_input(path)?;
        let mut hdr = [0u8; 16];
        f.read_exact(&mut hdr).map_err(|e| e.to_string())?;
        if &hdr[0..4] != b"FRM8" || &hdr[12..16] != b"DSD " {
            return Err("Not a DSDIFF file".into());
        }
        let be64 = |b: &[u8]| u64::from_be_bytes(b[..8].try_into().unwrap());
        let (mut rate, mut channels) = (0u32, 0usize);
        let mut compressed = false;
        let (mut data_start, mut data_len) = (0u64, 0u64);
        loop {
            let mut ch = [0u8; 12];
            if f.read_exact(&mut ch).is_err() {
                break;
            }
            let id = &ch[0..4];
            let size = be64(&ch[4..12]);
            let body = f.stream_position().map_err(|e| e.to_string())?;
            match id {
                b"PROP" => {
                    // "SND " then sub-chunks
                    let mut snd = [0u8; 4];
                    f.read_exact(&mut snd).map_err(|e| e.to_string())?;
                    let end = body + size;
                    while f.stream_position().map_err(|e| e.to_string())? + 12 <= end {
                        let mut sc = [0u8; 12];
                        f.read_exact(&mut sc).map_err(|e| e.to_string())?;
                        let ssize = be64(&sc[4..12]);
                        let sbody = f.stream_position().map_err(|e| e.to_string())?;
                        let mut data = vec![0u8; ssize.min(4096) as usize];
                        f.read_exact(&mut data).map_err(|e| e.to_string())?;
                        match &sc[0..4] {
                            b"FS  " if data.len() >= 4 => rate = u32::from_be_bytes(data[0..4].try_into().unwrap()),
                            b"CHNL" if data.len() >= 2 => channels = u16::from_be_bytes([data[0], data[1]]) as usize,
                            b"CMPR" if data.len() >= 4 => compressed = &data[0..4] != b"DSD ",
                            _ => {}
                        }
                        f.seek(SeekFrom::Start(sbody + ssize + (ssize & 1))).map_err(|e| e.to_string())?;
                    }
                }
                b"DSD " => {
                    data_start = body;
                    data_len = size;
                    break;
                }
                b"DST " => {
                    compressed = true;
                    break;
                }
                _ => {}
            }
            f.seek(SeekFrom::Start(body + size + (size & 1))).map_err(|e| e.to_string())?;
        }
        if compressed {
            return Err("This DSDIFF file is DST-compressed, which isn't supported. Plain DSD .dff files play fine.".into());
        }
        if rate == 0 || channels == 0 || data_len == 0 {
            return Err("DSDIFF: no DSD audio found".into());
        }
        let (conv, pcm_rate) = DsdConv::new(rate, dop);
        let duration = data_len as f64 / channels as f64 * 8.0 / rate as f64;
        f.seek(SeekFrom::Start(data_start)).map_err(|e| e.to_string())?;
        Ok(Self { input: f, info: dsd_info("DFF", rate, pcm_rate, channels as u16, duration, dop), conv, channels, data_start, data_len, pos: 0, buf: Vec::new() })
    }
}

impl Source for DffSource {
    fn info(&self) -> &StreamInfo {
        &self.info
    }
    fn decode_more(&mut self, out: &mut Vec<f32>) -> bool {
        let ch = self.channels;
        let want = (ch * 4096) as u64;
        let n = want.min(self.data_len - self.pos.min(self.data_len)) as usize / ch * ch;
        if n == 0 {
            return false;
        }
        self.buf.resize(n, 0);
        if self.input.read_exact(&mut self.buf).is_err() {
            return false;
        }
        self.pos += n as u64;
        let frames = n / ch;
        let (lc, rc) = if ch == 1 { (0, 0) } else { (0, 1) };
        let l: Vec<u8> = (0..frames).map(|i| self.buf[i * ch + lc]).collect();
        let r: Vec<u8> = (0..frames).map(|i| self.buf[i * ch + rc]).collect();
        self.conv.push(&l, &r, out);
        true
    }
    fn seek(&mut self, secs: f64) -> f64 {
        let ch = self.channels as u64;
        let byte_frames = ((secs.max(0.0) * self.info.dsd_rate as f64 / 8.0) as u64 / 4 * 4).min(self.data_len / ch);
        self.pos = byte_frames * ch;
        let _ = self.input.seek(SeekFrom::Start(self.data_start + self.pos));
        self.conv.reset();
        byte_frames as f64 * 8.0 / self.info.dsd_rate as f64
    }
}

// ---------------------------------------------------------------------------------------------
// SACD disc images (.iso) — Scarletbook stereo area, plain DSD
// ---------------------------------------------------------------------------------------------

const SECTOR: u64 = 2048;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SacdTrack {
    pub number: usize,
    pub title: String,
    pub artist: String,
    pub duration: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SacdDisc {
    pub album: String,
    pub artist: String,
    pub dst: bool,
    pub tracks: Vec<SacdTrack>,
}

struct SacdArea {
    starts: Vec<u32>,
    lengths: Vec<u32>,
    durations: Vec<f64>,
    channels: u8,
    dst: bool,
    titles: Vec<String>,
    album: String,
    artist: String,
}

/// Rough playing time of a run of plain-DSD sectors (one 1/75 s frame = 4704 bytes per channel).
fn sectors_to_secs(sectors: u32, channels: u8) -> f64 {
    sectors as f64 * 2030.0 / (4704.0 * channels.max(1) as f64 * 75.0)
}

fn read_sector(f: &mut dyn ReadSeek, lsn: u64, buf: &mut [u8; 2048]) -> Result<(), String> {
    f.seek(SeekFrom::Start(lsn * SECTOR)).map_err(|e| e.to_string())?;
    f.read_exact(buf).map_err(|e| e.to_string())
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

fn read_area(f: &mut dyn ReadSeek) -> Result<SacdArea, String> {
    let mut s = [0u8; 2048];
    read_sector(f, 510, &mut s)?;
    if &s[0..8] != b"SACDMTOC" {
        return Err("Not an SACD disc image (no Scarletbook master TOC)".into());
    }
    let two_ch = be32(&s[64..68]);
    let multi = be32(&s[72..76]);
    let area = if two_ch != 0 { two_ch } else { multi };
    if area == 0 {
        return Err("SACD image has no audio area".into());
    }
    // master text (album title / artist) — sector 511, offsets are relative to the sector
    let (mut album, mut artist) = (String::new(), String::new());
    if read_sector(f, 511, &mut s).is_ok() && &s[0..8] == b"SACDText" {
        let txt = |off: u16, s: &[u8; 2048]| -> String {
            if off == 0 || off as usize >= 2048 {
                return String::new();
            }
            let b = &s[off as usize..];
            let end = b.iter().position(|&c| c == 0).unwrap_or(b.len().min(200));
            String::from_utf8_lossy(&b[..end]).trim().to_string()
        };
        album = txt(u16::from_be_bytes([s[16], s[17]]), &s);
        artist = txt(u16::from_be_bytes([s[18], s[19]]), &s);
    }
    read_sector(f, area as u64, &mut s)?;
    if &s[0..8] != b"TWOCHTOC" && &s[0..8] != b"MULCHTOC" {
        return Err("SACD: area TOC not found".into());
    }
    let dst = (s[21] & 0x0F) == 0;
    let channels = s[32].max(2);
    let toc_size = u16::from_be_bytes([s[10], s[11]]) as u64;
    let (mut starts, mut lengths, mut durations, mut titles) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for k in 1..toc_size.max(1).min(64) {
        if read_sector(f, area as u64 + k, &mut s).is_err() {
            break;
        }
        match &s[0..8] {
            b"SACDTRL1" => {
                for i in 0..255 {
                    let st = be32(&s[8 + i * 4..]);
                    let ln = be32(&s[8 + 1020 + i * 4..]);
                    if st == 0 || ln == 0 {
                        break;
                    }
                    starts.push(st);
                    lengths.push(ln);
                }
            }
            b"SACDTRL2" => {
                for i in 0..255 {
                    let d = &s[8 + 1020 + i * 4..8 + 1020 + i * 4 + 4];
                    let secs = d[0] as f64 * 60.0 + d[1] as f64 + d[2] as f64 / 75.0;
                    if secs == 0.0 && i > 0 {
                        break;
                    }
                    durations.push(secs);
                }
            }
            b"SACDTTxt" => {
                // per-track text offsets (u16) at 16.., each points to [type,pad,text\0] groups
                for i in 0..255 {
                    let off = u16::from_be_bytes([s[16 + i * 2], s[17 + i * 2]]) as usize;
                    if off == 0 || off >= 2040 {
                        if i >= starts.len().max(1) {
                            break;
                        }
                        titles.push(String::new());
                        continue;
                    }
                    let b = &s[off + 4..];
                    let end = b.iter().position(|&c| c == 0).unwrap_or(0);
                    titles.push(String::from_utf8_lossy(&b[..end]).trim().to_string());
                }
            }
            _ => {}
        }
    }
    if starts.is_empty() {
        return Err("SACD: no track list found".into());
    }
    Ok(SacdArea { starts, lengths, durations, channels, dst, titles, album, artist })
}

/// Track list of an SACD image (for the library).
pub fn sacd_disc(path: &Path) -> Result<SacdDisc, String> {
    let mut f = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
    let a = read_area(&mut f)?;
    let tracks = (0..a.starts.len())
        .map(|i| SacdTrack {
            number: i + 1,
            title: a.titles.get(i).cloned().filter(|t| !t.is_empty()).unwrap_or_else(|| format!("Track {}", i + 1)),
            artist: a.artist.clone(),
            duration: a.durations.get(i).copied().filter(|d| *d > 0.0).unwrap_or_else(|| sectors_to_secs(a.lengths[i], a.channels)),
        })
        .collect();
    Ok(SacdDisc { album: a.album, artist: a.artist, dst: a.dst, tracks })
}

pub struct SacdIsoSource {
    f: Box<dyn ReadSeek>,
    info: StreamInfo,
    conv: DsdConv,
    start: u64,
    end: u64,
    lsn: u64,
    channels: usize,
    aligned: bool,
    sec: [u8; 2048],
}

impl SacdIsoSource {
    pub fn open(path: &Path, track: usize, dop: bool) -> Result<Self, String> {
        let (mut f, _) = open_input(path)?;
        let a = read_area(&mut f)?;
        if a.dst {
            return Err("This SACD image is DST-compressed, which isn't supported. Plain-DSD images play fine (or convert it to DSF first).".into());
        }
        let i = track.checked_sub(1).filter(|&i| i < a.starts.len()).ok_or("SACD: no such track")?;
        let start = a.starts[i] as u64;
        let end = start + a.lengths[i] as u64;
        let dsd_rate = 2_822_400;
        let (conv, rate) = DsdConv::new(dsd_rate, dop);
        let duration = a.durations.get(i).copied().filter(|d| *d > 0.0).unwrap_or_else(|| sectors_to_secs(a.lengths[i], a.channels));
        let channels = a.channels as usize;
        Ok(Self { f, info: dsd_info("SACD", dsd_rate, rate, channels as u16, duration, dop), conv, start, end, lsn: start, channels, aligned: true, sec: [0; 2048] })
    }

    /// Audio payload bytes of one sector (channel-interleaved DSD), or None at the end.
    fn next_payload(&mut self, out: &mut Vec<u8>) -> Option<()> {
        if self.lsn >= self.end {
            return None;
        }
        let lsn = self.lsn;
        self.lsn += 1;
        let mut sec = self.sec;
        read_sector(&mut self.f, lsn, &mut sec).ok()?;
        self.sec = sec;
        let h = self.sec[0];
        let packets = (h & 0x07) as usize;
        let frames = ((h >> 3) & 0x07) as usize;
        let dst = h & 0x80 != 0;
        let mut p = 1 + packets * 2 + frames * if dst { 4 } else { 3 };
        for k in 0..packets {
            let w = u16::from_be_bytes([self.sec[1 + k * 2], self.sec[2 + k * 2]]);
            let frame_start = w & 0x8000 != 0;
            let kind = (w >> 11) & 0x07;
            let len = (w & 0x07FF) as usize;
            if p + len > 2048 {
                break;
            }
            if kind == 2 {
                if !self.aligned && frame_start {
                    self.aligned = true;
                }
                if self.aligned {
                    out.extend_from_slice(&self.sec[p..p + len]);
                }
            }
            p += len;
        }
        Some(())
    }
}

impl Source for SacdIsoSource {
    fn info(&self) -> &StreamInfo {
        &self.info
    }
    fn decode_more(&mut self, out: &mut Vec<f32>) -> bool {
        let mut raw = Vec::with_capacity(8 * 2048);
        for _ in 0..8 {
            if self.next_payload(&mut raw).is_none() {
                break;
            }
        }
        if raw.is_empty() {
            return self.lsn < self.end;
        }
        let ch = self.channels.max(1);
        let frames = raw.len() / ch;
        let l: Vec<u8> = (0..frames).map(|i| raw[i * ch]).collect();
        let r: Vec<u8> = (0..frames).map(|i| raw[i * ch + if ch > 1 { 1 } else { 0 }]).collect();
        self.conv.push(&l, &r, out);
        true
    }
    fn seek(&mut self, secs: f64) -> f64 {
        let span = (self.end - self.start) as f64;
        let frac = (secs / self.info.duration.max(0.001)).clamp(0.0, 1.0);
        self.lsn = self.start + (span * frac) as u64;
        self.aligned = secs <= 0.0;
        self.conv.reset();
        frac * self.info.duration
    }
}

// ---------------------------------------------------------------------------------------------
// Monkey's Audio (.ape)
// ---------------------------------------------------------------------------------------------

pub struct ApeSource {
    dec: ape_decoder::ApeDecoder<Box<dyn ReadSeek>>,
    info: StreamInfo,
    frame: u32,
    skip: u64,
    ch: usize,
    bps: usize,
    render: Render,
}

impl ApeSource {
    pub fn open(path: &Path) -> Result<Self, String> {
        let (f, _) = open_input(path)?;
        let dec = ape_decoder::ApeDecoder::new(f).map_err(|e| format!("APE: {e}"))?;
        let i = dec.info().clone();
        let ch = i.channels.max(1) as usize;
        let info = StreamInfo {
            codec: "APE".into(),
            sample_rate: i.sample_rate,
            bits: i.bits_per_sample as u32,
            channels: ch as u16,
            duration: i.total_samples as f64 / i.sample_rate.max(1) as f64,
            lossless: true,
            ..Default::default()
        };
        let render = Render::new(i.sample_rate, ch, default_mask(ch));
        Ok(Self { dec, info, frame: 0, skip: 0, ch, bps: i.bytes_per_sample.max(1) as usize, render })
    }
}

impl Source for ApeSource {
    fn info(&self) -> &StreamInfo {
        &self.info
    }
    fn decode_more(&mut self, out: &mut Vec<f32>) -> bool {
        loop {
            if self.frame >= self.dec.total_frames() {
                return false;
            }
            let f = self.frame;
            self.frame += 1;
            let Ok(bytes) = self.dec.decode_frame(f) else { continue };
            let n = bytes.len() / self.bps;
            let mut pcm = Vec::with_capacity(n);
            for k in 0..n {
                let b = &bytes[k * self.bps..];
                let v = match self.bps {
                    1 => (b[0] as f32 - 128.0) / 128.0,
                    2 => i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0,
                    3 => ((((b[2] as i32) << 24) | ((b[1] as i32) << 16) | ((b[0] as i32) << 8)) >> 8) as f32 / 8_388_608.0,
                    _ => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
                };
                pcm.push(v);
            }
            let skip = (self.skip as usize * self.ch).min(pcm.len());
            self.skip = 0;
            self.render.process(&pcm[skip..], out);
            return true;
        }
    }
    fn seek(&mut self, secs: f64) -> f64 {
        let sample = (secs.max(0.0) * self.info.sample_rate as f64) as u64;
        match self.dec.seek(sample) {
            Ok(r) => {
                self.frame = r.frame_index;
                self.skip = r.skip_samples as u64;
                self.render.reset();
                r.actual_sample as f64 / self.info.sample_rate.max(1) as f64
            }
            Err(_) => 0.0,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Spatial renderer: any channel layout -> stereo (binaural for headphones, or ITU downmix)
// ---------------------------------------------------------------------------------------------

/// WAVE channel-mask bits, in channel order.
const SPEAKERS: [(u32, f64, f64); 18] = [
    (0x1, -30.0, 0.0),     // FL
    (0x2, 30.0, 0.0),      // FR
    (0x4, 0.0, 0.0),       // FC
    (0x8, 0.0, -99.0),     // LFE
    (0x10, -140.0, 0.0),   // BL
    (0x20, 140.0, 0.0),    // BR
    (0x40, -15.0, 0.0),    // FLC
    (0x80, 15.0, 0.0),     // FRC
    (0x100, 180.0, 0.0),   // BC
    (0x200, -100.0, 0.0),  // SL
    (0x400, 100.0, 0.0),   // SR
    (0x800, 0.0, 85.0),    // TC
    (0x1000, -45.0, 45.0), // TFL
    (0x2000, 0.0, 45.0),   // TFC
    (0x4000, 45.0, 45.0),  // TFR
    (0x8000, -135.0, 45.0), // TBL
    (0x10000, 180.0, 45.0), // TBC
    (0x20000, 135.0, 45.0), // TBR
];

pub fn default_mask(ch: usize) -> u32 {
    match ch {
        1 => 0x4,
        2 => 0x3,
        3 => 0x7,
        4 => 0x33,
        5 => 0x37,
        6 => 0x3F,
        7 => 0x13F,
        8 => 0x63F,
        10 => 0x5063F,  // 7.1.2 (approx.)
        12 => 0x2D63F,  // 7.1.4
        _ => 0,
    }
}

/// Channel mask for an FFmpeg layout name ("5.1(side)", "7.1.4", …).
fn ffmpeg_layout_mask(name: &str, ch: usize) -> u32 {
    match name.trim() {
        "mono" => 0x4,
        "stereo" => 0x3,
        "2.1" => 0xB,
        "3.0" => 0x7,
        "quad" => 0x33,
        "quad(side)" => 0x603,
        "4.0" => 0x107,
        "5.0" => 0x37,
        "5.0(side)" => 0x607,
        "5.1" => 0x3F,
        "5.1(side)" => 0x60F,
        "6.1" => 0x70F,
        "7.1" => 0x63F,
        "7.1(wide)" => 0xFF,
        "7.1(wide-side)" => 0x6CF,
        "5.1.2" => 0x503F,
        "5.1.4" => 0x2D03F,
        "7.1.2" => 0x563F,
        "7.1.4" => 0x2D63F,
        _ => default_mask(ch),
    }
}

struct Ear {
    buf: Vec<f64>,
    w: usize,
}
impl Ear {
    fn new(n: usize) -> Self {
        Self { buf: vec![0.0; n.next_power_of_two().max(8)], w: 0 }
    }
    fn push(&mut self, x: f64) {
        self.w = (self.w + 1) & (self.buf.len() - 1);
        self.buf[self.w] = x;
    }
    fn read(&self, d: f64) -> f64 {
        let m = self.buf.len() - 1;
        let d = d.clamp(0.0, (self.buf.len() - 2) as f64);
        let i = d.floor() as usize;
        let f = d - i as f64;
        let a = self.buf[(self.w + self.buf.len() - i) & m];
        let b = self.buf[(self.w + self.buf.len() - i - 1) & m];
        a + (b - a) * f
    }
}

struct VSpk {
    lfe: bool,
    // stereo downmix gains
    gl: f64,
    gr: f64,
    // binaural
    line: Ear,
    d_near: f64,
    d_far: f64,
    g_near: f64,
    g_far: f64,
    right_near: bool,
    shadow_a: f64,
    shadow_z: f64,
    tone: [Biquad; 2],
    send: f64,
}

pub struct Render {
    ch: usize,
    binaural: bool,
    spk: Vec<VSpk>,
    room: Option<Reverb>,
    norm: f64,
    pub label: String,
}

impl Render {
    pub fn new(sr: u32, ch: usize, mask: u32) -> Self {
        let sr = sr.max(8_000) as f64;
        let binaural = ch > 2 && options().spatial != "stereo";
        // positions for each channel, in mask order (unknown extra channels default around the listener)
        let mut pos: Vec<(f64, f64)> = SPEAKERS.iter().filter(|(b, _, _)| mask & b != 0).map(|&(_, az, el)| (az, el)).collect();
        while pos.len() < ch {
            let k = pos.len() as f64;
            pos.push((-180.0 + 360.0 * (k * 0.618).fract(), 0.0));
        }
        pos.truncate(ch);
        let mains = pos.iter().filter(|p| p.1 > -90.0).count().max(1) as f64;
        const HEAD: f64 = 0.0875;
        const C: f64 = 343.0;
        let spk = pos
            .iter()
            .map(|&(az, el)| {
                let lfe = el < -90.0;
                let th = az.to_radians();
                let elev = el.to_radians();
                let behind = az.abs() > 90.0;
                let lateral = if behind { th.signum() * (std::f64::consts::PI - th.abs()) } else { th } * elev.cos();
                let la = lateral.abs();
                let itd = HEAD / C * (la + la.sin());
                let base = 1.6 / C * sr + 8.0;
                let shadow_hz = 20_000.0 * (1.0 - 0.85 * la.sin());
                // stereo downmix (constant power pan, rears/heights a little lower)
                let pan = (az.clamp(-90.0, 90.0) / 90.0 + 1.0) * std::f64::consts::FRAC_PI_4;
                let lvl = if lfe { 0.0 } else if el > 0.0 { 0.6 } else if behind { 0.75 } else { 1.0 };
                VSpk {
                    lfe,
                    gl: pan.cos() * lvl,
                    gr: pan.sin() * lvl,
                    line: Ear::new((sr * 0.01) as usize),
                    d_near: base,
                    d_far: base + itd * sr,
                    g_near: 10f64.powf(1.5 * la.sin() / 20.0),
                    g_far: 10f64.powf(-7.0 * la.sin() / 20.0),
                    right_near: lateral >= 0.0,
                    shadow_a: (-2.0 * std::f64::consts::PI * shadow_hz.min(sr * 0.49) / sr).exp(),
                    shadow_z: 0.0,
                    tone: [
                        // behind: duller; above: pinna notch around 7–8 kHz plus a little "air"
                        Biquad::highshelf(sr, 4_000.0, 0.7, if behind { -5.0 } else { 0.0 }),
                        if el > 0.0 { Biquad::peaking(sr, 7_600.0, 2.0, -9.0 * (el / 90.0).min(1.0) - 2.0) } else { Biquad::peaking(sr, 1_000.0, 1.0, 0.0) },
                    ],
                    send: if el > 0.0 { 0.22 } else { 0.14 },
                }
            })
            .collect();
        let room = if binaural {
            let mut r = Reverb::new(sr, 0.5, 6.0);
            r.feedback = 0.7;
            r.damp = 0.5;
            Some(r)
        } else {
            None
        };
        let label = if ch <= 2 { String::new() } else if binaural { format!("{ch}ch → binaural") } else { format!("{ch}ch → stereo") };
        Self { ch, binaural, spk, room, norm: 1.0 / mains.sqrt() * 1.15, label }
    }

    pub fn reset(&mut self) {
        for s in self.spk.iter_mut() {
            s.line = Ear::new(s.line.buf.len());
            s.shadow_z = 0.0;
        }
    }

    /// Interleaved `ch`-channel samples in, interleaved stereo out.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let ch = self.ch.max(1);
        let frames = input.len() / ch;
        out.reserve(frames * 2);
        if ch == 1 {
            for &x in &input[..frames] {
                out.push(x);
                out.push(x);
            }
            return;
        }
        if ch == 2 {
            out.extend_from_slice(&input[..frames * 2]);
            return;
        }
        for f in 0..frames {
            let s = &input[f * ch..f * ch + ch];
            let (mut l, mut r, mut send, mut lfe) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
            for (k, v) in self.spk.iter_mut().enumerate() {
                let x = s[k] as f64;
                if v.lfe {
                    lfe += x;
                    continue;
                }
                if !self.binaural {
                    l += x * v.gl;
                    r += x * v.gr;
                    continue;
                }
                let t0 = v.tone[0].run(0, x);
                let y = v.tone[1].run(0, t0);
                v.line.push(y);
                let near = v.line.read(v.d_near) * v.g_near;
                let far_raw = v.line.read(v.d_far);
                v.shadow_z = far_raw * (1.0 - v.shadow_a) + v.shadow_z * v.shadow_a;
                let far = v.shadow_z * v.g_far;
                if v.right_near {
                    r += near;
                    l += far;
                } else {
                    l += near;
                    r += far;
                }
                send += y * v.send;
            }
            if let Some(room) = self.room.as_mut() {
                let (rl, rr) = room.run(send, send);
                l += rl * 0.35;
                r += rr * 0.35;
            }
            let n = self.norm;
            out.push(((l + lfe * 0.5) * n) as f32);
            out.push(((r + lfe * 0.5) * n) as f32);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Windows Media Foundation (Dolby Digital / Dolby Digital Plus incl. Atmos, WMA, …)
// ---------------------------------------------------------------------------------------------

mod mf {
    use super::*;
    use windows::core::{GUID, HSTRING};
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::System::Variant::VT_I8;

    fn init() {
        thread_local!(static COM: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
        COM.with(|c| {
            if !c.get() {
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                }
                c.set(true);
            }
        });
        static START: std::sync::Once = std::sync::Once::new();
        START.call_once(|| unsafe {
            let _ = MFStartup(MF_VERSION, MFSTARTUP_FULL);
        });
    }

    const AUDIO: u32 = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;

    /// Exact length of a raw E-AC-3 / AC-3 stream, by walking its frames (Media Foundation only
    /// estimates it for elementary streams).
    fn raw_dolby_duration(path: &Path) -> Option<f64> {
        const AC3_RATES: [u32; 3] = [48_000, 44_100, 32_000];
        // AC-3 frame sizes in 16-bit words for 48 kHz, per frmsizecod/2 (44.1/32 kHz scale from it)
        const AC3_KBPS: [u32; 19] = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];
        let data = std::fs::read(path).ok()?;
        let (mut i, mut samples, mut rate) = (0usize, 0u64, 0u32);
        while i + 6 <= data.len() {
            if data[i] != 0x0B || data[i + 1] != 0x77 {
                i += 1;
                continue;
            }
            let bsid = data[i + 5] >> 3;
            if (11..=16).contains(&bsid) {
                let strmtyp = data[i + 2] >> 6;
                let substream = (data[i + 2] >> 3) & 7;
                let frmsiz = (((data[i + 2] & 7) as usize) << 8) | data[i + 3] as usize;
                let fscod = (data[i + 4] >> 6) as usize;
                let (blocks, sr) = if fscod == 3 {
                    (6u64, [24_000, 22_050, 16_000][(((data[i + 4] >> 4) & 3) as usize).min(2)])
                } else {
                    ([1u64, 2, 3, 6][((data[i + 4] >> 4) & 3) as usize], AC3_RATES[fscod])
                };
                if strmtyp != 1 && substream == 0 {
                    samples += blocks * 256;
                    rate = sr;
                }
                i += (frmsiz + 1) * 2;
            } else if bsid <= 8 {
                let fscod = (data[i + 4] >> 6) as usize;
                let code = (data[i + 4] & 0x3F) as usize;
                if fscod > 2 || code / 2 >= AC3_KBPS.len() {
                    i += 1;
                    continue;
                }
                let kbps = AC3_KBPS[code / 2];
                let words = match fscod {
                    0 => kbps * 2,
                    1 => kbps * 320 / 147 + (code as u32 & 1),
                    _ => kbps * 3,
                };
                samples += 1536;
                rate = AC3_RATES[fscod];
                i += words as usize * 2;
            } else {
                i += 1;
            }
        }
        (rate > 0).then(|| samples as f64 / rate as f64)
    }

    pub struct MfSource {
        reader: IMFSourceReader,
        info: StreamInfo,
        render: Render,
        ch: usize,
        eof: bool,
    }
    // Media Foundation's source reader is free-threaded.
    unsafe impl Send for MfSource {}

    /// Does an MP4's `dec3` box flag Dolby Atmos (JOC)?
    fn mp4_has_atmos(path: &Path) -> bool {
        let Ok(mut f) = File::open(path) else { return false };
        let mut buf = vec![0u8; 4 << 20];
        let n = f.read(&mut buf).unwrap_or(0);
        let b = &buf[..n];
        if let Some(i) = b.windows(4).position(|w| w == b"dec3") {
            // dec3: data_rate(13) num_ind_sub(3) then per substream 3 bytes (+1 if num_dep_sub>0);
            // a trailing reserved(7)+flag_ec3_extension_type_a(1) byte signals JOC
            let size = u32::from_be_bytes([b[i - 4], b[i - 3], b[i - 2], b[i - 1]]) as usize;
            if size >= 8 && i + size - 4 <= b.len() {
                let body = &b[i + 4..i - 4 + size];
                let num_ind = ((u16::from_be_bytes([body[0], body[1]]) & 0x7) + 1) as usize;
                let mut p = 2;
                for _ in 0..num_ind {
                    if p + 3 > body.len() {
                        return false;
                    }
                    let num_dep = (body[p + 2] >> 1) & 0x0F;
                    p += 3 + if num_dep > 0 { 1 } else { 0 };
                }
                return p < body.len() && body[p] & 0x01 == 1;
            }
        }
        false
    }

    impl MfSource {
        pub fn open(path: &Path) -> Result<Self, String> {
            init();
            unsafe {
                let reader = MFCreateSourceReaderFromURL(&HSTRING::from(path.as_os_str()), None).map_err(|e| format!("Windows can't open this file: {e}"))?;
                reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false).ok();
                reader.SetStreamSelection(AUDIO, true).map_err(|_| "No audio stream".to_string())?;
                let native = reader.GetNativeMediaType(AUDIO, 0).map_err(|e| e.to_string())?;
                let sub = native.GetGUID(&MF_MT_SUBTYPE).unwrap_or(GUID::zeroed());
                let src_ch = native.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(2);
                let t = MFCreateMediaType().map_err(|e| e.to_string())?;
                t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|e| e.to_string())?;
                t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float).map_err(|e| e.to_string())?;
                reader
                    .SetCurrentMediaType(AUDIO, None, &t)
                    .map_err(|e| format!("No decoder for this audio format is installed in Windows ({e})"))?;
                let cur = reader.GetCurrentMediaType(AUDIO).map_err(|e| e.to_string())?;
                let ch = cur.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(2).max(1) as usize;
                let rate = cur.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(48_000);
                let mask = cur.GetUINT32(&MF_MT_AUDIO_CHANNEL_MASK).unwrap_or(default_mask(ch));
                let duration = reader
                    .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
                    .map(|pv| pv.Anonymous.Anonymous.Anonymous.uhVal as f64 / 1e7)
                    .unwrap_or(0.0);
                let atmos = sub == MFAudioFormat_Dolby_DDPlus && mp4_has_atmos(path);
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
                let duration = if matches!(ext.as_str(), "ec3" | "eac3" | "ac3") { raw_dolby_duration(path).unwrap_or(duration) } else { duration };
                let codec = if sub == MFAudioFormat_Dolby_DDPlus {
                    if atmos { "Dolby Atmos (DD+)".to_string() } else { "Dolby Digital Plus".to_string() }
                } else if sub == MFAudioFormat_Dolby_AC4 || sub == MFAudioFormat_Dolby_AC4_V1 || sub == MFAudioFormat_Dolby_AC4_V2 {
                    "Dolby AC-4 (Atmos)".to_string()
                } else if sub == MFAudioFormat_Dolby_AC3 || sub == MFAudioFormat_Dolby_AC3_SPDIF {
                    "Dolby Digital".to_string()
                } else if sub == MFAudioFormat_WMAudioV8 || sub == MFAudioFormat_WMAudioV9 || sub == MFAudioFormat_WMAudio_Lossless {
                    "WMA".to_string()
                } else {
                    "Audio".to_string()
                };
                let render = Render::new(rate, ch, if mask == 0 { default_mask(ch) } else { mask });
                let info = StreamInfo {
                    codec,
                    sample_rate: rate,
                    bits: 0,
                    channels: src_ch.max(ch as u32) as u16,
                    duration,
                    lossless: sub == MFAudioFormat_WMAudio_Lossless,
                    spatial: render.label.clone(),
                    ..Default::default()
                };
                Ok(Self { reader, info, render, ch, eof: false })
            }
        }
    }

    impl Source for MfSource {
        fn info(&self) -> &StreamInfo {
            &self.info
        }
        fn decode_more(&mut self, out: &mut Vec<f32>) -> bool {
            if self.eof {
                return false;
            }
            init();
            unsafe {
                for _ in 0..8 {
                    let mut flags = 0u32;
                    let mut sample: Option<IMFSample> = None;
                    if self.reader.ReadSample(AUDIO, 0, None, Some(&mut flags), None, Some(&mut sample)).is_err() {
                        self.eof = true;
                        return false;
                    }
                    if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                        self.eof = true;
                    }
                    if let Some(s) = sample {
                        let Ok(buf) = s.ConvertToContiguousBuffer() else { continue };
                        let mut p: *mut u8 = std::ptr::null_mut();
                        let mut len = 0u32;
                        if buf.Lock(&mut p, None, Some(&mut len)).is_ok() && !p.is_null() {
                            let n = len as usize / 4 / self.ch * self.ch;
                            let data = std::slice::from_raw_parts(p as *const f32, n);
                            self.render.process(data, out);
                            let _ = buf.Unlock();
                            return true;
                        }
                    }
                    if self.eof {
                        return false;
                    }
                }
            }
            true
        }
        fn seek(&mut self, secs: f64) -> f64 {
            init();
            let pv = PROPVARIANT {
                Anonymous: PROPVARIANT_0 {
                    Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                        vt: VT_I8,
                        wReserved1: 0,
                        wReserved2: 0,
                        wReserved3: 0,
                        Anonymous: PROPVARIANT_0_0_0 { hVal: (secs.max(0.0) * 1e7) as i64 },
                    }),
                },
            };
            unsafe {
                let _ = self.reader.SetCurrentPosition(&GUID::zeroed(), &pv);
            }
            self.eof = false;
            self.render.reset();
            secs.max(0.0)
        }
    }
}
pub use mf::MfSource;

// ---------------------------------------------------------------------------------------------
// FFmpeg (optional, external)
// ---------------------------------------------------------------------------------------------

static FFMPEG: Mutex<Option<Option<PathBuf>>> = Mutex::new(None);

/// Locate ffmpeg.exe: the configured path, PATH, or a winget install.
pub fn find_ffmpeg() -> Option<PathBuf> {
    if let Some(c) = FFMPEG.lock().clone() {
        return c;
    }
    let found = (|| {
        let o = options();
        if !o.ffmpeg_path.trim().is_empty() {
            let p = PathBuf::from(o.ffmpeg_path.trim());
            if p.is_file() {
                return Some(p);
            }
        }
        if let Some(paths) = std::env::var_os("PATH") {
            for d in std::env::split_paths(&paths) {
                let p = d.join("ffmpeg.exe");
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
        let link = local.join("Microsoft\\WinGet\\Links\\ffmpeg.exe");
        if link.is_file() {
            return Some(link);
        }
        let pk = local.join("Microsoft\\WinGet\\Packages");
        for e in std::fs::read_dir(pk).ok()?.flatten() {
            if !e.file_name().to_string_lossy().to_ascii_lowercase().contains("ffmpeg") {
                continue;
            }
            for f in walkdir::WalkDir::new(e.path()).max_depth(4).into_iter().flatten() {
                if f.file_name().eq_ignore_ascii_case("ffmpeg.exe") {
                    return Some(f.path().to_path_buf());
                }
            }
        }
        None
    })();
    *FFMPEG.lock() = Some(found.clone());
    found
}

pub struct FfmpegSource {
    exe: PathBuf,
    path: PathBuf,
    info: StreamInfo,
    render: Render,
    ch: usize,
    child: Option<std::process::Child>,
    rx: Option<crossbeam_channel::Receiver<Vec<f32>>>,
}

fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000)
}

impl FfmpegSource {
    pub fn open(path: &Path) -> Result<Self, String> {
        let exe = find_ffmpeg().ok_or("This format needs FFmpeg, which isn't installed (Settings → Playback engine shows how to add it).")?;
        // probe: `ffmpeg -i` prints the stream line + duration to stderr
        let probe = no_window(std::process::Command::new(&exe).args(["-hide_banner", "-nostdin", "-i"]).arg(path))
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("FFmpeg failed to start: {e}"))?;
        let txt = String::from_utf8_lossy(&probe.stderr);
        let mut duration = 0.0;
        if let Some(i) = txt.find("Duration: ") {
            let d = &txt[i + 10..];
            let t: Vec<f64> = d.split(',').next().unwrap_or("").split(':').filter_map(|x| x.trim().parse().ok()).collect();
            if t.len() == 3 {
                duration = t[0] * 3600.0 + t[1] * 60.0 + t[2];
            }
        }
        let line = txt.lines().find(|l| l.contains("Audio: ")).ok_or("No audio stream found")?;
        let a = &line[line.find("Audio: ").unwrap() + 7..];
        let parts: Vec<&str> = a.split(", ").collect();
        let codec_raw = parts.first().map(|c| c.split_whitespace().next().unwrap_or("")).unwrap_or("").to_string();
        let rate: u32 = parts.iter().find(|p| p.ends_with(" Hz")).and_then(|p| p.trim_end_matches(" Hz").trim().parse().ok()).unwrap_or(48_000);
        let layout = parts.iter().skip_while(|p| !p.ends_with(" Hz")).nth(1).copied().unwrap_or("stereo");
        let ch = match layout.trim() {
            "mono" => 1,
            "stereo" => 2,
            l => {
                if let Some(n) = l.strip_suffix(" channels").and_then(|n| n.trim().parse::<usize>().ok()) {
                    n
                } else {
                    let m = ffmpeg_layout_mask(l, 2);
                    (m.count_ones() as usize).max(2)
                }
            }
        };
        let mask = ffmpeg_layout_mask(layout, ch);
        let lossless = ["truehd", "mlp", "flac", "alac", "wavpack", "ape", "tta", "dts"].iter().any(|c| codec_raw.starts_with(c)) && !codec_raw.starts_with("dts") || layout.contains("lossless");
        let atmos = codec_raw == "truehd" && (txt.contains("Atmos") || ch >= 8);
        let codec = match codec_raw.as_str() {
            "truehd" => if atmos { "Dolby Atmos (TrueHD)".into() } else { "Dolby TrueHD".into() },
            "eac3" => "Dolby Digital Plus".into(),
            "ac3" => "Dolby Digital".into(),
            "dts" => if line.contains("DTS-HD MA") { "DTS-HD MA".into() } else { "DTS".into() },
            "wavpack" => "WavPack".into(),
            "opus" => "Opus".into(),
            c => c.to_uppercase(),
        };
        let render = Render::new(rate, ch, mask);
        let info = StreamInfo { codec, sample_rate: rate, bits: 0, channels: ch as u16, duration, lossless, spatial: render.label.clone(), ..Default::default() };
        let mut s = Self { exe, path: path.to_path_buf(), info, render, ch, child: None, rx: None };
        s.spawn(0.0)?;
        Ok(s)
    }

    fn spawn(&mut self, at: f64) -> Result<(), String> {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        let mut cmd = std::process::Command::new(&self.exe);
        cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error"]);
        if at > 0.0 {
            cmd.args(["-ss", &format!("{at:.3}")]);
        }
        cmd.arg("-i").arg(&self.path).args(["-map", "0:a:0", "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"]);
        let mut child = no_window(&mut cmd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("FFmpeg failed to start: {e}"))?;
        let mut out = child.stdout.take().ok_or("FFmpeg: no output")?;
        let (tx, rx) = crossbeam_channel::bounded::<Vec<f32>>(16);
        let ch = self.ch;
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                let n = match out.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                carry.extend_from_slice(&buf[..n]);
                let whole = carry.len() / (4 * ch) * (4 * ch);
                let v: Vec<f32> = carry[..whole].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
                carry.drain(..whole);
                if !v.is_empty() && tx.send(v).is_err() {
                    break;
                }
            }
        });
        self.child = Some(child);
        self.rx = Some(rx);
        self.render.reset();
        Ok(())
    }
}

impl Source for FfmpegSource {
    fn info(&self) -> &StreamInfo {
        &self.info
    }
    fn decode_more(&mut self, out: &mut Vec<f32>) -> bool {
        let Some(rx) = self.rx.as_ref() else { return false };
        match rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(v) => {
                self.render.process(&v, out);
                true
            }
            Err(_) => false,
        }
    }
    fn seek(&mut self, secs: f64) -> f64 {
        let _ = self.spawn(secs.max(0.0));
        secs.max(0.0)
    }
}

impl Drop for FfmpegSource {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

// ---------------------------------------------------------------------------------------------
// CUE sheets
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueTrack {
    pub number: u32,
    pub title: String,
    pub performer: String,
    pub file: String,
    pub start: f64,
    /// None = until the end of the file
    pub end: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueSheet {
    pub title: String,
    pub performer: String,
    pub genre: String,
    pub date: String,
    pub tracks: Vec<CueTrack>,
}

fn cue_text(raw: &[u8]) -> String {
    // UTF-8 (with or without BOM), else Windows-1252-ish (Latin-1)
    let raw = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw);
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => raw.iter().map(|&b| b as char).collect(),
    }
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if let Some(r) = s.strip_prefix('"') {
        r.split('"').next().unwrap_or("").to_string()
    } else {
        s.to_string()
    }
}

/// Parse a .cue sheet; FILE entries are resolved next to the sheet.
pub fn parse_cue(path: &Path) -> Result<CueSheet, String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let text = cue_text(&raw);
    let dir = path.parent().unwrap_or(Path::new("."));
    let mut sheet = CueSheet { title: String::new(), performer: String::new(), genre: String::new(), date: String::new(), tracks: Vec::new() };
    let mut file = String::new();
    let mut cur: Option<CueTrack> = None;
    let flush = |cur: &mut Option<CueTrack>, sheet: &mut CueSheet| {
        if let Some(t) = cur.take() {
            sheet.tracks.push(t);
        }
    };
    for line in text.lines() {
        let l = line.trim();
        let (cmd, rest) = l.split_once(char::is_whitespace).unwrap_or((l, ""));
        match cmd.to_ascii_uppercase().as_str() {
            "FILE" => {
                flush(&mut cur, &mut sheet);
                let name = unquote(rest.rsplitn(2, char::is_whitespace).last().unwrap_or(rest));
                let mut p = dir.join(&name);
                if !p.is_file() {
                    // sheets often name a .wav that was later compressed: find the same stem
                    let stem = Path::new(&name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    if let Ok(rd) = std::fs::read_dir(dir) {
                        for e in rd.flatten() {
                            let ep = e.path();
                            if ep.file_stem().map(|s| s.to_string_lossy() == stem).unwrap_or(false) && crate::decoder::is_audio_file(&ep) {
                                p = ep;
                                break;
                            }
                        }
                    }
                }
                file = p.to_string_lossy().to_string();
            }
            "TRACK" => {
                flush(&mut cur, &mut sheet);
                let n = rest.split_whitespace().next().and_then(|n| n.parse().ok()).unwrap_or(sheet.tracks.len() as u32 + 1);
                let audio = rest.to_ascii_uppercase().contains("AUDIO");
                cur = audio.then(|| CueTrack { number: n, title: String::new(), performer: String::new(), file: file.clone(), start: 0.0, end: None });
            }
            "TITLE" => match cur.as_mut() {
                Some(t) => t.title = unquote(rest),
                None => sheet.title = unquote(rest),
            },
            "PERFORMER" => match cur.as_mut() {
                Some(t) => t.performer = unquote(rest),
                None => sheet.performer = unquote(rest),
            },
            "REM" => {
                let (k, v) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
                match k.to_ascii_uppercase().as_str() {
                    "GENRE" => sheet.genre = unquote(v),
                    "DATE" => sheet.date = unquote(v),
                    _ => {}
                }
            }
            "INDEX" => {
                let mut it = rest.split_whitespace();
                let idx = it.next().unwrap_or("");
                let t: Vec<f64> = it.next().unwrap_or("").split(':').filter_map(|x| x.parse().ok()).collect();
                if idx == "01" && t.len() == 3 {
                    if let Some(c) = cur.as_mut() {
                        c.start = t[0] * 60.0 + t[1] + t[2] / 75.0;
                    }
                }
            }
            _ => {}
        }
    }
    flush(&mut cur, &mut sheet);
    // each track ends where the next one (in the same file) starts
    let n = sheet.tracks.len();
    for i in 0..n {
        if i + 1 < n && sheet.tracks[i + 1].file == sheet.tracks[i].file {
            sheet.tracks[i].end = Some(sheet.tracks[i + 1].start);
        }
        if sheet.tracks[i].performer.is_empty() {
            sheet.tracks[i].performer = sheet.performer.clone();
        }
        if sheet.tracks[i].title.is_empty() {
            sheet.tracks[i].title = format!("Track {:02}", sheet.tracks[i].number);
        }
    }
    sheet.tracks.retain(|t| Path::new(&t.file).is_file());
    if sheet.tracks.is_empty() {
        return Err("CUE sheet: no playable tracks (is the audio file next to the sheet?)".into());
    }
    Ok(sheet)
}

/// Virtual path for one CUE track.
pub fn cue_track_path(t: &CueTrack) -> String {
    match t.end {
        Some(e) => format!("{}?t={:.4}-{:.4}", t.file, t.start, e),
        None => format!("{}?t={:.4}-", t.file, t.start),
    }
}
