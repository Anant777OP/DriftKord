//! Decoding layer: Symphonia for PCM/FLAC/ALAC/MP3/OGG/AAC/WAV/AIFF and a native
//! DSF reader for DSD (either packed as DoP for bit-perfect DACs, or converted to PCM).
//!
//! Every source produces interleaved *stereo* f32. Integer sources up to 24 bit are
//! represented exactly in f32, which is what makes the bit-perfect path possible.

use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymErr;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::{Time, TimeBase};

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub codec: String,
    pub sample_rate: u32,
    pub bits: u32,
    pub channels: u16,
    pub duration: f64,
    pub lossless: bool,
    pub dsd: bool,
    pub dop: bool,
    /// DSD native rate (e.g. 2822400) when `dsd` is true.
    pub dsd_rate: u32,
    /// How a multichannel source is turned into stereo ("6ch → binaural"), empty for stereo.
    pub spatial: String,
}

pub trait Source: Send {
    fn info(&self) -> &StreamInfo;
    /// Decode the next chunk, appending interleaved stereo f32. Returns false at end of stream.
    fn decode_more(&mut self, out: &mut Vec<f32>) -> bool;
    /// Seek; returns the actual position in seconds.
    fn seek(&mut self, secs: f64) -> f64;
}

pub const AUDIO_EXTENSIONS: &[&str] = &[
    "flac", "wav", "wave", "mp3", "ogg", "oga", "m4a", "alac", "aac", "aif", "aiff", "aifc", "caf",
    "mka", "dsf", "dff", "ape", "wv", "opus", "wma", "ec3", "eac3", "ac3", "thd", "truehd", "mlp", "dts", "tta",
];

/// Extra file types accepted when dropped/opened directly (not picked up by folder scans).
const IMPORT_ONLY: &[&str] = &["mp4", "m4v", "mkv", "mov", "iso", "cue"];

pub fn is_importable(path: &Path) -> bool {
    is_audio_file(path)
        || path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| IMPORT_ONLY.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false)
}

pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Open a file. `dop` requests DoP packing for DSD files (only valid for bit-perfect exclusive output).
pub fn open(path: &Path, dop: bool) -> Result<Box<dyn Source>, String> {
    use crate::formats::{ApeSource, DffSource, FfmpegSource, MfSource, SacdIsoSource};
    // virtual tracks: one track of a CUE album image, or of an SACD disc image
    let s = path.to_string_lossy();
    if let Some((base, q)) = s.split_once('?') {
        return crate::formats::open_virtual(base, q, dop);
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "dsf" => return Ok(Box::new(DsfSource::open(path, dop)?)),
        "dff" => return Ok(Box::new(DffSource::open(path, dop)?)),
        "iso" => return Ok(Box::new(SacdIsoSource::open(path, 1, dop)?)),
        "ape" => return Ok(Box::new(ApeSource::open(path)?)),
        // Dolby Digital (Plus) / Atmos and WMA: Windows' own decoders, FFmpeg as a fallback
        "ec3" | "eac3" | "ac3" | "wma" => {
            return match MfSource::open(path) {
                Ok(s) => Ok(Box::new(s)),
                Err(e) => FfmpegSource::open(path).map(|s| Box::new(s) as Box<dyn Source>).map_err(|_| e),
            }
        }
        // only FFmpeg decodes these
        "thd" | "truehd" | "mlp" | "dts" | "wv" | "opus" | "tta" => return Ok(Box::new(FfmpegSource::open(path)?)),
        _ => {}
    }
    match SymphoniaSource::open(path) {
        Ok(s) => Ok(Box::new(s)),
        Err(e) => {
            // e.g. Dolby Atmos (E-AC-3) in .m4a/.mp4, TrueHD in .mka/.mkv
            if let Ok(s) = MfSource::open(path) {
                return Ok(Box::new(s));
            }
            if let Ok(s) = FfmpegSource::open(path) {
                return Ok(Box::new(s));
            }
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Symphonia
// ---------------------------------------------------------------------------------------------

pub struct SymphoniaSource {
    reader: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    info: StreamInfo,
    sbuf: Option<SampleBuffer<f32>>,
    /// Frames to discard after an accurate seek landed before the requested timestamp.
    skip_frames: u64,
    /// Multichannel -> stereo renderer (created on the first multichannel packet).
    render: Option<crate::formats::Render>,
}

// Symphonia readers/decoders are Send; the trait objects just don't say so.
unsafe impl Send for SymphoniaSource {}

impl SymphoniaSource {
    pub fn open(path: &Path) -> Result<Self, String> {
        let input = crate::formats::MsInput::open(path)?;
        let mss = MediaSourceStream::new(Box::new(input), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        let fmt_opts = FormatOptions {
            enable_gapless: true,
            ..Default::default()
        };
        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &fmt_opts, &MetadataOptions::default())
            .map_err(|e| format!("Unsupported format: {e}"))?;
        let reader = probed.format;
        let track = reader
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or("No audio track found")?;
        let params = track.codec_params.clone();
        let track_id = track.id;
        let decoder = symphonia::default::get_codecs()
            .make(&params, &DecoderOptions::default())
            .map_err(|e| format!("Unsupported codec: {e}"))?;

        let short = symphonia::default::get_codecs()
            .get_codec(params.codec)
            .map(|d| d.short_name.to_string())
            .unwrap_or_else(|| "unknown".into());
        let lossless = short.starts_with("pcm") || short == "flac" || short == "alac" || short == "wavpack";
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_uppercase();
        let codec = match short.as_str() {
            "flac" => "FLAC".to_string(),
            "alac" => "ALAC".to_string(),
            "mp3" => "MP3".to_string(),
            "vorbis" => "OGG Vorbis".to_string(),
            "aac" => "AAC".to_string(),
            s if s.starts_with("pcm") => match ext.as_str() {
                "AIF" | "AIFF" | "AIFC" => "AIFF".to_string(),
                _ => "WAV".to_string(),
            },
            s => s.to_uppercase(),
        };
        let sample_rate = params.sample_rate.unwrap_or(44_100);
        let bits = if lossless {
            params
                .bits_per_sample
                .or(params.bits_per_coded_sample)
                .unwrap_or(16)
        } else {
            0
        };
        let channels = params.channels.map(|c| c.count() as u16).unwrap_or(2);
        let time_base = params.time_base;
        let duration = match (params.n_frames, time_base) {
            (Some(n), Some(tb)) => {
                let t = tb.calc_time(n);
                t.seconds as f64 + t.frac
            }
            (Some(n), None) => n as f64 / sample_rate as f64,
            _ => 0.0,
        };
        Ok(Self {
            reader,
            decoder,
            track_id,
            time_base,
            info: StreamInfo {
                codec,
                sample_rate,
                bits,
                channels,
                duration,
                lossless,
                dsd: false,
                dop: false,
                dsd_rate: 0,
                spatial: String::new(),
            },
            sbuf: None,
            skip_frames: 0,
            render: None,
        })
    }
}

/// Fold any channel layout down to stereo. Mono is duplicated; 5.1/7.1 uses ITU-style
/// coefficients (FL FR FC LFE SL SR [BL BR]).
fn push_stereo(samples: &[f32], ch: usize, out: &mut Vec<f32>, mut skip: u64) -> u64 {
    if ch == 0 {
        return skip;
    }
    let frames = samples.len() / ch;
    out.reserve(frames * 2);
    for f in 0..frames {
        if skip > 0 {
            skip -= 1;
            continue;
        }
        let s = &samples[f * ch..f * ch + ch];
        match ch {
            1 => {
                out.push(s[0]);
                out.push(s[0]);
            }
            2 => {
                out.push(s[0]);
                out.push(s[1]);
            }
            _ => {
                let c = if ch > 2 { s[2] * 0.7071 } else { 0.0 };
                let sl = if ch > 4 { s[4] * 0.7071 } else { 0.0 };
                let sr = if ch > 5 { s[5] * 0.7071 } else { 0.0 };
                let bl = if ch > 6 { s[6] * 0.5 } else { 0.0 };
                let br = if ch > 7 { s[7] * 0.5 } else { 0.0 };
                let norm = 1.0 / (1.0 + 0.7071 + 0.7071 + 0.5);
                out.push((s[0] + c + sl + bl) * norm);
                out.push((s[1] + c + sr + br) * norm);
            }
        }
    }
    skip
}

impl Source for SymphoniaSource {
    fn info(&self) -> &StreamInfo {
        &self.info
    }

    fn decode_more(&mut self, out: &mut Vec<f32>) -> bool {
        loop {
            let packet = match self.reader.next_packet() {
                Ok(p) => p,
                Err(SymErr::ResetRequired) => {
                    // Chained streams (e.g. OGG): rebuild decoder for the new parameters.
                    let params = match self.reader.tracks().iter().find(|t| t.id == self.track_id) {
                        Some(t) => t.codec_params.clone(),
                        None => return false,
                    };
                    match symphonia::default::get_codecs().make(&params, &DecoderOptions::default()) {
                        Ok(d) => self.decoder = d,
                        Err(_) => return false,
                    }
                    continue;
                }
                Err(_) => return false,
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            match self.decoder.decode(&packet) {
                Ok(buf) => {
                    let spec = *buf.spec();
                    let needed = buf.capacity() as u64;
                    let realloc = match &self.sbuf {
                        Some(sb) => sb.capacity() < buf.capacity() * spec.channels.count(),
                        None => true,
                    };
                    if realloc {
                        self.sbuf = Some(SampleBuffer::<f32>::new(needed, spec));
                    }
                    let sb = self.sbuf.as_mut().unwrap();
                    sb.copy_interleaved_ref(buf);
                    let ch = spec.channels.count();
                    if ch > 2 {
                        // multichannel: binaural (headphones) or stereo downmix
                        if self.render.is_none() {
                            let r = crate::formats::Render::new(spec.rate, ch, spec.channels.bits());
                            self.info.spatial = r.label.clone();
                            self.render = Some(r);
                        }
                        let samples = sb.samples();
                        let frames = samples.len() / ch;
                        let skip = (self.skip_frames as usize).min(frames);
                        self.skip_frames -= skip as u64;
                        self.render.as_mut().unwrap().process(&samples[skip * ch..], out);
                    } else {
                        self.skip_frames = push_stereo(sb.samples(), ch, out, self.skip_frames);
                    }
                    return true;
                }
                Err(SymErr::DecodeError(_)) => continue,
                Err(SymErr::IoError(_)) => continue,
                Err(_) => return false,
            }
        }
    }

    fn seek(&mut self, secs: f64) -> f64 {
        let secs = secs.max(0.0);
        let res = self.reader.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time: Time::from(secs),
                track_id: Some(self.track_id),
            },
        );
        self.decoder.reset();
        if let Some(r) = self.render.as_mut() {
            r.reset();
        }
        match res {
            Ok(s) => {
                self.skip_frames = s.required_ts.saturating_sub(s.actual_ts);
                match self.time_base {
                    Some(tb) => {
                        let t = tb.calc_time(s.required_ts);
                        t.seconds as f64 + t.frac
                    }
                    None => secs,
                }
            }
            Err(_) => 0.0,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// DSF (DSD Stream File)
// ---------------------------------------------------------------------------------------------

pub struct DsfSource {
    file: BufReader<Box<dyn crate::formats::ReadSeek>>,
    info: StreamInfo,
    channels: usize,
    block: usize,
    lsb_first: bool,
    data_start: u64,
    data_len: u64,
    consumed: u64,
    total_bits_per_ch: u64,
    bits_emitted: u64,
    dop: bool,
    dop_marker: bool,
    // PCM conversion state: previous 32-bit word per channel for a triangular (64-tap) window,
    // plus 2nd-order low-pass per channel.
    prev_word: [u32; 2],
    lp: [[f64; 4]; 2],
    lp_coef: [f64; 5],
}

impl DsfSource {
    pub fn open(path: &Path, dop: bool) -> Result<Self, String> {
        let (f, _) = crate::formats::open_input(path)?;
        let mut file = BufReader::with_capacity(1 << 16, f);
        let mut hdr = [0u8; 28];
        file.read_exact(&mut hdr).map_err(|e| e.to_string())?;
        if &hdr[0..4] != b"DSD " {
            return Err("Not a DSF file".into());
        }
        let mut fmt = [0u8; 52];
        file.read_exact(&mut fmt).map_err(|e| e.to_string())?;
        if &fmt[0..4] != b"fmt " {
            return Err("DSF: missing fmt chunk".into());
        }
        let le32 = |b: &[u8]| u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        let le64 = |b: &[u8]| u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        let fmt_size = le64(&fmt[4..12]);
        let channels = le32(&fmt[24..28]) as usize;
        let dsd_rate = le32(&fmt[28..32]);
        let bits_per_sample = le32(&fmt[32..36]);
        let sample_count = le64(&fmt[36..44]);
        let block = le32(&fmt[44..48]) as usize;
        if fmt_size > 52 {
            file.seek(SeekFrom::Current((fmt_size - 52) as i64)).map_err(|e| e.to_string())?;
        }
        let mut data_hdr = [0u8; 12];
        file.read_exact(&mut data_hdr).map_err(|e| e.to_string())?;
        if &data_hdr[0..4] != b"data" {
            return Err("DSF: missing data chunk".into());
        }
        let data_len = le64(&data_hdr[4..12]).saturating_sub(12);
        let data_start = file.stream_position().map_err(|e| e.to_string())?;
        if channels == 0 || channels > 6 || block == 0 {
            return Err("DSF: unsupported channel layout".into());
        }
        let duration = sample_count as f64 / dsd_rate as f64;
        let (rate, bits) = if dop { (dsd_rate / 16, 24) } else { (dsd_rate / 32, 24) };
        // 2nd order Butterworth low-pass at 30 kHz for the PCM conversion path.
        let lp_coef = {
            let fs = rate as f64;
            let w0 = 2.0 * std::f64::consts::PI * 30_000f64.min(fs * 0.45) / fs;
            let alpha = w0.sin() / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
            let cosw = w0.cos();
            let a0 = 1.0 + alpha;
            [
                (1.0 - cosw) / 2.0 / a0,
                (1.0 - cosw) / a0,
                (1.0 - cosw) / 2.0 / a0,
                -2.0 * cosw / a0,
                (1.0 - alpha) / a0,
            ]
        };
        Ok(Self {
            file,
            info: StreamInfo {
                codec: format!("DSD{}", dsd_rate / 44_100),
                sample_rate: rate,
                bits,
                channels: channels as u16,
                duration,
                lossless: true,
                dsd: true,
                dop,
                dsd_rate,
                spatial: String::new(),
            },
            channels,
            block,
            lsb_first: bits_per_sample == 1,
            data_start,
            data_len,
            consumed: 0,
            total_bits_per_ch: sample_count,
            bits_emitted: 0,
            dop,
            dop_marker: false,
            prev_word: [0x6969_6969; 2],
            lp: [[0.0; 4]; 2],
            lp_coef,
        })
    }

    fn byte(&self, b: u8) -> u8 {
        if self.lsb_first {
            b.reverse_bits()
        } else {
            b
        }
    }
}

impl Source for DsfSource {
    fn info(&self) -> &StreamInfo {
        &self.info
    }

    fn decode_more(&mut self, out: &mut Vec<f32>) -> bool {
        let group = self.block * self.channels;
        if self.consumed + group as u64 > self.data_len || self.bits_emitted >= self.total_bits_per_ch {
            return false;
        }
        let mut buf = vec![0u8; group];
        if self.file.read_exact(&mut buf).is_err() {
            return false;
        }
        self.consumed += group as u64;
        // Map to stereo: first two channels (DSF channel types 2+ start with FL, FR).
        let (lc, rc) = if self.channels == 1 { (0, 0) } else { (0, 1) };
        let remaining_bytes = ((self.total_bits_per_ch - self.bits_emitted) / 8) as usize;
        let usable = self.block.min(remaining_bytes.max(0));
        if self.dop {
            // 2 DSD bytes per channel -> one 24-bit DoP word: [marker][msb byte][lsb byte]
            let mut i = 0;
            while i + 1 < usable {
                let marker: u32 = if self.dop_marker { 0xFA } else { 0x05 };
                self.dop_marker = !self.dop_marker;
                for &c in &[lc, rc] {
                    let b1 = self.byte(buf[c * self.block + i]) as u32;
                    let b2 = self.byte(buf[c * self.block + i + 1]) as u32;
                    let word = (marker << 16) | (b1 << 8) | b2;
                    let signed = if word & 0x80_0000 != 0 {
                        word as i32 - 0x100_0000
                    } else {
                        word as i32
                    };
                    out.push(signed as f32 / 8_388_608.0);
                }
                i += 2;
            }
        } else {
            // DSD -> PCM: 64-bit triangular window over (previous word, current word), decimate by 32.
            let mut i = 0;
            while i + 3 < usable {
                let mut frame = [0f32; 2];
                for (k, &c) in [lc, rc].iter().enumerate() {
                    let base = c * self.block + i;
                    let w = ((self.byte(buf[base]) as u32) << 24)
                        | ((self.byte(buf[base + 1]) as u32) << 16)
                        | ((self.byte(buf[base + 2]) as u32) << 8)
                        | (self.byte(buf[base + 3]) as u32);
                    let prev = self.prev_word[k];
                    self.prev_word[k] = w;
                    // Triangular weights: rising over prev (1..32), falling over current (32..1).
                    let mut acc = 0i32;
                    for bit in 0..32 {
                        let wp = (bit + 1) as i32;
                        let wc = (32 - bit) as i32;
                        let bp = if (prev >> (31 - bit)) & 1 == 1 { 1 } else { -1 };
                        let bc = if (w >> (31 - bit)) & 1 == 1 { 1 } else { -1 };
                        acc += bp * wp + bc * wc;
                    }
                    let x = acc as f64 / (33.0 * 32.0); // normalise to ±1
                    let c = &self.lp_coef;
                    let st = &mut self.lp[k];
                    let y = c[0] * x + c[1] * st[0] + c[2] * st[1] - c[3] * st[2] - c[4] * st[3];
                    st[1] = st[0];
                    st[0] = x;
                    st[3] = st[2];
                    st[2] = y;
                    frame[k] = (y * 0.5) as f32; // DSD 0 dB ≈ 50% modulation
                }
                out.push(frame[0]);
                out.push(frame[1]);
                i += 4;
            }
        }
        self.bits_emitted += (usable as u64) * 8;
        true
    }

    fn seek(&mut self, secs: f64) -> f64 {
        let bytes_per_ch = (secs.max(0.0) * self.info.dsd_rate as f64 / 8.0) as u64;
        let block_idx = bytes_per_ch / self.block as u64;
        let group = (self.block * self.channels) as u64;
        let pos = (block_idx * group).min(self.data_len.saturating_sub(group));
        let block_idx = pos / group;
        let _ = self.file.seek(SeekFrom::Start(self.data_start + pos));
        self.consumed = pos;
        self.bits_emitted = block_idx * self.block as u64 * 8;
        self.dop_marker = false;
        self.bits_emitted as f64 / self.info.dsd_rate as f64
    }
}

// ---------------------------------------------------------------------------------------------
// Live stream (YouTube Music audio captured in the embedded page and pushed in as PCM)
// ---------------------------------------------------------------------------------------------

/// Times the YouTube stream ran dry while playing (diagnostics).
pub static STREAM_UNDERRUNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Fixed rate the page's AudioContext runs at (Chromium resamples YouTube's audio to it).
pub const STREAM_RATE: u32 = 48_000;

/// Shared buffer between the WebView message handler (producer) and the engine (consumer).
pub struct StreamBuf {
    pub buf: parking_lot::Mutex<std::collections::VecDeque<f32>>,
    primed: std::sync::atomic::AtomicBool,
}

impl StreamBuf {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            buf: parking_lot::Mutex::new(std::collections::VecDeque::with_capacity(STREAM_RATE as usize * 4)),
            primed: std::sync::atomic::AtomicBool::new(false),
        })
    }
    /// Append interleaved stereo samples.
    pub fn push(&self, samples: &[f32]) {
        let mut b = self.buf.lock();
        b.extend(samples.iter().copied());
        // Safety valve only (drift is corrected smoothly by the reader): beyond 2 s, trim to 0.3 s.
        let max = STREAM_RATE as usize * 2 * 2;
        if b.len() > max {
            let keep = STREAM_RATE as usize * 2 * 3 / 10;
            let drop = (b.len() - keep) & !1;
            b.drain(..drop);
        }
    }
    /// Seek / track change in the page: discard what's queued so the new audio starts right away.
    pub fn flush(&self) {
        self.buf.lock().clear();
        self.primed.store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Reads the live stream with a ~0.3 s cushion. Clock drift between the browser and the DAC is
/// absorbed by nudging the read speed (±0.3 %, inaudible) instead of dropping audio, and any
/// dropout fades out/in over 5 ms instead of clicking.
pub struct StreamSource {
    stream: std::sync::Arc<StreamBuf>,
    info: StreamInfo,
    pos: f64,
    gain: f32,
    last: [f32; 2],
}

impl StreamSource {
    pub fn new(stream: std::sync::Arc<StreamBuf>) -> Self {
        Self {
            stream,
            info: StreamInfo {
                codec: "YouTube Music".into(),
                sample_rate: STREAM_RATE,
                bits: 0,
                channels: 2,
                duration: 0.0,
                lossless: false,
                dsd: false,
                dop: false,
                dsd_rate: 0,
                spatial: String::new(),
            },
            pos: 0.0,
            gain: 0.0,
            last: [0.0; 2],
        }
    }

    /// Fade the last sample to silence (used while waiting for data).
    fn fade_out(&mut self, out: &mut Vec<f32>, frames: usize) {
        let step = 1.0 / (STREAM_RATE as f32 * 0.005);
        for _ in 0..frames {
            self.gain = (self.gain - step).max(0.0);
            out.push(self.last[0] * self.gain);
            out.push(self.last[1] * self.gain);
        }
    }
}

impl Source for StreamSource {
    fn info(&self) -> &StreamInfo {
        &self.info
    }

    /// Never reports end-of-stream: when the page is paused or behind, it supplies silence.
    fn decode_more(&mut self, out: &mut Vec<f32>) -> bool {
        use std::sync::atomic::Ordering;
        const CHUNK: usize = 512; // frames per call (~11 ms)
        let rate = STREAM_RATE as f64;
        let target = 0.30; // seconds of cushion
        let mut b = self.stream.buf.lock();
        let avail = b.len() / 2;
        if !self.stream.primed.load(Ordering::Relaxed) {
            self.pos = 0.0;
            if (avail as f64) < target * rate {
                drop(b);
                self.fade_out(out, CHUNK);
                return true;
            }
            self.stream.primed.store(true, Ordering::Relaxed);
        }
        // smooth drift correction: read a hair faster when the cushion grows, slower when it shrinks
        let fill = avail as f64 / rate;
        let ratio = 1.0 + (((fill - target) / target) * 0.003).clamp(-0.003, 0.003);
        let ramp = 1.0 / (STREAM_RATE as f32 * 0.005);
        let mut produced = 0;
        while produced < CHUNK {
            let i = self.pos as usize;
            if i + 1 >= avail {
                // ran dry: re-prime, and fade the remainder of this chunk
                self.stream.primed.store(false, Ordering::Relaxed);
                STREAM_UNDERRUNS.fetch_add(1, Ordering::Relaxed);
                break;
            }
            let f = (self.pos - i as f64) as f32;
            let l = b[i * 2] + (b[i * 2 + 2] - b[i * 2]) * f;
            let r = b[i * 2 + 1] + (b[i * 2 + 3] - b[i * 2 + 1]) * f;
            self.gain = (self.gain + ramp).min(1.0);
            out.push(l * self.gain);
            out.push(r * self.gain);
            self.last = [l, r];
            self.pos += ratio;
            produced += 1;
        }
        let consumed = (self.pos as usize).min(avail);
        b.drain(..consumed * 2);
        self.pos -= consumed as f64;
        drop(b);
        if produced < CHUNK {
            self.fade_out(out, CHUNK - produced);
        }
        true
    }

    fn seek(&mut self, _secs: f64) -> f64 {
        self.stream.flush();
        0.0
    }
}
