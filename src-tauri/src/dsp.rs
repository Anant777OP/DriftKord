//! Real-time DSP chain (all stereo, per-sample):
//!   Stem isolator â†’ 10-band parametric EQ â†’ Sonic Time-Machine coloration â†’
//!   Crossfeed â†’ Binaural soundstage (spherical-head ITD/ILD model + room) .
//! ReplayGain, volume and ducking are applied by the player around this chain.
//! When every stage is neutral the chain reports `is_bypass()` and the player
//! skips it entirely so the output stays bit-perfect.

use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

// ---------------------------------------------------------------------------------------------
// Parameters (mirrors the TypeScript `DspParams` type)
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EqBand {
    pub freq: f32,
    pub gain_db: f32,
    pub q: f32,
    /// "peak" | "lowshelf" | "highshelf" | "lowpass" | "highpass" | "bandpass" | "notch" | "allpass"
    pub kind: String,
    /// Which signal the filter acts on: "st" (both channels) | "l" | "r" | "m" (mid) | "s" (side)
    pub channel: String,
    pub enabled: bool,
}

impl Default for EqBand {
    fn default() -> Self {
        Self { freq: 1000.0, gain_db: 0.0, q: 1.0, kind: "peak".into(), channel: "st".into(), enabled: true }
    }
}

impl EqBand {
    /// Filter types that change the sound even at 0 dB gain.
    fn shapes_without_gain(&self) -> bool {
        matches!(self.kind.as_str(), "lowpass" | "highpass" | "bandpass" | "notch" | "allpass")
    }
    fn audible(&self) -> bool {
        self.enabled && (self.gain_db.abs() > 1e-3 || self.shapes_without_gain())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Stems {
    pub vocals: f32,
    pub drums: f32,
    pub bass: f32,
    pub other: f32,
}

impl Default for Stems {
    fn default() -> Self {
        Self { vocals: 1.0, drums: 1.0, bass: 1.0, other: 1.0 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Speaker {
    /// Degrees, 0 = straight ahead, +90 = right, Â±180 = behind.
    pub azimuth: f32,
    /// Metres, 0.5 â€“ 4.
    pub distance: f32,
    /// "L" | "R" | "C"
    pub source: String,
}

impl Default for Speaker {
    fn default() -> Self {
        Self { azimuth: -30.0, distance: 1.5, source: "L".into() }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DspParams {
    pub eq_enabled: bool,
    pub preamp_db: f32,
    pub bands: Vec<EqBand>,
    /// 0 = off, 1 = strong.
    pub crossfeed: f32,
    /// "off" | "track" | "album"
    pub replaygain: String,
    pub rg_preamp_db: f32,
    /// "off" | "tube" | "tape" | "vinyl" | "stadium"
    pub era: String,
    pub era_amount: f32,
    pub stems: Stems,
    pub stage_enabled: bool,
    pub speakers: Vec<Speaker>,
    pub room: f32,
    pub volume: f32,
    /// Fold left and right into one mono signal.
    pub mono: bool,
    /// Volume slider follows a logarithmic (perceptual) curve instead of a linear one.
    pub exp_volume: bool,
    /// Playback speed, 0.01 – 100.
    pub speed: f32,
    /// Keep the original key when the speed changes (time-stretch instead of resample).
    pub preserve_pitch: bool,
}

pub fn default_bands() -> Vec<EqBand> {
    let freqs = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];
    freqs
        .iter()
        .enumerate()
        .map(|(i, &f)| EqBand {
            freq: f,
            gain_db: 0.0,
            q: if i == 0 || i == 9 { 0.7 } else { 1.41 },
            kind: if i == 0 { "lowshelf".into() } else if i == 9 { "highshelf".into() } else { "peak".into() },
            ..Default::default()
        })
        .collect()
}

impl Default for DspParams {
    fn default() -> Self {
        Self {
            eq_enabled: false,
            preamp_db: 0.0,
            bands: default_bands(),
            crossfeed: 0.0,
            replaygain: "off".into(),
            rg_preamp_db: 0.0,
            era: "off".into(),
            era_amount: 0.6,
            stems: Stems::default(),
            stage_enabled: false,
            speakers: vec![
                Speaker { azimuth: -30.0, distance: 1.5, source: "L".into() },
                Speaker { azimuth: 30.0, distance: 1.5, source: "R".into() },
            ],
            room: 0.3,
            volume: 1.0,
            mono: false,
            exp_volume: false,
            speed: 1.0,
            preserve_pitch: true,
        }
    }
}

impl DspParams {
    pub fn eq_active(&self) -> bool {
        self.eq_enabled && (self.preamp_db.abs() > 1e-3 || self.bands.iter().any(|b| b.audible()))
    }
    pub fn stems_active(&self) -> bool {
        let s = &self.stems;
        [s.vocals, s.drums, s.bass, s.other].iter().any(|v| (v - 1.0).abs() > 1e-3)
    }
    pub fn era_active(&self) -> bool {
        self.era != "off" && self.era_amount > 1e-3
    }
    /// Human readable list of active stages (for the Signal Path HUD).
    pub fn active_stages(&self) -> Vec<String> {
        let mut v = Vec::new();
        if self.stems_active() {
            v.push("Stem Isolator".to_string());
        }
        if self.eq_active() {
            let n = self.bands.iter().filter(|b| b.audible()).count();
            v.push(format!("EQ Studio ({n} filter{})", if n == 1 { "" } else { "s" }));
        }
        if self.era_active() {
            v.push(format!("Time-Machine: {}", era_label(&self.era)));
        }
        if self.crossfeed > 1e-3 {
            v.push("Crossfeed".to_string());
        }
        if self.stage_enabled {
            v.push("Binaural Soundstage".to_string());
        }
        if self.mono {
            v.push("Mono".to_string());
        }
        v
    }
}

pub fn era_label(era: &str) -> &'static str {
    match era {
        "tube" => "1970s Tube Amp",
        "tape" => "1989 WM-DD9 Tape",
        "vinyl" => "Vinyl Lathe",
        "stadium" => "Live Stadium",
        "gramophone" => "1925 Shellac Gramophone",
        "radio" => "1950s AM Radio",
        "jukebox" => "1962 Diner Jukebox",
        "eighttrack" => "1974 8-Track Cartridge",
        "boombox" => "1986 Boombox",
        "cd" => "1992 Early CD",
        "telephone" => "1995 Landline Phone",
        "mp3" => "2001 128k MP3",
        "loudness" => "2008 Loudness War",
        "club" => "2012 Club PA",
        "lofi" => "2018 Lo-fi Beats",
        "hall" => "Concert Hall",
        _ => "Off",
    }
}

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Default)]
pub struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: [f64; 2],
    z2: [f64; 2],
}

impl Biquad {
    fn from(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Self {
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: [0.0; 2], z2: [0.0; 2] }
    }
    fn w0(sr: f64, f: f64) -> f64 {
        2.0 * PI * f.clamp(5.0, sr * 0.49) / sr
    }
    pub fn peaking(sr: f64, f: f64, q: f64, db: f64) -> Self {
        let a = 10f64.powf(db / 40.0);
        let w0 = Self::w0(sr, f);
        let alpha = w0.sin() / (2.0 * q.max(0.05));
        let c = w0.cos();
        Self::from(1.0 + alpha * a, -2.0 * c, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * c, 1.0 - alpha / a)
    }
    pub fn lowshelf(sr: f64, f: f64, q: f64, db: f64) -> Self {
        let a = 10f64.powf(db / 40.0);
        let w0 = Self::w0(sr, f);
        let c = w0.cos();
        let alpha = w0.sin() / (2.0 * q.max(0.05));
        let s = 2.0 * a.sqrt() * alpha;
        Self::from(
            a * ((a + 1.0) - (a - 1.0) * c + s),
            2.0 * a * ((a - 1.0) - (a + 1.0) * c),
            a * ((a + 1.0) - (a - 1.0) * c - s),
            (a + 1.0) + (a - 1.0) * c + s,
            -2.0 * ((a - 1.0) + (a + 1.0) * c),
            (a + 1.0) + (a - 1.0) * c - s,
        )
    }
    pub fn highshelf(sr: f64, f: f64, q: f64, db: f64) -> Self {
        let a = 10f64.powf(db / 40.0);
        let w0 = Self::w0(sr, f);
        let c = w0.cos();
        let alpha = w0.sin() / (2.0 * q.max(0.05));
        let s = 2.0 * a.sqrt() * alpha;
        Self::from(
            a * ((a + 1.0) + (a - 1.0) * c + s),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
            a * ((a + 1.0) + (a - 1.0) * c - s),
            (a + 1.0) - (a - 1.0) * c + s,
            2.0 * ((a - 1.0) - (a + 1.0) * c),
            (a + 1.0) - (a - 1.0) * c - s,
        )
    }
    pub fn lowpass(sr: f64, f: f64, q: f64) -> Self {
        let w0 = Self::w0(sr, f);
        let c = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        Self::from((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }
    pub fn bandpass(sr: f64, f: f64, q: f64) -> Self {
        // constant 0 dB peak gain
        let w0 = Self::w0(sr, f);
        let c = w0.cos();
        let alpha = w0.sin() / (2.0 * q.max(0.05));
        Self::from(alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }
    pub fn notch(sr: f64, f: f64, q: f64) -> Self {
        let w0 = Self::w0(sr, f);
        let c = w0.cos();
        let alpha = w0.sin() / (2.0 * q.max(0.05));
        Self::from(1.0, -2.0 * c, 1.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }
    pub fn allpass(sr: f64, f: f64, q: f64) -> Self {
        let w0 = Self::w0(sr, f);
        let c = w0.cos();
        let alpha = w0.sin() / (2.0 * q.max(0.05));
        Self::from(1.0 - alpha, -2.0 * c, 1.0 + alpha, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }
    pub fn highpass(sr: f64, f: f64, q: f64) -> Self {
        let w0 = Self::w0(sr, f);
        let c = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        Self::from((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }
    #[inline]
    pub fn run(&mut self, ch: usize, x: f64) -> f64 {
        let y = self.b0 * x + self.z1[ch];
        self.z1[ch] = self.b1 * x - self.a1 * y + self.z2[ch];
        self.z2[ch] = self.b2 * x - self.a2 * y;
        y
    }
}

const BUTTER_Q: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// Linkwitz-Riley 4th order (two cascaded Butterworth) low or high pass.
#[derive(Clone, Copy)]
struct Lr4 {
    a: Biquad,
    b: Biquad,
}
impl Lr4 {
    fn lp(sr: f64, f: f64) -> Self {
        Self { a: Biquad::lowpass(sr, f, BUTTER_Q), b: Biquad::lowpass(sr, f, BUTTER_Q) }
    }
    fn hp(sr: f64, f: f64) -> Self {
        Self { a: Biquad::highpass(sr, f, BUTTER_Q), b: Biquad::highpass(sr, f, BUTTER_Q) }
    }
    #[inline]
    fn run(&mut self, ch: usize, x: f64) -> f64 {
        let y = self.a.run(ch, x);
        self.b.run(ch, y)
    }
}

#[derive(Clone, Copy, Default)]
struct OnePole {
    a: f64,
    z: [f64; 2],
}
impl OnePole {
    fn lp(sr: f64, f: f64) -> Self {
        Self { a: (-2.0 * PI * f.min(sr * 0.49) / sr).exp(), z: [0.0; 2] }
    }
    fn set(&mut self, sr: f64, f: f64) {
        self.a = (-2.0 * PI * f.clamp(10.0, sr * 0.49) / sr).exp();
    }
    #[inline]
    fn run(&mut self, ch: usize, x: f64) -> f64 {
        self.z[ch] = x * (1.0 - self.a) + self.z[ch] * self.a;
        self.z[ch]
    }
}

/// Fractional delay line (linear interpolation).
#[derive(Clone)]
struct Delay {
    buf: Vec<f64>,
    w: usize,
}
impl Delay {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len.next_power_of_two().max(4)], w: 0 }
    }
    #[inline]
    fn push(&mut self, x: f64) {
        self.w = (self.w + 1) & (self.buf.len() - 1);
        self.buf[self.w] = x;
    }
    #[inline]
    fn read(&self, delay: f64) -> f64 {
        let mask = self.buf.len() - 1;
        let d = delay.clamp(0.0, (self.buf.len() - 2) as f64);
        let i = d.floor() as usize;
        let f = d - i as f64;
        let a = self.buf[(self.w + self.buf.len() - i) & mask];
        let b = self.buf[(self.w + self.buf.len() - i - 1) & mask];
        a + (b - a) * f
    }
}

#[derive(Clone, Copy)]
pub struct Rng(u32);
impl Rng {
    pub fn new(seed: u32) -> Self {
        Self(seed.max(1))
    }
    #[inline]
    pub fn next_f(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x as f64 / u32::MAX as f64) * 2.0 - 1.0
    }
}

// ---------------------------------------------------------------------------------------------
// Freeverb-style reverb (used by Stadium + soundstage room)
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
struct Comb {
    buf: Vec<f64>,
    i: usize,
    store: f64,
}
impl Comb {
    fn new(n: usize) -> Self {
        Self { buf: vec![0.0; n.max(1)], i: 0, store: 0.0 }
    }
    #[inline]
    fn run(&mut self, x: f64, feedback: f64, damp: f64) -> f64 {
        let out = self.buf[self.i];
        self.store = out * (1.0 - damp) + self.store * damp;
        self.buf[self.i] = x + self.store * feedback;
        self.i = (self.i + 1) % self.buf.len();
        out
    }
}
#[derive(Clone)]
struct Allpass {
    buf: Vec<f64>,
    i: usize,
}
impl Allpass {
    fn new(n: usize) -> Self {
        Self { buf: vec![0.0; n.max(1)], i: 0 }
    }
    #[inline]
    fn run(&mut self, x: f64) -> f64 {
        let b = self.buf[self.i];
        let out = -x + b;
        self.buf[self.i] = x + b * 0.5;
        self.i = (self.i + 1) % self.buf.len();
        out
    }
}

#[derive(Clone)]
pub struct Reverb {
    combs: [Vec<Comb>; 2],
    aps: [Vec<Allpass>; 2],
    pre: Delay,
    pre_samples: f64,
    pub feedback: f64,
    pub damp: f64,
}
impl Reverb {
    pub fn new(sr: f64, size: f64, predelay_ms: f64) -> Self {
        let scale = sr / 44_100.0 * size;
        let cl = [1116, 1188, 1277, 1356, 1422, 1491];
        let al = [556, 441, 341];
        let mk_c = |spread: usize| cl.iter().map(|&n| Comb::new(((n + spread) as f64 * scale) as usize)).collect();
        let mk_a = |spread: usize| al.iter().map(|&n| Allpass::new(((n + spread) as f64 * scale) as usize)).collect();
        Self {
            combs: [mk_c(0), mk_c(23)],
            aps: [mk_a(0), mk_a(23)],
            pre: Delay::new((sr * 0.25) as usize),
            pre_samples: predelay_ms * sr / 1000.0,
            feedback: 0.84,
            damp: 0.3,
        }
    }
    #[inline]
    pub fn run(&mut self, l: f64, r: f64) -> (f64, f64) {
        self.pre.push((l + r) * 0.5);
        let x = self.pre.read(self.pre_samples) * 0.015;
        let mut out = [0.0; 2];
        for ch in 0..2 {
            let mut acc = 0.0;
            for c in self.combs[ch].iter_mut() {
                acc += c.run(x, self.feedback, self.damp);
            }
            for a in self.aps[ch].iter_mut() {
                acc = a.run(acc);
            }
            out[ch] = acc;
        }
        (out[0], out[1])
    }
}

// ---------------------------------------------------------------------------------------------
// Stem isolator (frequency + mid/side phase decomposition)
// ---------------------------------------------------------------------------------------------

struct StemIsolator {
    bass_lp: Lr4,
    rest_hp: Lr4,
    vox_hp: Lr4,
    vox_lp: Lr4,
    env_fast: f64,
    env_slow: f64,
    a_fast_att: f64,
    a_fast_rel: f64,
    a_slow_att: f64,
    a_slow_rel: f64,
}

impl StemIsolator {
    fn new(sr: f64) -> Self {
        let coef = |ms: f64| (-1.0 / (ms * 0.001 * sr)).exp();
        Self {
            bass_lp: Lr4::lp(sr, 160.0),
            rest_hp: Lr4::hp(sr, 160.0),
            vox_hp: Lr4::hp(sr, 200.0),
            vox_lp: Lr4::lp(sr, 6500.0),
            env_fast: 0.0,
            env_slow: 0.0,
            a_fast_att: coef(0.8),
            a_fast_rel: coef(25.0),
            a_slow_att: coef(40.0),
            a_slow_rel: coef(350.0),
        }
    }
    #[inline]
    fn process(&mut self, l: f64, r: f64, s: &Stems) -> (f64, f64) {
        let mid = (l + r) * 0.5;
        let side = (l - r) * 0.5;
        // Bass: low band of the mid channel (bass is almost always centred).
        let bass = self.bass_lp.run(0, mid);
        let mid_hi = self.rest_hp.run(0, mid);
        let side_hi = self.rest_hp.run(1, side);
        // Vocals: centred (phase-coherent) energy in the vocal band.
        let vox = self.vox_lp.run(0, self.vox_hp.run(0, mid_hi));
        let mid_other = mid_hi - vox;
        // Drums: transient emphasis derived from fast/slow envelope ratio.
        let a = (l.abs() + r.abs()) * 0.5;
        self.env_fast = if a > self.env_fast {
            a + (self.env_fast - a) * self.a_fast_att
        } else {
            a + (self.env_fast - a) * self.a_fast_rel
        };
        self.env_slow = if a > self.env_slow {
            a + (self.env_slow - a) * self.a_slow_att
        } else {
            a + (self.env_slow - a) * self.a_slow_rel
        };
        let trans = ((self.env_fast / (self.env_slow + 1e-9) - 1.0) * 1.5).clamp(0.0, 1.0);
        let dg = 1.0 + (s.drums as f64 - 1.0) * trans;
        let m = (bass * s.bass as f64 + vox * s.vocals as f64 + mid_other * s.other as f64) * dg;
        let sd = side_hi * s.other as f64 * dg + (side - side_hi) * s.bass as f64;
        (m + sd, m - sd)
    }
}

// ---------------------------------------------------------------------------------------------
// Sonic Time-Machine
// ---------------------------------------------------------------------------------------------

struct TimeMachine {
    sr: f64,
    // shared
    rng: Rng,
    dc: [f64; 2],
    dc_prev: [f64; 2],
    // tube
    warmth: Biquad,
    tube_lp: Biquad,
    // tape
    head_bump: Biquad,
    tape_lp: Biquad,
    wow: Delay,
    wow_r: Delay,
    phase_wow: f64,
    phase_flutter: f64,
    // vinyl
    riaa_tilt: Biquad,
    side_hp: Lr4,
    crackle_env: f64,
    crackle_sign: f64,
    rumble: OnePole,
    // stadium
    reverb: Reverb,
    slap: Delay,
    stadium_hp: Biquad,
    // the later eras: a filter chain per era (applied in order), plus shared helpers
    chains: std::collections::HashMap<&'static str, Vec<Biquad>>,
    comp_env: [f64; 2],
    hold: [f64; 2],
    hold_n: f64,
    room: Reverb,
    hall: Reverb,
    noise_bp: Biquad,
    crosstalk: Delay,
}

/// Simple feed-forward compressor gain for an envelope (linear), threshold (linear) and ratio.
#[inline]
fn comp_gain(env: f64, th: f64, ratio: f64) -> f64 {
    if env <= th { 1.0 } else { (th / env).powf(1.0 - 1.0 / ratio) }
}

impl TimeMachine {
    fn new(sr: f64) -> Self {
        let mut reverb = Reverb::new(sr, 1.6, 60.0);
        reverb.feedback = 0.88;
        reverb.damp = 0.4;
        Self {
            sr,
            rng: Rng::new(0x1234_5678),
            dc: [0.0; 2],
            dc_prev: [0.0; 2],
            warmth: Biquad::peaking(sr, 220.0, 0.8, 2.0),
            tube_lp: Biquad::lowpass(sr, 17_500.0, BUTTER_Q),
            head_bump: Biquad::peaking(sr, 62.0, 1.1, 3.0),
            tape_lp: Biquad::lowpass(sr, 14_500.0, 0.6),
            wow: Delay::new((sr * 0.02) as usize),
            wow_r: Delay::new((sr * 0.02) as usize),
            phase_wow: 0.0,
            phase_flutter: 0.0,
            riaa_tilt: Biquad::highshelf(sr, 6_000.0, 0.7, -2.5),
            side_hp: Lr4::hp(sr, 150.0),
            crackle_env: 0.0,
            crackle_sign: 1.0,
            rumble: OnePole::lp(sr, 25.0),
            reverb,
            slap: Delay::new((sr * 0.3) as usize),
            stadium_hp: Biquad::highpass(sr, 90.0, BUTTER_Q),
            chains: {
                let mut m: std::collections::HashMap<&'static str, Vec<Biquad>> = std::collections::HashMap::new();
                // shellac 78 through an acoustic horn: ~200 Hz - 5 kHz with a horn resonance
                m.insert("gramophone", vec![Biquad::highpass(sr, 200.0, 0.9), Biquad::highpass(sr, 200.0, 0.6), Biquad::lowpass(sr, 4_800.0, 0.9), Biquad::lowpass(sr, 5_200.0, 0.6), Biquad::peaking(sr, 1_400.0, 1.2, 5.0)]);
                // AM broadcast through a small speaker
                m.insert("radio", vec![Biquad::highpass(sr, 160.0, BUTTER_Q), Biquad::lowpass(sr, 4_500.0, BUTTER_Q), Biquad::lowpass(sr, 4_500.0, BUTTER_Q), Biquad::peaking(sr, 900.0, 0.9, 3.0)]);
                // big jukebox cabinet: fat bass, rolled-off top
                m.insert("jukebox", vec![Biquad::lowshelf(sr, 110.0, 0.7, 4.5), Biquad::peaking(sr, 2_500.0, 1.0, -2.0), Biquad::lowpass(sr, 9_000.0, BUTTER_Q)]);
                m.insert("eighttrack", vec![Biquad::peaking(sr, 80.0, 1.0, 2.5), Biquad::lowpass(sr, 9_500.0, 0.6), Biquad::highpass(sr, 45.0, BUTTER_Q)]);
                // boombox: "bass boost" button + bright cones
                m.insert("boombox", vec![Biquad::lowshelf(sr, 90.0, 0.8, 6.5), Biquad::peaking(sr, 3_200.0, 1.0, 3.0), Biquad::lowpass(sr, 13_000.0, BUTTER_Q), Biquad::highpass(sr, 50.0, BUTTER_Q)]);
                // early-90s digital: slightly bright, steep top end
                m.insert("cd", vec![Biquad::highshelf(sr, 8_000.0, 0.7, 1.8), Biquad::lowpass(sr, 20_000.0, 0.54), Biquad::lowpass(sr, 20_000.0, 1.31)]);
                m.insert("telephone", vec![Biquad::highpass(sr, 300.0, BUTTER_Q), Biquad::highpass(sr, 300.0, BUTTER_Q), Biquad::lowpass(sr, 3_400.0, BUTTER_Q), Biquad::lowpass(sr, 3_400.0, BUTTER_Q), Biquad::peaking(sr, 1_800.0, 1.0, 4.0)]);
                // 128 kbps encoders cut everything above ~16 kHz
                m.insert("mp3", vec![Biquad::lowpass(sr, 16_000.0, 0.54), Biquad::lowpass(sr, 16_000.0, 1.31)]);
                m.insert("loudness", vec![Biquad::lowshelf(sr, 70.0, 0.7, 2.0), Biquad::highshelf(sr, 9_000.0, 0.7, 2.5)]);
                m.insert("club", vec![Biquad::highpass(sr, 32.0, BUTTER_Q), Biquad::lowshelf(sr, 65.0, 0.8, 7.0), Biquad::peaking(sr, 350.0, 0.8, -2.5), Biquad::highshelf(sr, 10_000.0, 0.7, 2.0)]);
                m.insert("lofi", vec![Biquad::lowpass(sr, 7_000.0, BUTTER_Q), Biquad::highpass(sr, 70.0, BUTTER_Q), Biquad::peaking(sr, 300.0, 0.8, 2.0)]);
                m.insert("hall", vec![Biquad::highshelf(sr, 7_000.0, 0.7, -1.5)]);
                m
            },
            comp_env: [0.0; 2],
            hold: [0.0; 2],
            hold_n: 0.0,
            room: {
                let mut r = Reverb::new(sr, 0.45, 6.0);
                r.feedback = 0.72;
                r.damp = 0.5;
                r
            },
            hall: {
                let mut r = Reverb::new(sr, 1.35, 28.0);
                r.feedback = 0.86;
                r.damp = 0.35;
                r
            },
            noise_bp: Biquad::bandpass(sr, 2_500.0, 0.6),
            crosstalk: Delay::new((sr * 0.01) as usize),
        }
    }

    #[inline]
    fn chain(&mut self, era: &'static str, ch: usize, x: f64) -> f64 {
        let mut y = x;
        if let Some(c) = self.chains.get_mut(era) {
            for f in c.iter_mut() {
                y = f.run(ch, y);
            }
        }
        y
    }

    /// Envelope-follower compressor on a stereo pair (linked).
    #[inline]
    fn compress(&mut self, l: f64, r: f64, th_db: f64, ratio: f64, attack_ms: f64, release_ms: f64, makeup_db: f64) -> (f64, f64) {
        let lvl = l.abs().max(r.abs());
        let att = (-1.0 / (attack_ms * 0.001 * self.sr)).exp();
        let rel = (-1.0 / (release_ms * 0.001 * self.sr)).exp();
        let e = &mut self.comp_env[0];
        *e = if lvl > *e { att * *e + (1.0 - att) * lvl } else { rel * *e + (1.0 - rel) * lvl };
        let g = comp_gain(*e, 10f64.powf(th_db / 20.0), ratio) * 10f64.powf(makeup_db / 20.0);
        (l * g, r * g)
    }

    /// Crackle impulse (vinyl/shellac surface), returns the sample to add.
    #[inline]
    fn crackle(&mut self, rate: f64, level: f64) -> f64 {
        if self.rng.next_f() > 1.0 - rate * (48_000.0 / self.sr) {
            self.crackle_env = 0.25 + 0.6 * self.rng.next_f().abs();
            self.crackle_sign = if self.rng.next_f() > 0.0 { 1.0 } else { -1.0 };
        }
        let c = self.crackle_env * self.crackle_sign * level;
        self.crackle_env *= 0.8;
        c
    }

    /// Wow & flutter as a modulated delay on both channels.
    #[inline]
    fn wobble(&mut self, l: f64, r: f64, wow_hz: f64, flutter_hz: f64, depth_ms: f64) -> (f64, f64) {
        self.phase_wow = (self.phase_wow + wow_hz / self.sr).fract();
        self.phase_flutter = (self.phase_flutter + flutter_hz / self.sr).fract();
        let m = depth_ms * ((2.0 * PI * self.phase_wow).sin() + 0.25 * (2.0 * PI * self.phase_flutter).sin());
        let d = (1.5 * depth_ms.max(0.2) + 0.5 + m) * self.sr / 1000.0;
        self.wow.push(l);
        self.wow_r.push(r);
        (self.wow.read(d), self.wow_r.read(d))
    }

    /// Reduce bit depth (no dither: the "cheap digital" sound).
    #[inline]
    fn crush(x: f64, bits: f64) -> f64 {
        let q = 2f64.powf(bits - 1.0);
        (x * q).round() / q
    }

    #[inline]
    fn dc_block(&mut self, ch: usize, x: f64) -> f64 {
        let y = x - self.dc_prev[ch] + 0.9995 * self.dc[ch];
        self.dc_prev[ch] = x;
        self.dc[ch] = y;
        y
    }

    #[inline]
    fn process(&mut self, era: &str, amt: f64, l: f64, r: f64) -> (f64, f64) {
        match era {
            "tube" => {
                let mut o = [l, r];
                for (ch, x) in o.iter_mut().enumerate() {
                    let drive = 1.0 + amt * 2.5;
                    let v = *x * drive;
                    // Asymmetric triode-like transfer -> even harmonics.
                    let sat = if v >= 0.0 { v.tanh() } else { (v * 0.8).tanh() / 0.8 };
                    let h2 = v * v * 0.08 * amt;
                    let y = (sat + h2) / drive.sqrt();
                    let y = self.dc_block(ch, y);
                    let y = self.warmth.run(ch, y);
                    let y = self.tube_lp.run(ch, y);
                    *x = *x * (1.0 - amt) + y * amt;
                }
                (o[0], o[1])
            }
            "tape" => {
                self.phase_wow += 0.55 / self.sr;
                self.phase_flutter += 6.3 / self.sr;
                if self.phase_wow > 1.0 {
                    self.phase_wow -= 1.0;
                }
                if self.phase_flutter > 1.0 {
                    self.phase_flutter -= 1.0;
                }
                let mod_ms = 0.18 * (2.0 * PI * self.phase_wow).sin() + 0.04 * (2.0 * PI * self.phase_flutter).sin();
                let d = (1.2 + mod_ms * amt) * self.sr / 1000.0;
                self.wow.push(l);
                self.wow_r.push(r);
                let wl = self.wow.read(d);
                let wr = self.wow_r.read(d);
                let mut o = [wl, wr];
                for (ch, x) in o.iter_mut().enumerate() {
                    let drive = 1.0 + amt * 1.8;
                    let y = (*x * drive).tanh() / drive.tanh();
                    let y = self.head_bump.run(ch, y);
                    let y = self.tape_lp.run(ch, y);
                    let hiss = self.rng.next_f() * 0.0006 * amt;
                    *x = y + hiss;
                }
                let dry = 1.0 - amt;
                (l * dry + o[0] * amt, r * dry + o[1] * amt)
            }
            "vinyl" => {
                // Lathe: bass summed to mono, gentle top-end tilt, crackle and rumble.
                let mid = (l + r) * 0.5;
                let side = (l - r) * 0.5;
                // Removing the low band from the side signal sums the bass to mono.
                let s = self.side_hp.run(0, side);
                let mut o = [mid + s, mid - s];
                // Crackle: sparse impulses with fast decay.
                if self.rng.next_f() > 1.0 - 0.00012 * amt * (48_000.0 / self.sr) {
                    self.crackle_env = 0.25 + 0.6 * self.rng.next_f().abs();
                    self.crackle_sign = if self.rng.next_f() > 0.0 { 1.0 } else { -1.0 };
                }
                let crackle = self.crackle_env * self.crackle_sign * amt * 0.18;
                self.crackle_env *= 0.82;
                let rumble = self.rumble.run(0, self.rng.next_f()) * 0.02 * amt;
                for (ch, x) in o.iter_mut().enumerate() {
                    let y = self.riaa_tilt.run(ch, *x);
                    let y = (y * 1.1).tanh() / 1.1f64.tanh();
                    *x = y + crackle + rumble;
                }
                (l * (1.0 - amt) + o[0] * amt, r * (1.0 - amt) + o[1] * amt)
            }
            "stadium" => {
                let (rl, rr) = self.reverb.run(l, r);
                self.slap.push((l + r) * 0.5);
                let slap = self.slap.read(0.19 * self.sr) * 0.22;
                let wl = self.stadium_hp.run(0, rl + slap);
                let wr = self.stadium_hp.run(1, rr + slap);
                let dry = 1.0 - amt * 0.45;
                (l * dry + wl * amt * 1.2, r * dry + wr * amt * 1.2)
            }
            "gramophone" => {
                let m = (l + r) * 0.5;
                let y = self.chain("gramophone", 0, m);
                let y = (y * 1.8).tanh() / 1.8f64.tanh();
                let hiss = self.noise_bp.run(0, self.rng.next_f()) * 0.025;
                let crackle = self.crackle(0.0007, 0.22);
                let rumble = self.rumble.run(0, self.rng.next_f()) * 0.03;
                let o = y + (hiss + crackle + rumble) * amt;
                (l * (1.0 - amt) + o * amt, r * (1.0 - amt) + o * amt)
            }
            "radio" => {
                let m = (l + r) * 0.5;
                let y = self.chain("radio", 0, m);
                let (y, _) = self.compress(y, y, -24.0, 5.0, 3.0, 250.0, 9.0);
                let y = (y * 1.3).tanh();
                let static_noise = self.noise_bp.run(1, self.rng.next_f()) * 0.012;
                let o = y + static_noise * amt;
                (l * (1.0 - amt) + o * amt, r * (1.0 - amt) + o * amt)
            }
            "jukebox" => {
                // narrow, warm cabinet in a small diner
                let (m, s) = ((l + r) * 0.5, (l - r) * 0.5 * 0.35);
                let mut o = [m + s, m - s];
                for (ch, x) in o.iter_mut().enumerate() {
                    let y = self.chain("jukebox", ch, *x);
                    let v = y * 1.6;
                    *x = (if v >= 0.0 { v.tanh() } else { (v * 0.85).tanh() / 0.85 }) / 1.25;
                }
                let (rl, rr) = self.room.run(o[0], o[1]);
                let (a, b) = (o[0] + rl * 0.35, o[1] + rr * 0.35);
                (l * (1.0 - amt) + a * amt, r * (1.0 - amt) + b * amt)
            }
            "eighttrack" => {
                let (wl, wr) = self.wobble(l, r, 0.9, 9.0, 0.35 * amt.max(0.2));
                // neighbouring-program bleed: a faint, delayed copy of the other channel
                self.crosstalk.push((wl - wr) * 0.5);
                let bleed = self.crosstalk.read(0.004 * self.sr) * 0.06;
                let mut o = [wl + bleed, wr - bleed];
                for (ch, x) in o.iter_mut().enumerate() {
                    let y = self.chain("eighttrack", ch, *x);
                    *x = (y * 1.5).tanh() / 1.5f64.tanh() + self.rng.next_f() * 0.0012;
                }
                (l * (1.0 - amt) + o[0] * amt, r * (1.0 - amt) + o[1] * amt)
            }
            "boombox" => {
                let mut o = [l, r];
                for (ch, x) in o.iter_mut().enumerate() {
                    let y = self.chain("boombox", ch, *x);
                    *x = (y * 1.4).tanh() / 1.4f64.tanh();
                }
                (l * (1.0 - amt) + o[0] * amt, r * (1.0 - amt) + o[1] * amt)
            }
            "cd" => {
                let mut o = [l, r];
                for (ch, x) in o.iter_mut().enumerate() {
                    let y = self.chain("cd", ch, *x);
                    *x = Self::crush(y, 16.0 - 2.0 * amt);
                }
                (l * (1.0 - amt) + o[0] * amt, r * (1.0 - amt) + o[1] * amt)
            }
            "telephone" => {
                let m = (l + r) * 0.5;
                let y = self.chain("telephone", 0, m);
                // 8-bit mu-law style companding
                let mu = 255.0;
                let c = y.signum() * (1.0 + mu * y.abs().min(1.0)).ln() / (1.0f64 + mu).ln();
                let c = Self::crush(c, 8.0);
                let y = c.signum() * ((1.0f64 + mu).powf(c.abs()) - 1.0) / mu;
                let o = y * 1.4 + self.rng.next_f() * 0.002 * amt;
                (l * (1.0 - amt) + o * amt, r * (1.0 - amt) + o * amt)
            }
            "mp3" => {
                // band-limited, with a slightly narrower image (joint stereo)
                let (m, s) = ((l + r) * 0.5, (l - r) * 0.5 * 0.85);
                let mut o = [m + s, m - s];
                for (ch, x) in o.iter_mut().enumerate() {
                    *x = self.chain("mp3", ch, *x);
                }
                (l * (1.0 - amt) + o[0] * amt, r * (1.0 - amt) + o[1] * amt)
            }
            "loudness" => {
                let a = self.chain("loudness", 0, l);
                let b = self.chain("loudness", 1, r);
                let (a, b) = self.compress(a, b, -20.0, 8.0, 1.0, 60.0, 14.0);
                let clip = |x: f64| x.clamp(-0.89, 0.89) / 0.89 * 0.97;
                (l * (1.0 - amt) + clip(a) * amt, r * (1.0 - amt) + clip(b) * amt)
            }
            "club" => {
                let a = self.chain("club", 0, l);
                let b = self.chain("club", 1, r);
                let (a, b) = self.compress(a, b, -14.0, 3.0, 8.0, 120.0, 3.0);
                let (rl, rr) = self.room.run(a, b);
                let (a, b) = ((a * 1.2).tanh() / 1.2 + rl * 0.3, (b * 1.2).tanh() / 1.2 + rr * 0.3);
                (l * (1.0 - amt) + a * amt, r * (1.0 - amt) + b * amt)
            }
            "lofi" => {
                let (wl, wr) = self.wobble(l, r, 0.5, 4.0, 0.25 * amt.max(0.2));
                // sample-and-hold down to ~22 kHz and 12-bit
                self.hold_n += 22_050.0 / self.sr;
                if self.hold_n >= 1.0 {
                    self.hold_n -= 1.0;
                    self.hold = [wl, wr];
                }
                let crackle = self.crackle(0.00025, 0.12);
                let mut o = self.hold;
                for (ch, x) in o.iter_mut().enumerate() {
                    let y = self.chain("lofi", ch, Self::crush(*x, 12.0));
                    *x = y + crackle + self.rng.next_f() * 0.0015;
                }
                (l * (1.0 - amt) + o[0] * amt, r * (1.0 - amt) + o[1] * amt)
            }
            "hall" => {
                let (rl, rr) = self.hall.run(l, r);
                let rl = self.chain("hall", 0, rl);
                let rr = self.chain("hall", 1, rr);
                let dry = 1.0 - amt * 0.3;
                (l * dry + rl * amt * 1.4, r * dry + rr * amt * 1.4)
            }
            _ => (l, r),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Crossfeed (Bauer-style)
// ---------------------------------------------------------------------------------------------

struct Crossfeed {
    lp: OnePole,
    dl: Delay,
    dr: Delay,
    delay: f64,
}
impl Crossfeed {
    fn new(sr: f64) -> Self {
        Self { lp: OnePole::lp(sr, 700.0), dl: Delay::new(64), dr: Delay::new(64), delay: 0.0003 * sr }
    }
    #[inline]
    fn process(&mut self, amt: f64, l: f64, r: f64) -> (f64, f64) {
        self.dl.push(l);
        self.dr.push(r);
        let xl = self.lp.run(0, self.dl.read(self.delay));
        let xr = self.lp.run(1, self.dr.read(self.delay));
        let c = amt * 0.45;
        let norm = 1.0 / (1.0 + c);
        ((l + c * xr) * norm, (r + c * xl) * norm)
    }
}

// ---------------------------------------------------------------------------------------------
// Binaural soundstage (spherical head model)
// ---------------------------------------------------------------------------------------------

struct VirtualSpeaker {
    source: u8, // 0=L 1=R 2=C
    delay_near: f64,
    delay_far: f64,
    gain_near: f64,
    gain_far: f64,
    right_is_near: bool,
    shadow: OnePole,
    rear: Biquad,
    line: Delay,
    send: f64,
}

struct Soundstage {
    speakers: Vec<VirtualSpeaker>,
    room: Reverb,
    room_amt: f64,
}

impl Soundstage {
    fn new(sr: f64, p: &DspParams) -> Self {
        const HEAD: f64 = 0.0875;
        const C: f64 = 343.0;
        let speakers = p
            .speakers
            .iter()
            .take(8)
            .map(|s| {
                let mut th = (s.azimuth as f64).to_radians();
                while th > PI {
                    th -= 2.0 * PI;
                }
                while th < -PI {
                    th += 2.0 * PI;
                }
                let behind = th.abs() > PI / 2.0;
                let lateral = if behind { th.signum() * (PI - th.abs()) } else { th };
                let la = lateral.abs();
                let itd = HEAD / C * (la + la.sin());
                let dist = (s.distance as f64).clamp(0.3, 5.0);
                let base = dist / C * sr + 8.0;
                let mut shadow = OnePole::default();
                shadow.set(sr, 20_000.0 * (1.0 - 0.86 * la.sin()));
                let dist_gain = (1.0 / dist).min(2.0);
                VirtualSpeaker {
                    source: match s.source.as_str() {
                        "R" => 1,
                        "C" => 2,
                        _ => 0,
                    },
                    delay_near: base,
                    delay_far: base + itd * sr,
                    gain_near: dist_gain * 10f64.powf(1.5 * la.sin() / 20.0),
                    gain_far: dist_gain * 10f64.powf(-7.0 * la.sin() / 20.0),
                    right_is_near: lateral >= 0.0,
                    shadow,
                    rear: Biquad::highshelf(sr, 4_000.0, 0.7, if behind { -5.0 } else { 0.0 }),
                    line: Delay::new((sr * 0.03) as usize),
                    send: 0.12 + 0.25 * (dist / 4.0).min(1.0),
                }
            })
            .collect();
        let mut room = Reverb::new(sr, 0.55 + p.room as f64 * 0.6, 8.0);
        room.feedback = 0.70 + p.room as f64 * 0.18;
        room.damp = 0.45;
        Self { speakers, room, room_amt: p.room as f64 }
    }

    #[inline]
    fn process(&mut self, l: f64, r: f64) -> (f64, f64) {
        let mut ol = 0.0;
        let mut or = 0.0;
        let mut send = 0.0;
        let n = self.speakers.len().max(1) as f64;
        for s in self.speakers.iter_mut() {
            let x = match s.source {
                0 => l,
                1 => r,
                _ => (l + r) * 0.5,
            };
            let x = s.rear.run(0, x);
            s.line.push(x);
            let near = s.line.read(s.delay_near) * s.gain_near;
            let far = s.shadow.run(0, s.line.read(s.delay_far)) * s.gain_far;
            if s.right_is_near {
                or += near;
                ol += far;
            } else {
                ol += near;
                or += far;
            }
            send += x * s.send;
        }
        let scale = 2.0 / n * 0.8;
        let (rl, rr) = self.room.run(send, send);
        (ol * scale + rl * self.room_amt * 0.9, or * scale + rr * self.room_amt * 0.9)
    }
}

// ---------------------------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------------------------

pub struct Dsp {
    pub params: DspParams,
    sr: f64,
    eq: Vec<Biquad>,
    /// per filter: 0 = both, 1 = left, 2 = right, 3 = mid, 4 = side, 255 = off
    eq_ch: Vec<u8>,
    preamp: f64,
    stems: StemIsolator,
    era: TimeMachine,
    crossfeed: Crossfeed,
    stage: Soundstage,
    bypass: bool,
}

impl Dsp {
    pub fn new(sr: u32, params: DspParams) -> Self {
        let sr = sr.max(8_000) as f64;
        let mut d = Self {
            stems: StemIsolator::new(sr),
            era: TimeMachine::new(sr),
            crossfeed: Crossfeed::new(sr),
            stage: Soundstage::new(sr, &params),
            eq: Vec::new(),
            eq_ch: Vec::new(),
            preamp: 1.0,
            params: params.clone(),
            sr,
            bypass: true,
        };
        d.set_params(params);
        d
    }

    pub fn sample_rate(&self) -> u32 {
        self.sr as u32
    }

    pub fn set_params(&mut self, p: DspParams) {
        let sr = self.sr;
        let eq_changed = p.bands.len() != self.params.bands.len()
            || p.bands.iter().zip(self.params.bands.iter()).any(|(a, b)| {
                a.freq != b.freq || a.gain_db != b.gain_db || a.q != b.q || a.kind != b.kind || a.channel != b.channel || a.enabled != b.enabled
            })
            || self.eq.is_empty();
        if eq_changed {
            // Preserve filter state where possible to avoid clicks while dragging.
            let old = std::mem::take(&mut self.eq);
            self.eq = p
                .bands
                .iter()
                .enumerate()
                .map(|(i, b)| {
                    let (f0, q, g) = (b.freq as f64, (b.q as f64).max(0.05), b.gain_db as f64);
                    let mut f = match b.kind.as_str() {
                        "lowshelf" => Biquad::lowshelf(sr, f0, q, g),
                        "highshelf" => Biquad::highshelf(sr, f0, q, g),
                        "lowpass" => Biquad::lowpass(sr, f0, q),
                        "highpass" => Biquad::highpass(sr, f0, q),
                        "bandpass" => Biquad::bandpass(sr, f0, q),
                        "notch" => Biquad::notch(sr, f0, q),
                        "allpass" => Biquad::allpass(sr, f0, q),
                        _ => Biquad::peaking(sr, f0, q, g),
                    };
                    if let Some(o) = old.get(i) {
                        f.z1 = o.z1;
                        f.z2 = o.z2;
                    }
                    f
                })
                .collect();
            self.eq_ch = p
                .bands
                .iter()
                .map(|b| if !b.audible() { 255 } else { match b.channel.as_str() { "l" => 1, "r" => 2, "m" => 3, "s" => 4, _ => 0 } })
                .collect();
        }
        self.preamp = 10f64.powf(p.preamp_db as f64 / 20.0);
        let stage_changed = p.stage_enabled
            && (!self.params.stage_enabled
                || p.room != self.params.room
                || p.speakers.len() != self.params.speakers.len()
                || p.speakers.iter().zip(self.params.speakers.iter()).any(|(a, b)| {
                    a.azimuth != b.azimuth || a.distance != b.distance || a.source != b.source
                }));
        if stage_changed {
            self.stage = Soundstage::new(sr, &p);
        }
        self.bypass = !(p.eq_active() || p.stems_active() || p.era_active() || p.crossfeed > 1e-3 || p.stage_enabled || p.mono);
        self.params = p;
    }

    pub fn is_bypass(&self) -> bool {
        self.bypass
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        if self.bypass {
            return (l, r);
        }
        let p = &self.params;
        let (mut a, mut b) = (l as f64, r as f64);
        if p.stems_active() {
            let s = p.stems.clone();
            let o = self.stems.process(a, b, &s);
            a = o.0;
            b = o.1;
        }
        if p.eq_active() {
            a *= self.preamp;
            b *= self.preamp;
            for (f, &ch) in self.eq.iter_mut().zip(self.eq_ch.iter()) {
                match ch {
                    0 => {
                        a = f.run(0, a);
                        b = f.run(1, b);
                    }
                    1 => a = f.run(0, a),
                    2 => b = f.run(1, b),
                    3 | 4 => {
                        let (mut m, mut s) = ((a + b) * 0.5, (a - b) * 0.5);
                        if ch == 3 { m = f.run(0, m) } else { s = f.run(1, s) }
                        a = m + s;
                        b = m - s;
                    }
                    _ => {}
                }
            }
        }
        if p.era_active() {
            let amt = (p.era_amount as f64).clamp(0.0, 1.0);
            let o = self.era.process(&p.era, amt, a, b);
            a = o.0;
            b = o.1;
        }
        if p.crossfeed > 1e-3 {
            let o = self.crossfeed.process(p.crossfeed as f64, a, b);
            a = o.0;
            b = o.1;
        }
        if p.stage_enabled {
            let o = self.stage.process(a, b);
            a = o.0;
            b = o.1;
        }
        if p.mono {
            let m = (a + b) * 0.5;
            a = m;
            b = m;
        }
        (a as f32, b as f32)
    }
}
