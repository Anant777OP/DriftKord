//! Pitch-preserving time-stretch (WSOLA: waveform-similarity overlap-add).
//!
//! Grains of ~43 ms are taken from the input every `speed × hop` samples and overlap-added every
//! `hop` samples; each grain's start is nudged (±tolerance) to the spot that best continues the
//! previous grain's waveform, so the music speeds up or slows down without changing key and
//! without the phasey smear of a plain overlap-add.

use std::collections::VecDeque;

pub struct Stretch {
    n: usize,
    hop: usize,
    tol: usize,
    win: Vec<f32>,
    /// input frames, `inp[0]` is absolute input frame `base`
    inp: VecDeque<[f32; 2]>,
    base: u64,
    /// nominal start (absolute input frame) of the next grain
    apos: f64,
    /// actual start of the previous grain
    prev: Option<u64>,
    ola: Vec<[f32; 2]>,
    out: VecDeque<[f32; 2]>,
    ended: bool,
    drained: usize,
}

impl Stretch {
    pub fn new(sr: u32) -> Self {
        let n = if sr > 100_000 { 4096 } else { 2048 };
        let win = (0..n).map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos()) as f32).collect();
        Self { n, hop: n / 2, tol: n / 4, win, inp: VecDeque::new(), base: 0, apos: 0.0, prev: None, ola: vec![[0.0; 2]; n], out: VecDeque::new(), ended: false, drained: 0 }
    }

    pub fn reset(&mut self) {
        self.inp.clear();
        self.base = 0;
        self.apos = 0.0;
        self.prev = None;
        self.ola.iter_mut().for_each(|f| *f = [0.0; 2]);
        self.out.clear();
        self.ended = false;
        self.drained = 0;
    }

    #[inline]
    fn at(&self, abs: u64) -> [f32; 2] {
        abs.checked_sub(self.base).and_then(|i| self.inp.get(i as usize).copied()).unwrap_or([0.0; 2])
    }

    /// Next output frame; `pull` supplies input frames (None at the end of the track).
    pub fn next(&mut self, speed: f64, mut pull: impl FnMut() -> Option<[f32; 2]>) -> Option<[f32; 2]> {
        while self.out.is_empty() {
            if self.ended && self.drained > self.n {
                return None;
            }
            self.grain(speed, &mut pull);
        }
        self.out.pop_front()
    }

    fn grain(&mut self, speed: f64, pull: &mut impl FnMut() -> Option<[f32; 2]>) {
        let (n, hop, tol) = (self.n, self.hop, self.tol);
        let nominal = self.apos.floor().max(0.0) as u64;
        let lo = nominal.saturating_sub(tol as u64);
        // make sure the search window and the grain are buffered
        let need = nominal + tol as u64 + n as u64;
        while self.base + (self.inp.len() as u64) < need {
            match if self.ended { None } else { pull() } {
                Some(f) => self.inp.push_back(f),
                None => {
                    self.ended = true;
                    self.inp.push_back([0.0; 2]);
                    self.drained += 1;
                }
            }
        }
        // best start: the one whose first half matches what naturally followed the previous grain
        let start = match self.prev {
            None => nominal,
            Some(p) => {
                let tmpl = p + hop as u64;
                let span = n / 2;
                let mut best = nominal;
                let mut best_v = f32::MIN;
                let mut k = lo;
                while k <= nominal + tol as u64 {
                    let mut acc = 0f32;
                    let mut j = 0;
                    while j < span {
                        let a = self.at(k + j as u64);
                        let b = self.at(tmpl + j as u64);
                        acc += (a[0] + a[1]) * (b[0] + b[1]);
                        j += 4;
                    }
                    if acc > best_v {
                        best_v = acc;
                        best = k;
                    }
                    k += 2;
                }
                best
            }
        };
        for i in 0..n {
            let f = self.at(start + i as u64);
            let w = self.win[i];
            self.ola[i][0] += f[0] * w;
            self.ola[i][1] += f[1] * w;
        }
        for i in 0..hop {
            self.out.push_back(self.ola[i]);
        }
        self.ola.copy_within(hop.., 0);
        for f in self.ola[n - hop..].iter_mut() {
            *f = [0.0; 2];
        }
        self.prev = Some(start);
        self.apos += hop as f64 * speed;
        // forget input nobody will look at again
        let keep_from = (start + hop as u64).min((self.apos.floor() as u64).saturating_sub(tol as u64));
        while self.base < keep_from && !self.inp.is_empty() {
            self.inp.pop_front();
            self.base += 1;
        }
    }
}
