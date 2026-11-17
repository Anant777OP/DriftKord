// The eight Walkman-style visualizers (Silk, Balloon, Gate, Glow, Album Art, Animal, Graffiti, Ink),
// driven by the Rust FFT stream (`live.frame`), plus Lyric-Reactive rendering: the current lyric line
// is drawn *by the visualizer itself* so text rides the silk wave, drifts like ink, hops like animals…
import { useEffect, useRef } from "react";
import type { Frame } from "./api";
import { live, livePosition, LyricLine, VizId } from "./store";

export const VISUALIZERS: { id: VizId; name: string; desc: string }[] = [
  { id: "silk", name: "Silk", desc: "Layered satin ribbons with highlight edges, rippling with the spectrum" },
  { id: "balloon", name: "Balloon", desc: "Glass orbs with glowing rims and reflections, rising on the beat" },
  { id: "gate", name: "Gate", desc: "Rounded neon portals rushing towards you over a perspective floor" },
  { id: "glow", name: "Glow", desc: "Bokeh lights, a breathing core and comet sparks on bass drops" },
  { id: "albumart", name: "Album Art", desc: "Floating cover card over a blurred-cover ambience, with a pill spectrum" },
  { id: "animal", name: "Animal", desc: "Flat geometric creatures hopping to the beat on parallax hills" },
  { id: "graffiti", name: "Graffiti", desc: "Glossy paint splats, drips and neon tags on every transient" },
  { id: "ink", name: "Ink", desc: "Ink filaments drifting through a flow field, blooming on every beat" },
  { id: "orbit", name: "Orbit", desc: "Radial spectrum around a spinning record, with shockwaves on the beat" },
  { id: "horizon", name: "Horizon", desc: "Glowing ridge lines of your music receding towards a sunset" },
];

// ------------------------------------------------------------------ lyrics model
/**
 * Parse LRC. Accepts [mm:ss], [mm:ss.xx], [mm:ss:xx], [hh:mm:ss.xx], several stamps per line,
 * enhanced-LRC word stamps <mm:ss.xx> (removed) and the [offset:±ms] tag.
 * Lyrics without any timestamps are returned with negative times = "unsynced" (never auto-timed).
 */
export function parseLrc(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  let offset = 0;
  const src = text.replace(/^﻿/, "").normalize("NFC");
  // [mm:ss], [mm:ss.xx] and the common [mm:ss:xx] variant (colon before hundredths)
  const stamp = /\[()(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of src.split(/\r?\n/)) {
    const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw);
    if (off) {
      offset = parseInt(off[1], 10) / 1000;
      continue;
    }
    const tags = [...raw.matchAll(stamp)];
    if (!tags.length) continue;
    const lyric = raw
      .replace(/\[[^\]]*\]/g, "")
      .replace(/<\d+:\d{1,2}(?:[.:]\d{1,3})?>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    for (const m of tags) {
      const hh = m[1] ? parseInt(m[1], 10) : 0;
      const frac = m[4] ? parseInt(m[4], 10) / Math.pow(10, m[4].length) : 0;
      out.push({ time: hh * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + frac - offset, text: lyric });
    }
  }
  if (!out.length) {
    const lines = src.split(/\r?\n/).map((l) => l.replace(/\[[a-z]+:[^\]]*\]/gi, "").trim()).filter(Boolean);
    return lines.map((l, i) => ({ time: -1 - i, text: l }));
  }
  return out.sort((a, b) => a.time - b.time);
}

export function isSynced(lines: LyricLine[] | null): boolean {
  // unsynced lyrics are stored with times -1, -2, -3…; real stamps can be slightly negative after an [offset:] tag
  return !!lines && lines.length > 0 && lines.some((l) => l.time >= 0);
}

export interface LyricView { text: string; next: string; progress: number; age: number; index: number }

export function lyricAt(lines: LyricLine[] | null, pos: number, duration: number): LyricView | null {
  // Lyrics without timestamps are never guessed — showing them at the wrong moment is worse than not at all.
  if (!lines || !lines.length || !isSynced(lines)) return null;
  void duration;
  const times = lines.map((l) => l.time);
  let i = -1;
  for (let k = 0; k < times.length; k++) if (times[k] <= pos) i = k;
  if (i < 0) return { text: "", next: lines[0].text, progress: 0, age: 0, index: -1 };
  const start = times[i];
  const end = i + 1 < times.length ? times[i + 1] : start + 6;
  return {
    text: lines[i].text,
    next: i + 1 < lines.length ? lines[i + 1].text : "",
    progress: Math.max(0, Math.min(1, (pos - start) / Math.max(0.1, end - start))),
    age: pos - start,
    index: i,
  };
}

// ------------------------------------------------------------------ colour helpers
interface Colors { accent: string; accent2: string; glow: string; text: string; bg: string; bg2: string; font: string }
function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement);
  const g = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return { accent: g("--accent", "#ff6a00"), accent2: g("--accent2", "#00e0ff"), glow: g("--glow", "#ff6a00"), text: g("--text", "#fff"), bg: g("--bg", "#000"), bg2: g("--bg2", "#111"), font: g("--font-display", "sans-serif") };
}
function hexToRgb(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) {
    const r = /rgba?\(([^)]+)\)/.exec(c);
    if (r) {
      const p = r[1].split(",").map((x) => parseFloat(x));
      return [p[0] || 0, p[1] || 0, p[2] || 0];
    }
    return [255, 255, 255];
  }
  let h = m[1];
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (c: string, a: number) => {
  const [r, g, b] = hexToRgb(c);
  return `rgba(${r},${g},${b},${a})`;
};
const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${a})`;
function hueOf(c: string): number {
  const [r, g, b] = hexToRgb(c).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return 0;
  const d = mx - mn;
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

/** Dominant colours from a cover image (coarse hue buckets weighted by saturation). */
export function extractPalette(img: HTMLImageElement): string[] {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const x = c.getContext("2d")!;
    x.drawImage(img, 0, 0, 32, 32);
    const d = x.getImageData(0, 0, 32, 32).data;
    const buckets = new Map<number, { r: number; g: number; b: number; w: number }>();
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx ? (mx - mn) / mx : 0;
      const w = 0.2 + sat * (mx / 255);
      const key = Math.round(hueOf(`#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`) / 30) * 4 + Math.round((mx / 255) * 3);
      const e = buckets.get(key) ?? { r: 0, g: 0, b: 0, w: 0 };
      e.r += r * w; e.g += g * w; e.b += b * w; e.w += w;
      buckets.set(key, e);
    }
    return [...buckets.values()].sort((a, b) => b.w - a.w).slice(0, 4)
      .map((e) => `#${[e.r / e.w, e.g / e.w, e.b / e.w].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ visualizer implementations
// Shared modern look: a dark "stage" with slow aurora light, a two-colour palette derived from
// the theme (or album art in adaptive mode), cheap bloom, vignette and film grain.
type Ctx = CanvasRenderingContext2D;
type HSLc = [number, number, number];

function hslOfColor(c: string): HSLc {
  const [r0, g0, b0] = hexToRgb(c);
  const r = r0 / 255, g = g0 / 255, b = b0 / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
}

interface Pal { ha: number; dh: number; sat: number; c: (t: number, l?: number, alpha?: number) => string }

function makePal(col: Colors): Pal {
  const A = hslOfColor(col.accent), B = hslOfColor(col.accent2);
  const ha = A[0];
  const hb = B[1] > 0.3 ? B[0] : ha - 50; // analogous partner (e.g. orange → pink) when the theme's 2nd accent is grey
  let dh = ((hb - ha + 540) % 360) - 180; // shortest way round the wheel
  if (Math.abs(dh) < 20) dh = 55;
  const sat = A[1] < 0.12 ? 0 : Math.max(62, Math.min(95, A[1] * 100));
  return {
    ha, dh, sat,
    c: (t, l = 62, alpha = 1) => {
      const tt = ((t % 1) + 1) % 1;
      const k = tt < 0.5 ? tt * 2 : (1 - tt) * 2; // ping-pong between the two hues
      return hsl(ha + dh * k, sat, l, alpha);
    },
  };
}

/** Visualizers always render on a dark stage (light themes get a deep tint of their accent). */
function stageColors(col: Colors): Colors {
  const [, , l] = hslOfColor(col.bg);
  const A = hslOfColor(col.accent);
  if (l < 0.22) return { ...col, text: "#f5f6fa" };
  return { ...col, bg: hslHex(A[0], 35, 6), bg2: hslHex((A[0] + 25) % 360, 30, 13), text: "#f5f6fa" };
}

interface Fx { b1: HTMLCanvasElement; b2: HTMLCanvasElement; grain: HTMLCanvasElement | null; vig: { w: number; h: number; g: CanvasGradient | null } }
function makeFx(): Fx {
  return { b1: document.createElement("canvas"), b2: document.createElement("canvas"), grain: null, vig: { w: 0, h: 0, g: null } };
}

interface DrawArgs {
  ctx: Ctx; w: number; h: number; f: Frame; t: number; dt: number; beat: boolean; col: Colors; st: any;
  cover: HTMLImageElement | null; palette: string[]; pointer: { x: number; y: number }; P: Pal; fx: Fx; q: number;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const ease = (cur: number, target: number, k: number) => cur + (target - cur) * k;

function bandAvg(f: Frame, a: number, b: number) {
  let s = 0;
  for (let i = a; i < b; i++) s += f.bands[i] ?? 0;
  return s / Math.max(1, b - a);
}

/** Smooth curve through points (quadratic through midpoints). */
function smoothThrough(ctx: Ctx, pts: [number, number][], move = true) {
  if (!pts.length) return;
  if (move) ctx.moveTo(pts[0][0], pts[0][1]);
  else ctx.lineTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const l = pts[pts.length - 1];
  ctx.lineTo(l[0], l[1]);
}

function backdrop(a: DrawArgs, intensity = 1) {
  const { ctx, w, h, t, f, P, col } = a;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, col.bg2);
  g.addColorStop(1, col.bg);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 3; i++) {
    const x = w * (0.5 + 0.38 * Math.sin(t * 0.06 * (i + 1) + i * 2.1));
    const y = h * (0.5 + 0.32 * Math.cos(t * 0.045 * (i + 1) + i * 1.3));
    const r = Math.max(w, h) * (0.42 + 0.08 * Math.sin(t * 0.11 + i));
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, P.c(i / 3, 50, 0.11 * intensity * (1 + f.bass * 0.7)));
    rg.addColorStop(1, P.c(i / 3, 50, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalCompositeOperation = "source-over";
}

/** Bloom (two-step downsample, additive upscale) + vignette + grain. */
function post(a: DrawArgs, bloom = 0.4) {
  const { ctx, w, h, fx } = a;
  if (bloom > 0) {
    const w1 = Math.max(1, (w / 4) | 0), h1 = Math.max(1, (h / 4) | 0);
    const w2 = Math.max(1, (w / 12) | 0), h2 = Math.max(1, (h / 12) | 0);
    if (fx.b1.width !== w1 || fx.b1.height !== h1) { fx.b1.width = w1; fx.b1.height = h1; }
    if (fx.b2.width !== w2 || fx.b2.height !== h2) { fx.b2.width = w2; fx.b2.height = h2; }
    const c1 = fx.b1.getContext("2d")!, c2 = fx.b2.getContext("2d")!;
    c1.drawImage(ctx.canvas, 0, 0, w1, h1);
    c2.drawImage(fx.b1, 0, 0, w2, h2);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = bloom;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(fx.b2, 0, 0, w, h);
    ctx.globalAlpha = bloom * 0.5;
    ctx.drawImage(fx.b1, 0, 0, w, h);
    ctx.restore();
  }
  if (fx.vig.w !== w || fx.vig.h !== h || !fx.vig.g) {
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.55)");
    fx.vig = { w, h, g };
  }
  ctx.fillStyle = fx.vig.g!;
  ctx.fillRect(0, 0, w, h);
  if (!fx.grain) {
    const gc = document.createElement("canvas");
    gc.width = gc.height = 128;
    const gx = gc.getContext("2d")!;
    const img = gx.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    gx.putImageData(img, 0, 0);
    fx.grain = gc;
  }
  ctx.save();
  ctx.globalAlpha = 0.035;
  ctx.globalCompositeOperation = "overlay";
  const pat = ctx.createPattern(fx.grain, "repeat")!;
  ctx.translate((Math.random() * 128) | 0, (Math.random() * 128) | 0);
  ctx.fillStyle = pat;
  ctx.fillRect(-128, -128, w + 256, h + 256);
  ctx.restore();
}

const drawers: Record<VizId, (a: DrawArgs) => void> = {
  // ---------------- Silk: layered satin ribbons with highlight edges
  silk(a) {
    backdrop(a);
    const { ctx, w, h, f, t, P, st, q } = a;
    const N = 6;
    st.amp = st.amp ?? new Array(N).fill(0);
    ctx.globalCompositeOperation = "lighter";
    for (let r = 0; r < N; r++) {
      st.amp[r] = ease(st.amp[r], bandAvg(f, r * 10, r * 10 + 10), 0.12);
      const e = st.amp[r];
      const amp = h * (0.05 + e * 0.26);
      const thick = h * (0.018 + e * 0.09 + f.bass * 0.025);
      const off = (r - (N - 1) / 2) * h * 0.045;
      const top: [number, number][] = [];
      const bot: [number, number][] = [];
      const steps = 48;
      for (let k = 0; k <= steps; k++) {
        const p = k / steps;
        const x = p * w;
        const env = Math.sin(p * Math.PI);
        const y = h * 0.5 + off
          + Math.sin(p * (2.4 + r * 0.45) * Math.PI + t * (0.45 + r * 0.09)) * amp * env
          + Math.sin(p * 7.0 + t * 1.1 + r * 1.7) * amp * 0.28 * env;
        top.push([x, y]);
        bot.push([x, y + thick * (0.25 + env)]);
      }
      const tH = r / N;
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, P.c(tH, 60, 0));
      grad.addColorStop(0.25, P.c(tH, 58, 0.22 + e * 0.3));
      grad.addColorStop(0.75, P.c(tH + 0.25, 62, 0.22 + e * 0.3));
      grad.addColorStop(1, P.c(tH + 0.25, 60, 0));
      ctx.beginPath();
      smoothThrough(ctx, top);
      smoothThrough(ctx, [...bot].reverse(), false);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      // satin highlight along the upper edge
      ctx.beginPath();
      smoothThrough(ctx, top);
      ctx.strokeStyle = P.c(tH + 0.1, 82, 0.35 + e * 0.5);
      ctx.lineWidth = 1.3 * q;
      ctx.stroke();
      if (r === 2) st.mainWave = top;
    }
    ctx.globalCompositeOperation = "source-over";
    post(a, 0.35);
  },

  // ---------------- Balloon: glass orbs with fresnel rims, depth and speculars
  balloon(a) {
    backdrop(a, 0.85);
    const { ctx, w, h, f, beat, dt, P, st, q } = a;
    st.orbs = st.orbs ?? [];
    const orbs: any[] = st.orbs;
    if (beat || Math.random() < f.mid * 0.05) {
      const n = beat ? 1 + Math.floor(f.bass * 3) : 1;
      for (let i = 0; i < n; i++) {
        const z = rnd(0.35, 1);
        orbs.push({ x: rnd(0.06, 0.94) * w, y: h + 80 * q, r: (22 + rnd(0, 40) + f.bass * 50) * z * q, z, tH: Math.random(), vy: rnd(28, 60), ph: rnd(0, 6), life: 0 });
      }
    }
    orbs.sort((p, q2) => p.z - q2.z);
    for (let i = orbs.length - 1; i >= 0; i--) {
      const o = orbs[i];
      o.life += dt;
      o.y -= (o.vy * (0.4 + o.z) + f.bass * 90 * o.z) * dt * q;
      o.x += Math.sin(o.life * 0.8 + o.ph) * 14 * o.z * dt * q;
      if (o.y < -o.r * 2) orbs.splice(i, 1);
    }
    for (const o of orbs) {
      const r = o.r * (1 + f.mid * 0.08);
      const al = 0.3 + 0.7 * o.z;
      // body: transparent centre, bright fresnel rim
      const body = ctx.createRadialGradient(o.x + r * 0.15, o.y + r * 0.2, r * 0.05, o.x, o.y, r);
      body.addColorStop(0, P.c(o.tH, 60, 0.05 * al));
      body.addColorStop(0.7, P.c(o.tH, 62, 0.16 * al));
      body.addColorStop(0.93, P.c(o.tH, 74, 0.5 * al));
      body.addColorStop(1, P.c(o.tH, 80, 0));
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
      ctx.fill();
      // caustic glow at the bottom
      const cg = ctx.createRadialGradient(o.x + r * 0.25, o.y + r * 0.45, 0, o.x + r * 0.25, o.y + r * 0.45, r * 0.55);
      cg.addColorStop(0, P.c(o.tH + 0.2, 80, 0.32 * al));
      cg.addColorStop(1, P.c(o.tH + 0.2, 80, 0));
      ctx.fillStyle = cg;
      ctx.fill();
      // specular highlight
      ctx.save();
      ctx.translate(o.x - r * 0.38, o.y - r * 0.42);
      ctx.rotate(-0.6);
      const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.35);
      sg.addColorStop(0, `rgba(255,255,255,${0.7 * al})`);
      sg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sg;
      ctx.scale(1, 0.55);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (orbs.length > 60) orbs.splice(0, orbs.length - 60);
    post(a, 0.35);
  },

  // ---------------- Gate: rounded neon portals over a perspective floor
  gate(a) {
    backdrop(a, 0.6);
    const { ctx, w, h, f, beat, t, dt, P, st, q } = a;
    const cx = w / 2 + Math.sin(t * 0.3) * w * 0.02, cy = h * 0.46 + Math.cos(t * 0.25) * h * 0.02;
    // floor grid
    st.scroll = ((st.scroll ?? 0) + dt * (0.4 + f.bass * 1.6)) % 1;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1 * q;
    for (let i = -12; i <= 12; i++) {
      ctx.strokeStyle = P.c(0.1, 60, 0.07);
      ctx.beginPath();
      ctx.moveTo(cx, cy + h * 0.06);
      ctx.lineTo(cx + i * w * 0.12, h);
      ctx.stroke();
    }
    for (let k = 0; k < 10; k++) {
      const z = (k + st.scroll) / 10;
      const y = cy + h * 0.06 + Math.pow(z, 2.2) * (h - cy);
      ctx.strokeStyle = P.c(0.1, 60, 0.12 * z);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    // vanishing glow
    const vg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * (0.25 + f.bass * 0.2));
    vg.addColorStop(0, P.c(0.5, 72, 0.4 + f.bass * 0.4));
    vg.addColorStop(1, P.c(0.5, 60, 0));
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
    // portals
    st.gates = st.gates ?? [];
    const gates: any[] = st.gates;
    st.spawn = (st.spawn ?? 0) + dt * (1 + f.mid * 2);
    if (beat || st.spawn > 0.55) {
      st.spawn = 0;
      gates.push({ z: 1, tH: (t * 0.05) % 1 + (beat ? 0.5 : 0), strong: beat });
    }
    const speed = 0.3 + f.bass * 0.9;
    const aspect = Math.min(1.8, w / h);
    for (let i = gates.length - 1; i >= 0; i--) {
      const g = gates[i];
      g.z -= dt * speed;
      if (g.z <= 0.03) { gates.splice(i, 1); continue; }
      const s = (Math.min(w, h) * 0.1) / g.z;
      const ww = s * aspect, hh = s;
      const al = Math.min(1, (1 - g.z) * 1.4) * (g.strong ? 1 : 0.65);
      const grad = ctx.createLinearGradient(cx - ww, cy - hh, cx + ww, cy + hh);
      grad.addColorStop(0, P.c(g.tH, 66, al));
      grad.addColorStop(1, P.c(g.tH + 0.35, 70, al));
      ctx.strokeStyle = grad;
      ctx.lineWidth = ((g.strong ? 3 : 1.6) / Math.max(0.3, g.z)) * q;
      ctx.beginPath();
      ctx.roundRect(cx - ww, cy - hh, ww * 2, hh * 2, hh * 0.25);
      ctx.stroke();
    }
    ctx.restore();
    post(a, 0.55);
  },

  // ---------------- Glow: bokeh discs, a pulsing core and comet sparks
  glow(a) {
    backdrop(a, 1.1);
    const { ctx, w, h, f, beat, t, dt, P, st, q } = a;
    st.bokeh = st.bokeh ?? Array.from({ length: 28 }, (_, i) => ({ x: Math.random(), y: Math.random(), r: rnd(18, 80), band: Math.floor(rnd(0, 60)), tH: i / 28, sp: rnd(0.005, 0.02), e: 0 }));
    ctx.globalCompositeOperation = "lighter";
    for (const b of st.bokeh) {
      b.e = ease(b.e, bandAvg(f, b.band, b.band + 4), 0.15);
      b.y -= b.sp * dt * (1 + f.mid);
      b.x += Math.sin(t * 0.2 + b.tH * 9) * b.sp * dt * 0.5;
      if (b.y < -0.15) { b.y = 1.15; b.x = Math.random(); }
      const x = b.x * w, y = b.y * h, r = b.r * q * (0.85 + b.e * 0.5);
      const al = 0.05 + b.e * 0.35;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, P.c(b.tH, 65, al * 0.55));
      g.addColorStop(0.82, P.c(b.tH, 68, al * 0.7));
      g.addColorStop(0.93, P.c(b.tH, 78, al * 1.2));
      g.addColorStop(1, P.c(b.tH, 70, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // breathing core
    st.core = ease(st.core ?? 0, f.bass, 0.2);
    const cr = Math.min(w, h) * (0.12 + st.core * 0.22);
    const cg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, cr * 2.2);
    cg.addColorStop(0, P.c(0.3, 85, 0.75));
    cg.addColorStop(0.25, P.c(0.4, 68, 0.4));
    cg.addColorStop(1, P.c(0.5, 60, 0));
    ctx.fillStyle = cg;
    ctx.fillRect(0, 0, w, h);
    // comet sparks
    st.sparks = st.sparks ?? [];
    const sp: any[] = st.sparks;
    if (beat) {
      for (let i = 0; i < 70; i++) {
        const an = rnd(0, Math.PI * 2), v = rnd(80, 420) * (0.6 + f.bass) * q;
        sp.push({ x: w / 2, y: h / 2, px: w / 2, py: h / 2, vx: Math.cos(an) * v, vy: Math.sin(an) * v, life: 1, tH: Math.random() });
      }
    }
    ctx.lineCap = "round";
    for (let i = sp.length - 1; i >= 0; i--) {
      const s = sp[i];
      s.px = s.x; s.py = s.y;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.vx *= 0.96; s.vy *= 0.96;
      s.life -= dt * 0.9;
      if (s.life <= 0) { sp.splice(i, 1); continue; }
      ctx.strokeStyle = P.c(s.tH, 80, s.life * 0.9);
      ctx.lineWidth = (1 + s.life * 2) * q;
      ctx.beginPath();
      ctx.moveTo(s.px - s.vx * 0.03, s.py - s.vy * 0.03);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
    }
    if (sp.length > 600) sp.splice(0, sp.length - 600);
    ctx.globalCompositeOperation = "source-over";
    post(a, 0.5);
  },

  // ---------------- Album Art: blurred-cover ambience, floating card, pill spectrum
  albumart(a) {
    const { ctx, w, h, f, t, P, st, cover, palette, pointer, q } = a;
    if (cover && cover.complete && cover.naturalWidth) {
      if (st.tinySrc !== cover.src) {
        st.tiny = st.tiny ?? document.createElement("canvas");
        st.tiny.width = st.tiny.height = 14;
        st.tiny.getContext("2d")!.drawImage(cover, 0, 0, 14, 14);
        st.tinySrc = cover.src;
      }
      const z = 1.15 + f.bass * 0.04 + Math.sin(t * 0.1) * 0.02;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(st.tiny, w / 2 - (w * z) / 2, h / 2 - (h * z) / 2, w * z, h * z);
      ctx.fillStyle = "rgba(0,0,0,0.42)";
      ctx.fillRect(0, 0, w, h);
    } else backdrop(a);
    const size = Math.min(w, h) * 0.5 * (1 + f.bass * 0.025);
    const px = (pointer.x - 0.5) * 24 * q + Math.sin(t * 0.4) * 4 * q;
    const py = (pointer.y - 0.5) * 16 * q + Math.cos(t * 0.33) * 3 * q;
    const x = w / 2 - size / 2 + px, y = h * 0.44 - size / 2 + py;
    const rad = size * 0.05;
    // ambient halo
    const halo = palette[0] ?? a.col.accent;
    const hg = ctx.createRadialGradient(x + size / 2, y + size / 2, size * 0.3, x + size / 2, y + size / 2, size * 1.1);
    hg.addColorStop(0, rgba(halo, 0.35 + f.bass * 0.3));
    hg.addColorStop(1, rgba(halo, 0));
    ctx.fillStyle = hg;
    ctx.fillRect(0, 0, w, h);
    // card shadow + image
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 40 * q;
    ctx.shadowOffsetY = 18 * q;
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, rad);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, rad);
    ctx.clip();
    if (cover && cover.complete && cover.naturalWidth) ctx.drawImage(cover, x, y, size, size);
    else {
      const g = ctx.createLinearGradient(x, y, x + size, y + size);
      g.addColorStop(0, P.c(0, 45, 1));
      g.addColorStop(1, P.c(0.5, 25, 1));
      ctx.fillStyle = g;
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = "rgba(255,255,255,.75)";
      ctx.font = `${size * 0.28}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("♪", x + size / 2, y + size / 2);
    }
    // glass sheen following the pointer
    const sx = x + size * (0.2 + pointer.x * 0.6);
    const sheen = ctx.createLinearGradient(sx - size * 0.6, y, sx + size * 0.2, y + size);
    sheen.addColorStop(0, "rgba(255,255,255,0)");
    sheen.addColorStop(0.5, "rgba(255,255,255,0.12)");
    sheen.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    ctx.fillRect(x, y, size, size);
    ctx.restore();
    // pill spectrum (mirrored)
    const bars = 40;
    const bw = size / bars;
    st.bars = st.bars ?? new Array(bars).fill(0);
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < bars; i++) {
      const band = Math.floor((Math.abs(i - bars / 2 + 0.5) / (bars / 2)) * 40);
      st.bars[i] = ease(st.bars[i], f.bands[band] ?? 0, 0.3);
      const bh = 4 * q + st.bars[i] * h * 0.11;
      const bx = x + i * bw + bw * 0.2;
      const by = y + size + 26 * q;
      ctx.fillStyle = P.c(i / bars, 70, 0.85);
      ctx.beginPath();
      ctx.roundRect(bx, by, bw * 0.6, bh, bw * 0.3);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    post(a, 0.3);
  },

  // ---------------- Animal: flat geometric creatures on parallax hills
  animal(a) {
    backdrop(a, 0.7);
    const { ctx, w, h, f, beat, t, dt, P, st, q } = a;
    const hill = (x: number, layer: number) =>
      h * (0.62 + layer * 0.08) + Math.sin(x * 0.004 / (layer + 1) + t * 0.05 * (layer + 1) + layer * 2) * h * 0.04 + Math.sin(x * 0.011 + layer) * h * 0.015;
    for (let layer = 0; layer < 3; layer++) {
      ctx.fillStyle = hsl(P.ha + P.dh * (0.2 + layer * 0.2), P.sat * 0.3, 9 + layer * 5, 1);
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 16) ctx.lineTo(x, hill(x, layer) - (layer === 2 ? f.bass * h * 0.02 : 0));
      ctx.lineTo(w, h);
      ctx.fill();
    }
    st.cr = st.cr ?? ["bunny", "cat", "frog", "bird", "bunny", "cat"].map((k, i) => ({ k, x: (i + 0.5) / 6, y: 0, vy: 0, sq: 0, tH: i / 6, ph: i * 0.9 }));
    const s = Math.min(w, h) * 0.055;
    for (let i = 0; i < st.cr.length; i++) {
      const c = st.cr[i];
      if (beat && (i + (st.n ?? 0)) % 2 === 0 && c.y === 0) { c.vy = -(240 + f.bass * 420) * q; c.sq = 0.3; }
      c.vy += 1500 * q * dt;
      c.y = Math.min(0, c.y + c.vy * dt);
      if (c.y === 0 && c.vy > 0) { c.vy = 0; c.sq = Math.max(c.sq, 0.18); }
      c.sq *= 0.85;
      const cx = c.x * w + Math.sin(t * 0.5 + c.ph) * 18 * q;
      const ground = hill(cx, 2) - f.bass * h * 0.02;
      const fly = c.k === "bird" ? h * 0.22 + Math.sin(t * 1.6 + c.ph) * 24 * q : 0;
      const cy = ground + c.y - fly;
      // soft shadow
      ctx.fillStyle = `rgba(0,0,0,${0.35 - Math.min(0.25, -c.y / (h * 0.6))})`;
      ctx.beginPath();
      ctx.ellipse(cx, ground + 2 * q, s * (0.8 + c.y / (h * 2)), s * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1 + c.sq * 0.5, 1 - c.sq);
      const body = ctx.createLinearGradient(0, -s * 1.6, 0, 0);
      body.addColorStop(0, P.c(c.tH, 74, 1));
      body.addColorStop(1, P.c(c.tH, 52, 1));
      ctx.fillStyle = body;
      const ell = (x: number, y: number, rx: number, ry: number, rot = 0) => { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); ctx.fill(); };
      let eye: [number, number] = [s * 0.45, -s * 1.15];
      if (c.k === "bunny") {
        ell(0, -s * 0.55, s * 0.62, s * 0.55);
        ell(s * 0.35, -s * 1.15, s * 0.38, s * 0.34);
        ell(s * 0.22, -s * 1.8, s * 0.11, s * 0.4, -0.15);
        ell(s * 0.48, -s * 1.8, s * 0.11, s * 0.4, 0.25 + Math.sin(t * 5) * 0.15 * f.treble);
      } else if (c.k === "cat") {
        ell(0, -s * 0.5, s * 0.7, s * 0.48);
        ell(s * 0.5, -s * 1.05, s * 0.38, s * 0.34);
        ctx.beginPath(); ctx.moveTo(s * 0.25, -s * 1.25); ctx.lineTo(s * 0.33, -s * 1.62); ctx.lineTo(s * 0.5, -s * 1.33); ctx.fill();
        ctx.beginPath(); ctx.moveTo(s * 0.58, -s * 1.33); ctx.lineTo(s * 0.76, -s * 1.62); ctx.lineTo(s * 0.82, -s * 1.22); ctx.fill();
        ctx.strokeStyle = P.c(c.tH, 60, 1); ctx.lineWidth = s * 0.14; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(-s * 0.6, -s * 0.6); ctx.quadraticCurveTo(-s * 1.2, -s * (1.0 + Math.sin(t * 3) * 0.3 * f.mid), -s * 0.9, -s * 1.5); ctx.stroke();
        eye = [s * 0.6, -s * 1.08];
      } else if (c.k === "frog") {
        ell(0, -s * 0.42, s * 0.78, s * 0.42);
        ell(-s * 0.32, -s * 0.85, s * 0.22, s * 0.22);
        ell(s * 0.32, -s * 0.85, s * 0.22, s * 0.22);
        eye = [s * 0.32, -s * 0.87];
        ctx.fillStyle = "#fff"; ell(-s * 0.32, -s * 0.87, s * 0.12, s * 0.12);
        ctx.fillStyle = "#111"; ell(-s * 0.32, -s * 0.87, s * 0.06, s * 0.06);
        ctx.fillStyle = body;
      } else {
        const flap = Math.sin(t * 13 + c.ph) * (0.4 + f.treble);
        ell(0, -s * 0.4, s * 0.5, s * 0.32);
        ell(s * 0.45, -s * 0.62, s * 0.24, s * 0.21);
        ctx.beginPath(); ctx.moveTo(-s * 0.1, -s * 0.48); ctx.quadraticCurveTo(-s * 0.4, -s * (1 + flap), -s * 0.7, -s * (0.75 + flap)); ctx.lineTo(s * 0.2, -s * 0.5); ctx.fill();
        ctx.fillStyle = P.c(c.tH + 0.5, 70, 1);
        ctx.beginPath(); ctx.moveTo(s * 0.66, -s * 0.66); ctx.lineTo(s * 0.92, -s * 0.6); ctx.lineTo(s * 0.66, -s * 0.54); ctx.fill();
        eye = [s * 0.5, -s * 0.66];
      }
      ctx.fillStyle = "#fff"; ell(eye[0], eye[1], s * 0.1, s * 0.1);
      ctx.fillStyle = "#151515"; ell(eye[0] + s * 0.03, eye[1], s * 0.05, s * 0.05);
      ctx.restore();
    }
    if (beat) st.n = (st.n ?? 0) + 1;
    post(a, 0.25);
  },

  // ---------------- Graffiti: glossy splats and neon tags on a dark wall
  graffiti(a) {
    const { ctx, w, h, f, beat, t, P, st, q, col } = a;
    if (!st.layer || st.layer.width !== w || st.layer.height !== h) {
      const mk = () => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
      st.wall = mk();
      const wl = st.wall.getContext("2d")!;
      const g = wl.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, col.bg2);
      g.addColorStop(1, col.bg);
      wl.fillStyle = g;
      wl.fillRect(0, 0, w, h);
      wl.strokeStyle = "rgba(255,255,255,0.035)";
      wl.lineWidth = 1;
      const bh = 30 * q, bw = 64 * q;
      for (let y = 0; y < h; y += bh) for (let x = (y / bh) % 2 ? -bw / 2 : 0; x < w; x += bw) wl.strokeRect(x, y, bw, bh);
      st.layer = mk();
      st.layer.getContext("2d")!.drawImage(st.wall, 0, 0);
    }
    const L: Ctx = st.layer.getContext("2d")!;
    const hues = [0, 0.5, 0.25, 0.75];
    const transient = beat || (f.treble > 0.62 && Math.random() < 0.12);
    if (transient) {
      const x = rnd(0.1, 0.9) * w, y = rnd(0.12, 0.72) * h;
      const tH = hues[Math.floor(Math.random() * hues.length)];
      const r = (24 + f.bass * 80) * q;
      const pts: [number, number][] = [];
      const n = 14;
      for (let k = 0; k <= n + 1; k++) {
        const an = (k / n) * Math.PI * 2;
        const rr = r * (k % n === 0 ? 1 : rnd(0.7, 1.25));
        pts.push([x + Math.cos(an) * rr, y + Math.sin(an) * rr]);
      }
      const g = L.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r * 1.2);
      g.addColorStop(0, P.c(tH, 75, 1));
      g.addColorStop(1, P.c(tH, 50, 1));
      L.fillStyle = g;
      L.beginPath();
      smoothThrough(L, pts);
      L.closePath();
      L.fill();
      // gloss
      L.fillStyle = "rgba(255,255,255,0.18)";
      L.beginPath();
      L.ellipse(x - r * 0.35, y - r * 0.4, r * 0.35, r * 0.15, -0.5, 0, Math.PI * 2);
      L.fill();
      // droplets + drips
      L.fillStyle = P.c(tH, 60, 1);
      for (let k = 0; k < 18; k++) {
        const an = rnd(0, Math.PI * 2), d = r * rnd(1.2, 2.3);
        L.beginPath();
        L.arc(x + Math.cos(an) * d, y + Math.sin(an) * d, rnd(1.5, 5) * q, 0, Math.PI * 2);
        L.fill();
      }
      for (let k = 0; k < 3; k++) {
        const dx = x + rnd(-r * 0.6, r * 0.6), len = rnd(25, 100) * (0.5 + f.bass) * q, dw = rnd(3, 6) * q;
        L.beginPath();
        L.roundRect(dx - dw / 2, y + r * 0.3, dw, len, dw / 2);
        L.arc(dx, y + r * 0.3 + len, dw * 0.8, 0, Math.PI * 2);
        L.fill();
      }
      if (Math.random() < 0.22) {
        L.save();
        L.translate(rnd(0.15, 0.85) * w, rnd(0.25, 0.8) * h);
        L.rotate(rnd(-0.25, 0.25));
        L.font = `900 ${Math.round(rnd(36, 72) * q)}px ${col.font}`;
        L.textAlign = "center";
        const tag = ["DRIFTKORD", "HI-FI", "BASS", "LOUD", "24/192", "★", "VIBE"][Math.floor(Math.random() * 7)];
        L.shadowColor = P.c(tH + 0.5, 65, 1);
        L.shadowBlur = 18 * q;
        L.lineWidth = 3 * q;
        L.strokeStyle = "#fff";
        L.strokeText(tag, 0, 0);
        L.shadowBlur = 0;
        L.fillStyle = P.c(tH + 0.5, 62, 1);
        L.fillText(tag, 0, 0);
        L.restore();
      }
    }
    // spray mist following the mids
    L.fillStyle = P.c((t * 0.05) % 1, 70, 0.2);
    const sx = (Math.sin(t * 0.6) * 0.4 + 0.5) * w, sy = (Math.cos(t * 0.45) * 0.3 + 0.45) * h;
    for (let k = 0; k < 24 * f.mid; k++) L.fillRect(sx + rnd(-30, 30) * q, sy + rnd(-30, 30) * q, 1.5 * q, 1.5 * q);
    // slow fade back to the bare wall
    L.globalAlpha = 0.012;
    L.drawImage(st.wall, 0, 0);
    L.globalAlpha = 1;
    ctx.drawImage(st.layer, 0, 0);
    post(a, 0.3);
  },

  // ---------------- Ink: particles advected through a flow field leave silky ink filaments
  ink(a) {
    backdrop(a, 0.6);
    const { ctx, w, h, f, beat, t, dt, P, st, q } = a;
    const lw = Math.max(2, (w / 2) | 0), lh = Math.max(2, (h / 2) | 0);
    if (!st.layer || st.layer.width !== lw || st.layer.height !== lh) {
      st.layer = document.createElement("canvas");
      st.layer.width = lw;
      st.layer.height = lh;
      const l = st.layer.getContext("2d")!;
      l.fillStyle = "#000";
      l.fillRect(0, 0, lw, lh);
      st.ps = Array.from({ length: 420 }, () => ({ x: Math.random() * lw, y: Math.random() * lh, tH: Math.random() }));
    }
    const L: Ctx = st.layer.getContext("2d")!;
    L.globalCompositeOperation = "source-over";
    L.globalAlpha = 0.06;
    L.fillStyle = "#000";
    L.fillRect(0, 0, lw, lh);
    L.globalAlpha = 1;
    const loud = (f.rms[0] + f.rms[1]) * 0.5;
    if (beat) {
      // a fresh ink drop: pull a group of particles into a new bloom
      const x = rnd(0.15, 0.85) * lw, y = rnd(0.15, 0.85) * lh, tH = Math.random();
      for (let i = 0; i < 70; i++) {
        const p = st.ps[(Math.random() * st.ps.length) | 0];
        const an = rnd(0, Math.PI * 2), d = rnd(0, 18);
        p.x = x + Math.cos(an) * d; p.y = y + Math.sin(an) * d; p.tH = tH;
      }
      const g = L.createRadialGradient(x, y, 0, x, y, 40 + f.bass * 60);
      g.addColorStop(0, P.c(tH, 60, 0.35));
      g.addColorStop(1, P.c(tH, 60, 0));
      L.fillStyle = g;
      L.fillRect(0, 0, lw, lh);
    }
    L.globalCompositeOperation = "lighter";
    L.lineWidth = 1.1;
    L.lineCap = "round";
    const sp = (18 + loud * 160 + f.bass * 40) * dt;
    for (const p of st.ps) {
      const an = (Math.sin(p.x * 0.012 + t * 0.25) + Math.cos(p.y * 0.014 - t * 0.2) + Math.sin((p.x + p.y) * 0.006 + t * 0.1)) * Math.PI;
      const nx = p.x + Math.cos(an) * sp, ny = p.y + Math.sin(an) * sp;
      L.strokeStyle = P.c(p.tH, 62, 0.14 + loud * 0.2);
      L.beginPath();
      L.moveTo(p.x, p.y);
      L.lineTo(nx, ny);
      L.stroke();
      p.x = nx; p.y = ny;
      if (p.x < 0 || p.x > lw || p.y < 0 || p.y > lh) { p.x = Math.random() * lw; p.y = Math.random() * lh; }
    }
    ctx.imageSmoothingQuality = "high";
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(st.layer, 0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    post(a, 0.45);
  },

  // ---------------- Orbit (new): radial spectrum around a spinning cover "record"
  orbit(a) {
    backdrop(a);
    const { ctx, w, h, f, beat, dt, P, st, q, cover } = a;
    const cx = w / 2, cy = h / 2;
    st.bass = ease(st.bass ?? 0, f.bass, 0.25);
    const R = Math.min(w, h) * 0.2 * (1 + st.bass * 0.08);
    st.rot = (st.rot ?? 0) + dt * (0.08 + f.mid * 0.3);
    const N = 96;
    st.v = st.v ?? new Array(N).fill(0);
    ctx.globalCompositeOperation = "lighter";
    // shockwave rings
    st.waves = st.waves ?? [];
    if (beat) st.waves.push({ r: R, a: 0.7 });
    for (let i = st.waves.length - 1; i >= 0; i--) {
      const wv = st.waves[i];
      wv.r += dt * Math.min(w, h) * 0.45;
      wv.a -= dt * 0.9;
      if (wv.a <= 0) { st.waves.splice(i, 1); continue; }
      ctx.strokeStyle = P.c(0.5, 70, wv.a * 0.5);
      ctx.lineWidth = 2 * q;
      ctx.beginPath();
      ctx.arc(cx, cy, wv.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // bars
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(2 * q, ((Math.PI * 2 * R) / N) * 0.42);
    for (let i = 0; i < N; i++) {
      const band = Math.floor((Math.abs((i / N) * 2 - 1)) * 54);
      st.v[i] = ease(st.v[i], f.bands[band] ?? 0, 0.35);
      const an = (i / N) * Math.PI * 2 + st.rot - Math.PI / 2;
      const len = 4 * q + st.v[i] * R * 0.95;
      const r0 = R + 8 * q;
      ctx.strokeStyle = P.c(i / N, 64 + st.v[i] * 18, 0.9);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(an) * r0, cy + Math.sin(an) * r0);
      ctx.lineTo(cx + Math.cos(an) * (r0 + len), cy + Math.sin(an) * (r0 + len));
      ctx.stroke();
    }
    // core glow
    const cg = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.6);
    cg.addColorStop(0, P.c(0.2, 70, 0.35 + st.bass * 0.3));
    cg.addColorStop(1, P.c(0.2, 60, 0));
    ctx.fillStyle = cg;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    // the "record": cover art (or gradient) rotating inside a ring
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(st.rot * 0.6);
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.92, 0, Math.PI * 2);
    ctx.clip();
    if (cover && cover.complete && cover.naturalWidth) ctx.drawImage(cover, -R * 0.92, -R * 0.92, R * 1.84, R * 1.84);
    else {
      const g = ctx.createLinearGradient(-R, -R, R, R);
      g.addColorStop(0, P.c(0, 45, 1));
      g.addColorStop(1, P.c(0.5, 22, 1));
      ctx.fillStyle = g;
      ctx.fillRect(-R, -R, R * 2, R * 2);
    }
    // vinyl grooves + spindle
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1;
    for (let k = 0.35; k < 0.92; k += 0.05) { ctx.beginPath(); ctx.arc(0, 0, R * k, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
    ctx.fillStyle = a.col.bg;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = P.c(0.3, 75, 0.7);
    ctx.lineWidth = 1.5 * q;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.94, 0, Math.PI * 2);
    ctx.stroke();
    post(a, 0.5);
  },

  // ---------------- Horizon (new): glowing ridge lines receding to a sunset horizon
  horizon(a) {
    backdrop(a, 0.7);
    const { ctx, w, h, f, t, dt, P, st, q, col } = a;
    const horizonY = h * 0.38;
    // sun
    const sr = Math.min(w, h) * 0.16;
    const sg = ctx.createLinearGradient(0, horizonY - sr * 2, 0, horizonY);
    sg.addColorStop(0, P.c(0.35, 70, 0.9));
    sg.addColorStop(1, P.c(0.05, 60, 0.9));
    ctx.save();
    ctx.beginPath();
    ctx.arc(w / 2, horizonY, sr * (1 + f.bass * 0.05), Math.PI, 0);
    ctx.fillStyle = sg;
    ctx.shadowColor = P.c(0.2, 65, 0.8);
    ctx.shadowBlur = 50 * q;
    ctx.fill();
    ctx.restore();
    // history of spectra
    st.hist = st.hist ?? [];
    st.acc = (st.acc ?? 0) + dt;
    if (st.acc > 1 / 24) {
      st.acc = 0;
      st.hist.push(f.bands.slice(0, 56));
      if (st.hist.length > 34) st.hist.shift();
    }
    const rows: number[][] = st.hist;
    const n = rows.length;
    for (let r = 0; r < n; r++) {
      const depth = (r + 1) / n; // 0 far → 1 near
      const y0 = horizonY + Math.pow(depth, 1.8) * (h * 0.95 - horizonY);
      const half = w * (0.18 + 0.42 * depth);
      const bands = rows[r];
      const pts: [number, number][] = [];
      const cols = 56;
      for (let i = 0; i <= cols; i++) {
        const u = i / cols; // 0..1 across
        const centre = Math.exp(-Math.pow((u - 0.5) / 0.22, 2));
        const band = bands[Math.floor(Math.abs(u - 0.5) * 2 * 50)] ?? 0;
        const wob = Math.sin(u * 30 + r * 0.7 + t * 0.6) * 0.04;
        const lift = (band * (0.35 + centre * 0.9) + wob * centre) * h * 0.16 * depth;
        pts.push([w / 2 - half + u * half * 2, y0 - lift]);
      }
      // occlude what's behind, then stroke the ridge
      ctx.beginPath();
      smoothThrough(ctx, pts);
      ctx.lineTo(pts[pts.length - 1][0], h);
      ctx.lineTo(pts[0][0], h);
      ctx.closePath();
      ctx.fillStyle = col.bg;
      ctx.fill();
      ctx.beginPath();
      smoothThrough(ctx, pts);
      ctx.strokeStyle = P.c(depth * 0.6, 55 + depth * 20, 0.25 + depth * 0.75);
      ctx.lineWidth = (0.8 + depth * 1.6) * q;
      ctx.stroke();
    }
    post(a, 0.5);
  },
};

// ------------------------------------------------------------------ lyric-reactive rendering
// Scripts whose letters join/combine (Devanagari & other Indic, Thai, Lao, Myanmar, Khmer…):
// animating single code points breaks matras and conjuncts, so these animate per word.
const SHAPED = /[ऀ-෿฀-໿က-႟ក-៿꣠-ꣿ]/;
// Right-to-left scripts keep the whole line as one unit so word order stays correct.
const RTL = /[֐-׿؀-ۿݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/;
const graphemes: { segment: (s: string) => Iterable<{ segment: string }> } | null =
  typeof Intl !== "undefined" && (Intl as any).Segmenter ? new (Intl as any).Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Split a lyric line into units that can be animated independently without breaking the script. */
export function lyricUnits(text: string): string[] {
  if (RTL.test(text)) return [text];
  if (SHAPED.test(text)) return text.split(/(\s+)/).filter((s) => s.length).map((s) => (/^\s+$/.test(s) ? " " : s));
  if (graphemes) return Array.from(graphemes.segment(text), (s) => s.segment);
  return [...text];
}

function drawLyrics(viz: VizId, a: DrawArgs, ly: LyricView, big: boolean) {
  const { ctx, w, h, f, t, col, st } = a;
  if (!ly.text) return;
  const size = Math.round(Math.min(w * 0.05, h * 0.075) * (big ? 1 : 0.7));
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Indic scripts need a font with those glyphs; Nirmala UI ships with Windows.
  const font = `${col.font}, "Nirmala UI", "Segoe UI", sans-serif`;
  ctx.font = `700 ${size}px ${font}`;
  const chars = lyricUnits(ly.text);
  let widths = chars.map((c) => ctx.measureText(c).width);
  let total = widths.reduce((s, v) => s + v, 0);
  // shrink long lines so they always fit on screen
  const maxW = w * 0.9;
  if (total > maxW) {
    const k = Math.max(0.45, maxW / total);
    ctx.font = `700 ${Math.round(size * k)}px ${font}`;
    widths = chars.map((c) => ctx.measureText(c).width);
    total = widths.reduce((s, v) => s + v, 0);
  }
  const sung = Math.floor(chars.length * Math.min(1, ly.progress * 1.25));
  let x0 = w / 2 - total / 2;
  const baseY = h * 0.72;
  const colorFor = (i: number) => (i < sung ? col.accent : rgba(col.text, 0.85));

  chars.forEach((ch, i) => {
    const cw = widths[i];
    let x = x0 + cw / 2, y = baseY, rot = 0, alpha = 1, blur = 0, scale = 1;
    switch (viz) {
      case "silk": {
        // ride the main ribbon
        const pts: [number, number][] | undefined = st.mainWave;
        if (pts && pts.length) {
          const idx = Math.max(0, Math.min(pts.length - 2, Math.floor((x / w) * (pts.length - 1))));
          const [ax, ay] = pts[idx], [bx, by] = pts[idx + 1];
          y = ay + (by - ay) * ((x - ax) / Math.max(1, bx - ax)) - size * 0.9;
          rot = Math.atan2(by - ay, bx - ax);
        }
        break;
      }
      case "ink": {
        // characters diffuse and drift the longer the line has been on screen
        const age = Math.max(0, ly.age);
        const seed = i * 12.9898;
        x += Math.sin(seed + t * 0.5) * age * 4;
        y += Math.cos(seed * 1.7 + t * 0.4) * age * 3 - age * 2;
        blur = Math.min(2.5, age * 0.4 * (i < sung ? 0.3 : 1));
        alpha = Math.max(0.15, 1 - age * 0.06);
        break;
      }
      case "balloon": {
        const rise = ((t * 0.3 + i * 0.07) % 1) * 0;
        y = baseY - Math.sin(t * 2 + i * 0.6) * 8 - f.bass * 20 - rise;
        if (ch !== " ") {
          ctx.fillStyle = rgba(col.accent, 0.09);
          ctx.beginPath();
          ctx.arc(x, y, size * 0.62 * (1 + f.bass * 0.3), 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case "gate": {
        const z = 1 - ly.progress;
        scale = 0.6 + (1 - z) * 0.8 + f.bass * 0.2;
        x = w / 2 + (x - w / 2) * scale;
        y = h / 2 + (baseY - h / 2) * 0.3;
        alpha = Math.min(1, 0.4 + ly.progress);
        break;
      }
      case "glow":
        blur = 0;
        ctx.shadowColor = col.glow;
        ctx.shadowBlur = 8 + f.bass * 40 + (i < sung ? 12 : 0);
        break;
      case "orbit":
        y = h * 0.9;
        break;
      case "horizon":
        y = h * 0.2 + Math.sin(t * 1.2 + i * 0.4) * 3;
        break;
      case "albumart":
        x += (a.pointer.x - 0.5) * -18;
        y = h * 0.86 + (a.pointer.y - 0.5) * -10;
        break;
      case "animal": {
        const hop = Math.abs(Math.sin(t * 6 + i * 0.5)) * (6 + f.bass * 26);
        y = baseY - hop;
        scale = 1 + (hop > 15 ? 0.08 : 0);
        break;
      }
      case "graffiti":
        rot = Math.sin(i * 1.7) * 0.18;
        y = baseY + Math.sin(i * 2.3) * 6;
        if (i < sung && ch !== " ") {
          ctx.fillStyle = rgba(col.accent, 0.6);
          ctx.fillRect(x - 1.5, y + size * 0.4, 3, (Math.sin(i * 3.1) * 0.5 + 0.5) * size * 0.9);
        }
        break;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    if (blur > 0.2) ctx.filter = `blur(${blur.toFixed(1)}px)`;
    if (viz === "graffiti") {
      ctx.lineWidth = 5;
      ctx.strokeStyle = "#000";
      ctx.strokeText(ch, 0, 0);
    } else if (viz !== "glow") {
      ctx.shadowColor = rgba(col.bg, 0.8);
      ctx.shadowBlur = 8;
    }
    ctx.fillStyle = colorFor(i);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    x0 += cw;
  });
  if (big && ly.next) {
    ctx.font = `500 ${Math.round(size * 0.5)}px ${font}`;
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = col.text;
    ctx.fillText(ly.next, w / 2, baseY + size * 1.4);
  }
  ctx.restore();
}

// ------------------------------------------------------------------ React component
export function Visualizer({
  viz, cover, lyrics, duration = 0, showLyrics = false, bigLyrics = false, className, fps = 60, lyricOffset = 0,
}: {
  viz: VizId; cover: string | null; lyrics?: LyricLine[] | null; duration?: number; showLyrics?: boolean;
  bigLyrics?: boolean; className?: string; fps?: number; lyricOffset?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const props = useRef({ viz, lyrics, duration, showLyrics, bigLyrics, fps, lyricOffset });
  props.current = { viz, lyrics, duration, showLyrics, bigLyrics, fps, lyricOffset };
  const coverImg = useRef<HTMLImageElement | null>(null);
  const palette = useRef<string[]>([]);

  useEffect(() => {
    if (!cover) {
      coverImg.current = null;
      palette.current = [];
      return;
    }
    const img = new Image();
    img.onload = () => {
      coverImg.current = img;
      palette.current = extractPalette(img);
    };
    img.src = cover;
  }, [cover]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d", { alpha: false })!;
    let raf = 0;
    let last = performance.now();
    let lastDraw = 0;
    let quality = 1; // render scale, lowered automatically on slow machines
    let slow = 0;
    let state: any = {};
    let curViz = props.current.viz;
    let colors = readColors();
    let stage = stageColors(colors);
    let pal = makePal(colors);
    const fx = makeFx();
    let colorTick = 0;
    const pointer = { x: 0.5, y: 0.5 };
    let lastBeats = live.beats;
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.x = (e.clientX - r.left) / Math.max(1, r.width);
      pointer.y = (e.clientY - r.top) / Math.max(1, r.height);
    };
    window.addEventListener("pointermove", onMove);
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const minDt = 1000 / props.current.fps;
      if (now - lastDraw < minDt - 1) return;
      lastDraw = now;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const dpr = quality;
      const cw = Math.max(1, Math.floor(canvas.clientWidth * dpr)), ch = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
        state.layer = null;
      }
      if (props.current.viz !== curViz) {
        curViz = props.current.viz;
        state = {};
      }
      if (++colorTick % 30 === 0) {
        colors = readColors();
        stage = stageColors(colors);
        pal = makePal(colors);
      }
      const beat = live.beats !== lastBeats;
      lastBeats = live.beats;
      const args: DrawArgs = { ctx, w: cw, h: ch, f: live.frame, t: now / 1000, dt, beat, col: stage, st: state, cover: coverImg.current, palette: palette.current, pointer, P: pal, fx, q: dpr };
      try {
        drawers[curViz](args);
        if (props.current.showLyrics && props.current.lyrics) {
          const ly = lyricAt(props.current.lyrics, livePosition() + props.current.lyricOffset - live.lyricLatency, props.current.duration);
          if (ly) drawLyrics(curViz, args, ly, props.current.bigLyrics);
        }
      } catch (e) {
        state = {};
      }
      const cost = performance.now() - now;
      if (cost > 12) {
        if (++slow > 15 && quality > 0.5) { quality = Math.max(0.5, quality - 0.25); slow = 0; state.layer = null; }
      } else slow = Math.max(0, slow - 1);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return <canvas ref={canvasRef} className={`visualizer ${className ?? ""}`} />;
}

// ------------------------------------------------------------------ Ambient particle layer (theme surfaces)
export function Particles({ kind }: { kind: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (kind === "none") return;
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    const N = { rain: 140, snow: 90, petals: 36, leaves: 26, stars: 160, bubbles: 40, embers: 60, fireflies: 40 }[kind] ?? 50;
    const ps = Array.from({ length: N }, () => ({ x: Math.random(), y: Math.random(), s: Math.random(), p: Math.random() * 6 }));
    let last = performance.now();
    const col = readColors();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 32) return; // ambient particles at ~30 fps
      const dt = Math.min(0.06, (now - last) / 1000);
      last = now;
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } else ctx.clearRect(0, 0, w, h);
      const energy = live.frame.bass;
      for (const p of ps) {
        switch (kind) {
          case "rain":
            p.y += dt * (1.4 + p.s);
            p.x += dt * 0.05;
            ctx.strokeStyle = rgba(col.text, 0.12 + p.s * 0.15);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(p.x * w, p.y * h);
            ctx.lineTo(p.x * w + 3, p.y * h + 14 + p.s * 10);
            ctx.stroke();
            break;
          case "snow":
            p.y += dt * (0.04 + p.s * 0.06);
            p.x += Math.sin(now / 1000 + p.p) * dt * 0.02;
            ctx.fillStyle = rgba("#ffffff", 0.5 + p.s * 0.4);
            ctx.beginPath();
            ctx.arc(p.x * w, p.y * h, 1 + p.s * 2.5, 0, Math.PI * 2);
            ctx.fill();
            break;
          case "petals":
          case "leaves": {
            p.y += dt * (0.05 + p.s * 0.05);
            p.x += Math.sin(now / 900 + p.p) * dt * 0.05 + dt * 0.02;
            ctx.save();
            ctx.translate(p.x * w, p.y * h);
            ctx.rotate(now / 1000 * (0.5 + p.s) + p.p);
            ctx.fillStyle = kind === "petals" ? rgba("#ffb7c9", 0.75) : rgba(["#e8692a", "#c9452a", "#ffbf3f", "#7a9a5a"][Math.floor(p.p) % 4], 0.8);
            ctx.beginPath();
            ctx.ellipse(0, 0, 6 + p.s * 4, 3 + p.s * 2, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            break;
          }
          case "stars": {
            const tw = 0.4 + 0.6 * Math.abs(Math.sin(now / 700 * (0.3 + p.s) + p.p));
            ctx.fillStyle = rgba("#ffffff", tw * (0.35 + p.s * 0.5));
            ctx.fillRect(p.x * w, p.y * h, 1 + p.s * 1.5, 1 + p.s * 1.5);
            break;
          }
          case "bubbles":
            p.y -= dt * (0.03 + p.s * 0.05 + energy * 0.1);
            p.x += Math.sin(now / 800 + p.p) * dt * 0.01;
            ctx.strokeStyle = rgba(col.accent, 0.35);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(p.x * w, p.y * h, 3 + p.s * 8, 0, Math.PI * 2);
            ctx.stroke();
            break;
          case "embers":
            p.y -= dt * (0.04 + p.s * 0.08 + energy * 0.15);
            p.x += Math.sin(now / 600 + p.p) * dt * 0.02;
            ctx.fillStyle = rgba(col.accent, 0.3 + 0.5 * Math.abs(Math.sin(now / 300 + p.p)));
            ctx.beginPath();
            ctx.arc(p.x * w, p.y * h, 1 + p.s * 2, 0, Math.PI * 2);
            ctx.fill();
            break;
          case "fireflies":
            p.x += Math.sin(now / 1500 + p.p) * dt * 0.03;
            p.y += Math.cos(now / 1700 + p.p * 2) * dt * 0.03;
            ctx.fillStyle = rgba("#fff7a0", 0.2 + 0.7 * Math.abs(Math.sin(now / 500 + p.p)));
            ctx.beginPath();
            ctx.arc(p.x * w, p.y * h, 2, 0, Math.PI * 2);
            ctx.fill();
            break;
        }
        if (p.y > 1.05) { p.y = -0.05; p.x = Math.random(); }
        if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); }
        if (p.x > 1.05) p.x = -0.05;
        if (p.x < -0.05) p.x = 1.05;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [kind]);
  if (kind === "none") return null;
  return <canvas ref={ref} className="particles" aria-hidden />;
}
