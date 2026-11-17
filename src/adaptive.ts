// Adaptive colours: re-tints whichever theme is active from the current album art.
//  * "accent" – accent / secondary accent / glow come from the cover's most vibrant colours
//  * "full"   – additionally tints backgrounds, panels and borders with the cover's dominant hue
// Lightness is fitted to the theme so text keeps its contrast (WCAG ≥ 3.5:1 for accents).
import { AdaptiveMode, getState, setState, subscribe } from "./store";
import { Palette, setPaletteOverride, themeById } from "./themes";

export type { AdaptiveMode };

type RGB = [number, number, number];
type HSL = [number, number, number];

function rgbToHsl([r, g, b]: RGB): HSL {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]: HSL): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const hex = ([r, g, b]: RGB) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;

function parseColor(c: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const r = /rgba?\(([^)]+)\)/.exec(c);
  if (r) {
    const p = r[1].split(",").map((x) => parseFloat(x));
    return [p[0] || 0, p[1] || 0, p[2] || 0];
  }
  return [0, 0, 0];
}

function relLum([r, g, b]: RGB) {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: RGB, b: RGB) {
  const la = relLum(a), lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Move lightness away from the background until the colour reads clearly against it. */
function fitContrast(c: HSL, bg: RGB, target = 3.5): RGB {
  const darkBg = relLum(bg) < 0.4;
  let [h, s, l] = c;
  s = Math.max(s, 0.5);
  for (let i = 0; i < 40; i++) {
    const rgb = hslToRgb([h, s, l]);
    if (contrast(rgb, bg) >= target) return rgb;
    l = darkBg ? Math.min(0.92, l + 0.025) : Math.max(0.08, l - 0.025);
  }
  return hslToRgb([h, s, l]);
}

interface Extracted { vibrant: HSL[]; dominant: HSL; colorful: boolean; swatches: string[] }

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    if (!src.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

async function extract(src: string): Promise<Extracted | null> {
  const img = await loadImage(src);
  const N = 64;
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(img, 0, 0, N, N);
  let data: Uint8ClampedArray;
  try {
    data = x.getImageData(0, 0, N, N).data;
  } catch {
    return null; // cross-origin image without CORS
  }
  // 24 hue bins for saturated pixels + overall average for the dominant tone
  const bins = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0, n: 0 }));
  const all = { r: 0, g: 0, b: 0, n: 0 };
  for (let i = 0; i < data.length; i += 4) {
    const rgb: RGB = [data[i], data[i + 1], data[i + 2]];
    const [h, s, l] = rgbToHsl(rgb);
    all.r += rgb[0]; all.g += rgb[1]; all.b += rgb[2]; all.n++;
    if (s < 0.2 || l < 0.12 || l > 0.9) continue;
    const bin = bins[Math.floor(h / 15) % 24];
    const w = s * s * (1 - Math.abs(l - 0.5) * 1.4);
    bin.w += w; bin.r += rgb[0] * w; bin.g += rgb[1] * w; bin.b += rgb[2] * w; bin.n++;
  }
  const ranked = bins
    .map((b, i) => ({ ...b, i }))
    .filter((b) => b.w > 0 && b.n > 6)
    .sort((a, b) => b.w - a.w)
    .map((b) => rgbToHsl([b.r / b.w, b.g / b.w, b.b / b.w]));
  // pick up to three hues that are clearly different from each other
  const vibrant: HSL[] = [];
  for (const h of ranked) {
    if (vibrant.every((v) => Math.min(Math.abs(v[0] - h[0]), 360 - Math.abs(v[0] - h[0])) > 35)) vibrant.push(h);
    if (vibrant.length === 3) break;
  }
  const dominant = rgbToHsl([all.r / all.n, all.g / all.n, all.b / all.n]);
  const colorful = vibrant.length > 0;
  return { vibrant, dominant, colorful, swatches: [...vibrant.map((v) => hex(hslToRgb(v))), hex(hslToRgb(dominant))] };
}

/** Build palette overrides for the active theme. */
function build(ex: Extracted, mode: AdaptiveMode, themeId: string): Partial<Palette> | null {
  const base = themeById(themeId).c;
  const bg = parseColor(base.bg);
  if (!ex.colorful) return null; // greyscale cover: keep the theme's own colours
  const a1 = fitContrast(ex.vibrant[0], bg);
  const a2 = fitContrast(ex.vibrant[1] ?? [(ex.vibrant[0][0] + 40) % 360, ex.vibrant[0][1], ex.vibrant[0][2]], bg, 2.8);
  const o: Partial<Palette> = { accent: hex(a1), accent2: hex(a2), glow: hex(a1) };
  if (mode === "full") {
    const [, , bgL] = rgbToHsl(bg);
    const [, , bg2L] = rgbToHsl(parseColor(base.bg2));
    const hue = (ex.dominant[1] > 0.12 ? ex.dominant : ex.vibrant[0])[0];
    const sat = Math.min(0.45, Math.max(0.18, ex.dominant[1] * 0.8 + 0.1));
    // keep the theme's lightness so its text colours stay readable
    o.bg = hex(hslToRgb([hue, sat * (bgL > 0.5 ? 0.6 : 1), bgL]));
    o.bg2 = hex(hslToRgb([(hue + 18) % 360, sat * (bgL > 0.5 ? 0.6 : 1), bg2L]));
    o.panel = `color-mix(in srgb, ${base.panel} 80%, ${o.bg2} 20%)`;
    o.panel2 = `color-mix(in srgb, ${hex(a1)} 9%, transparent)`;
    o.border = `color-mix(in srgb, ${hex(a1)} 32%, transparent)`;
  }
  return o;
}

// ------------------------------------------------------------------ wiring
let lastKey = "";
let seq = 0;

async function refresh() {
  const s = getState();
  const key = `${s.adaptive}|${s.themeId}|${s.cover ?? ""}`;
  if (key === lastKey) return;
  lastKey = key;
  const my = ++seq;
  if (s.adaptive === "off" || !s.cover) {
    setPaletteOverride(null);
    if (s.adaptive === "off") setState({ adaptiveSwatches: [] });
    return;
  }
  try {
    const ex = await extract(s.cover);
    if (my !== seq) return; // a newer cover arrived meanwhile
    if (!ex) {
      setPaletteOverride(null);
      return;
    }
    setPaletteOverride(build(ex, s.adaptive, s.themeId));
    setState({ adaptiveSwatches: ex.swatches });
  } catch {
    if (my === seq) setPaletteOverride(null);
  }
}

let started = false;
export function initAdaptive() {
  if (started) return;
  started = true;
  let t: number | undefined;
  subscribe(() => {
    window.clearTimeout(t);
    t = window.setTimeout(refresh, 60);
  });
  refresh();
}
