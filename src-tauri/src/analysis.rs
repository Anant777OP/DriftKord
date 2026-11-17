//! Analysis:
//!  * `Meter` – lock-light tap the audio thread writes into (ring buffer + DR accumulators).
//!  * `RealtimeAnalyzer` – FFT spectrum, band energies, beat detection, phase correlation,
//!    goniometer points and a long-term average spectrum (LTAS) for the lossless verifier.
//!  * `analyze_file` – offline pass computing BPM, first beat, key/Camelot, energy, EBU R128
//!    loudness, DR (crest factor), spectral cutoff and the lossless authenticity verdict.

use crate::decoder;
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;

pub const RING: usize = 8192;

// ---------------------------------------------------------------------------------------------
// Meter tap
// ---------------------------------------------------------------------------------------------

pub struct Meter {
    pub ring: Vec<[f32; 2]>,
    pub w: usize,
    pub written: u64,
    pub sample_rate: u32,
    // DR accumulators (3 s blocks)
    block_len: usize,
    block_n: usize,
    block_sq: [f64; 2],
    block_pk: [f32; 2],
    pub blocks: Vec<([f64; 2], [f32; 2])>, // (rms, peak) per channel
    pub peak_hold: [f32; 2],
}

impl Meter {
    pub fn new() -> Self {
        Self {
            ring: vec![[0.0; 2]; RING],
            w: 0,
            written: 0,
            sample_rate: 44_100,
            block_len: 44_100 * 3,
            block_n: 0,
            block_sq: [0.0; 2],
            block_pk: [0.0; 2],
            blocks: Vec::new(),
            peak_hold: [0.0; 2],
        }
    }

    pub fn reset_track(&mut self, sample_rate: u32) {
        self.sample_rate = sample_rate;
        self.block_len = sample_rate as usize * 3;
        self.block_n = 0;
        self.block_sq = [0.0; 2];
        self.block_pk = [0.0; 2];
        self.blocks.clear();
        self.peak_hold = [0.0; 2];
    }

    pub fn push(&mut self, frames: &[f32]) {
        for f in frames.chunks_exact(2) {
            self.ring[self.w] = [f[0], f[1]];
            self.w = (self.w + 1) % RING;
            for ch in 0..2 {
                let v = f[ch];
                self.block_sq[ch] += (v as f64) * (v as f64);
                let a = v.abs();
                if a > self.block_pk[ch] {
                    self.block_pk[ch] = a;
                }
                if a > self.peak_hold[ch] {
                    self.peak_hold[ch] = a;
                }
            }
            self.block_n += 1;
            if self.block_n >= self.block_len {
                let n = self.block_n as f64;
                let rms = [(2.0 * self.block_sq[0] / n).sqrt(), (2.0 * self.block_sq[1] / n).sqrt()];
                self.blocks.push((rms, self.block_pk));
                if self.blocks.len() > 4000 {
                    self.blocks.remove(0);
                }
                self.block_n = 0;
                self.block_sq = [0.0; 2];
                self.block_pk = [0.0; 2];
            }
        }
        self.written += (frames.len() / 2) as u64;
    }

    /// Copy the most recent `n` frames, oldest first.
    pub fn latest(&self, n: usize) -> Vec<[f32; 2]> {
        let n = n.min(RING);
        let mut v = Vec::with_capacity(n);
        let start = (self.w + RING - n) % RING;
        for i in 0..n {
            v.push(self.ring[(start + i) % RING]);
        }
        v
    }

    /// Running DR value (Pleasurize/TT style) for what has been played so far.
    pub fn running_dr(&self) -> Option<f32> {
        dr_from_blocks(&self.blocks)
    }
}

pub fn dr_from_blocks(blocks: &[([f64; 2], [f32; 2])]) -> Option<f32> {
    if blocks.len() < 2 {
        return None;
    }
    let mut dr_ch = [0.0f64; 2];
    for ch in 0..2 {
        let mut rms: Vec<f64> = blocks.iter().map(|b| b.0[ch]).collect();
        let mut peaks: Vec<f32> = blocks.iter().map(|b| b.1[ch]).collect();
        rms.sort_by(|a, b| b.partial_cmp(a).unwrap());
        peaks.sort_by(|a, b| b.partial_cmp(a).unwrap());
        let top = ((rms.len() as f64) * 0.2).ceil().max(1.0) as usize;
        let mean_sq: f64 = rms[..top].iter().map(|r| r * r).sum::<f64>() / top as f64;
        let peak2 = peaks.get(1).copied().unwrap_or(peaks[0]) as f64;
        if mean_sq <= 0.0 || peak2 <= 0.0 {
            return None;
        }
        dr_ch[ch] = 20.0 * (peak2 / mean_sq.sqrt()).log10();
    }
    Some(((dr_ch[0] + dr_ch[1]) / 2.0) as f32)
}

// ---------------------------------------------------------------------------------------------
// Realtime analyzer (runs on the emitter thread, not the audio thread)
// ---------------------------------------------------------------------------------------------

pub const FFT_N: usize = 4096;
pub const BANDS: usize = 64;
pub const LTAS_POINTS: usize = 192;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub bands: Vec<f32>,
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    pub rms: [f32; 2],
    pub peak: [f32; 2],
    pub correlation: f32,
    pub gonio: Vec<f32>,
    pub beat: bool,
    pub crest_db: f32,
    pub position: f64,
    pub playing: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Ltas {
    pub freqs: Vec<f32>,
    pub db: Vec<f32>,
    pub cutoff_hz: f32,
    pub verdict: String,
    pub sample_rate: u32,
}

pub struct RealtimeAnalyzer {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    scratch: Vec<Complex<f32>>,
    smooth: Vec<f32>,
    bass_avg: f32,
    last_beat: std::time::Instant,
    ltas_acc: Vec<f64>,
    ltas_n: u64,
    pub last_written: u64,
}

impl RealtimeAnalyzer {
    pub fn new() -> Self {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(FFT_N);
        let window = (0..FFT_N)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_N as f32 - 1.0)).cos())
            .collect();
        Self {
            fft,
            window,
            scratch: vec![Complex::default(); FFT_N],
            smooth: vec![0.0; BANDS],
            bass_avg: 0.0,
            last_beat: std::time::Instant::now(),
            ltas_acc: vec![0.0; FFT_N / 2],
            ltas_n: 0,
            last_written: 0,
        }
    }

    pub fn reset_ltas(&mut self) {
        self.ltas_acc.iter_mut().for_each(|v| *v = 0.0);
        self.ltas_n = 0;
    }

    /// Compute a visual frame from the latest samples.
    pub fn frame(&mut self, samples: &[[f32; 2]], sr: u32, fresh: bool) -> Frame {
        let n = samples.len().min(FFT_N);
        let tail = &samples[samples.len() - n..];
        for i in 0..FFT_N {
            let v = if i < n { (tail[i][0] + tail[i][1]) * 0.5 } else { 0.0 };
            self.scratch[i] = Complex::new(v * self.window[i], 0.0);
        }
        self.fft.process(&mut self.scratch);
        let half = FFT_N / 2;
        let mags: Vec<f32> = self.scratch[..half].iter().map(|c| c.norm() / (FFT_N as f32 / 4.0)).collect();
        if fresh {
            for (a, m) in self.ltas_acc.iter_mut().zip(mags.iter()) {
                *a += (*m as f64) * (*m as f64);
            }
            self.ltas_n += 1;
        }
        let nyq = sr as f32 / 2.0;
        let fmin = 20.0f32;
        let fmax = nyq.min(20_000.0);
        let mut bands = vec![0.0f32; BANDS];
        for b in 0..BANDS {
            let f0 = fmin * (fmax / fmin).powf(b as f32 / BANDS as f32);
            let f1 = fmin * (fmax / fmin).powf((b + 1) as f32 / BANDS as f32);
            let i0 = ((f0 / nyq) * half as f32).floor() as usize;
            let i1 = (((f1 / nyq) * half as f32).ceil() as usize).max(i0 + 1).min(half);
            let mut peak = 0.0f32;
            for m in &mags[i0.min(half - 1)..i1] {
                peak = peak.max(*m);
            }
            let db = 20.0 * (peak + 1e-9).log10();
            let v = ((db + 72.0) / 72.0).clamp(0.0, 1.0);
            // fast attack, slower release
            let s = &mut self.smooth[b];
            *s = if v > *s { v * 0.7 + *s * 0.3 } else { v * 0.18 + *s * 0.82 };
            bands[b] = *s;
        }
        let band_avg = |lo: f32, hi: f32| {
            let mut sum = 0.0;
            let mut cnt = 0.0;
            for b in 0..BANDS {
                let f = fmin * (fmax / fmin).powf((b as f32 + 0.5) / BANDS as f32);
                if f >= lo && f < hi {
                    sum += bands[b];
                    cnt += 1.0;
                }
            }
            if cnt > 0.0 { sum / cnt } else { 0.0 }
        };
        let bass = band_avg(20.0, 250.0);
        let mid = band_avg(250.0, 4000.0);
        let treble = band_avg(4000.0, 20_000.0);

        // levels over the last ~1/60 s window (use last 1024 frames)
        let lw = &samples[samples.len().saturating_sub(1024)..];
        let mut sq = [0.0f64; 2];
        let mut pk = [0.0f32; 2];
        let mut lr = 0.0f64;
        for f in lw {
            for ch in 0..2 {
                sq[ch] += (f[ch] as f64).powi(2);
                pk[ch] = pk[ch].max(f[ch].abs());
            }
        }
        // correlation over the whole window
        let mut sl = 0.0f64;
        let mut sr2 = 0.0f64;
        for f in tail {
            lr += f[0] as f64 * f[1] as f64;
            sl += (f[0] as f64).powi(2);
            sr2 += (f[1] as f64).powi(2);
        }
        let denom = (sl * sr2).sqrt();
        let correlation = if denom > 1e-12 { (lr / denom) as f32 } else { 1.0 };
        let cnt = lw.len().max(1) as f64;
        let rms = [(sq[0] / cnt).sqrt() as f32, (sq[1] / cnt).sqrt() as f32];
        let crest_db = {
            let r = ((rms[0] + rms[1]) / 2.0).max(1e-9);
            let p = pk[0].max(pk[1]).max(1e-9);
            20.0 * (p / r).log10()
        };
        // goniometer: 160 points (mid/side)
        let mut gonio = Vec::with_capacity(320);
        let step = (tail.len() / 160).max(1);
        for f in tail.iter().step_by(step).take(160) {
            let m = (f[0] + f[1]) * 0.7071;
            let s = (f[0] - f[1]) * 0.7071;
            gonio.push(s);
            gonio.push(m);
        }
        // beat: bass onset vs moving average
        let mut beat = false;
        if bass > self.bass_avg * 1.18 + 0.03 && self.last_beat.elapsed().as_millis() > 220 {
            beat = true;
            self.last_beat = std::time::Instant::now();
        }
        self.bass_avg = self.bass_avg * 0.92 + bass * 0.08;
        Frame {
            bands,
            bass,
            mid,
            treble,
            rms,
            peak: pk,
            correlation,
            gonio,
            beat,
            crest_db,
            position: 0.0,
            playing: true,
        }
    }

    pub fn ltas(&self, sr: u32, lossless: bool) -> Ltas {
        let half = FFT_N / 2;
        let nyq = sr as f32 / 2.0;
        let n = self.ltas_n.max(1) as f64;
        let db_bins: Vec<f32> = self
            .ltas_acc
            .iter()
            .map(|v| (10.0 * ((v / n) + 1e-14).log10()) as f32)
            .collect();
        let mut freqs = Vec::with_capacity(LTAS_POINTS);
        let mut db = Vec::with_capacity(LTAS_POINTS);
        for p in 0..LTAS_POINTS {
            let f = 20.0 * (nyq / 20.0).powf(p as f32 / (LTAS_POINTS - 1) as f32);
            let i = ((f / nyq) * half as f32) as usize;
            let i = i.min(half - 1);
            freqs.push(f);
            db.push(db_bins[i]);
        }
        let (cutoff, verdict) = if self.ltas_n < 30 {
            (0.0, "Listening…".to_string())
        } else {
            cutoff_and_verdict(&db_bins, sr, lossless)
        };
        Ltas { freqs, db, cutoff_hz: cutoff, verdict, sample_rate: sr }
    }
}

/// Find the spectral cutoff (highest frequency with real content) and judge authenticity.
pub fn cutoff_and_verdict(db_bins: &[f32], sr: u32, lossless: bool) -> (f32, String) {
    let half = db_bins.len();
    let nyq = sr as f32 / 2.0;
    let hz_per_bin = nyq / half as f32;
    // smooth over ~200 Hz
    let w = ((200.0 / hz_per_bin) as usize).max(1);
    let smooth: Vec<f32> = (0..half)
        .map(|i| {
            let a = i.saturating_sub(w);
            let b = (i + w).min(half - 1);
            db_bins[a..=b].iter().sum::<f32>() / (b - a + 1) as f32
        })
        .collect();
    // Reference level: 1–4 kHz.
    let r0 = (1000.0 / hz_per_bin) as usize;
    let r1 = ((4000.0 / hz_per_bin) as usize).min(half - 1);
    let reference = smooth[r0..r1].iter().sum::<f32>() / (r1 - r0).max(1) as f32;
    let floor = smooth[(half as f32 * 0.98) as usize..].iter().cloned().fold(f32::MAX, f32::min);
    let threshold = floor + (reference - floor) * 0.18;
    let mut cutoff_bin = half - 1;
    for i in (r1..half).rev() {
        if smooth[i] > threshold {
            cutoff_bin = i;
            break;
        }
    }
    let cutoff = cutoff_bin as f32 * hz_per_bin;
    // Steepness: drop across ±600 Hz at the cutoff.
    let d = (600.0 / hz_per_bin) as usize;
    let below = smooth[cutoff_bin.saturating_sub(d)];
    let above = smooth[(cutoff_bin + d).min(half - 1)];
    let steep = below - above;
    let verdict = if !lossless {
        if cutoff < 16_500.0 {
            format!("Lossy source, band-limited at {:.1} kHz (low bitrate)", cutoff / 1000.0)
        } else {
            format!("Lossy source, cutoff {:.1} kHz (high bitrate)", cutoff / 1000.0)
        }
    } else if sr > 48_000 && cutoff < 23_000.0 {
        format!(
            "Suspicious: {} kHz container but content stops at {:.1} kHz — likely upsampled from CD/48k",
            sr / 1000,
            cutoff / 1000.0
        )
    } else if cutoff < nyq * 0.9 && cutoff > 10_000.0 && cutoff < 20_600.0 && steep > 18.0 {
        format!(
            "FAKE lossless: brick-wall cutoff at {:.1} kHz — transcoded from MP3/AAC",
            cutoff / 1000.0
        )
    } else {
        format!("Authentic lossless — content extends to {:.1} kHz", cutoff / 1000.0)
    };
    (cutoff, verdict)
}

// ---------------------------------------------------------------------------------------------
// Offline analysis
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackAnalysis {
    pub bpm: f32,
    pub first_beat: f32,
    pub key: String,
    pub camelot: String,
    pub energy: f32,
    pub brightness: f32,
    pub lufs: f32,
    pub peak: f32,
    pub dr: f32,
    pub cutoff_hz: f32,
    pub verdict: String,
    #[serde(skip)]
    pub loudness_blocks: Vec<f64>,
}

const KEY_NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const CAMELOT_MAJOR: [u8; 12] = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR: [u8; 12] = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
const PROFILE_MAJOR: [f32; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const PROFILE_MINOR: [f32; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/// BS.1770 K-weighting biquad pair for an arbitrary sample rate (pyloudnorm derivation).
fn k_filters(sr: f64) -> [[f64; 5]; 2] {
    let shelf = {
        let (g, q, fc) = (3.999843853973347, 0.7071752369554196, 1681.974450955533);
        let a = 10f64.powf(g / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * fc / sr;
        let alpha = w0.sin() / (2.0 * q);
        let c = w0.cos();
        let s = 2.0 * a.sqrt() * alpha;
        let b0 = a * ((a + 1.0) + (a - 1.0) * c + s);
        let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * c);
        let b2 = a * ((a + 1.0) + (a - 1.0) * c - s);
        let a0 = (a + 1.0) - (a - 1.0) * c + s;
        let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * c);
        let a2 = (a + 1.0) - (a - 1.0) * c - s;
        [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
    };
    let hp = {
        let (q, fc) = (0.5003270373238773, 38.13547087602444);
        let w0 = 2.0 * std::f64::consts::PI * fc / sr;
        let alpha = w0.sin() / (2.0 * q);
        let c = w0.cos();
        let a0 = 1.0 + alpha;
        [(1.0 + c) / 2.0 / a0, -(1.0 + c) / a0, (1.0 + c) / 2.0 / a0, -2.0 * c / a0, (1.0 - alpha) / a0]
    };
    [shelf, hp]
}

pub fn integrated_lufs(blocks: &[f64]) -> f32 {
    let abs: Vec<f64> = blocks
        .iter()
        .cloned()
        .filter(|&z| -0.691 + 10.0 * z.max(1e-20).log10() > -70.0)
        .collect();
    if abs.is_empty() {
        return -70.0;
    }
    let mean_abs = abs.iter().sum::<f64>() / abs.len() as f64;
    let rel_gate = -0.691 + 10.0 * mean_abs.log10() - 10.0;
    let gated: Vec<f64> = abs
        .into_iter()
        .filter(|&z| -0.691 + 10.0 * z.log10() > rel_gate)
        .collect();
    if gated.is_empty() {
        return -70.0;
    }
    (-0.691 + 10.0 * (gated.iter().sum::<f64>() / gated.len() as f64).log10()) as f32
}

pub fn analyze_file(path: &Path) -> Result<TrackAnalysis, String> {
    let mut src = decoder::open(path, false)?;
    let info = src.info().clone();
    let sr = info.sample_rate.max(8000) as f64;

    // --- loudness state
    let k = k_filters(sr);
    let mut kst = [[0.0f64; 4]; 4]; // [ch*2 + stage] -> x1 x2 y1 y2
    let sub_len = (sr * 0.1) as usize;
    let mut sub_acc = 0.0f64;
    let mut sub_n = 0usize;
    let mut subs: Vec<f64> = Vec::new();
    // --- DR blocks
    let blk_len = (sr * 3.0) as usize;
    let mut blk_sq = [0.0f64; 2];
    let mut blk_pk = [0.0f32; 2];
    let mut blk_n = 0usize;
    let mut blocks: Vec<([f64; 2], [f32; 2])> = Vec::new();
    let mut peak = 0.0f32;
    // --- mono downsampled stream for rhythm / key (~22 kHz)
    let decim = ((sr / 22_050.0).round() as usize).max(1);
    let msr = sr / decim as f64;
    let mut mono: Vec<f32> = Vec::new();
    let mut dacc = 0.0f32;
    let mut dn = 0usize;
    // --- spectrum for cutoff (full rate, mono)
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_N);
    let hann: Vec<f32> = (0..FFT_N)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_N as f32 - 1.0)).cos())
        .collect();
    let mut spec_acc = vec![0.0f64; FFT_N / 2];
    let mut spec_n = 0u64;
    let mut fbuf: Vec<f32> = Vec::with_capacity(FFT_N);
    let mut frame_counter = 0u64;
    let mut sum_sq_total = 0.0f64;
    let mut total_frames = 0u64;

    let mut chunk = Vec::new();
    loop {
        chunk.clear();
        if !src.decode_more(&mut chunk) {
            break;
        }
        for f in chunk.chunks_exact(2) {
            let (l, r) = (f[0], f[1]);
            total_frames += 1;
            sum_sq_total += ((l as f64).powi(2) + (r as f64).powi(2)) * 0.5;
            // K-weighting per channel
            let mut z = 0.0;
            for (ch, &x) in [l as f64, r as f64].iter().enumerate() {
                let mut v = x;
                for st in 0..2 {
                    let c = &k[st];
                    let s = &mut kst[ch * 2 + st];
                    let y = c[0] * v + c[1] * s[0] + c[2] * s[1] - c[3] * s[2] - c[4] * s[3];
                    s[1] = s[0];
                    s[0] = v;
                    s[3] = s[2];
                    s[2] = y;
                    v = y;
                }
                z += v * v;
            }
            sub_acc += z;
            sub_n += 1;
            if sub_n >= sub_len {
                subs.push(sub_acc / sub_n as f64);
                sub_acc = 0.0;
                sub_n = 0;
            }
            // DR
            for (ch, &v) in [l, r].iter().enumerate() {
                blk_sq[ch] += (v as f64).powi(2);
                blk_pk[ch] = blk_pk[ch].max(v.abs());
                peak = peak.max(v.abs());
            }
            blk_n += 1;
            if blk_n >= blk_len {
                let n = blk_n as f64;
                blocks.push(([(2.0 * blk_sq[0] / n).sqrt(), (2.0 * blk_sq[1] / n).sqrt()], blk_pk));
                blk_sq = [0.0; 2];
                blk_pk = [0.0; 2];
                blk_n = 0;
            }
            // mono decimation
            let m = (l + r) * 0.5;
            dacc += m;
            dn += 1;
            if dn == decim {
                mono.push(dacc / decim as f32);
                dacc = 0.0;
                dn = 0;
            }
            // cutoff spectrum: every 4th FFT frame to save time
            fbuf.push(m);
            if fbuf.len() == FFT_N {
                frame_counter += 1;
                if frame_counter % 4 == 0 {
                    let mut buf: Vec<Complex<f32>> =
                        fbuf.iter().zip(hann.iter()).map(|(s, w)| Complex::new(s * w, 0.0)).collect();
                    fft.process(&mut buf);
                    for (a, c) in spec_acc.iter_mut().zip(buf.iter()) {
                        *a += (c.norm_sqr() as f64) / (FFT_N as f64);
                    }
                    spec_n += 1;
                }
                fbuf.clear();
            }
        }
    }
    if total_frames == 0 {
        return Err("No audio decoded".into());
    }
    if blk_n > blk_len / 3 {
        let n = blk_n as f64;
        blocks.push(([(2.0 * blk_sq[0] / n).sqrt(), (2.0 * blk_sq[1] / n).sqrt()], blk_pk));
    }
    // 400 ms blocks with 75% overlap from 100 ms sub-blocks
    let mut lblocks = Vec::new();
    if subs.len() >= 4 {
        for i in 0..=subs.len() - 4 {
            lblocks.push((subs[i] + subs[i + 1] + subs[i + 2] + subs[i + 3]) / 4.0);
        }
    }
    let lufs = integrated_lufs(&lblocks);
    let dr = dr_from_blocks(&blocks).unwrap_or(0.0);

    let db_bins: Vec<f32> = spec_acc
        .iter()
        .map(|v| (10.0 * (v / spec_n.max(1) as f64 + 1e-14).log10()) as f32)
        .collect();
    let (cutoff_hz, verdict) = cutoff_and_verdict(&db_bins, info.sample_rate, info.lossless);

    // brightness: spectral centroid of the long-term spectrum
    let nyq = info.sample_rate as f64 / 2.0;
    let (mut num, mut den) = (0.0, 0.0);
    for (i, v) in spec_acc.iter().enumerate() {
        let f = i as f64 / spec_acc.len() as f64 * nyq;
        num += f * v;
        den += v;
    }
    let centroid = if den > 0.0 { num / den } else { 0.0 };
    let brightness = ((centroid / 4000.0).clamp(0.0, 1.0)) as f32;

    let (bpm, first_beat) = detect_tempo(&mono, msr);
    let (key, camelot) = detect_key(&mono, msr);

    let rms_db = 10.0 * (sum_sq_total / total_frames as f64 + 1e-12).log10();
    let loud = ((rms_db + 30.0) / 24.0).clamp(0.0, 1.0) as f32;
    let tempo_e = ((bpm - 60.0) / 120.0).clamp(0.0, 1.0);
    let energy = (loud * 0.55 + tempo_e * 0.25 + brightness * 0.2).clamp(0.0, 1.0);

    Ok(TrackAnalysis {
        bpm,
        first_beat,
        key,
        camelot,
        energy,
        brightness,
        lufs,
        peak,
        dr,
        cutoff_hz,
        verdict,
        loudness_blocks: lblocks,
    })
}

/// Spectral-flux onset envelope + autocorrelation tempo estimate.
fn detect_tempo(mono: &[f32], sr: f64) -> (f32, f32) {
    const N: usize = 1024;
    const HOP: usize = 512;
    if mono.len() < N * 8 {
        return (0.0, 0.0);
    }
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N);
    let hann: Vec<f32> = (0..N)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (N as f32 - 1.0)).cos())
        .collect();
    let mut prev = vec![0.0f32; N / 2];
    let mut env = Vec::new();
    let mut buf = vec![Complex::<f32>::default(); N];
    let mut pos = 0;
    // analyse at most ~4 minutes for speed
    let max_len = (sr * 240.0) as usize;
    let data = &mono[..mono.len().min(max_len)];
    while pos + N <= data.len() {
        for i in 0..N {
            buf[i] = Complex::new(data[pos + i] * hann[i], 0.0);
        }
        fft.process(&mut buf);
        let mut flux = 0.0f32;
        for i in 1..N / 2 {
            let m = (1.0 + 1000.0 * buf[i].norm()).ln();
            let d = m - prev[i];
            if d > 0.0 {
                flux += d;
            }
            prev[i] = m;
        }
        env.push(flux);
        pos += HOP;
    }
    // remove local mean
    let w = 16;
    let envn: Vec<f32> = (0..env.len())
        .map(|i| {
            let a = i.saturating_sub(w);
            let b = (i + w).min(env.len() - 1);
            let mean = env[a..=b].iter().sum::<f32>() / (b - a + 1) as f32;
            (env[i] - mean).max(0.0)
        })
        .collect();
    let fps = sr / HOP as f64;
    let min_lag = (fps * 60.0 / 200.0) as usize;
    let max_lag = (fps * 60.0 / 60.0) as usize;
    let mut best = (0usize, 0.0f64);
    for lag in min_lag.max(1)..=max_lag.min(envn.len() / 2) {
        let mut acc = 0.0f64;
        for i in lag..envn.len() {
            acc += (envn[i] * envn[i - lag]) as f64;
        }
        acc /= (envn.len() - lag) as f64;
        let bpm = 60.0 * fps / lag as f64;
        // log-gaussian prior centred at 120 BPM
        let prior = (-0.5 * ((bpm / 120.0).log2() / 0.9).powi(2)).exp();
        let score = acc * prior;
        if score > best.1 {
            best = (lag, score);
        }
    }
    if best.0 == 0 {
        return (0.0, 0.0);
    }
    let mut bpm = 60.0 * fps / best.0 as f64;
    while bpm < 70.0 {
        bpm *= 2.0;
    }
    while bpm > 180.0 {
        bpm /= 2.0;
    }
    // beat phase
    let lag = best.0;
    let mut best_off = (0usize, 0.0f32);
    for off in 0..lag {
        let mut s = 0.0;
        let mut i = off;
        while i < envn.len() {
            s += envn[i];
            i += lag;
        }
        if s > best_off.1 {
            best_off = (off, s);
        }
    }
    ((bpm * 10.0).round() as f32 / 10.0, (best_off.0 as f64 / fps) as f32)
}

/// Chromagram + Krumhansl–Schmuckler key profiles.
fn detect_key(mono: &[f32], sr: f64) -> (String, String) {
    const N: usize = 8192;
    if mono.len() < N * 4 {
        return (String::new(), String::new());
    }
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N);
    let hann: Vec<f32> = (0..N)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (N as f32 - 1.0)).cos())
        .collect();
    // precompute pitch class per bin
    let pcs: Vec<Option<usize>> = (0..N / 2)
        .map(|i| {
            let f = i as f64 * sr / N as f64;
            if !(55.0..=2000.0).contains(&f) {
                return None;
            }
            let midi = 69.0 + 12.0 * (f / 440.0).log2();
            Some(((midi.round() as i64).rem_euclid(12)) as usize)
        })
        .collect();
    let mut chroma = [0.0f64; 12];
    let mut buf = vec![Complex::<f32>::default(); N];
    let mut pos = 0;
    while pos + N <= mono.len() {
        for i in 0..N {
            buf[i] = Complex::new(mono[pos + i] * hann[i], 0.0);
        }
        fft.process(&mut buf);
        let mut frame = [0.0f64; 12];
        for (i, pc) in pcs.iter().enumerate() {
            if let Some(pc) = pc {
                frame[*pc] += buf[i].norm() as f64;
            }
        }
        let mx = frame.iter().cloned().fold(0.0, f64::max);
        if mx > 0.0 {
            for k in 0..12 {
                chroma[k] += frame[k] / mx;
            }
        }
        pos += N;
    }
    let corr = |profile: &[f32; 12], root: usize| -> f64 {
        let pm = profile.iter().map(|&v| v as f64).sum::<f64>() / 12.0;
        let cm = chroma.iter().sum::<f64>() / 12.0;
        let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
        for i in 0..12 {
            let a = chroma[(i + root) % 12] - cm;
            let b = profile[i] as f64 - pm;
            num += a * b;
            da += a * a;
            db += b * b;
        }
        num / (da * db).sqrt().max(1e-12)
    };
    let mut best = (0usize, false, f64::MIN);
    for root in 0..12 {
        let maj = corr(&PROFILE_MAJOR, root);
        let min = corr(&PROFILE_MINOR, root);
        if maj > best.2 {
            best = (root, false, maj);
        }
        if min > best.2 {
            best = (root, true, min);
        }
    }
    let (root, minor, _) = best;
    let key = format!("{}{}", KEY_NAMES[root], if minor { "m" } else { "" });
    let camelot = if minor {
        format!("{}A", CAMELOT_MINOR[root])
    } else {
        format!("{}B", CAMELOT_MAJOR[root])
    };
    (key, camelot)
}
