// Soundscapes: ambient backgrounds (rain, ocean, forest, fire…) that play alongside your music.
// Every layer is synthesised live with the Web Audio API from noise and oscillators, so nothing is
// downloaded, it never loops audibly, and it costs almost no CPU.

export type LayerId =
  | "rain" | "thunder" | "ocean" | "wind" | "birds" | "stream" | "fire" | "crickets"
  | "white" | "pink" | "brown" | "binaural";

export interface LayerInfo { id: LayerId; name: string; group: "Nature" | "Weather" | "Focus"; hint: string }

export const LAYERS: LayerInfo[] = [
  { id: "rain", name: "Rain", group: "Weather", hint: "Steady rainfall with drops on the window" },
  { id: "thunder", name: "Thunder", group: "Weather", hint: "Distant rolling thunder every so often" },
  { id: "wind", name: "Wind", group: "Weather", hint: "Gusts that rise and fall" },
  { id: "ocean", name: "Ocean waves", group: "Nature", hint: "Waves washing in and out" },
  { id: "stream", name: "Brook", group: "Nature", hint: "A bubbling mountain stream" },
  { id: "birds", name: "Birdsong", group: "Nature", hint: "Morning birds around you" },
  { id: "crickets", name: "Night crickets", group: "Nature", hint: "Warm summer night" },
  { id: "fire", name: "Fireplace", group: "Nature", hint: "Crackling logs and a low roar" },
  { id: "white", name: "White noise", group: "Focus", hint: "Bright, masks speech" },
  { id: "pink", name: "Pink noise", group: "Focus", hint: "Balanced, easy on the ears" },
  { id: "brown", name: "Brown noise", group: "Focus", hint: "Deep and soft, for concentration" },
  { id: "binaural", name: "Focus tones", group: "Focus", hint: "Binaural beat — use headphones" },
];

export type BeatMode = "theta" | "alpha" | "beta";
export const BEATS: Record<BeatMode, { hz: number; label: string }> = {
  theta: { hz: 6, label: "Calm · 6 Hz" },
  alpha: { hz: 10, label: "Relaxed focus · 10 Hz" },
  beta: { hz: 16, label: "Alert · 16 Hz" },
};

export interface Scene { id: string; name: string; mood: string; layers: Partial<Record<LayerId, number>>; colors: [string, string, string] }

export const SCENES: Scene[] = [
  { id: "rainy-window", name: "Rainy Window", mood: "Cosy afternoon indoors", layers: { rain: 0.7, fire: 0.25, thunder: 0.2 }, colors: ["#2b3a55", "#5a7aa6", "#c9d6ea"] },
  { id: "thunderstorm", name: "Thunderstorm", mood: "Heavy rain and rumbling sky", layers: { rain: 0.9, thunder: 0.75, wind: 0.45 }, colors: ["#141a2b", "#3b4a6b", "#8fa3c7"] },
  { id: "ocean-breeze", name: "Ocean Breeze", mood: "Shoreline with sea wind", layers: { ocean: 0.8, wind: 0.3, birds: 0.1 }, colors: ["#0b4f6c", "#1fa2b8", "#9be3e6"] },
  { id: "forest-morning", name: "Forest Morning", mood: "Birds by a gentle stream", layers: { birds: 0.6, stream: 0.45, wind: 0.15 }, colors: ["#1f4d2b", "#4f9a55", "#c7e8a3"] },
  { id: "night-camp", name: "Night Camp", mood: "Campfire under the stars", layers: { fire: 0.65, crickets: 0.45, wind: 0.15 }, colors: ["#1b1033", "#7a2e3a", "#f2a65a"] },
  { id: "mountain-stream", name: "Mountain Stream", mood: "Fresh water over stones", layers: { stream: 0.8, birds: 0.2, wind: 0.2 }, colors: ["#23445c", "#3f8f8a", "#bfe6d6"] },
  { id: "deep-focus", name: "Deep Focus", mood: "Brown noise + focus tones", layers: { brown: 0.6, binaural: 0.25 }, colors: ["#20123a", "#4b3a8c", "#a99bea"] },
  { id: "soft-static", name: "Soft Static", mood: "Pink noise to block distractions", layers: { pink: 0.5 }, colors: ["#3a2f3f", "#8a6f8f", "#e6d3e9"] },
];

// ------------------------------------------------------------------ engine
type Built = { out: GainNode; stop: () => void };

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let analyser: AnalyserNode | null = null;
const built = new Map<LayerId, Built>();
const levels = new Map<LayerId, number>();
let masterLevel = 0.7;
let beatMode: BeatMode = "alpha";
let running = false;
const noiseCache = new Map<string, AudioBuffer>();

function ac(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: "playback" });
    master = ctx.createGain();
    master.gain.value = 0;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    master.connect(analyser);
    analyser.connect(ctx.destination);
  }
  return ctx;
}

/** Stereo noise (independent channels for width). */
function noise(kind: "white" | "pink" | "brown", seconds = 6): AudioBuffer {
  const key = kind + seconds;
  const hit = noiseCache.get(key);
  if (hit) return hit;
  const c = ac();
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === "white") d[i] = w * 0.5;
      else if (kind === "pink") {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
    // crossfade the loop seam so it never clicks
    const fade = Math.floor(c.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[len - fade + i] = d[len - fade + i] * (1 - t) + d[i] * t;
    }
  }
  noiseCache.set(key, buf);
  return buf;
}

function loop(kind: "white" | "pink" | "brown", dest: AudioNode, rate = 1): AudioBufferSourceNode {
  const c = ac();
  const s = c.createBufferSource();
  s.buffer = noise(kind);
  s.loop = true;
  s.playbackRate.value = rate;
  s.loopStart = Math.random() * 2;
  s.connect(dest);
  s.start(c.currentTime, Math.random() * 4);
  return s;
}

function filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
  const f = ac().createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}
function gain(v: number): GainNode {
  const g = ac().createGain();
  g.gain.value = v;
  return g;
}
function pan(v: number): StereoPannerNode {
  const p = ac().createStereoPanner();
  p.pan.value = v;
  return p;
}
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Runs `tick(now)` on a timer to schedule events slightly ahead of time. */
function scheduler(tick: (t: number) => void, everyMs = 120) {
  const id = window.setInterval(() => { if (ctx && ctx.state === "running") tick(ctx.currentTime); }, everyMs);
  return () => window.clearInterval(id);
}

/** Short burst of filtered noise (rain drops, crackles). */
function burst(dest: AudioNode, at: number, dur: number, freq: number, level: number, p: number, type: BiquadFilterType = "bandpass", q = 1.2) {
  const c = ac();
  const s = c.createBufferSource();
  s.buffer = noise("white", 1);
  const f = filter(type, freq, q);
  const g = c.createGain();
  const pn = pan(p);
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(level, at + Math.min(0.004, dur / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  s.connect(f).connect(g).connect(pn).connect(dest);
  s.start(at, Math.random() * 0.9, dur + 0.05);
}

const BUILDERS: Record<LayerId, (out: GainNode) => () => void> = {
  rain(out) {
    const bed = gain(0.55);
    const hp = filter("highpass", 500);
    const lp = filter("lowpass", 8000);
    const s1 = loop("white", hp);
    hp.connect(lp).connect(bed).connect(out);
    const body = gain(0.35);
    const bp = filter("bandpass", 1800, 0.4);
    const s2 = loop("pink", bp);
    bp.connect(body).connect(out);
    let next = 0;
    const stopDrops = scheduler((now) => {
      if (next < now) next = now;
      while (next < now + 0.3) {
        burst(out, next, rnd(0.01, 0.04), rnd(2500, 7000), rnd(0.05, 0.25), rnd(-0.9, 0.9));
        next += rnd(0.01, 0.06);
      }
    });
    return () => { s1.stop(); s2.stop(); stopDrops(); };
  },
  thunder(out) {
    let next = ac().currentTime + rnd(2, 6);
    const sources: AudioBufferSourceNode[] = [];
    const stop = scheduler((now) => {
      if (now + 0.5 < next) return;
      const c = ac();
      const s = c.createBufferSource();
      s.buffer = noise("brown", 6);
      const lp = filter("lowpass", rnd(110, 260), 0.9);
      const g = c.createGain();
      const pn = pan(rnd(-0.6, 0.6));
      const t = next, len = rnd(4, 8);
      g.gain.setValueAtTime(0, t);
      // a few swells: crack, roll, rumble away
      let at = t;
      for (let k = 0; k < 4; k++) {
        at += rnd(0.15, 0.9);
        g.gain.linearRampToValueAtTime(rnd(0.6, 1.4) / (k + 1) ** 0.4, at);
        at += rnd(0.4, 1.4);
        g.gain.linearRampToValueAtTime(rnd(0.15, 0.4), at);
      }
      g.gain.linearRampToValueAtTime(0.0001, t + len);
      s.connect(lp).connect(g).connect(pn).connect(out);
      s.start(t, Math.random() * 3, len + 0.2);
      sources.push(s);
      if (sources.length > 4) sources.shift();
      next = t + rnd(12, 32);
    }, 250);
    return () => { stop(); sources.forEach((s) => { try { s.stop(); } catch { /* ended */ } }); };
  },
  ocean(out) {
    const stops: (() => void)[] = [];
    for (const side of [-0.5, 0.5]) {
      const lp = filter("lowpass", 400, 0.5);
      const g = gain(0.2);
      const pn = pan(side);
      const s = loop(side < 0 ? "brown" : "pink", lp);
      lp.connect(g).connect(pn).connect(out);
      let next = ac().currentTime + rnd(0, 3);
      stops.push(scheduler((now) => {
        if (now + 0.5 < next) return;
        const t = next, rise = rnd(2.5, 4), fall = rnd(3.5, 6);
        lp.frequency.setTargetAtTime(rnd(1400, 2400), t, rise / 3);
        g.gain.setTargetAtTime(rnd(0.7, 1.0), t, rise / 3);
        lp.frequency.setTargetAtTime(rnd(250, 420), t + rise, fall / 3);
        g.gain.setTargetAtTime(rnd(0.12, 0.25), t + rise, fall / 3);
        next = t + rise + fall * rnd(0.7, 1);
      }, 300));
      stops.push(() => s.stop());
    }
    return () => stops.forEach((f) => f());
  },
  wind(out) {
    const bp = filter("bandpass", 500, 0.9);
    const g = gain(0.5);
    const s = loop("pink", bp);
    bp.connect(g).connect(out);
    const whistle = filter("bandpass", 900, 6);
    const wg = gain(0.08);
    const s2 = loop("white", whistle);
    whistle.connect(wg).connect(out);
    const stop = scheduler((now) => {
      if (Math.random() < 0.06) {
        const dur = rnd(1.5, 4);
        bp.frequency.setTargetAtTime(rnd(280, 950), now, dur / 3);
        g.gain.setTargetAtTime(rnd(0.25, 1.0), now, dur / 3);
        whistle.frequency.setTargetAtTime(rnd(600, 1600), now, dur / 2);
      }
    }, 200);
    return () => { s.stop(); s2.stop(); stop(); };
  },
  birds(out) {
    let next = ac().currentTime + 0.3;
    const stop = scheduler((now) => {
      const c = ac();
      while (next < now + 0.4) {
        // a phrase from one bird: a few chirps of the same "species"
        const base = rnd(2200, 5200), notes = Math.floor(rnd(2, 7)), p = rnd(-0.9, 0.9), lvl = rnd(0.05, 0.16);
        const up = Math.random() < 0.5, len = rnd(0.05, 0.14), gap = rnd(0.04, 0.12);
        let t = next;
        for (let k = 0; k < notes; k++) {
          const o = c.createOscillator();
          o.type = "sine";
          const f0 = base * rnd(0.92, 1.08);
          o.frequency.setValueAtTime(up ? f0 * 0.75 : f0 * 1.3, t);
          o.frequency.exponentialRampToValueAtTime(up ? f0 * 1.35 : f0 * 0.8, t + len);
          const g = c.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(lvl, t + len * 0.25);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);
          o.connect(g).connect(pan(p)).connect(out);
          o.start(t);
          o.stop(t + len + 0.02);
          t += len + gap;
        }
        next = t + rnd(0.4, 3.5);
      }
    });
    return stop;
  },
  stream(out) {
    const bed = filter("lowpass", 700, 0.5);
    const bg = gain(0.45);
    const s1 = loop("pink", bed);
    bed.connect(bg).connect(out);
    const bp = filter("bandpass", 1500, 2.5);
    const g = gain(0.6);
    const s2 = loop("white", bp);
    bp.connect(g).connect(out);
    const stop = scheduler((now) => {
      for (let i = 0; i < 4; i++) {
        const t = now + i * 0.03;
        bp.frequency.setTargetAtTime(rnd(900, 2800), t, 0.015);
        g.gain.setTargetAtTime(rnd(0.25, 0.75), t, 0.02);
      }
    }, 120);
    return () => { s1.stop(); s2.stop(); stop(); };
  },
  fire(out) {
    const lp = filter("lowpass", 350, 0.6);
    const roar = gain(0.6);
    const s = loop("brown", lp);
    lp.connect(roar).connect(out);
    let next = 0;
    const stop = scheduler((now) => {
      if (next < now) next = now;
      roar.gain.setTargetAtTime(rnd(0.4, 0.8), now, 0.4);
      while (next < now + 0.3) {
        const pop = Math.random() < 0.08;
        burst(out, next, pop ? rnd(0.02, 0.05) : rnd(0.002, 0.012), rnd(1500, 5000), pop ? rnd(0.5, 0.9) : rnd(0.1, 0.45), rnd(-0.6, 0.6), "highpass", 0.7);
        next += Math.random() < 0.3 ? rnd(0.01, 0.04) : rnd(0.05, 0.4);
      }
    });
    return () => { s.stop(); stop(); };
  },
  crickets(out) {
    const crickets = [0, 1, 2].map(() => ({ f: rnd(4200, 5200), p: rnd(-0.8, 0.8), period: rnd(0.45, 0.9), next: ac().currentTime + rnd(0, 1), lvl: rnd(0.03, 0.07) }));
    const stop = scheduler((now) => {
      const c = ac();
      for (const k of crickets) {
        while (k.next < now + 0.4) {
          const o = c.createOscillator();
          o.frequency.value = k.f;
          const g = c.createGain();
          g.gain.value = 0;
          const pulses = Math.random() < 0.15 ? 0 : 3;
          for (let i = 0; i < pulses; i++) {
            const t = k.next + i * 0.035;
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(k.lvl, t + 0.005);
            g.gain.linearRampToValueAtTime(0, t + 0.02);
          }
          o.connect(g).connect(pan(k.p)).connect(out);
          o.start(k.next);
          o.stop(k.next + 0.15);
          k.next += k.period * rnd(0.92, 1.08);
        }
      }
    });
    return stop;
  },
  white(out) { const lp = filter("lowpass", 9000); const g = gain(0.5); const s = loop("white", lp); lp.connect(g).connect(out); return () => s.stop(); },
  pink(out) { const g = gain(0.9); const s = loop("pink", g); g.connect(out); return () => s.stop(); },
  brown(out) { const lp = filter("lowpass", 900); const g = gain(0.8); const s = loop("brown", lp); lp.connect(g).connect(out); return () => s.stop(); },
  binaural(out) {
    const c = ac();
    const merger = c.createChannelMerger(2);
    const base = 200, beat = BEATS[beatMode].hz;
    const l = c.createOscillator(), r = c.createOscillator();
    l.frequency.value = base;
    r.frequency.value = base + beat;
    const gl = gain(0.25), gr = gain(0.25);
    l.connect(gl).connect(merger, 0, 0);
    r.connect(gr).connect(merger, 0, 1);
    merger.connect(out);
    l.start(); r.start();
    return () => { l.stop(); r.stop(); };
  },
};

function fadeTo(g: AudioParam, v: number, secs = 0.8) {
  const c = ac();
  g.cancelScheduledValues(c.currentTime);
  g.setValueAtTime(g.value, c.currentTime);
  g.setTargetAtTime(v, c.currentTime, secs / 3);
}

/** Perceptual volume curve. */
const curve = (v: number) => v * v;

function ensureLayer(id: LayerId) {
  let b = built.get(id);
  if (!b) {
    const out = ac().createGain();
    out.gain.value = 0;
    out.connect(master!);
    const stop = BUILDERS[id](out);
    b = { out, stop };
    built.set(id, b);
  }
  return b;
}

function dropLayer(id: LayerId) {
  const b = built.get(id);
  if (!b) return;
  built.delete(id);
  fadeTo(b.out.gain, 0, 0.6);
  window.setTimeout(() => { b.stop(); b.out.disconnect(); }, 900);
}

/** Set a layer's level (0 = off). Takes effect immediately if the soundscape is playing. */
export function setLayer(id: LayerId, level: number) {
  const v = Math.max(0, Math.min(1, level));
  if (v > 0) levels.set(id, v); else levels.delete(id);
  if (!running) return;
  if (v > 0) fadeTo(ensureLayer(id).out.gain, curve(v));
  else dropLayer(id);
}

export function setMaster(v: number) {
  masterLevel = Math.max(0, Math.min(1, v));
  if (running && master) fadeTo(master.gain, curve(masterLevel), 0.3);
}

export function setBeatMode(m: BeatMode) {
  beatMode = m;
  if (running && levels.has("binaural")) {
    const v = levels.get("binaural")!;
    dropLayer("binaural");
    window.setTimeout(() => setLayer("binaural", v), 650);
  }
}

export async function start() {
  const c = ac();
  if (c.state !== "running") await c.resume();
  running = true;
  for (const [id, v] of levels) fadeTo(ensureLayer(id).out.gain, curve(v));
  fadeTo(master!.gain, curve(masterLevel), 1.5);
}

export function stop(fadeSecs = 1.2) {
  if (!ctx || !running) return;
  running = false;
  fadeTo(master!.gain, 0, fadeSecs);
  window.setTimeout(() => {
    if (running) return;
    for (const id of [...built.keys()]) {
      const b = built.get(id)!;
      b.stop();
      b.out.disconnect();
      built.delete(id);
    }
    ctx?.suspend().catch(() => {});
  }, fadeSecs * 1000 + 300);
}

export const isRunning = () => running;

/** 0..1 loudness of what's playing, for the page's animation. */
export function meter(): number {
  if (!analyser || !running) return 0;
  const d = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(d);
  let s = 0;
  for (let i = 0; i < d.length; i++) s += d[i] * d[i];
  return Math.min(1, Math.sqrt(s / d.length) * 4);
}
