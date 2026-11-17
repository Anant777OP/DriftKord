//! Playback engine.
//!
//! ```text
//!  decoder (Source) ─► Loaded (buffer, varispeed/SRC, ReplayGain)
//!                         │  crossfade / gapless hand-over
//!                         ▼
//!                      Player::fill ─► DSP chain ─► volume/duck ─► output thread
//!                                                                 ├─ WASAPI Exclusive (bit-perfect, auto rate/bit switching, DoP)
//!                                                                 ├─ WASAPI Shared (Windows mixer)
//!                                                                 └─ ASIO (native host, no SDK needed)
//! ```
//! The emitter thread turns the meter tap into 60 fps spectrum frames for the UI.

use crate::analysis::{Meter, RealtimeAnalyzer, FFT_N};
use crate::decoder::{self, Source, StreamInfo};
use crate::dsp::{Dsp, DspParams};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------------------------
// Types shared with the UI
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OutputConfig {
    /// "exclusive" | "shared" | "asio"
    pub mode: String,
    pub device_id: Option<String>,
    pub asio_device: Option<String>,
    /// Allow DSD over PCM (DoP) when in exclusive mode.
    pub dop: bool,
}

impl Default for OutputConfig {
    fn default() -> Self {
        Self { mode: "exclusive".into(), device_id: None, asio_device: None, dop: true }
    }
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OutputState {
    pub open: bool,
    pub backend: String,
    pub exclusive: bool,
    pub rate: u32,
    pub bits: u32,
    pub container_bits: u32,
    pub float: bool,
    pub device_name: String,
    pub error: Option<String>,
    pub fell_back: bool,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplayGainInfo {
    pub track_gain: Option<f32>,
    pub track_peak: Option<f32>,
    pub album_gain: Option<f32>,
    pub album_peak: Option<f32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EngineEvent {
    #[serde(rename_all = "camelCase")]
    TrackChanged { path: String, track_id: Option<i64>, gapless: bool, crossfade: bool },
    Ended,
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
    pub state: String,
    pub path: Option<String>,
    pub track_id: Option<i64>,
    pub position: f64,
    pub duration: f64,
    pub info: Option<StreamInfo>,
    pub next_path: Option<String>,
    pub output: OutputState,
    pub signal_path: Vec<String>,
    pub bit_perfect: bool,
    pub resampling: bool,
    pub last_transition_gapless: Option<bool>,
    pub running_dr: Option<f32>,
    pub volume: f32,
    pub duck: f32,
}

// ---------------------------------------------------------------------------------------------
// Loaded track (decoder + buffer + varispeed)
// ---------------------------------------------------------------------------------------------

/// Silences local output while a network player (DLNA) is playing the music; the engine keeps
/// running as the clock for lyrics, visuals and the progress bar.
pub static CAST_MUTE: AtomicBool = AtomicBool::new(false);

/// Pseudo path used for the YouTube Music live stream.
pub const STREAM_PATH: &str = "youtube:stream";

pub struct Loaded {
    pub src: Box<dyn Source>,
    pub path: String,
    pub track_id: Option<i64>,
    pub info: StreamInfo,
    pub rg: ReplayGainInfo,
    buf: VecDeque<f32>,
    tmp: Vec<f32>,
    eof: bool,
    consumed: u64,
    base_pos: f64,
    /// Source frames per output frame (sample-rate conversion factor).
    pub ratio: f64,
    tempo: f64,
    pub tempo_target: f64,
    frac: f64,
    hist: [[f32; 2]; 4],
    pub interp: bool,
    tail: u32,
    /// High-precision windowed-sinc resampler (used for steady rate conversion; the Hermite
    /// interpolator above handles crossfade tempo-matching).
    use_sinc: bool,
    sinc: Option<Sinc>,
    /// User playback speed applied by resampling (pitch follows), 1 = normal.
    pub speed: f64,
    /// How fast the track is consumed overall (speed, with or without pitch preservation).
    pub clock: f64,
}

/// Polyphase windowed-sinc (Kaiser) resampler for one stereo stream.
pub struct Sinc {
    step: f64,
    half: usize,
    phases: usize,
    /// (phases + 1) rows of `2 * half` taps
    table: Vec<f32>,
    win: VecDeque<[f32; 2]>,
    frac: f64,
    tail: usize,
}

impl Sinc {
    fn bessel_i0(x: f64) -> f64 {
        let (mut sum, mut term, mut k) = (1.0, 1.0, 1.0);
        while term > 1e-12 * sum {
            term *= (x / (2.0 * k)) * (x / (2.0 * k));
            sum += term;
            k += 1.0;
        }
        sum
    }
    pub fn new(step: f64) -> Self {
        // wider kernel when downsampling so the anti-alias filter stays steep
        let half = ((64.0 * step.max(1.0)).ceil() as usize).clamp(32, 512);
        let phases = 256;
        let cutoff = 0.94 / step.max(1.0);
        let beta = 9.0;
        let i0b = Self::bessel_i0(beta);
        let taps = 2 * half;
        let mut table = vec![0f32; (phases + 1) * taps];
        for p in 0..=phases {
            let frac = p as f64 / phases as f64;
            let mut sum = 0.0;
            let row = &mut table[p * taps..(p + 1) * taps];
            for (k, v) in row.iter_mut().enumerate() {
                let t = k as f64 - (half as f64 - 1.0) - frac;
                let x = cutoff * t;
                let sinc = if x.abs() < 1e-9 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
                let r = t / half as f64;
                let w = if r.abs() >= 1.0 { 0.0 } else { Self::bessel_i0(beta * (1.0 - r * r).sqrt()) / i0b };
                let h = cutoff * sinc * w;
                *v = h as f32;
                sum += h;
            }
            // unity DC gain for every phase
            if sum.abs() > 1e-9 {
                for v in row.iter_mut() {
                    *v = (*v as f64 / sum) as f32;
                }
            }
        }
        Self { step, half, phases, table, win: VecDeque::with_capacity(taps + 1), frac: 0.0, tail: 0 }
    }
}

impl Loaded {
    pub fn open(path: &str, track_id: Option<i64>, rg: ReplayGainInfo, dop: bool) -> Result<Self, String> {
        let src = decoder::open(Path::new(path), dop)?;
        Ok(Self::from_source(src, path, track_id, rg))
    }

    pub fn from_source(src: Box<dyn Source>, path: &str, track_id: Option<i64>, rg: ReplayGainInfo) -> Self {
        let info = src.info().clone();
        Self {
            src,
            path: path.to_string(),
            track_id,
            info,
            rg,
            buf: VecDeque::with_capacity(32_768),
            tmp: Vec::with_capacity(16_384),
            eof: false,
            consumed: 0,
            base_pos: 0.0,
            ratio: 1.0,
            tempo: 1.0,
            tempo_target: 1.0,
            frac: 0.0,
            hist: [[0.0; 2]; 4],
            interp: false,
            tail: 0,
            use_sinc: crate::formats::options().resampler != "fast",
            sinc: None,
            speed: 1.0,
            clock: 1.0,
        }
    }

    /// One output frame through the sinc resampler.
    fn next_sinc(&mut self, step: f64) -> Option<[f32; 2]> {
        if self.sinc.as_ref().map(|s| (s.step - step).abs() > 1e-9).unwrap_or(true) {
            let mut s = Sinc::new(step);
            // prime: `half - 1` frames of silence before the first sample, then the first `half + 1`
            for _ in 0..s.half - 1 {
                s.win.push_back([0.0; 2]);
            }
            for _ in 0..s.half + 1 {
                let f = self.pull().unwrap_or([0.0; 2]);
                s.win.push_back(f);
            }
            self.sinc = Some(s);
        }
        let s = self.sinc.as_mut().unwrap();
        if s.tail > s.half {
            return None;
        }
        let taps = 2 * s.half;
        let pf = s.frac * s.phases as f64;
        let p = (pf as usize).min(s.phases - 1);
        let t = (pf - p as f64) as f32;
        let (r0, r1) = (&s.table[p * taps..(p + 1) * taps], &s.table[(p + 1) * taps..(p + 2) * taps]);
        let (mut l, mut r) = (0f32, 0f32);
        for (k, w) in s.win.iter().enumerate().take(taps) {
            let h = r0[k] + (r1[k] - r0[k]) * t;
            l += w[0] * h;
            r += w[1] * h;
        }
        s.frac += step;
        let mut advance = 0usize;
        while s.frac >= 1.0 {
            s.frac -= 1.0;
            advance += 1;
        }
        // slide the window forward with fresh input (borrow of the resampler released first)
        for _ in 0..advance {
            let f = match self.pull() {
                Some(f) => f,
                None => {
                    self.sinc.as_mut().unwrap().tail += 1;
                    [0.0; 2]
                }
            };
            let s = self.sinc.as_mut().unwrap();
            s.win.pop_front();
            s.win.push_back(f);
        }
        Some([l, r])
    }

    fn refill(&mut self) {
        while self.buf.len() < 2 && !self.eof {
            self.tmp.clear();
            if self.src.decode_more(&mut self.tmp) {
                self.buf.extend(self.tmp.iter().copied());
            } else {
                self.eof = true;
            }
        }
    }

    #[inline]
    fn pull(&mut self) -> Option<[f32; 2]> {
        if self.buf.len() < 2 {
            self.refill();
        }
        if self.buf.len() >= 2 {
            let l = self.buf.pop_front().unwrap();
            let r = self.buf.pop_front().unwrap();
            self.consumed += 1;
            Some([l, r])
        } else {
            None
        }
    }

    /// Produce one output frame. Exact copy when no rate change is needed (bit-perfect path),
    /// 4-point Hermite interpolation otherwise (crossfade tempo-matching / fixed-rate ASIO).
    #[inline]
    pub fn next_frame(&mut self) -> Option<[f32; 2]> {
        if (self.tempo - self.tempo_target).abs() > 1e-7 {
            self.tempo += (self.tempo_target - self.tempo) * 0.000_02;
        }
        let step = self.ratio * self.tempo * self.speed;
        // steady sample-rate conversion: high-precision sinc (unless a crossfade is tempo-matching)
        if self.use_sinc
            && !self.interp
            && (step - 1.0).abs() >= 1e-9
            && (self.tempo - 1.0).abs() < 1e-9
            && (self.tempo_target - 1.0).abs() < 1e-9
            && (self.speed - 1.0).abs() < 1e-9
        {
            return self.next_sinc(step);
        }
        if !self.interp {
            if (step - 1.0).abs() < 1e-9 {
                return self.pull();
            }
            self.interp = true;
            self.hist[0] = [0.0; 2];
            for i in 1..4 {
                self.hist[i] = self.pull().unwrap_or([0.0; 2]);
            }
            self.frac = 0.0;
        }
        if self.tail >= 3 {
            return None;
        }
        let t = self.frac as f32;
        let h = &self.hist;
        let mut out = [0.0f32; 2];
        for ch in 0..2 {
            let (y0, y1, y2, y3) = (h[0][ch], h[1][ch], h[2][ch], h[3][ch]);
            let c0 = y1;
            let c1 = 0.5 * (y2 - y0);
            let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
            let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
            out[ch] = ((c3 * t + c2) * t + c1) * t + c0;
        }
        self.frac += step;
        while self.frac >= 1.0 {
            self.frac -= 1.0;
            self.hist.rotate_left(1);
            self.hist[3] = match self.pull() {
                Some(f) => f,
                None => {
                    self.tail += 1;
                    [0.0; 2]
                }
            };
        }
        Some(out)
    }

    pub fn position(&self) -> f64 {
        self.base_pos + self.consumed as f64 / self.info.sample_rate.max(1) as f64
    }

    pub fn seek(&mut self, secs: f64) {
        let actual = self.src.seek(secs);
        self.base_pos = actual;
        self.consumed = 0;
        self.buf.clear();
        self.eof = false;
        self.interp = false;
        self.tail = 0;
        self.frac = 0.0;
        self.sinc = None;
    }

    fn remaining_out_frames(&self, out_rate: f64) -> f64 {
        if self.info.duration <= 0.0 {
            return f64::MAX;
        }
        // remaining source frames / (source frames per output frame) == seconds * out_rate / tempo
        let rem = (self.info.duration - self.position()).max(0.0);
        rem * out_rate / (self.tempo * self.clock).max(0.0001)
    }
}

fn rg_gain(l: &Loaded, p: &DspParams) -> f32 {
    let (gain, peak) = match p.replaygain.as_str() {
        "track" => (l.rg.track_gain, l.rg.track_peak),
        "album" => (l.rg.album_gain.or(l.rg.track_gain), l.rg.album_peak.or(l.rg.track_peak)),
        _ => return 1.0,
    };
    let Some(g) = gain else { return 1.0 };
    let lin = 10f32.powf((g + p.rg_preamp_db) / 20.0);
    match peak {
        Some(pk) if pk > 0.0 => lin.min(1.0 / pk),
        _ => lin,
    }
}

struct Fade {
    src: Loaded,
    pos: f64,
    len: f64,
}

// ---------------------------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------------------------

pub struct Player {
    pub cur: Option<Loaded>,
    pub next: Option<Loaded>,
    next_xfade: f64,
    fading: Option<Fade>,
    pub paused: bool,
    pub paused_since: Option<Instant>,
    pub out_rate: u32,
    /// Output cannot change rate (ASIO / forced) — resample instead of reopening.
    pub fixed_rate: bool,
    pub reopen: bool,
    pub dsp: Dsp,
    pub vol: f32,
    pub duck: f32,
    pub duck_target: f32,
    pub events: Vec<EngineEvent>,
    pub last_gapless: Option<bool>,
    pub dop_ok: bool,
    stretch: crate::stretch::Stretch,
    stretch_on: bool,
}

impl Player {
    fn new() -> Self {
        Self {
            cur: None,
            next: None,
            next_xfade: 0.0,
            fading: None,
            paused: false,
            paused_since: None,
            out_rate: 44_100,
            fixed_rate: false,
            reopen: false,
            dsp: Dsp::new(44_100, DspParams::default()),
            vol: 1.0,
            duck: 1.0,
            duck_target: 1.0,
            events: Vec::new(),
            last_gapless: None,
            dop_ok: false,
            stretch: crate::stretch::Stretch::new(44_100),
            stretch_on: false,
        }
    }

    /// Reset the time-stretcher (new track, seek, speed toggled).
    pub fn reset_stretch(&mut self) {
        self.stretch = crate::stretch::Stretch::new(self.out_rate);
    }

    pub fn is_dop(&self) -> bool {
        self.cur.as_ref().map(|c| c.info.dop).unwrap_or(false)
    }

    /// Called by the output thread once a stream is open.
    pub fn output_opened(&mut self, rate: u32, fixed_rate: bool, dop_ok: bool) {
        self.out_rate = rate;
        self.fixed_rate = fixed_rate;
        self.dop_ok = dop_ok;
        self.reopen = false;
        if self.dsp.sample_rate() != rate {
            let p = self.dsp.params.clone();
            self.dsp = Dsp::new(rate, p);
        }
        for l in self.cur.iter_mut().chain(self.next.iter_mut()) {
            l.ratio = l.info.sample_rate as f64 / rate as f64;
        }
    }

    pub fn bit_perfect(&self) -> bool {
        let Some(c) = &self.cur else { return false };
        if c.info.dop {
            return self.dop_ok;
        }
        !CAST_MUTE.load(Ordering::Relaxed)
            && self.dsp.is_bypass()
            && (self.vol - 1.0).abs() < 1e-6
            && (self.duck - 1.0).abs() < 1e-6
            && (rg_gain(c, &self.dsp.params) - 1.0).abs() < 1e-6
            && !c.interp
            && (c.ratio - 1.0).abs() < 1e-9
            && self.fading.is_none()
    }

    pub fn fill(&mut self, out: &mut [f32]) {
        let frames = out.len() / 2;
        if self.paused || self.cur.is_none() || self.reopen {
            out.fill(0.0);
            return;
        }
        let sr = self.out_rate as f64;
        let smooth = (1.0 / (0.08 * sr)) as f32;
        let duck_smooth = (1.0 / (0.6 * sr)) as f32;
        let slider = self.dsp.params.volume.clamp(0.0, 1.0);
        // logarithmic option: the slider spans ~60 dB evenly (fine control at low volume)
        let target_vol = if self.dsp.params.exp_volume { slider * slider * slider } else { slider };
        // playback speed (DSD-over-PCM can't be altered)
        let dop_now = self.cur.as_ref().map(|c| c.info.dop).unwrap_or(false);
        let speed = if dop_now { 1.0 } else { (self.dsp.params.speed as f64).clamp(0.01, 100.0) };
        let stretch = self.dsp.params.preserve_pitch && (speed - 1.0).abs() > 1e-6 && self.fading.is_none();
        if stretch != self.stretch_on {
            self.stretch_on = stretch;
            self.reset_stretch();
        }
        if let Some(c) = self.cur.as_mut() {
            c.speed = if stretch { 1.0 } else { speed };
            c.clock = speed;
        }
        let fast = self.bit_perfect() && (target_vol - 1.0).abs() < 1e-6 && (speed - 1.0).abs() < 1e-6;

        let mut i = 0;
        while i < frames {
            // --- crossfade start
            if self.fading.is_none() && self.next.is_some() && self.next_xfade > 0.0 && (i & 63) == 0 {
                let rem = self.cur.as_ref().unwrap().remaining_out_frames(sr);
                let len = self.next_xfade * sr;
                if rem <= len {
                    let mut n = self.next.take().unwrap();
                    n.ratio = n.info.sample_rate as f64 / sr;
                    let old = self.cur.replace(n).unwrap();
                    self.fading = Some(Fade { src: old, pos: 0.0, len: rem.max(64.0) });
                    let c = self.cur.as_ref().unwrap();
                    self.last_gapless = Some(false);
                    self.events.push(EngineEvent::TrackChanged {
                        path: c.path.clone(),
                        track_id: c.track_id,
                        gapless: false,
                        crossfade: true,
                    });
                }
            }
            // --- current frame
            let next = if self.stretch_on {
                let c = self.cur.as_mut().unwrap();
                self.stretch.next(speed, || c.next_frame())
            } else {
                self.cur.as_mut().unwrap().next_frame()
            };
            let frame = match next {
                Some(f) => f,
                None => {
                    if let Some(mut n) = self.next.take() {
                        let same_rate = n.info.sample_rate == self.out_rate;
                        let dop_change = n.info.dop != self.cur.as_ref().map(|c| c.info.dop).unwrap_or(false);
                        let gapless = same_rate && !dop_change;
                        if self.fixed_rate {
                            n.ratio = n.info.sample_rate as f64 / sr;
                        }
                        self.last_gapless = Some(gapless || (self.fixed_rate && !dop_change));
                        self.events.push(EngineEvent::TrackChanged {
                            path: n.path.clone(),
                            track_id: n.track_id,
                            gapless: gapless || (self.fixed_rate && !dop_change),
                            crossfade: false,
                        });
                        self.cur = Some(n);
                        self.reset_stretch();
                        if let Some(c) = self.cur.as_mut() {
                            c.speed = if self.stretch_on { 1.0 } else { speed };
                            c.clock = speed;
                        }
                        if (!same_rate && !self.fixed_rate) || dop_change {
                            // Format change: the output thread must reopen the device at the new rate.
                            self.reopen = true;
                            out[i * 2..].fill(0.0);
                            return;
                        }
                        self.cur.as_mut().unwrap().next_frame().unwrap_or([0.0; 2])
                    } else if let Some(fd) = self.fading.take() {
                        // current ended during a crossfade (very short track) — keep the tail.
                        self.cur = Some(fd.src);
                        [0.0; 2]
                    } else {
                        self.cur = None;
                        self.events.push(EngineEvent::Ended);
                        out[i * 2..].fill(0.0);
                        return;
                    }
                }
            };
            if fast {
                out[i * 2] = frame[0];
                out[i * 2 + 1] = frame[1];
                i += 1;
                continue;
            }
            let p = &self.dsp.params;
            let g = rg_gain(self.cur.as_ref().unwrap(), p);
            let (mut l, mut r) = (frame[0] * g, frame[1] * g);
            if let Some(fd) = self.fading.as_mut() {
                let t = (fd.pos / fd.len).min(1.0);
                let a = (t * std::f64::consts::FRAC_PI_2).sin() as f32;
                let b = (t * std::f64::consts::FRAC_PI_2).cos() as f32;
                let gf = rg_gain(&fd.src, p);
                let ff = fd.src.next_frame().unwrap_or([0.0; 2]);
                l = l * a + ff[0] * gf * b;
                r = r * a + ff[1] * gf * b;
                fd.pos += 1.0;
                if fd.pos >= fd.len {
                    self.fading = None;
                    // beat-matched track glides back to its natural tempo after the mix
                    if let Some(c) = self.cur.as_mut() {
                        c.tempo_target = 1.0;
                    }
                }
            }
            let dop = self.cur.as_ref().map(|c| c.info.dop).unwrap_or(false);
            let muted = CAST_MUTE.load(Ordering::Relaxed);
            if muted {
                l = 0.0;
                r = 0.0;
            }
            if !dop && !muted {
                let o = self.dsp.process(l, r);
                self.vol += (target_vol - self.vol) * smooth;
                self.duck += (self.duck_target - self.duck) * duck_smooth;
                let gain = self.vol * self.duck;
                l = (o.0 * gain).clamp(-1.0, 1.0);
                r = (o.1 * gain).clamp(-1.0, 1.0);
            }
            out[i * 2] = l;
            out[i * 2 + 1] = r;
            i += 1;
        }
        // keep the smoothed values settled when on the fast path
        if fast {
            self.vol = target_vol;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

pub struct Shared {
    pub player: Mutex<Player>,
    pub meter: Mutex<Meter>,
    pub output_cfg: Mutex<OutputConfig>,
    pub output_gen: AtomicU64,
    pub out_state: Mutex<OutputState>,
    pub quit: AtomicBool,
    pub frame_interval_ms: AtomicU64,
    /// Capturing this process tree's own audio (YouTube window) for the visualizers.
    pub loopback: AtomicBool,
}

pub struct Engine {
    pub shared: Arc<Shared>,
    #[allow(dead_code)]
    pub app: AppHandle,
}

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

impl Engine {
    pub fn start(app: AppHandle) -> Arc<Engine> {
        let shared = Arc::new(Shared {
            player: Mutex::new(Player::new()),
            meter: Mutex::new(Meter::new()),
            output_cfg: Mutex::new(OutputConfig::default()),
            output_gen: AtomicU64::new(0),
            out_state: Mutex::new(OutputState::default()),
            quit: AtomicBool::new(false),
            frame_interval_ms: AtomicU64::new(16),
            loopback: AtomicBool::new(false),
        });
        let s1 = shared.clone();
        std::thread::Builder::new()
            .name("audio-output".into())
            .spawn(move || output_thread(s1))
            .expect("spawn output thread");
        let s2 = shared.clone();
        let a2 = app.clone();
        std::thread::Builder::new()
            .name("audio-emitter".into())
            .spawn(move || emitter_thread(s2, a2))
            .expect("spawn emitter thread");
        Arc::new(Engine { shared, app })
    }

    fn wants_dop(&self) -> bool {
        let cfg = self.shared.output_cfg.lock();
        cfg.dop && cfg.mode == "exclusive"
    }

    /// Play YouTube Music audio captured from the embedded page through the full engine
    /// (DSP, volume, ducking, meters, chosen output device).
    pub fn play_stream(&self, stream: Arc<decoder::StreamBuf>) -> StreamInfo {
        let l = Loaded::from_source(Box::new(decoder::StreamSource::new(stream)), STREAM_PATH, None, ReplayGainInfo::default());
        self.install(l, STREAM_PATH, None)
    }

    /// Stop only if the YouTube stream is what's playing (never interrupts a local track).
    pub fn stop_stream(&self) {
        let mut p = self.shared.player.lock();
        if p.cur.as_ref().map(|c| c.path == STREAM_PATH).unwrap_or(false) {
            p.cur = None;
            p.next = None;
            p.fading = None;
            p.paused = false;
        }
    }

    pub fn play(&self, path: &str, track_id: Option<i64>, rg: ReplayGainInfo, start_at: f64) -> Result<StreamInfo, String> {
        let dop = self.wants_dop();
        let mut l = Loaded::open(path, track_id, rg.clone(), dop)?;
        if start_at > 0.0 {
            l.seek(start_at);
        }
        Ok(self.install(l, path, track_id))
    }

    fn install(&self, mut l: Loaded, path: &str, track_id: Option<i64>) -> StreamInfo {
        let info = l.info.clone();
        {
            let mut p = self.shared.player.lock();
            let need_reopen = p.out_rate != info.sample_rate || p.is_dop() != info.dop;
            if !p.fixed_rate {
                l.ratio = 1.0;
            } else {
                l.ratio = info.sample_rate as f64 / p.out_rate as f64;
            }
            p.cur = Some(l);
            p.next = None;
            p.fading = None;
            p.paused = false;
            p.paused_since = None;
            p.last_gapless = None;
            // A fresh start is the right moment to switch the hardware rate (also for ASIO).
            if need_reopen {
                p.reopen = true;
            }
            p.events.push(EngineEvent::TrackChanged {
                path: path.to_string(),
                track_id,
                gapless: false,
                crossfade: false,
            });
        }
        self.shared.meter.lock().reset_track(info.sample_rate);
        info
    }

    /// Queue the following track. `xfade` seconds of equal-power crossfade (0 = gapless),
    /// `tempo` playback-rate factor for beat-matching, `start_at` cue point in seconds.
    pub fn set_next(
        &self,
        path: Option<&str>,
        track_id: Option<i64>,
        rg: ReplayGainInfo,
        xfade: f64,
        tempo: f64,
        start_at: f64,
    ) -> Result<(), String> {
        let Some(path) = path else {
            let mut p = self.shared.player.lock();
            p.next = None;
            p.next_xfade = 0.0;
            return Ok(());
        };
        let dop = self.wants_dop() && xfade <= 0.0;
        let mut l = Loaded::open(path, track_id, rg, dop)?;
        if start_at > 0.0 {
            l.seek(start_at);
        }
        let tempo = if tempo.is_finite() && tempo > 0.0 { tempo.clamp(0.9, 1.1) } else { 1.0 };
        // Held at `tempo` during the crossfade, then glides back to 1.0 (see Player::fill).
        l.tempo = tempo;
        l.tempo_target = tempo;
        let mut p = self.shared.player.lock();
        p.next = Some(l);
        p.next_xfade = xfade.max(0.0);
        Ok(())
    }

    pub fn pause(&self, paused: bool) {
        let mut p = self.shared.player.lock();
        p.paused = paused;
        p.paused_since = if paused { Some(Instant::now()) } else { None };
    }

    pub fn stop(&self) {
        let mut p = self.shared.player.lock();
        p.cur = None;
        p.next = None;
        p.fading = None;
        p.paused = false;
    }

    pub fn seek(&self, secs: f64) {
        let mut p = self.shared.player.lock();
        p.fading = None;
        if let Some(c) = p.cur.as_mut() {
            c.seek(secs);
        }
        p.reset_stretch();
    }

    pub fn set_dsp(&self, params: DspParams) {
        let mut p = self.shared.player.lock();
        p.dsp.set_params(params);
    }

    pub fn set_volume(&self, v: f32) {
        let mut p = self.shared.player.lock();
        let mut params = p.dsp.params.clone();
        params.volume = v.clamp(0.0, 1.0);
        p.dsp.set_params(params);
    }

    pub fn set_duck(&self, target: f32) {
        self.shared.player.lock().duck_target = target.clamp(0.0, 1.0);
    }

    pub fn set_output(&self, cfg: OutputConfig) {
        *self.shared.output_cfg.lock() = cfg;
        self.shared.output_gen.fetch_add(1, Ordering::SeqCst);
        self.shared.player.lock().reopen = true;
    }

    /// Feed the analyzer from WASAPI process-loopback of our own process tree, so the
    /// visualizers/meters also react to YouTube Music (which plays inside WebView2).
    pub fn set_loopback(&self, on: bool) {
        let was = self.shared.loopback.swap(on, Ordering::SeqCst);
        if on && !was {
            let sh = self.shared.clone();
            let _ = std::thread::Builder::new().name("loopback".into()).spawn(move || loopback_thread(sh));
        }
    }

    pub fn set_frame_rate(&self, fps: u32) {
        let ms = 1000 / fps.clamp(5, 120) as u64;
        self.shared.frame_interval_ms.store(ms, Ordering::Relaxed);
    }

    pub fn status(&self) -> AudioStatus {
        let out = self.shared.out_state.lock().clone();
        let running_dr = self.shared.meter.lock().running_dr();
        let p = self.shared.player.lock();
        let mut st = AudioStatus {
            state: if p.cur.is_none() {
                "stopped".into()
            } else if p.paused {
                "paused".into()
            } else {
                "playing".into()
            },
            output: out.clone(),
            volume: p.dsp.params.volume,
            duck: p.duck,
            last_transition_gapless: p.last_gapless,
            running_dr,
            next_path: p.next.as_ref().map(|n| n.path.clone()),
            ..Default::default()
        };
        if let Some(c) = &p.cur {
            st.path = Some(c.path.clone());
            st.track_id = c.track_id;
            st.position = c.position();
            st.duration = c.info.duration;
            st.info = Some(c.info.clone());
            st.bit_perfect = p.bit_perfect() && out.open && out.exclusive;
            st.resampling = c.interp || (out.open && !out.exclusive && out.rate != c.info.sample_rate);
            // ---- signal path
            let i = &c.info;
            let mut sp = Vec::new();
            if i.dsd {
                sp.push(format!("{} · {:.1} MHz", i.codec, i.dsd_rate as f64 / 1e6));
                sp.push(if i.dop { "DoP packing (bit-perfect DSD)".into() } else { format!("DSD→PCM {:.1} kHz", i.sample_rate as f64 / 1000.0) });
            } else if i.lossless {
                sp.push(format!("{} {}-bit / {}", i.codec, i.bits, khz(i.sample_rate)));
            } else {
                sp.push(format!("{} (lossy) / {}", i.codec, khz(i.sample_rate)));
            }
            let g = rg_gain(c, &p.dsp.params);
            if (g - 1.0).abs() > 1e-4 {
                sp.push(format!("ReplayGain {:+.1} dB", 20.0 * g.log10()));
            }
            if !i.dop {
                sp.extend(p.dsp.params.active_stages());
            }
            if c.interp {
                sp.push(format!("Hermite SRC {} → {}", khz(i.sample_rate), khz(p.out_rate)));
            } else if out.open && !out.exclusive && out.rate != i.sample_rate {
                sp.push(format!("Windows mixer SRC {} → {}", khz(i.sample_rate), khz(out.rate)));
            } else {
                sp.push("No Resampling".into());
            }
            if (p.dsp.params.volume - 1.0).abs() > 1e-4 && !i.dop {
                sp.push(format!("Digital volume {:.0}%", p.dsp.params.volume * 100.0));
            }
            if (p.duck - 1.0).abs() > 0.01 {
                sp.push(format!("Ducking {:.0}%", p.duck * 100.0));
            }
            if out.open {
                sp.push(format!(
                    "{} · {} / {} · {}",
                    out.backend,
                    if out.float { "32f".to_string() } else if out.container_bits != out.bits { format!("{}-in-{} bit", out.bits, out.container_bits) } else { format!("{}-bit", out.bits) },
                    khz(out.rate),
                    out.device_name
                ));
            } else {
                sp.push("Opening output…".into());
            }
            st.signal_path = sp;
        }
        st
    }
}

fn khz(r: u32) -> String {
    if r % 1000 == 0 {
        format!("{} kHz", r / 1000)
    } else {
        format!("{:.1} kHz", r as f64 / 1000.0)
    }
}

// ---------------------------------------------------------------------------------------------
// Device listing
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

pub fn list_devices() -> Result<Vec<DeviceInfo>, String> {
    let _ = wasapi::initialize_mta();
    let en = wasapi::DeviceEnumerator::new().map_err(es)?;
    let def_id = en
        .get_default_device(wasapi::Direction::Render)
        .and_then(|d| d.get_id())
        .unwrap_or_default();
    let col = en.get_device_collection(wasapi::Direction::Render).map_err(es)?;
    let n = col.get_nbr_devices().map_err(es)?;
    let mut v = Vec::new();
    for i in 0..n {
        if let Ok(d) = col.get_device_at_index(i) {
            let id = d.get_id().unwrap_or_default();
            v.push(DeviceInfo {
                is_default: id == def_id,
                name: d.get_friendlyname().unwrap_or_else(|_| "Unknown device".into()),
                id,
            });
        }
    }
    Ok(v)
}

// ---------------------------------------------------------------------------------------------
// Sample conversion
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SampleFmt {
    I16,
    I24,
    /// 32-bit container (valid bits informational)
    I32,
    F32,
}

pub fn convert(src: &[f32], fmt: SampleFmt, dst: &mut Vec<u8>) {
    dst.clear();
    match fmt {
        SampleFmt::I16 => {
            dst.reserve(src.len() * 2);
            for &s in src {
                let v = (s as f64 * 32768.0).round().clamp(-32768.0, 32767.0) as i16;
                dst.extend_from_slice(&v.to_le_bytes());
            }
        }
        SampleFmt::I24 => {
            dst.reserve(src.len() * 3);
            for &s in src {
                let v = (s as f64 * 8_388_608.0).round().clamp(-8_388_608.0, 8_388_607.0) as i32;
                let b = v.to_le_bytes();
                dst.extend_from_slice(&b[0..3]);
            }
        }
        SampleFmt::I32 => {
            dst.reserve(src.len() * 4);
            for &s in src {
                let v = (s as f64 * 2_147_483_648.0).round().clamp(-2_147_483_648.0, 2_147_483_647.0) as i32;
                dst.extend_from_slice(&v.to_le_bytes());
            }
        }
        SampleFmt::F32 => {
            dst.reserve(src.len() * 4);
            for &s in src {
                dst.extend_from_slice(&s.to_le_bytes());
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Output thread
// ---------------------------------------------------------------------------------------------

pub enum RunEnd {
    Reopen,
    Idle,
}

fn output_thread(sh: Arc<Shared>) {
    let _ = wasapi::initialize_mta();
    let mut last_err: Option<(String, Instant)> = None;
    loop {
        if sh.quit.load(Ordering::Relaxed) {
            break;
        }
        // Nothing to play → keep the device closed (frees exclusive access for other apps).
        let (rate, dop, bits, paused_long) = {
            let p = sh.player.lock();
            let paused_long = p.paused && p.paused_since.map(|t| t.elapsed() > Duration::from_secs(5)).unwrap_or(false);
            match &p.cur {
                Some(c) => (c.info.sample_rate, c.info.dop, c.info.bits, paused_long),
                None => (0, false, 0, false),
            }
        };
        if rate == 0 || paused_long {
            sh.out_state.lock().open = false;
            std::thread::sleep(Duration::from_millis(15));
            continue;
        }
        if let Some((_, t)) = &last_err {
            if t.elapsed() < Duration::from_millis(1500) {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
        }
        let cfg = sh.output_cfg.lock().clone();
        let gen = sh.output_gen.load(Ordering::SeqCst);
        let res = if cfg.mode == "asio" {
            crate::asio::run_asio(&sh, &cfg, rate, gen)
        } else {
            run_wasapi(&sh, &cfg, rate, bits, dop, gen)
        };
        match res {
            Ok(RunEnd::Reopen) | Ok(RunEnd::Idle) => {
                last_err = None;
            }
            Err(e) => {
                // DoP failed? fall back to PCM conversion of the same file at the same position.
                if dop {
                    let mut p = sh.player.lock();
                    if let Some(c) = p.cur.as_ref() {
                        let path = c.path.clone();
                        let pos = c.position();
                        let tid = c.track_id;
                        let rg = c.rg.clone();
                        drop(p);
                        if let Ok(mut l) = Loaded::open(&path, tid, rg, false) {
                            l.seek(pos);
                            p = sh.player.lock();
                            p.cur = Some(l);
                            p.reopen = false;
                            p.events.push(EngineEvent::Error {
                                message: format!("DoP not accepted by device ({e}); converting DSD to PCM."),
                            });
                            continue;
                        }
                    }
                }
                {
                    let mut st = sh.out_state.lock();
                    st.open = false;
                    st.error = Some(e.clone());
                }
                sh.player.lock().events.push(EngineEvent::Error { message: e.clone() });
                last_err = Some((e, Instant::now()));
            }
        }
    }
}


/// Shared helper for any backend: pull `frames` from the player, feed the meter.
pub fn pull_frames(sh: &Shared, buf: &mut Vec<f32>, frames: usize) -> bool {
    buf.resize(frames * 2, 0.0);
    let (playing, reopen) = {
        let mut p = sh.player.lock();
        p.fill(buf);
        (p.cur.is_some() && !p.paused, p.reopen)
    };
    if playing {
        sh.meter.lock().push(buf);
    }
    reopen
}

pub fn should_stop(sh: &Shared, gen: u64) -> Option<RunEnd> {
    if sh.quit.load(Ordering::Relaxed) || sh.output_gen.load(Ordering::SeqCst) != gen {
        return Some(RunEnd::Reopen);
    }
    let p = sh.player.lock();
    if p.reopen {
        return Some(RunEnd::Reopen);
    }
    if p.cur.is_none() {
        return Some(RunEnd::Idle);
    }
    if p.paused && p.paused_since.map(|t| t.elapsed() > Duration::from_secs(5)).unwrap_or(false) {
        return Some(RunEnd::Idle);
    }
    None
}

fn run_wasapi(sh: &Arc<Shared>, cfg: &OutputConfig, rate: u32, src_bits: u32, dop: bool, gen: u64) -> Result<RunEnd, String> {
    use wasapi::{Direction, SampleType, StreamMode, WaveFormat};
    let en = wasapi::DeviceEnumerator::new().map_err(es)?;
    let device = match cfg.device_id.as_deref() {
        Some(id) if !id.is_empty() => en.get_device(id).or_else(|_| en.get_default_device(Direction::Render)),
        _ => en.get_default_device(Direction::Render),
    }
    .map_err(|e| format!("No output device: {e}"))?;
    let name = device.get_friendlyname().unwrap_or_else(|_| "Audio device".into());

    let mut client = device.get_iaudioclient().map_err(es)?;
    let (def_period, _min_period) = client.get_device_period().map_err(es)?;
    let want_exclusive = cfg.mode == "exclusive";
    let mut opened: Option<(WaveFormat, SampleFmt, bool, u32, u32, bool)> = None; // fmt, sfmt, exclusive, bits, container, float
    let mut fell_back = false;

    if want_exclusive {
        // Candidate formats, best first. Everything ≥ source bit depth is bit-perfect.
        let mut cands: Vec<(usize, usize, SampleType, SampleFmt)> = vec![
            (32, 24, SampleType::Int, SampleFmt::I32),
            (24, 24, SampleType::Int, SampleFmt::I24),
            (32, 32, SampleType::Int, SampleFmt::I32),
        ];
        if !dop && src_bits <= 16 {
            cands.push((16, 16, SampleType::Int, SampleFmt::I16));
        }
        if !dop {
            cands.push((32, 32, SampleType::Float, SampleFmt::F32));
        }
        for (store, valid, st, sf) in cands {
            let wf = WaveFormat::new(store, valid, st.clone(), rate as usize, 2, None);
            let Ok(accepted) = client.is_supported_exclusive_with_quirks(&wf) else { continue };
            let period = client
                .calculate_aligned_period_near(def_period * 2, Some(128), &accepted)
                .unwrap_or(def_period * 2);
            let mode = StreamMode::EventsExclusive { period_hns: period };
            let mut res = client.initialize_client(&accepted, Direction::Render, mode, None);
            if let Err(wasapi::WasapiError::Windows(werr)) = &res {
                if werr.code() == windows::Win32::Media::Audio::AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED {
                    let frames = client.get_buffer_size().map_err(es)?;
                    let aligned = wasapi::calculate_period_100ns(frames as i64, rate as i64);
                    client = device.get_iaudioclient().map_err(es)?;
                    res = client.initialize_client(
                        &accepted,
                        Direction::Render,
                        StreamMode::EventsExclusive { period_hns: aligned },
                        None,
                    );
                }
            }
            match res {
                Ok(()) => {
                    opened = Some((accepted, sf, true, valid as u32, store as u32, matches!(st, SampleType::Float)));
                    break;
                }
                Err(_) => {
                    client = device.get_iaudioclient().map_err(es)?;
                }
            }
        }
        if opened.is_none() {
            if dop {
                return Err(format!("{name} does not accept DoP at {} kHz in exclusive mode", rate as f64 / 1000.0));
            }
            fell_back = true;
        }
    }
    if opened.is_none() {
        let wf = WaveFormat::new(32, 32, SampleType::Float, rate as usize, 2, None);
        let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: def_period * 3 };
        client
            .initialize_client(&wf, Direction::Render, mode, None)
            .map_err(|e| format!("Shared-mode open failed: {e}"))?;
        let mix_rate = client.get_mixformat().map(|m| m.get_samplespersec()).unwrap_or(rate);
        opened = Some((wf, SampleFmt::F32, false, 32, 32, true));
        let mut st = sh.out_state.lock();
        st.rate = mix_rate;
    }
    let (fmt, sfmt, exclusive, bits, container, float) = opened.unwrap();
    let blockalign = fmt.get_blockalign() as usize;
    {
        let mut st = sh.out_state.lock();
        *st = OutputState {
            open: true,
            backend: if exclusive { "WASAPI Exclusive".into() } else { "WASAPI Shared".into() },
            exclusive,
            rate: if exclusive { rate } else { st.rate.max(1) },
            bits,
            container_bits: container,
            float,
            device_name: name.clone(),
            error: if fell_back { Some("Exclusive mode unavailable (device busy or format unsupported) — using shared mode".into()) } else { None },
            fell_back,
        };
    }
    sh.player.lock().output_opened(rate, false, exclusive && !float && dop);

    let h = client.set_get_eventhandle().map_err(es)?;
    let render = client.get_audiorenderclient().map_err(es)?;
    let mut fbuf: Vec<f32> = Vec::new();
    let mut bytes: Vec<u8> = Vec::new();
    let avail = client.get_available_space_in_frames().map_err(es)? as usize;
    pull_frames(sh, &mut fbuf, avail);
    convert(&fbuf, sfmt, &mut bytes);
    debug_assert_eq!(bytes.len(), avail * blockalign);
    render.write_to_device(&bytes, None).map_err(es)?;
    client.start_stream().map_err(es)?;

    let end = loop {
        if let Some(e) = should_stop(sh, gen) {
            break e;
        }
        if h.wait_for_event(1000).is_err() {
            let _ = client.stop_stream();
            return Err("Audio device stopped responding (unplugged?)".into());
        }
        let avail = match client.get_available_space_in_frames() {
            Ok(a) => a as usize,
            Err(e) => {
                let _ = client.stop_stream();
                return Err(format!("Device error: {e}"));
            }
        };
        if avail == 0 {
            continue;
        }
        pull_frames(sh, &mut fbuf, avail);
        convert(&fbuf, sfmt, &mut bytes);
        if let Err(e) = render.write_to_device(&bytes, None) {
            let _ = client.stop_stream();
            return Err(format!("Write failed: {e}"));
        }
    };
    // let the last buffer play out before closing to avoid a click on format switch
    std::thread::sleep(Duration::from_millis(15));
    let _ = client.stop_stream();
    sh.out_state.lock().open = false;
    Ok(end)
}

fn loopback_thread(sh: Arc<Shared>) {
    use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat};
    let _ = wasapi::initialize_mta();
    let fmt = WaveFormat::new(32, 32, SampleType::Float, 48_000, 2, None);
    let mut client = match AudioClient::new_application_loopback_client(std::process::id(), true) {
        Ok(c) => c,
        Err(_) => {
            sh.loopback.store(false, Ordering::SeqCst);
            return;
        }
    };
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 };
    if client.initialize_client(&fmt, Direction::Capture, mode, None).is_err() {
        sh.loopback.store(false, Ordering::SeqCst);
        return;
    }
    let (Ok(h), Ok(cap)) = (client.set_get_eventhandle(), client.get_audiocaptureclient()) else { return };
    sh.meter.lock().reset_track(48_000);
    if client.start_stream().is_err() {
        return;
    }
    let mut q: VecDeque<u8> = VecDeque::new();
    let mut f: Vec<f32> = Vec::new();
    while sh.loopback.load(Ordering::SeqCst) && !sh.quit.load(Ordering::Relaxed) {
        let _ = h.wait_for_event(200);
        if let Ok(Some(n)) = cap.get_next_packet_size() {
            if n > 0 {
                let _ = cap.read_from_device_to_deque(&mut q);
            }
        }
        let n = q.len() / 8 * 8;
        if n > 0 {
            f.clear();
            let bytes: Vec<u8> = q.drain(..n).collect();
            for c in bytes.chunks_exact(4) {
                f.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
            }
            // only when the engine itself is idle, so local playback is never double-counted
            if sh.player.lock().cur.is_none() {
                sh.meter.lock().push(&f);
            }
        }
    }
    let _ = client.stop_stream();
}

// ---------------------------------------------------------------------------------------------
// Emitter thread – UI frames at up to 120 fps
// ---------------------------------------------------------------------------------------------

fn emitter_thread(sh: Arc<Shared>, app: AppHandle) {
    let mut ana = RealtimeAnalyzer::new();
    let mut last_status = Instant::now() - Duration::from_secs(1);
    let mut last_ltas = Instant::now();
    let mut idle_frames = 0u32;
    let engine_view = Engine { shared: sh.clone(), app: app.clone() };
    loop {
        if sh.quit.load(Ordering::Relaxed) {
            break;
        }
        let interval = sh.frame_interval_ms.load(Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(interval));

        // drain player events
        let (events, playing, position, lossless) = {
            let mut p = sh.player.lock();
            let ev = std::mem::take(&mut p.events);
            let playing = p.cur.is_some() && !p.paused;
            let pos = p.cur.as_ref().map(|c| c.position()).unwrap_or(0.0);
            let lossless = p.cur.as_ref().map(|c| c.info.lossless).unwrap_or(true);
            (ev, playing, pos, lossless)
        };
        for ev in events {
            if let EngineEvent::TrackChanged { .. } = &ev {
                ana.reset_ltas();
                let sr = sh.player.lock().cur.as_ref().map(|c| c.info.sample_rate).unwrap_or(44_100);
                sh.meter.lock().reset_track(sr);
                last_status = Instant::now() - Duration::from_secs(1);
            }
            let _ = app.emit("engine-event", ev);
        }

        let (latest, sr, written) = {
            let m = sh.meter.lock();
            (m.latest(FFT_N), m.sample_rate, m.written)
        };
        let fresh = written != ana.last_written;
        ana.last_written = written;
        let external = sh.loopback.load(Ordering::Relaxed) && fresh;
        if (playing || external) && fresh {
            idle_frames = 0;
            let mut f = ana.frame(&latest, sr, true);
            f.position = position;
            let _ = app.emit_to("main", "audio-frame", f);
        } else if idle_frames < 40 {
            // let the visualisers decay smoothly to silence
            idle_frames += 1;
            let silent = vec![[0.0f32; 2]; 1024];
            let mut f = ana.frame(&silent, sr, false);
            f.position = position;
            f.playing = false;
            let _ = app.emit_to("main", "audio-frame", f);
        }

        if last_status.elapsed() > Duration::from_millis(250) {
            last_status = Instant::now();
            let _ = app.emit("audio-status", engine_view.status());
        }
        if playing && last_ltas.elapsed() > Duration::from_millis(700) {
            last_ltas = Instant::now();
            let _ = app.emit_to("main", "audio-ltas", ana.ltas(sr, lossless));
        }
    }
}
