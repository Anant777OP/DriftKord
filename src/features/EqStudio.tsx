// EQ Studio: four equalizer modes sharing one engine filter bank.
//  - Legacy EQ      graphic EQ with any number of bands between a min and max frequency
//  - Parametric EQ  free filters (peak, shelves, pass, notch, all-pass) per channel incl. Mid/Side
//  - AutoEQ         upload your own headphone measurement (or a ready-made EQ file), pick a target,
//                   and DriftKord fits the filters itself (no headphone database is bundled)
//  - Speaker EQ     room correction: upload REW/CSV measurements or measure with a microphone,
//                   per channel, within a bass/room frequency window
// The selected mode is what plays. Everything is saved in the library settings ("eqStudio").
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, EqBand, EqChannel, EqKind } from "../api";
import { Icon, Toggle } from "../controls";
import { updateDsp } from "../player";
import { getState, toast, useStore } from "../store";

// ------------------------------------------------------------------ model
export type FType = "PK" | "LS" | "HS" | "LP" | "HP" | "BP" | "NO" | "AP";
export type FChan = "ST" | "L" | "R" | "M" | "S";
export interface Filter { type: FType; ch: FChan; freq: number; gain: number; q: number; on: boolean }
type Curve = [number, number][]; // [Hz, dB]
interface Measurement { name: string; points: Curve }
type Mode = "legacy" | "parametric" | "autoeq" | "speaker";
interface Profile { name: string; filters: Filter[]; preamp: number; extra?: unknown }
interface SpeakerChannel { measurement: Measurement | null; filters: Filter[] }
export interface Studio {
  enabled: boolean;
  mode: Mode;
  autoPreamp: boolean;
  legacy: { bands: number; minHz: number; maxHz: number; gains: number[]; preamp: number; preset: string; custom: Record<string, number[]> };
  parametric: { filters: Filter[]; preamp: number; preset: string };
  autoeq: { model: string; measurement: Measurement | null; target: string; customTarget: Measurement | null; filters: Filter[]; preamp: number; bands: number; maxHz: number; sampleRate: number };
  speaker: { layout: "2.0" | "1.0"; channel: "FL" | "FR"; ch: { FL: SpeakerChannel; FR: SpeakerChannel }; target: string; customTarget: Measurement | null; bands: number; bassLimit: number; roomLimit: number; preamp: number };
  profiles: { parametric: Profile[]; autoeq: Profile[]; speaker: Profile[] };
}

const TYPES: { v: FType; label: string; kind: EqKind; gain: boolean }[] = [
  { v: "PK", label: "Peak", kind: "peak", gain: true },
  { v: "LS", label: "Low shelf", kind: "lowshelf", gain: true },
  { v: "HS", label: "High shelf", kind: "highshelf", gain: true },
  { v: "LP", label: "Low pass", kind: "lowpass", gain: false },
  { v: "HP", label: "High pass", kind: "highpass", gain: false },
  { v: "BP", label: "Band pass", kind: "bandpass", gain: false },
  { v: "NO", label: "Notch", kind: "notch", gain: false },
  { v: "AP", label: "All pass", kind: "allpass", gain: false },
];
const CHANS: { v: FChan; label: string }[] = [
  { v: "ST", label: "Stereo (both)" }, { v: "L", label: "Left" }, { v: "R", label: "Right" }, { v: "M", label: "Mid (centre)" }, { v: "S", label: "Side (width)" },
];
const kindOf = (t: FType) => TYPES.find((x) => x.v === t)!.kind;
const hasGain = (t: FType) => TYPES.find((x) => x.v === t)!.gain;
const chanOf = (c: FChan): EqChannel => (c === "ST" ? "st" : (c.toLowerCase() as EqChannel));

const logspace = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => (n === 1 ? a : a * Math.pow(b / a, i / (n - 1))));
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const fmtHz = (f: number) => (f >= 1000 ? `${round(f / 1000, f >= 10000 ? 1 : 2)}k` : `${Math.round(f)}`);
const pk = (freq: number, gain = 0, q = 1.41): Filter => ({ type: "PK", ch: "ST", freq, gain, q, on: true });

export function defaultStudio(): Studio {
  return {
    enabled: false,
    mode: "parametric",
    autoPreamp: true,
    legacy: { bands: 16, minHz: 25, maxHz: 20000, gains: Array(16).fill(0), preamp: 0, preset: "Custom", custom: {} },
    parametric: { filters: [20, 43, 93, 200, 431, 928, 2000, 4300, 9300, 20000].map((f) => pk(f, 0, 1)), preamp: 0, preset: "Custom" },
    autoeq: { model: "", measurement: null, target: "harman-oe-2018", customTarget: null, filters: [], preamp: 0, bands: 10, maxHz: 16000, sampleRate: 48000 },
    speaker: { layout: "2.0", channel: "FL", ch: { FL: { measurement: null, filters: [] }, FR: { measurement: null, filters: [] } }, target: "harman-room-2013", customTarget: null, bands: 10, bassLimit: 40, roomLimit: 500, preamp: 0 },
    profiles: { parametric: [], autoeq: [], speaker: [] },
  };
}

// ------------------------------------------------------------------ filter maths (RBJ cookbook)
export function filterDb(f: Filter, hz: number, sr = 48000): number {
  if (!f.on) return 0;
  const A = Math.pow(10, f.gain / 40);
  const w0 = (2 * Math.PI * clamp(f.freq, 5, sr * 0.49)) / sr;
  const q = Math.max(0.05, f.q);
  const alpha = Math.sin(w0) / (2 * q), c = Math.cos(w0);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (f.type) {
    case "LS": case "HS": {
      const s = 2 * Math.sqrt(A) * alpha, sg = f.type === "LS" ? 1 : -1;
      b0 = A * ((A + 1) - sg * (A - 1) * c + s); b1 = sg * 2 * A * ((A - 1) - sg * (A + 1) * c); b2 = A * ((A + 1) - sg * (A - 1) * c - s);
      a0 = (A + 1) + sg * (A - 1) * c + s; a1 = -sg * 2 * ((A - 1) + sg * (A + 1) * c); a2 = (A + 1) + sg * (A - 1) * c - s;
      break;
    }
    case "LP": b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case "HP": b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case "BP": b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case "NO": b0 = 1; b1 = -2 * c; b2 = 1; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case "AP": return 0;
    default: b0 = 1 + alpha * A; b1 = -2 * c; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * c; a2 = 1 - alpha / A;
  }
  const w = (2 * Math.PI * hz) / sr;
  const cw = Math.cos(w), c2 = Math.cos(2 * w), sw = Math.sin(w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * cw + b2 * c2, ni = -(b1 * sw + b2 * s2);
  const dr = a0 + a1 * cw + a2 * c2, di = -(a1 * sw + a2 * s2);
  return 10 * Math.log10(Math.max(1e-20, (nr * nr + ni * ni) / (dr * dr + di * di)));
}
const response = (fs: Filter[], hz: number, sr = 48000) => fs.reduce((s, f) => s + filterDb(f, hz, sr), 0);

/** Highest boost of a filter set (for automatic preamp / clipping protection). */
function peakBoost(fs: Filter[]): number {
  let m = 0;
  for (const hz of logspace(20, 20000, 240)) m = Math.max(m, response(fs, hz));
  return m;
}

// ------------------------------------------------------------------ curves
/** Log-interpolate a curve at hz. */
export function at(c: Curve, hz: number): number {
  if (!c.length) return 0;
  if (hz <= c[0][0]) return c[0][1];
  if (hz >= c[c.length - 1][0]) return c[c.length - 1][1];
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m][0] <= hz) lo = m; else hi = m; }
  const [f0, d0] = c[lo], [f1, d1] = c[hi];
  const t = Math.log(hz / f0) / Math.log(f1 / f0);
  return d0 + (d1 - d0) * t;
}
/** Fractional-octave smoothing on a log grid. */
function smooth(c: Curve, octaves: number, grid = logspace(20, 20000, 320)): Curve {
  return grid.map((hz) => {
    const lo = hz / Math.pow(2, octaves / 2), hi = hz * Math.pow(2, octaves / 2);
    let s = 0, n = 0;
    for (const g of logspace(lo, hi, 9)) { s += at(c, g); n++; }
    return [hz, s / n];
  });
}

// Targets (approximations of the published curves, relative dB; 0 at 1 kHz)
const TARGETS: Record<string, { name: string; kind: "headphone" | "speaker" | "any"; pts: Curve }> = {
  "harman-oe-2018": { name: "Harman Over-Ear 2018", kind: "headphone", pts: [[20, 6.2], [40, 6.1], [60, 5.6], [100, 4.0], [150, 2.2], [200, 1.0], [300, 0.1], [500, -0.2], [1000, 0], [1500, 1.4], [2000, 4.2], [2600, 7.6], [3200, 8.6], [4000, 8.0], [5000, 6.2], [6300, 3.8], [8000, 2.6], [10000, 0.6], [12500, -2.0], [16000, -5.0], [20000, -7.5]] },
  "harman-ie-2019": { name: "Harman In-Ear 2019", kind: "headphone", pts: [[20, 9.6], [50, 9.4], [100, 8.0], [150, 6.0], [200, 4.3], [300, 2.2], [500, 0.6], [1000, 0], [1500, 1.6], [2000, 5.0], [2700, 9.8], [3200, 10.5], [4000, 9.2], [5000, 6.5], [6300, 3.5], [8000, 2.0], [10000, 1.5], [12500, -1.0], [16000, -4.0], [20000, -8.0]] },
  "diffuse-field": { name: "Diffuse Field (ISO 11904-2)", kind: "headphone", pts: [[20, 0], [200, 0], [500, 0.4], [1000, 0], [1600, 2.0], [2000, 4.5], [2700, 11.0], [3200, 12.5], [4000, 11.5], [5000, 8.5], [6300, 6.0], [8000, 4.5], [10000, 2.0], [12500, 0.5], [16000, -2.0], [20000, -4.0]] },
  "harman-room-2013": { name: "Harman In-Room (2013)", kind: "speaker", pts: [[20, 6.5], [50, 6.0], [100, 4.6], [200, 2.4], [400, 1.0], [1000, 0], [2000, -1.2], [5000, -3.0], [10000, -4.6], [20000, -6.5]] },
  "bk-1974": { name: "B&K 1974 (−1 dB/oct)", kind: "speaker", pts: [[20, 5.6], [100, 3.3], [1000, 0], [10000, -3.3], [20000, -4.3]] },
  flat: { name: "Flat", kind: "any", pts: [[20, 0], [20000, 0]] },
};
function targetCurve(id: string, custom: Measurement | null): Curve {
  if (id === "custom" && custom) return custom.points;
  return (TARGETS[id] ?? TARGETS.flat).pts;
}

// ------------------------------------------------------------------ file formats
/** Frequency-response file: AutoEQ CSV (frequency,raw,…), REW text export, .frd, plain "freq dB" pairs. */
export function parseCurve(text: string): Curve {
  const lines = text.split(/\r?\n/);
  let col = 1;
  const header = lines.find((l) => /[a-z]/i.test(l) && /freq/i.test(l));
  if (header) {
    const h = header.split(/[,;\t]+|\s{2,}/).map((s) => s.trim().toLowerCase());
    const raw = h.findIndex((x) => x === "raw" || x === "spl" || x.startsWith("spl") || x === "db" || x === "magnitude");
    if (raw > 0) col = raw;
  }
  const out: Curve = [];
  for (const l of lines) {
    if (!l.trim() || /^[*#;]/.test(l.trim())) continue;
    const p = l.trim().split(/[,;\t ]+/).map(Number);
    if (p.length > col && isFinite(p[0]) && isFinite(p[col]) && p[0] > 0) out.push([p[0], p[col]]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Equalizer APO / AutoEQ ParametricEQ.txt / our JSON. GraphicEQ lines become a curve to fit. */
export function parseEqFile(text: string): { filters: Filter[]; preamp: number; graphic: Curve | null } {
  const t = text.trim();
  if (t.startsWith("{")) {
    const j = JSON.parse(t);
    const fs: Filter[] = (j.filters ?? []).map((f: Partial<Filter>) => ({ type: f.type ?? "PK", ch: f.ch ?? "ST", freq: f.freq ?? 1000, gain: f.gain ?? 0, q: f.q ?? 1, on: f.on ?? true }));
    return { filters: fs, preamp: j.preamp ?? 0, graphic: null };
  }
  let preamp = 0;
  const filters: Filter[] = [];
  let graphic: Curve | null = null;
  let ch: FChan = "ST";
  for (const raw of t.split(/\r?\n/)) {
    const l = raw.trim();
    const pre = l.match(/^Preamp:\s*(-?[\d.]+)\s*dB/i);
    if (pre) { preamp = parseFloat(pre[1]); continue; }
    const chan = l.match(/^Channel:\s*(.+)$/i);
    if (chan) { const c = chan[1].trim().toUpperCase(); ch = c === "L" ? "L" : c === "R" ? "R" : "ST"; continue; }
    const g = l.match(/^GraphicEQ:\s*(.+)$/i);
    if (g) { graphic = g[1].split(";").map((p) => p.trim().split(/\s+/).map(Number) as [number, number]).filter((p) => p.length === 2 && isFinite(p[0]) && isFinite(p[1])); continue; }
    const m = l.match(/Filter\s*\d*:\s*(ON|OFF)\s+([A-Z]+)(?:\s+Fc\s+([\d.]+)\s*Hz)?(?:\s+Gain\s+(-?[\d.]+)\s*dB)?(?:\s+Q\s+([\d.]+))?/i);
    if (m) {
      const map: Record<string, FType> = { PK: "PK", PEQ: "PK", LS: "LS", LSC: "LS", LSQ: "LS", HS: "HS", HSC: "HS", HSQ: "HS", LP: "LP", LPQ: "LP", HP: "HP", HPQ: "HP", BP: "BP", NO: "NO", AP: "AP" };
      const type = map[m[2].toUpperCase()];
      if (!type) continue;
      filters.push({ type, ch, freq: parseFloat(m[3] ?? "1000"), gain: parseFloat(m[4] ?? "0"), q: parseFloat(m[5] ?? (type === "LS" || type === "HS" ? "0.71" : "0.71")), on: m[1].toUpperCase() === "ON" });
    }
  }
  return { filters, preamp, graphic };
}

function apoText(filters: Filter[], preamp: number): string {
  const lines = [`Preamp: ${round(preamp, 1)} dB`];
  let lastCh: FChan | null = null;
  filters.forEach((f, i) => {
    const ch = f.ch === "L" || f.ch === "R" ? f.ch : "ST";
    if (ch !== lastCh) { lines.push(`Channel: ${ch === "ST" ? "all" : ch}`); lastCh = ch; }
    lines.push(`Filter ${i + 1}: ${f.on ? "ON" : "OFF"} ${f.type} Fc ${round(f.freq, 0)} Hz${hasGain(f.type) ? ` Gain ${round(f.gain, 1)} dB` : ""} Q ${round(f.q, 2)}`);
  });
  return lines.join("\r\n") + "\r\n";
}

async function pickText(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((res) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = accept;
    inp.onchange = async () => {
      const f = inp.files?.[0];
      res(f ? { name: f.name.replace(/\.[^.]+$/, ""), text: await f.text() } : null);
    };
    inp.click();
  });
}
async function saveText(name: string, ext: string, text: string) {
  const p = await saveDialog({ defaultPath: `${name}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (typeof p === "string") { await api.saveTextFile(p, text); toast(`Saved ${p.split(/[\\/]/).pop()}`); }
}

// ------------------------------------------------------------------ AutoEQ fitting
/**
 * Fit peaking/shelf filters so measurement + EQ ≈ target. Works on a smoothed error curve between
 * \`lo\` and \`hi\` Hz: greedy placement at the largest remaining deviation, then coordinate-descent
 * refinement of every filter's frequency, gain and Q.
 */
export function fitFilters(meas: Curve, target: Curve, opts: { bands: number; lo: number; hi: number; maxGain: number; sr: number; shelves: boolean; cutOnlyAbove?: number }): Filter[] {
  const grid = logspace(opts.lo, opts.hi, 160);
  // level-match: align the measurement to the target around 300 Hz – 3 kHz
  const band = grid.filter((g) => g >= 300 && g <= 3000);
  const off = band.reduce((s, g) => s + (at(target, g) - at(meas, g)), 0) / Math.max(1, band.length);
  const sm = smooth(meas.map(([f, d]) => [f, d + off] as [number, number]), 1 / 6);
  const want = grid.map((g) => {
    let e = at(target, g) - at(sm, g);
    if (opts.cutOnlyAbove && g > opts.cutOnlyAbove) e = Math.min(0, e);
    return clamp(e, -opts.maxGain - 6, opts.maxGain);
  });
  const fs: Filter[] = [];
  const err = () => grid.reduce((s, g, i) => { const d = want[i] - response(fs, g, opts.sr); return s + d * d; }, 0);
  if (opts.shelves && opts.bands >= 5) {
    fs.push({ type: "LS", ch: "ST", freq: Math.max(opts.lo * 2, 105), gain: 0, q: 0.7, on: true });
    if (opts.hi > 8000) fs.push({ type: "HS", ch: "ST", freq: Math.min(10000, opts.hi * 0.7), gain: 0, q: 0.7, on: true });
    for (const f of fs) {
      const zone = grid.map((g, i) => [g, want[i]] as const).filter(([g]) => (f.type === "LS" ? g < f.freq * 0.8 : g > f.freq * 1.2));
      f.gain = clamp(zone.reduce((s, [, d]) => s + d, 0) / Math.max(1, zone.length) * 0.8, -opts.maxGain, opts.maxGain);
    }
  }
  while (fs.length < opts.bands) {
    // largest remaining deviation (wider areas weigh more than needle-thin ones)
    const res = grid.map((g, i) => want[i] - response(fs, g, opts.sr));
    let best = -1, bestV = 0;
    for (let i = 2; i < grid.length - 2; i++) {
      const v = (res[i - 2] + res[i - 1] + res[i] + res[i + 1] + res[i + 2]) / 5;
      if (Math.abs(v) > Math.abs(bestV)) { bestV = v; best = i; }
    }
    if (best < 0 || Math.abs(bestV) < 0.15) break;
    // width: where the residual falls to half
    let a = best, b = best;
    while (a > 0 && Math.sign(res[a]) === Math.sign(bestV) && Math.abs(res[a]) > Math.abs(bestV) / 2) a--;
    while (b < grid.length - 1 && Math.sign(res[b]) === Math.sign(bestV) && Math.abs(res[b]) > Math.abs(bestV) / 2) b++;
    const bw = Math.max(0.1, Math.log2(grid[b] / grid[a]));
    const q = clamp(Math.sqrt(Math.pow(2, bw)) / (Math.pow(2, bw) - 1), 0.4, 6);
    fs.push(pk(round(grid[best], 0), clamp(bestV, -opts.maxGain - 6, opts.maxGain), q));
  }
  // refine
  let cur = err();
  for (let it = 0; it < 40; it++) {
    let improved = false;
    for (const f of fs) {
      const steps: [keyof Filter, number][] = [["freq", f.freq * 0.04], ["gain", 0.25], ["q", f.q * 0.08]];
      for (const [k, st] of steps) {
        if (k === "gain" && !hasGain(f.type)) continue;
        for (const dir of [1, -1]) {
          const old = f[k] as number;
          let v = old + dir * st;
          if (k === "freq") v = clamp(v, opts.lo, opts.hi);
          if (k === "gain") v = clamp(v, -opts.maxGain - 6, opts.maxGain);
          if (k === "q") v = clamp(v, f.type === "PK" ? 0.25 : 0.4, 8);
          (f as unknown as Record<string, number>)[k] = v;
          const e = err();
          if (e < cur - 1e-6) { cur = e; improved = true; } else (f as unknown as Record<string, number>)[k] = old;
        }
      }
    }
    if (!improved) break;
  }
  return fs.map((f) => ({ ...f, freq: round(f.freq, 0), gain: round(f.gain, 1), q: round(f.q, 2) })).sort((a, b) => a.freq - b.freq);
}

// ------------------------------------------------------------------ microphone measurement (log sweep)
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Play a log sweep on one side and record it with the microphone; returns the smoothed response. */
async function measureSweep(side: "L" | "R" | "C", onStatus: (s: string) => void): Promise<Curve> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  const ctx = new AudioContext();
  const sr = ctx.sampleRate, T = 5, f1 = 20, f2 = 20000;
  const n = Math.floor(sr * T);
  const sweep = new Float32Array(n);
  const K = (T * 2 * Math.PI * f1) / Math.log(f2 / f1), L = T / Math.log(f2 / f1);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const fade = Math.min(1, i / (sr * 0.05), (n - i) / (sr * 0.05));
    sweep[i] = 0.5 * fade * Math.sin(K * (Math.exp(t / L) - 1));
  }
  const buf = ctx.createBuffer(2, n + sr, sr);
  if (side !== "R") buf.getChannelData(0).set(sweep);
  if (side !== "L") buf.getChannelData(1).set(sweep);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const mic = ctx.createMediaStreamSource(stream);
  const rec = new Float32Array(n + sr * 2);
  let w = 0;
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => { const d = e.inputBuffer.getChannelData(0); const k = Math.min(d.length, rec.length - w); rec.set(d.subarray(0, k), w); w += k; };
  mic.connect(proc);
  proc.connect(ctx.destination);
  onStatus("Measuring… keep quiet");
  await new Promise((r) => window.setTimeout(r, 300));
  src.start();
  await new Promise((r) => window.setTimeout(r, (T + 1.6) * 1000));
  proc.disconnect(); mic.disconnect();
  stream.getTracks().forEach((t) => t.stop());
  await ctx.close();
  onStatus("Analysing…");
  // deconvolve: H = FFT(recording) / FFT(sweep)
  let N = 1;
  while (N < rec.length) N <<= 1;
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  ar.set(rec); br.set(sweep);
  fft(ar, ai); fft(br, bi);
  const curve: Curve = [];
  for (const hz of logspace(20, 20000, 400)) {
    const k = Math.round((hz / sr) * N);
    let p = 0;
    for (let d = -2; d <= 2; d++) {
      const i = Math.max(1, k + d);
      const den = br[i] * br[i] + bi[i] * bi[i] + 1e-12;
      const hr = (ar[i] * br[i] + ai[i] * bi[i]) / den, hi = (ai[i] * br[i] - ar[i] * bi[i]) / den;
      p += hr * hr + hi * hi;
    }
    curve.push([hz, 10 * Math.log10(p / 5 + 1e-20)]);
  }
  const sm = smooth(curve, 1 / 6);
  const ref = at(sm, 1000);
  return sm.map(([f, d]) => [f, d - ref + 75] as [number, number]);
}

// ------------------------------------------------------------------ presets
const PRESET_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "Bass Boost": [6, 5, 3.5, 1.5, 0, 0, 0, 0, 0, 0],
  "Bass Reducer": [-5, -4, -2.5, -1, 0, 0, 0, 0, 0, 0],
  "Treble Boost": [0, 0, 0, 0, 0, 0.5, 1.5, 3, 4.5, 5],
  "Treble Tame": [0, 0, 0, 0, 0, 0, -1, -2, -3, -4],
  "Vocal Presence": [-2, -1, 0, 1, 2, 3, 3, 2, 0, -1],
  "V-Shape": [5, 3.5, 1.5, -1, -2, -2, -1, 1.5, 3.5, 5],
  "Harman-ish": [4, 3.5, 1.5, 0, -0.5, 0, 1, 2, 1, -1],
  Loudness: [5, 4, 1.5, 0, -1, -1, 0, 1, 3, 4],
  Acoustic: [3, 3, 2.5, 1, 1.5, 1.5, 2.5, 3, 2.5, 1.5],
  Classical: [3.5, 3, 2.5, 2, -1, -1, 0, 2, 2.5, 3],
  Dance: [6, 5, 1.5, 0, 0, -3, -2, -1, 3, 1.5],
  Electronic: [4.5, 4, 1, 0, -2, 2, 1, 1, 4, 5],
  "Hip-Hop": [5, 4.5, 1.5, 3, -1, -1, 1.5, -0.5, 2, 3],
  Jazz: [4, 3, 1.5, 2, -1.5, -1.5, 0, 1.5, 3, 4],
  Piano: [3, 2, 0, 2.5, 3, 1.5, 3.5, 4.5, 3, 3.5],
  Pop: [-1.5, -1, 0, 2, 4, 4, 2, 0, -1, -1.5],
  "R&B": [3, 7, 6, 1.5, -2, -1.5, 2.5, 3, 3, 3.5],
  Rock: [5, 4, 3, 1.5, -0.5, -1, 0.5, 2.5, 3.5, 4.5],
  "Small Speakers": [5, 4, 3.5, 2.5, 1, 0, -1, -2, -2.5, -3],
  "Spoken Word": [-3, -1, 0, 0.5, 3.5, 4.5, 4.5, 4, 2, 0],
  "Late Night": [2, 1.5, 0.5, 0, 0, 0, 0, -1, -2.5, -4],
};
const presetAt = (gains: number[], hz: number) => at(PRESET_FREQS.map((f, i) => [f, gains[i]] as [number, number]), hz);

// ------------------------------------------------------------------ turning the studio into engine filters
function legacyFilters(l: Studio["legacy"]): Filter[] {
  const n = clamp(Math.round(l.bands), 3, 31);
  const fs = logspace(clamp(l.minHz, 10, 20000), clamp(l.maxHz, 20, 24000), n);
  const bw = Math.log2(fs[n - 1] / fs[0]) / Math.max(1, n - 1);
  const q = Math.sqrt(Math.pow(2, bw)) / (Math.pow(2, bw) - 1);
  return fs.map((f, i) => pk(round(f, 0), l.gains[i] ?? 0, round(q, 2)));
}

export function activeFilters(s: Studio): { filters: Filter[]; preamp: number } {
  switch (s.mode) {
    case "legacy": return { filters: legacyFilters(s.legacy), preamp: s.legacy.preamp };
    case "parametric": return { filters: s.parametric.filters, preamp: s.parametric.preamp };
    case "autoeq": return { filters: s.autoeq.filters, preamp: s.autoeq.preamp };
    case "speaker": {
      if (s.speaker.layout === "1.0") return { filters: s.speaker.ch.FL.filters.map((f) => ({ ...f, ch: "ST" })), preamp: s.speaker.preamp };
      return { filters: [...s.speaker.ch.FL.filters.map((f) => ({ ...f, ch: "L" as FChan })), ...s.speaker.ch.FR.filters.map((f) => ({ ...f, ch: "R" as FChan }))], preamp: s.speaker.preamp };
    }
  }
}

function pushToEngine(s: Studio) {
  const { filters, preamp } = activeFilters(s);
  const auto = -Math.max(0, peakBoost(filters.filter((f) => f.ch !== "S")));
  const pre = s.autoPreamp ? round(auto, 1) : preamp;
  const bands: EqBand[] = filters.map((f) => ({ freq: f.freq, gainDb: hasGain(f.type) ? f.gain : 0, q: f.q, kind: kindOf(f.type), channel: chanOf(f.ch), enabled: f.on }));
  updateDsp({ eqEnabled: s.enabled, preampDb: pre, bands });
}

// ------------------------------------------------------------------ persistence
let saved: Studio | null = null;
async function loadStudio(): Promise<Studio> {
  if (saved) return saved;
  const raw = await api.getSetting("eqStudio").catch(() => null);
  const d = defaultStudio();
  if (raw) {
    try {
      const j = JSON.parse(raw);
      saved = { ...d, ...j, legacy: { ...d.legacy, ...j.legacy }, parametric: { ...d.parametric, ...j.parametric }, autoeq: { ...d.autoeq, ...j.autoeq }, speaker: { ...d.speaker, ...j.speaker, ch: { ...d.speaker.ch, ...(j.speaker?.ch ?? {}) } }, profiles: { ...d.profiles, ...j.profiles } };
      return saved!;
    } catch { /* fall through */ }
  }
  // first run: start from the current 10-band EQ so nothing changes for existing users
  const dsp = getState().dsp;
  d.enabled = dsp.eqEnabled;
  d.parametric.filters = dsp.bands.map((b) => ({ type: b.kind === "lowshelf" ? "LS" : b.kind === "highshelf" ? "HS" : "PK", ch: "ST", freq: b.freq, gain: b.gainDb, q: b.q, on: true }));
  d.parametric.preamp = dsp.preampDb;
  d.autoPreamp = false;
  saved = d;
  return d;
}
let saveTimer = 0;
function persist(s: Studio) {
  saved = s;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => api.setSetting("eqStudio", JSON.stringify(s)).catch(() => {}), 400);
}

// ------------------------------------------------------------------ UI pieces
const NODE_COLORS = ["#ff6b9d", "#ff9f43", "#feca57", "#1dd1a1", "#48dbfb", "#7f8cff", "#c56cf0", "#ff6b6b", "#10ac84", "#54a0ff"];

function Graph({ studio, onDrag }: { studio: Studio; onDrag?: (i: number, f: Partial<Filter>) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  // draw in real pixels so dots stay round at any width
  const [W, setW] = useState(1000);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(300, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 230, PADL = 34, PADB = 22;
  const fx = (f: number) => PADL + (Math.log(f / 20) / Math.log(1000)) * (W - PADL - 6);
  const xf = (x: number) => 20 * Math.pow(1000, (x - PADL) / (W - PADL - 6));
  const mode = studio.mode;
  const measured = mode === "autoeq" || mode === "speaker";
  const { filters } = activeFilters(studio);
  const grid = logspace(20, 20000, 240);
  // curves for measurement modes
  let original: Curve | null = null, target: Curve | null = null, corrected: Curve | null = null, marks: { f: number; label: string; cls: string }[] = [];
  if (mode === "autoeq") {
    const a = studio.autoeq;
    target = targetCurve(a.target, a.customTarget).map(([f, d]) => [f, d + 75] as [number, number]);
    if (a.measurement) {
      const band = grid.filter((g) => g >= 300 && g <= 3000);
      const off = band.reduce((s, g) => s + at(target!, g) - at(a.measurement!.points, g), 0) / band.length;
      original = smooth(a.measurement.points.map(([f, d]) => [f, d + off] as [number, number]), 1 / 12, grid);
      corrected = original.map(([f, d]) => [f, d + response(a.filters, f)] as [number, number]);
    }
  } else if (mode === "speaker") {
    const sp = studio.speaker;
    const ch = sp.ch[sp.channel];
    target = targetCurve(sp.target, sp.customTarget).map(([f, d]) => [f, d + 75] as [number, number]);
    if (ch.measurement) {
      const band = grid.filter((g) => g >= 300 && g <= 3000);
      const off = band.reduce((s, g) => s + at(target!, g) - at(ch.measurement!.points, g), 0) / band.length;
      original = smooth(ch.measurement.points.map(([f, d]) => [f, d + off] as [number, number]), 1 / 12, grid);
      corrected = original.map(([f, d]) => [f, d + response(ch.filters, f)] as [number, number]);
    }
    marks = [{ f: sp.bassLimit, label: `${fmtHz(sp.bassLimit)} Hz`, cls: "bass" }, { f: sp.roomLimit, label: `${fmtHz(sp.roomLimit)} Hz`, cls: "room" }];
  }
  let lo = -16, hi = 16;
  if (measured) {
    const all = [original, target, corrected].filter(Boolean).flatMap((c) => c!.filter(([f]) => f >= 20 && f <= 20000).map(([, d]) => d));
    lo = Math.floor((Math.min(...all, 60) - 2) / 5) * 5; hi = Math.ceil((Math.max(...all, 88) + 2) / 5) * 5;
  }
  const gy = (g: number) => 8 + ((hi - g) / (hi - lo)) * (H - PADB - 16);
  const yg = (y: number) => hi - ((y - 8) / (H - PADB - 16)) * (hi - lo);
  const path = (c: Curve) => c.filter(([f]) => f >= 20 && f <= 20000).map(([f, d], i) => `${i ? "L" : "M"}${fx(f).toFixed(1)},${gy(d).toFixed(1)}`).join("");
  const eqCurve: Curve = grid.map((f) => [f, response(filters, f)]);
  const yTicks: number[] = [];
  const step = measured ? 5 : 5;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) yTicks.push(v);
  const move = (e: React.PointerEvent) => {
    if (drag === null || !onDrag) return;
    const r = ref.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    const f = filters[drag];
    onDrag(drag, { freq: round(clamp(xf(x), 10, 22000), 0), ...(hasGain(f.type) ? { gain: round(clamp(yg(y), -24, 24), 1) } : {}) });
  };
  return (
    <svg ref={ref} className="eqs-graph" viewBox={`0 0 ${W} ${H}`} onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
      {mode === "speaker" && (
        <>
          <rect x={PADL} y={8} width={Math.max(0, fx(studio.speaker.bassLimit) - PADL)} height={H - PADB - 16} className="eqs-zone bass" />
          <rect x={fx(studio.speaker.roomLimit)} y={8} width={Math.max(0, W - 6 - fx(studio.speaker.roomLimit))} height={H - PADB - 16} className="eqs-zone room" />
        </>
      )}
      {[20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].map((f) => (
        <g key={f}><line x1={fx(f)} x2={fx(f)} y1={8} y2={H - PADB - 8} className="eqs-grid" /><text x={fx(f)} y={H - 6} className="eqs-axis" textAnchor="middle">{fmtHz(f)}</text></g>
      ))}
      {yTicks.map((v) => (
        <g key={v}><line x1={PADL} x2={W - 6} y1={gy(v)} y2={gy(v)} className={`eqs-grid ${!measured && v === 0 ? "zero" : ""}`} /><text x={PADL - 6} y={gy(v) + 4} className="eqs-axis" textAnchor="end">{v}</text></g>
      ))}
      {marks.map((m) => <g key={m.cls}><line x1={fx(m.f)} x2={fx(m.f)} y1={8} y2={H - PADB - 8} className={`eqs-mark ${m.cls}`} /><text x={fx(m.f)} y={20} className={`eqs-mark-label ${m.cls}`} textAnchor="middle">{m.label}</text></g>)}
      {measured ? (
        <>
          {target && <path d={path(target)} className="eqs-line target" />}
          {original && <path d={path(original)} className="eqs-line original" />}
          {corrected && <path d={path(corrected)} className="eqs-line corrected" />}
        </>
      ) : (
        <>
          <path d={path(eqCurve)} className="eqs-line eq" />
          {filters.map((f, i) => (
            <circle key={i} cx={fx(clamp(f.freq, 20, 20000))} cy={gy(hasGain(f.type) ? clamp(f.gain, lo, hi) : 0)} r={drag === i ? 9 : 7}
              className={`eqs-node ${f.on ? "" : "off"}`} style={{ fill: NODE_COLORS[i % NODE_COLORS.length] }}
              onPointerDown={(e) => { if (!onDrag) return; (e.target as Element).setPointerCapture?.(e.pointerId); setDrag(i); }}
              onWheel={(e) => onDrag?.(i, { q: round(clamp(f.q * (e.deltaY < 0 ? 1.1 : 0.9), 0.1, 20), 2) })}>
              <title>{`${i + 1}: ${f.type} ${fmtHz(f.freq)} Hz ${hasGain(f.type) ? `${f.gain} dB ` : ""}Q ${f.q}`}</title>
            </circle>
          ))}
        </>
      )}
    </svg>
  );
}

function Range({ value, min, max, step, log, onChange }: { value: number; min: number; max: number; step?: number; log?: boolean; onChange: (v: number) => void }) {
  const to = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const from = (t: number) => (log ? min * Math.pow(max / min, t) : min + (max - min) * t);
  return (
    <input type="range" className="eqs-range" min={0} max={1000} value={Math.round(clamp(to(value), 0, 1) * 1000)}
      onChange={(e) => { let v = from(Number(e.target.value) / 1000); if (step) v = Math.round(v / step) * step; onChange(v); }} />
  );
}

function FilterRows({ filters, onChange, colors = true }: { filters: Filter[]; onChange: (fs: Filter[]) => void; colors?: boolean }) {
  const set = (i: number, p: Partial<Filter>) => onChange(filters.map((f, k) => (k === i ? { ...f, ...p } : f)));
  return (
    <div className="eqs-filters">
      {filters.length === 0 && <p className="muted small">No filters yet.</p>}
      {filters.map((f, i) => (
        <div key={i} className={`eqs-filter ${f.on ? "" : "off"}`}>
          <div className="eqs-f-head">
            <button className="eqs-idx" title={f.on ? "Turn this filter off" : "Turn this filter on"} onClick={() => set(i, { on: !f.on })} style={colors ? { color: NODE_COLORS[i % NODE_COLORS.length] } : undefined}>{i + 1}</button>
            <select className="eqs-sel" value={f.type} title="Filter type" onChange={(e) => set(i, { type: e.target.value as FType })}>
              {TYPES.map((t) => <option key={t.v} value={t.v} title={t.label}>{t.v}</option>)}
            </select>
            <select className="eqs-sel" value={f.ch} title="Channel: ST = both, L/R, M = mid (centre), S = side (width)" onChange={(e) => set(i, { ch: e.target.value as FChan })}>
              {CHANS.map((c) => <option key={c.v} value={c.v} title={c.label}>{c.v}</option>)}
            </select>
          </div>
          <label className="eqs-param"><span>FREQ <b>{fmtHz(f.freq)} Hz</b></span><Range value={f.freq} min={10} max={22000} log onChange={(v) => set(i, { freq: round(v, 0) })} /></label>
          <label className={`eqs-param ${hasGain(f.type) ? "" : "na"}`}><span>GAIN <b>{hasGain(f.type) ? `${f.gain > 0 ? "+" : ""}${f.gain.toFixed(1)} dB` : "—"}</b></span><Range value={f.gain} min={-24} max={24} step={0.1} onChange={(v) => set(i, { gain: round(v, 1) })} /></label>
          <label className="eqs-param"><span>Q <b>{f.q.toFixed(2)}</b></span><Range value={f.q} min={0.1} max={20} log onChange={(v) => set(i, { q: round(v, 2) })} /></label>
        </div>
      ))}
    </div>
  );
}

function FilterBank({ title, filters, onChange, defaults, children }: { title: string; filters: Filter[]; onChange: (fs: Filter[]) => void; defaults: () => Filter[]; children?: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="eqs-card">
      <button className="eqs-card-head" onClick={() => setOpen(!open)}><span>{title}</span><Icon name={open ? "up" : "down"} size={14} /></button>
      {open && (
        <div className="eqs-card-body">
          {children}
          <div className="eqs-row eqs-tools">
            <button className="btn small" onClick={async () => {
              const f = await pickText(".txt,.json,.cfg");
              if (!f) return;
              try { const p = parseEqFile(f.text); if (!p.filters.length) throw new Error("no filters found"); onChange(p.filters); toast(`Imported ${p.filters.length} filters`); } catch (e) { toast(`Couldn't read that file: ${e}`); }
            }}>Import</button>
            <button className="btn small" onClick={() => saveText("DriftKord EQ", "txt", apoText(filters, 0))}>Export</button>
            <span className="grow" />
            <button className="btn small" onClick={() => {
              const last = filters[filters.length - 1];
              onChange([...filters, pk(last ? clamp(round(last.freq * 1.6, 0), 20, 20000) : 1000)]);
            }}>+ Add Band</button>
            <button className="btn small" disabled={!filters.length} onClick={() => onChange(filters.slice(0, -1))}>− Remove Band</button>
            <button className="btn small" onClick={() => onChange(defaults())}>Reset</button>
          </div>
          <FilterRows filters={filters} onChange={onChange} />
        </div>
      )}
    </section>
  );
}

function Profiles({ list, onSave, onLoad, onDelete }: { list: Profile[]; onSave: (name: string) => void; onLoad: (p: Profile) => void; onDelete: (i: number) => void }) {
  const [name, setName] = useState("");
  const [open, setOpen] = useState(true);
  return (
    <section className="eqs-card">
      <div className="eqs-card-head as-row">
        <button className="eqs-head-btn" onClick={() => setOpen(!open)}><span>SAVED PROFILES</span><span className="eqs-count">{list.length}</span></button>
        <span className="grow" />
        <input className="eqs-input small" placeholder="Profile name…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { onSave(name.trim()); setName(""); } }} />
        <button className="btn small primary" disabled={!name.trim()} onClick={() => { onSave(name.trim()); setName(""); }}>Save</button>
        <button className="eqs-head-btn" onClick={() => setOpen(!open)} aria-label="Show or hide profiles"><Icon name={open ? "up" : "down"} size={14} /></button>
      </div>
      {open && list.length > 0 && (
        <div className="eqs-profiles">
          {list.map((p, i) => (
            <div key={i} className="eqs-profile">
              <button className="eqs-profile-load" onClick={() => onLoad(p)} title="Load this profile">{p.name}<small>{p.filters.length} filters</small></button>
              <button className="btn small ghost" onClick={() => onDelete(i)} aria-label={`Delete ${p.name}`}>✕</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Select<T extends string | number>({ value, options, onChange, className }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <select className={`eqs-select ${className ?? ""}`} value={String(value)} onChange={(e) => onChange((typeof value === "number" ? Number(e.target.value) : e.target.value) as T)}>
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
}

// ------------------------------------------------------------------ main
const HELP: Record<Mode, string> = {
  legacy: "A classic graphic equalizer. Choose how many bands and the frequency range; each slider boosts or cuts around its frequency. Export APO writes an Equalizer APO config.",
  parametric: "Free filters. Type: PK peak, LS/HS shelves, LP/HP pass, BP band-pass, NO notch, AP all-pass. Channel: ST both, L or R only, M mid (centre: vocals, bass) or S side (stereo width). Drag the dots on the graph (mouse wheel changes Q).",
  autoeq: "Correct your headphones. Upload a frequency-response measurement of your headphones (CSV or text: frequency and dB, e.g. from AutoEQ's GitHub results, Squiglink or REW), choose a target, then press AutoEq. You can also import a ready-made EQ (Equalizer APO / ParametricEQ.txt / GraphicEQ.txt). No headphone database is bundled.",
  speaker: "Room correction for speakers. Import a measurement per channel (REW text export, CSV) or measure with a microphone at your listening position (uses the default Windows output — pause playback and use WASAPI Shared while measuring). Corrections are applied only between the bass limit and the room limit, where rooms cause the biggest problems; above the room limit only cuts are used.",
};

export function EqStudio() {
  const [s, setS] = useState<Studio | null>(saved);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState("");
  const dsp = useStore((x) => x.dsp);
  useEffect(() => { if (!s) loadStudio().then(setS); }, []);
  const update = (patch: Partial<Studio> | ((x: Studio) => Studio)) => {
    setS((prev) => {
      if (!prev) return prev;
      const next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
      persist(next);
      pushToEngine(next);
      return next;
    });
  };
  const autoPre = useMemo(() => (s ? -Math.max(0, peakBoost(activeFilters(s).filters)) : 0), [s]);
  if (!s) return <div className="eqs muted">Loading EQ Studio…</div>;
  const mode = s.mode;
  const preamp = s.autoPreamp ? round(autoPre, 1) : activeFilters(s).preamp;
  const setPreamp = (v: number) => update((x) => {
    const n = structuredClone(x);
    if (n.mode === "legacy") n.legacy.preamp = v; else if (n.mode === "parametric") n.parametric.preamp = v; else if (n.mode === "autoeq") n.autoeq.preamp = v; else n.speaker.preamp = v;
    n.autoPreamp = false;
    return n;
  });

  const legend = mode === "autoeq" || mode === "speaker";
  return (
    <div className="eqs">
      <div className="eqs-top">
        <div>
          <div className="eqs-title">EQ Studio</div>
          <div className="eqs-sub">Multi-mode equalizer with AutoEQ, M/S processing &amp; room correction</div>
        </div>
        <Toggle on={s.enabled} onChange={(v) => update({ enabled: v })} />
      </div>
      <div className={`eqs-body ${s.enabled ? "" : "disabled"}`}>
        <div className="eqs-tabs-row">
          <div className="eqs-tabs" role="tablist">
            {([["legacy", "Legacy EQ"], ["parametric", "Parametric EQ"], ["autoeq", "AutoEQ"], ["speaker", "Speaker EQ"]] as [Mode, string][]).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={mode === id} className={mode === id ? "on" : ""} onClick={() => update({ mode: id })}>{label}</button>
            ))}
          </div>
          <button className={`eqs-help ${help ? "on" : ""}`} onClick={() => setHelp(!help)} aria-label="Help">?</button>
        </div>
        {help && <div className="eqs-helptext">{HELP[mode]}</div>}

        {mode !== "legacy" && (
          <>
            <div className="eqs-graph-head">
              <span>FREQUENCY RESPONSE</span>
              {legend && <span className="eqs-legend"><i className="original" />Original <i className="target" />Target (Primary) <i className="corrected" />Corrected</span>}
            </div>
            <Graph studio={s} onDrag={mode === "parametric" ? (i, p) => update((x) => ({ ...x, parametric: { ...x.parametric, preset: "Custom", filters: x.parametric.filters.map((f, k) => (k === i ? { ...f, ...p } : f)) } })) : undefined} />
            <div className="eqs-row eqs-pre">
              <b>Preamp</b>
              <Range value={preamp} min={-24} max={12} step={0.1} onChange={setPreamp} />
              <span className="eqs-val">{preamp > 0 ? "+" : ""}{round(preamp, 1)} dB</span>
              <span className="grow" />
              <span className="muted small">Auto Preamp Compensation</span>
              <Toggle on={s.autoPreamp} onChange={(v) => update({ autoPreamp: v })} />
            </div>
          </>
        )}

        {mode === "legacy" && <LegacyPanel s={s} update={update} />}
        {mode === "parametric" && <ParametricPanel s={s} update={update} />}
        {mode === "autoeq" && <AutoEqPanel s={s} update={update} busy={busy} setBusy={setBusy} />}
        {mode === "speaker" && <SpeakerPanel s={s} update={update} busy={busy} setBusy={setBusy} />}
        {!s.enabled && <p className="muted small eqs-off-note">EQ Studio is off — the signal passes untouched (bit-perfect). Turn it on with the switch above.</p>}
        {s.enabled && dsp.bands.length > 0 && <p className="muted small">Playing: {mode === "legacy" ? "Legacy EQ" : mode === "parametric" ? "Parametric EQ" : mode === "autoeq" ? "AutoEQ" : "Speaker EQ"} · {dsp.bands.filter((b) => b.enabled !== false).length} filters · preamp {dsp.preampDb.toFixed(1)} dB</p>}
      </div>
    </div>
  );
}

type Upd = (patch: Partial<Studio> | ((x: Studio) => Studio)) => void;

function LegacyPanel({ s, update }: { s: Studio; update: Upd }) {
  const l = s.legacy;
  const n = clamp(Math.round(l.bands), 3, 31);
  const freqs = logspace(clamp(l.minHz, 10, 20000), clamp(l.maxHz, 20, 24000), n);
  const set = (p: Partial<Studio["legacy"]>) => update((x) => ({ ...x, legacy: { ...x.legacy, ...p } }));
  const resize = (bands: number, minHz = l.minHz, maxHz = l.maxHz) => {
    const old = legacyFilters(l);
    const nf = logspace(minHz, maxHz, clamp(bands, 3, 31));
    set({ bands, minHz, maxHz, gains: nf.map((f) => round(at(old.map((o) => [o.freq, o.gain] as [number, number]), f), 1)) });
  };
  const allPresets = { ...PRESETS, ...l.custom };
  return (
    <div className="eqs-legacy">
      <div className="eqs-row wrap">
        <label className="eqs-lbl">Bands <input className="eqs-input num" type="number" min={3} max={31} value={l.bands} onChange={(e) => resize(Number(e.target.value) || 10)} /></label>
        <label className="eqs-lbl">Min Hz <input className="eqs-input num" type="number" min={10} max={1000} value={l.minHz} onChange={(e) => resize(l.bands, clamp(Number(e.target.value) || 25, 10, 1000))} /></label>
        <label className="eqs-lbl">Max Hz <input className="eqs-input num" type="number" min={2000} max={24000} value={l.maxHz} onChange={(e) => resize(l.bands, l.minHz, clamp(Number(e.target.value) || 20000, 2000, 24000))} /></label>
      </div>
      <div className="eqs-row">
        <b>Preset</b>
        <Select className="grow" value={l.preset} options={[{ value: "Custom", label: "Custom" }, ...Object.keys(allPresets).map((k) => ({ value: k, label: k }))]}
          onChange={(k) => { const g = allPresets[k]; if (g) set({ preset: k, gains: freqs.map((f) => round(g.length === n && l.custom[k] ? g[freqs.indexOf(f)] : presetAt(g, f), 1)) }); else set({ preset: k }); }} />
        <button className="btn small" onClick={() => {
          const name = prompt("Preset name", "My preset");
          if (name) set({ custom: { ...l.custom, [name]: freqs.map((f) => at(freqs.map((ff, i) => [ff, l.gains[i] ?? 0] as [number, number]), f)) }, preset: name });
        }}>Save</button>
      </div>
      <div className="eqs-sliders" style={{ ["--n" as string]: n }}>
        {freqs.map((f, i) => (
          <div key={i} className="eqs-vs">
            <span className="eqs-vs-val">{(l.gains[i] ?? 0).toFixed(1)}</span>
            <input type="range" className="eqs-vrange" min={-120} max={120} value={Math.round((l.gains[i] ?? 0) * 10)} aria-label={`${fmtHz(f)} Hz`}
              onChange={(e) => { const g = [...l.gains]; while (g.length < n) g.push(0); g[i] = Number(e.target.value) / 10; set({ gains: g, preset: "Custom" }); }} />
            <span className="eqs-vs-f">{fmtHz(f).toUpperCase()}</span>
          </div>
        ))}
      </div>
      <div className="eqs-row wrap">
        <b>Preamp</b>
        <Range value={s.autoPreamp ? round(-Math.max(0, peakBoost(legacyFilters(l))), 1) : l.preamp} min={-24} max={12} step={0.1} onChange={(v) => update((x) => ({ ...x, autoPreamp: false, legacy: { ...x.legacy, preamp: round(v, 1) } }))} />
        <span className="eqs-val">{(s.autoPreamp ? round(-Math.max(0, peakBoost(legacyFilters(l))), 1) : l.preamp)} dB</span>
        <span className="grow" />
        <button className="btn small" onClick={() => set({ gains: Array(n).fill(0), preamp: 0, preset: "Flat" })}>Reset</button>
        <button className="btn small" onClick={async () => {
          const f = await pickText(".txt,.json");
          if (!f) return;
          const p = parseEqFile(f.text);
          const curve: Curve = p.graphic ?? freqs.map((ff) => [ff, response(p.filters, ff)]);
          set({ gains: freqs.map((ff) => round(at(curve, ff), 1)), preamp: p.preamp, preset: "Custom" });
          toast("Imported");
        }}>Import</button>
        <button className="btn small" onClick={() => saveText("DriftKord graphic EQ", "json", JSON.stringify({ kind: "driftkord-graphic-eq", bands: n, minHz: l.minHz, maxHz: l.maxHz, gains: l.gains.slice(0, n), preamp: l.preamp }, null, 2))}>Export</button>
        <button className="btn small" onClick={() => saveText("config", "txt", apoText(legacyFilters(l), l.preamp))}>Export APO</button>
      </div>
      <div className="eqs-row wrap"><span className="muted small">Auto Preamp Compensation</span><Toggle on={s.autoPreamp} onChange={(v) => update({ autoPreamp: v })} /></div>
    </div>
  );
}

function ParametricPanel({ s, update }: { s: Studio; update: Upd }) {
  const p = s.parametric;
  const setFilters = (filters: Filter[]) => update((x) => ({ ...x, parametric: { ...x.parametric, filters, preset: "Custom" } }));
  return (
    <section className="eqs-card">
      <div className="eqs-card-head static"><span>PARAMETRIC EQ FILTERS</span></div>
      <div className="eqs-card-body">
        <label className="eqs-lbl col">PRESET
          <Select value={p.preset} options={[{ value: "Custom", label: "Custom" }, ...Object.keys(PRESETS).map((k) => ({ value: k, label: k }))]}
            onChange={(k) => {
              const g = PRESETS[k];
              if (!g) return update((x) => ({ ...x, parametric: { ...x.parametric, preset: k } }));
              const fs: Filter[] = PRESET_FREQS.map((f, i) => ({ type: i === 0 ? "LS" : i === 9 ? "HS" : "PK", ch: "ST", freq: f, gain: g[i], q: i === 0 || i === 9 ? 0.71 : 1.41, on: true }));
              update((x) => ({ ...x, parametric: { ...x.parametric, filters: fs, preset: k } }));
            }} />
        </label>
        <Profiles list={s.profiles.parametric}
          onSave={(name) => update((x) => ({ ...x, profiles: { ...x.profiles, parametric: [...x.profiles.parametric.filter((q) => q.name !== name), { name, filters: x.parametric.filters, preamp: x.parametric.preamp }] } }))}
          onLoad={(pr) => update((x) => ({ ...x, parametric: { ...x.parametric, filters: pr.filters, preamp: pr.preamp, preset: "Custom" } }))}
          onDelete={(i) => update((x) => ({ ...x, profiles: { ...x.profiles, parametric: x.profiles.parametric.filter((_, k) => k !== i) } }))} />
        <FilterBank title="FILTERS" filters={p.filters} onChange={setFilters} defaults={() => defaultStudio().parametric.filters} />
      </div>
    </section>
  );
}

function AutoEqPanel({ s, update, busy, setBusy }: { s: Studio; update: Upd; busy: string; setBusy: (b: string) => void }) {
  const a = s.autoeq;
  const set = (p: Partial<Studio["autoeq"]>) => update((x) => ({ ...x, autoeq: { ...x.autoeq, ...p } }));
  const run = () => {
    if (!a.measurement) { toast("Upload your headphone measurement first"); return; }
    setBusy("Fitting filters…");
    window.setTimeout(() => {
      const fs = fitFilters(a.measurement!.points, targetCurve(a.target, a.customTarget), { bands: a.bands, lo: 20, hi: a.maxHz, maxGain: 12, sr: a.sampleRate, shelves: true });
      set({ filters: fs });
      setBusy("");
      toast(`AutoEQ: ${fs.length} filters`);
    }, 30);
  };
  return (
    <>
      <button className="eqs-big" onClick={run} disabled={!!busy}>{busy || "AutoEq"}</button>
      <section className="eqs-card">
        <div className="eqs-card-head static"><span>YOUR HEADPHONES</span><span className="muted small">no built-in database — upload your own</span></div>
        <div className="eqs-card-body">
          <label className="eqs-lbl col">HEADPHONE MODEL
            <input className="eqs-input" placeholder="e.g. Sony WH-1000XM5 (your label for this profile)" value={a.model} onChange={(e) => set({ model: e.target.value })} />
          </label>
          <div className="eqs-row wrap">
            <div className="eqs-file grow">{a.measurement ? <><Icon name="eq" size={14} /> {a.measurement.name} <small>({a.measurement.points.length} points)</small></> : <span className="muted">No measurement</span>}</div>
            <button className="btn small" onClick={async () => {
              const f = await pickText(".csv,.txt,.frd");
              if (!f) return;
              const pts = parseCurve(f.text);
              if (pts.length < 10) { toast("That file doesn't look like a frequency response (need frequency + dB columns)"); return; }
              set({ measurement: { name: f.name, points: pts }, model: a.model || f.name });
            }}>Upload measurement</button>
            <button className="btn small" title="Use an EQ you already have (Equalizer APO / ParametricEQ.txt / GraphicEQ.txt / JSON)" onClick={async () => {
              const f = await pickText(".txt,.json,.cfg");
              if (!f) return;
              const p = parseEqFile(f.text);
              if (p.graphic && !p.filters.length) {
                // GraphicEQ: fit parametric filters to it
                const fs = fitFilters(p.graphic.map(([hz]) => [hz, 0] as [number, number]), p.graphic, { bands: a.bands, lo: 20, hi: 20000, maxGain: 15, sr: a.sampleRate, shelves: true });
                set({ filters: fs, preamp: p.preamp, model: a.model || f.name });
              } else if (p.filters.length) set({ filters: p.filters, preamp: p.preamp, model: a.model || f.name });
              else { toast("No EQ found in that file"); return; }
              toast("Imported your EQ");
            }}>Import EQ</button>
            {a.measurement && <button className="btn small ghost" onClick={() => set({ measurement: null })}>Clear</button>}
          </div>
          <label className="eqs-lbl col"><span>TARGET <span className="muted small">· import custom with the button →</span></span>
            <div className="eqs-row">
              <Select className="grow" value={a.target} options={[...Object.entries(TARGETS).map(([k, t]) => ({ value: k, label: t.name })), ...(a.customTarget ? [{ value: "custom", label: `Custom: ${a.customTarget.name}` }] : [])]} onChange={(v) => set({ target: v })} />
              <button className="btn small" title="Import a custom target curve (frequency, dB)" onClick={async () => {
                const f = await pickText(".csv,.txt");
                if (!f) return;
                const pts = parseCurve(f.text);
                if (pts.length < 5) { toast("Couldn't read that target"); return; }
                set({ customTarget: { name: f.name, points: pts }, target: "custom" });
              }}><Icon name="import" size={14} /></button>
            </div>
          </label>
          <div className="eqs-grid3">
            <label className="eqs-lbl col">FILTER BANDS <Select value={a.bands} options={[5, 6, 8, 10, 12, 15, 20].map((v) => ({ value: v, label: String(v) }))} onChange={(v) => set({ bands: v })} /></label>
            <label className="eqs-lbl col">MAX HZ <Select value={a.maxHz} options={[8000, 10000, 12000, 16000, 20000].map((v) => ({ value: v, label: fmtHz(v) }))} onChange={(v) => set({ maxHz: v })} /></label>
            <label className="eqs-lbl col">SAMPLE RATE <Select value={a.sampleRate} options={[44100, 48000, 88200, 96000, 192000].map((v) => ({ value: v, label: `${v / 1000}k` }))} onChange={(v) => set({ sampleRate: v })} /></label>
          </div>
        </div>
      </section>
      <Profiles list={s.profiles.autoeq}
        onSave={(name) => update((x) => ({ ...x, profiles: { ...x.profiles, autoeq: [...x.profiles.autoeq.filter((q) => q.name !== name), { name, filters: x.autoeq.filters, preamp: x.autoeq.preamp, extra: { measurement: x.autoeq.measurement, target: x.autoeq.target, model: x.autoeq.model } }] } }))}
        onLoad={(pr) => update((x) => ({ ...x, autoeq: { ...x.autoeq, filters: pr.filters, preamp: pr.preamp, ...((pr.extra as Partial<Studio["autoeq"]>) ?? {}) } }))}
        onDelete={(i) => update((x) => ({ ...x, profiles: { ...x.profiles, autoeq: x.profiles.autoeq.filter((_, k) => k !== i) } }))} />
      <FilterBank title="PARAMETRIC EQ FILTERS" filters={a.filters} onChange={(filters) => set({ filters })} defaults={() => []} />
    </>
  );
}

function SpeakerPanel({ s, update, busy, setBusy }: { s: Studio; update: Upd; busy: string; setBusy: (b: string) => void }) {
  const sp = s.speaker;
  const chans: ("FL" | "FR")[] = sp.layout === "1.0" ? ["FL"] : ["FL", "FR"];
  const cur = sp.ch[sp.channel] ?? sp.ch.FL;
  const set = (p: Partial<Studio["speaker"]>) => update((x) => ({ ...x, speaker: { ...x.speaker, ...p } }));
  const setCh = (c: "FL" | "FR", p: Partial<SpeakerChannel>) => update((x) => ({ ...x, speaker: { ...x.speaker, ch: { ...x.speaker.ch, [c]: { ...x.speaker.ch[c], ...p } } } }));
  const fit = (c: "FL" | "FR", st = s): Filter[] | null => {
    const m = st.speaker.ch[c].measurement;
    if (!m) return null;
    return fitFilters(m.points, targetCurve(st.speaker.target, st.speaker.customTarget), { bands: st.speaker.bands, lo: st.speaker.bassLimit, hi: Math.max(st.speaker.roomLimit, st.speaker.bassLimit * 2), maxGain: 6, sr: 48000, shelves: false, cutOnlyAbove: st.speaker.roomLimit });
  };
  const measure = async (c: "FL" | "FR") => {
    setBusy(`Measuring ${c}…`);
    try {
      const pts = await measureSweep(sp.layout === "1.0" ? "C" : c === "FL" ? "L" : "R", setBusy);
      setCh(c, { measurement: { name: `Mic measurement ${c} · ${new Date().toLocaleTimeString()}`, points: pts } });
    } catch (e) {
      toast(`Measurement failed: ${e instanceof Error ? e.message : e}. Allow microphone access and try again.`);
    } finally { setBusy(""); }
  };
  return (
    <>
      <div className="eqs-row wrap">
        <Select value={sp.layout} options={[{ value: "2.0", label: "2.0 Stereo" }, { value: "1.0", label: "1.0 Mono" }]} onChange={(v) => set({ layout: v, channel: "FL" })} />
        <button className="btn small" onClick={() => saveText("DriftKord speaker EQ", "json", JSON.stringify({ kind: "driftkord-speaker-eq", ...sp }, null, 2))}>Export JSON</button>
        <button className="btn small" onClick={async () => {
          const f = await pickText(".json");
          if (!f) return;
          try { const j = JSON.parse(f.text); if (j.kind !== "driftkord-speaker-eq") throw new Error("not a DriftKord speaker EQ file"); const { kind: _k, ...rest } = j; void _k; set(rest); toast("Imported"); } catch (e) { toast(String(e)); }
        }}>Import JSON</button>
      </div>
      <div className="eqs-chans">
        {chans.map((c) => <button key={c} className={sp.channel === c ? "on" : ""} onClick={() => set({ channel: c })}>{c}</button>)}
      </div>
      <section className="eqs-card">
        <div className="eqs-card-body">
          <div className="eqs-grid2">
            <label className="eqs-lbl col"><span className="eqs-k">MEASUREMENT</span>
              <div className="eqs-row">
                <div className="eqs-file grow">{cur.measurement ? cur.measurement.name : <span className="muted">No measurement</span>}</div>
                <button className="btn small icon" title="Measure with a microphone" disabled={!!busy} onClick={() => measure(sp.channel)}><Icon name="mic" size={14} /></button>
                <button className="btn small icon" title="Import a measurement (REW text export, CSV, FRD)" onClick={async () => {
                  const f = await pickText(".txt,.csv,.frd");
                  if (!f) return;
                  const pts = parseCurve(f.text);
                  if (pts.length < 10) { toast("That file doesn't look like a measurement"); return; }
                  setCh(sp.channel, { measurement: { name: f.name, points: pts } });
                }}><Icon name="import" size={14} /></button>
              </div>
            </label>
            <label className="eqs-lbl col"><span className="eqs-k">TARGET</span>
              <div className="eqs-row">
                <Select className="grow" value={sp.target} options={[...Object.entries(TARGETS).filter(([, t]) => t.kind !== "headphone").map(([k, t]) => ({ value: k, label: t.name })), ...(sp.customTarget ? [{ value: "custom", label: `Custom: ${sp.customTarget.name}` }] : [])]} onChange={(v) => set({ target: v })} />
                <button className="btn small icon" title="Import a custom target" onClick={async () => {
                  const f = await pickText(".csv,.txt");
                  if (!f) return;
                  const pts = parseCurve(f.text);
                  if (pts.length >= 5) set({ customTarget: { name: f.name, points: pts }, target: "custom" });
                }}><Icon name="import" size={14} /></button>
              </div>
            </label>
          </div>
          <div className="eqs-grid4">
            <label className="eqs-lbl col"><span className="eqs-k">BANDS</span><Select value={sp.bands} options={[4, 6, 8, 10, 12, 16].map((v) => ({ value: v, label: String(v) }))} onChange={(v) => set({ bands: v })} /></label>
            <label className="eqs-lbl col"><span className="eqs-k bass">BASS LIMIT <b>{sp.bassLimit} Hz</b></span><Range value={sp.bassLimit} min={15} max={120} step={1} log onChange={(v) => set({ bassLimit: Math.round(v) })} /></label>
            <label className="eqs-lbl col"><span className="eqs-k room">ROOM LIMIT <b>{sp.roomLimit} Hz</b></span><Range value={sp.roomLimit} min={150} max={2000} step={10} log onChange={(v) => set({ roomLimit: Math.round(v / 10) * 10 })} /></label>
            <label className="eqs-lbl col"><span className="eqs-k">PREAMP <b>{s.autoPreamp ? "auto" : `${sp.preamp} dB`}</b></span><Range value={sp.preamp} min={-24} max={6} step={0.1} onChange={(v) => update((x) => ({ ...x, autoPreamp: false, speaker: { ...x.speaker, preamp: round(v, 1) } }))} /></label>
          </div>
          <div className="eqs-row">
            <button className="eqs-big grow" disabled={!cur.measurement || !!busy} onClick={() => { const fs = fit(sp.channel); if (fs) { setCh(sp.channel, { filters: fs }); toast(`${sp.channel}: ${fs.length} filters`); } }}>{busy || "AutoEQ"}</button>
            <button className="btn small" disabled={!!busy} onClick={() => update((x) => {
              const n = structuredClone(x);
              for (const c of chans) { const fs = fit(c, n); if (fs) n.speaker.ch[c].filters = fs; }
              return n;
            })}>AutoEQ All</button>
            <button className="btn small" disabled={!!busy} onClick={async () => { for (const c of chans) await measure(c); }}>Measure All</button>
          </div>
        </div>
      </section>
      <Profiles list={s.profiles.speaker}
        onSave={(name) => update((x) => ({ ...x, profiles: { ...x.profiles, speaker: [...x.profiles.speaker.filter((q) => q.name !== name), { name, filters: [], preamp: x.speaker.preamp, extra: x.speaker }] } }))}
        onLoad={(pr) => update((x) => ({ ...x, speaker: { ...x.speaker, ...((pr.extra as Studio["speaker"]) ?? {}) } }))}
        onDelete={(i) => update((x) => ({ ...x, profiles: { ...x.profiles, speaker: x.profiles.speaker.filter((_, k) => k !== i) } }))} />
      <FilterBank title={`PARAMETRIC EQ FILTERS · ${sp.channel}`} filters={cur.filters} onChange={(filters) => setCh(sp.channel, { filters })} defaults={() => []} />
    </>
  );
}
