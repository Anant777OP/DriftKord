// 50 full-UI morphing themes (10 categories × 5).
// A theme is not a palette: it selects the layout architecture, the control widget family,
// the window chrome, the surface material, typography, icon weight, motion and ambient particles.
import type { VizId } from "./store";

export type Layout = "bottom-bar" | "floating-dock" | "left-rail" | "hardware-rack" | "cinema";
export type Control = "rotary" | "led" | "pixel" | "ink" | "glass" | "fader" | "bevel";
export type Chrome = "win95" | "aqua" | "mica" | "hud" | "minimal" | "rack" | "paper" | "brutal";
export type Surface =
  | "brushed" | "scanlines" | "mica" | "paper" | "carbon" | "grid" | "marble" | "velvet" | "noise" | "holo"
  | "concrete" | "blueprint" | "stars" | "silk" | "wood" | "pinstripe" | "aero" | "none";
export type IconStyle = "line" | "bold" | "pixel" | "hairline" | "duotone";
export type Particles = "none" | "rain" | "snow" | "petals" | "leaves" | "stars" | "bubbles" | "embers" | "fireflies";
export type Motion = "snappy" | "smooth" | "bouncy" | "instant";

export interface Palette {
  bg: string; bg2: string; panel: string; panel2: string; text: string; muted: string;
  accent: string; accent2: string; border: string; glow: string;
}

export interface Theme {
  id: string;
  name: string;
  category: string;
  layout: Layout;
  control: Control;
  chrome: Chrome;
  surface: Surface;
  icon: IconStyle;
  particles: Particles;
  motion: Motion;
  radius: number;
  borderW: number;
  shadow: "none" | "soft" | "hard" | "glow";
  uppercase: boolean;
  fonts: { display: string; body: string; mono: string };
  c: Palette;
  viz: VizId;
  blurb: string;
}

type Def = Omit<Theme, "category" | "uppercase" | "borderW" | "shadow"> & Partial<Pick<Theme, "uppercase" | "borderW" | "shadow">>;

function cat(category: string, defs: Def[]): Theme[] {
  return defs.map((d) => ({ uppercase: false, borderW: 1, shadow: "soft", ...d, category }));
}

export const THEMES: Theme[] = [
  // ------------------------------------------------------------------ 0. DriftKord (the app's own look; default)
  ...cat("DriftKord", [
    {
      id: "driftkord-black", name: "DriftKord Black", layout: "bottom-bar", control: "fader", chrome: "minimal", surface: "none",
      icon: "line", particles: "none", motion: "smooth", radius: 14, shadow: "none",
      fonts: { display: "Unbounded", body: "Inter", mono: "JetBrains Mono" },
      c: { bg: "#000000", bg2: "#070707", panel: "#0c0c0c", panel2: "rgba(255,255,255,.055)", text: "#f4f4f4", muted: "#8b8b8b", accent: "#ffffff", accent2: "#b9b9b9", border: "rgba(255,255,255,.11)", glow: "#ffffff" },
      viz: "horizon", blurb: "The original. Pure black, hairline white, wide geometric type — nothing but your music.",
    },
    {
      id: "driftkord-white", name: "DriftKord White", layout: "bottom-bar", control: "fader", chrome: "minimal", surface: "none",
      icon: "line", particles: "none", motion: "smooth", radius: 14, shadow: "none",
      fonts: { display: "Unbounded", body: "Inter", mono: "JetBrains Mono" },
      c: { bg: "#ffffff", bg2: "#f5f5f5", panel: "#fafafa", panel2: "rgba(0,0,0,.045)", text: "#0b0b0b", muted: "#707070", accent: "#0b0b0b", accent2: "#4d4d4d", border: "rgba(0,0,0,.11)", glow: "#000000" },
      viz: "horizon", blurb: "The original, inverted. Paper white, ink black, the same quiet geometry.",
    },
  ]),
  // ------------------------------------------------------------------ 1. Gaming
  ...cat("Gaming", [
    {
      id: "cyberpunk-neon", name: "Cyberpunk Neon", layout: "left-rail", control: "led", chrome: "hud", surface: "grid",
      icon: "bold", particles: "none", motion: "snappy", radius: 2, shadow: "glow", uppercase: true,
      fonts: { display: "Orbitron", body: "Rajdhani", mono: "Share Tech Mono" },
      c: { bg: "#07030f", bg2: "#14062a", panel: "rgba(20,6,40,.82)", panel2: "rgba(255,0,170,.08)", text: "#f5e9ff", muted: "#a58bc4", accent: "#ff1fb4", accent2: "#00f0ff", border: "rgba(255,31,180,.55)", glow: "#ff1fb4" },
      viz: "gate", blurb: "Neon-soaked HUD, segmented LED controls, chamfered panels.",
    },
    {
      id: "tactical-hud", name: "Tactical HUD", layout: "hardware-rack", control: "led", chrome: "hud", surface: "scanlines",
      icon: "line", particles: "none", motion: "instant", radius: 0, shadow: "none", uppercase: true,
      fonts: { display: "Share Tech Mono", body: "Share Tech Mono", mono: "Share Tech Mono" },
      c: { bg: "#050806", bg2: "#0b120c", panel: "rgba(12,24,14,.9)", panel2: "rgba(140,255,120,.05)", text: "#c8ffbf", muted: "#5f8f5a", accent: "#8dff6a", accent2: "#ffb300", border: "rgba(141,255,106,.45)", glow: "#8dff6a" },
      viz: "gate", blurb: "Night-vision telemetry racks with bracketed readouts.",
    },
    {
      id: "retro-arcade", name: "Retro Arcade", layout: "bottom-bar", control: "pixel", chrome: "brutal", surface: "scanlines",
      icon: "pixel", particles: "stars", motion: "instant", radius: 0, borderW: 4, shadow: "hard", uppercase: true,
      fonts: { display: "Press Start 2P", body: "VT323", mono: "VT323" },
      c: { bg: "#0b0b2b", bg2: "#1b1464", panel: "#14124a", panel2: "#24207a", text: "#fffbe0", muted: "#9b98d8", accent: "#ffd400", accent2: "#ff3c3c", border: "#ffd400", glow: "#ffd400" },
      viz: "animal", blurb: "Chunky pixel blocks, coin-op marquee type, CRT glow.",
    },
    {
      id: "esports-minimal", name: "Esports Minimal", layout: "floating-dock", control: "fader", chrome: "minimal", surface: "noise",
      icon: "bold", particles: "none", motion: "snappy", radius: 6,
      fonts: { display: "Rajdhani", body: "Inter", mono: "JetBrains Mono" },
      c: { bg: "#111316", bg2: "#1a1d22", panel: "rgba(30,33,39,.92)", panel2: "rgba(255,255,255,.04)", text: "#f2f4f7", muted: "#8a919c", accent: "#ff3b3b", accent2: "#ffffff", border: "rgba(255,255,255,.08)", glow: "#ff3b3b" },
      viz: "glow", blurb: "Graphite tournament overlay with a single red signal colour.",
    },
    {
      id: "scifi-holo", name: "Sci-Fi Holo", layout: "cinema", control: "glass", chrome: "hud", surface: "holo",
      icon: "hairline", particles: "stars", motion: "smooth", radius: 14, shadow: "glow",
      fonts: { display: "Michroma", body: "Exo 2", mono: "Share Tech Mono" },
      c: { bg: "#020812", bg2: "#06182e", panel: "rgba(10,40,70,.45)", panel2: "rgba(120,220,255,.08)", text: "#dff6ff", muted: "#7fb4cc", accent: "#5ce1ff", accent2: "#b18cff", border: "rgba(92,225,255,.4)", glow: "#5ce1ff" },
      viz: "gate", blurb: "Full-bleed holographic projection with floating glass panes.",
    },
  ]),
  // ------------------------------------------------------------------ 2. Zen & Nature
  ...cat("Zen & Nature", [
    {
      id: "kyoto-bamboo", name: "Kyoto Bamboo", layout: "left-rail", control: "ink", chrome: "paper", surface: "paper",
      icon: "hairline", particles: "leaves", motion: "smooth", radius: 2, shadow: "none",
      fonts: { display: "Shippori Mincho", body: "Noto Serif JP", mono: "IBM Plex Mono" },
      c: { bg: "#f1ece0", bg2: "#e6dfcd", panel: "rgba(250,246,236,.85)", panel2: "rgba(90,110,60,.06)", text: "#2b2a24", muted: "#7b7865", accent: "#5f7d3a", accent2: "#b23a2a", border: "rgba(43,42,36,.18)", glow: "#5f7d3a" },
      viz: "ink", blurb: "Washi paper, sumi ink strokes and drifting bamboo leaves.",
    },
    {
      id: "midnight-rain", name: "Midnight Rain", layout: "cinema", control: "ink", chrome: "minimal", surface: "noise",
      icon: "hairline", particles: "rain", motion: "smooth", radius: 10,
      fonts: { display: "Cormorant Garamond", body: "Inter", mono: "IBM Plex Mono" },
      c: { bg: "#060a12", bg2: "#0d1626", panel: "rgba(14,22,38,.6)", panel2: "rgba(120,160,220,.06)", text: "#dbe6f5", muted: "#7387a6", accent: "#8fb8ff", accent2: "#c9a6ff", border: "rgba(143,184,255,.18)", glow: "#8fb8ff" },
      viz: "silk", blurb: "Rain on glass at 2 a.m., hairline controls, cinema framing.",
    },
    {
      id: "nordic-frost", name: "Nordic Frost", layout: "floating-dock", control: "glass", chrome: "mica", surface: "mica",
      icon: "line", particles: "snow", motion: "smooth", radius: 18,
      fonts: { display: "Josefin Sans", body: "Nunito Sans", mono: "IBM Plex Mono" },
      c: { bg: "#e8f0f6", bg2: "#d4e2ee", panel: "rgba(255,255,255,.6)", panel2: "rgba(120,160,200,.1)", text: "#1d2b38", muted: "#6a7f92", accent: "#3a86c8", accent2: "#7fc6d8", border: "rgba(29,43,56,.12)", glow: "#7fc6d8" },
      viz: "silk", blurb: "Frosted Mica panes and soft snowfall.",
    },
    {
      id: "desert-dusk", name: "Desert Dusk", layout: "bottom-bar", control: "rotary", chrome: "minimal", surface: "noise",
      icon: "line", particles: "embers", motion: "smooth", radius: 12,
      fonts: { display: "Marcellus", body: "Work Sans", mono: "IBM Plex Mono" },
      c: { bg: "#2a160f", bg2: "#4a2416", panel: "rgba(70,34,20,.78)", panel2: "rgba(255,160,90,.07)", text: "#ffe8d2", muted: "#c79a7c", accent: "#ff8a4c", accent2: "#ffd27a", border: "rgba(255,138,76,.25)", glow: "#ff8a4c" },
      viz: "glow", blurb: "Sandstone dials glowing at sunset.",
    },
    {
      id: "bioluminescent-ocean", name: "Bioluminescent Ocean", layout: "cinema", control: "glass", chrome: "minimal", surface: "none",
      icon: "line", particles: "bubbles", motion: "bouncy", radius: 22, shadow: "glow",
      fonts: { display: "Quicksand", body: "Quicksand", mono: "IBM Plex Mono" },
      c: { bg: "#010b14", bg2: "#022238", panel: "rgba(2,40,60,.5)", panel2: "rgba(0,255,220,.06)", text: "#d6fff8", muted: "#6fb3b0", accent: "#19f5d0", accent2: "#3d8bff", border: "rgba(25,245,208,.3)", glow: "#19f5d0" },
      viz: "balloon", blurb: "Deep-sea glow with rising bubbles.",
    },
  ]),
  // ------------------------------------------------------------------ 3. Audiophile Hi-Fi
  ...cat("Audiophile Hi-Fi", [
    {
      id: "mcintosh-glass", name: "McIntosh Glass", layout: "hardware-rack", control: "rotary", chrome: "rack", surface: "brushed",
      icon: "line", particles: "none", motion: "smooth", radius: 6, shadow: "glow", uppercase: true,
      fonts: { display: "Michroma", body: "IBM Plex Sans", mono: "IBM Plex Mono" },
      c: { bg: "#050608", bg2: "#0d1014", panel: "rgba(10,12,16,.95)", panel2: "rgba(40,140,255,.08)", text: "#dbe8ff", muted: "#7186a6", accent: "#3fa9ff", accent2: "#3cff8f", border: "rgba(63,169,255,.35)", glow: "#3fa9ff" },
      viz: "glow", blurb: "Black glass faceplate, blue watt meters, aluminium knobs.",
    },
    {
      id: "sony-walkman-1989", name: "1989 Sony Walkman", layout: "bottom-bar", control: "rotary", chrome: "rack", surface: "brushed",
      icon: "bold", particles: "none", motion: "snappy", radius: 8, uppercase: true,
      fonts: { display: "Archivo Black", body: "IBM Plex Sans", mono: "IBM Plex Mono" },
      c: { bg: "#1b1c20", bg2: "#2b2d33", panel: "rgba(48,50,57,.94)", panel2: "rgba(255,106,0,.07)", text: "#eceef2", muted: "#9aa0ab", accent: "#ff6a00", accent2: "#c9ced8", border: "rgba(201,206,216,.22)", glow: "#ff6a00" },
      viz: "silk", blurb: "WM-DD9 brushed alloy, orange accents, rotary dials.",
    },
    {
      id: "braun-dieter-rams", name: "Braun Dieter Rams", layout: "left-rail", control: "fader", chrome: "minimal", surface: "none",
      icon: "line", particles: "none", motion: "snappy", radius: 4,
      fonts: { display: "Inter Tight", body: "Inter", mono: "IBM Plex Mono" },
      c: { bg: "#ecebe6", bg2: "#dddcd5", panel: "#f6f5f1", panel2: "#e9e8e2", text: "#1f1f1f", muted: "#7c7c78", accent: "#e35a12", accent2: "#3d8c40", border: "rgba(0,0,0,.12)", glow: "#e35a12" },
      viz: "albumart", blurb: "Less, but better. Off-white, one orange, honest controls.",
    },
    {
      id: "vacuum-tube-warmth", name: "Vacuum Tube Warmth", layout: "hardware-rack", control: "rotary", chrome: "rack", surface: "wood",
      icon: "line", particles: "embers", motion: "smooth", radius: 10, shadow: "glow",
      fonts: { display: "Cinzel", body: "Libre Baskerville", mono: "IBM Plex Mono" },
      c: { bg: "#1a0f08", bg2: "#2e1a0e", panel: "rgba(40,22,12,.92)", panel2: "rgba(255,150,50,.07)", text: "#ffe2bf", muted: "#b48a62", accent: "#ff9b2e", accent2: "#ffcf73", border: "rgba(255,155,46,.28)", glow: "#ff9b2e" },
      viz: "glow", blurb: "Walnut cabinet, glowing filaments, amber VU needles.",
    },
    {
      id: "studio-rack", name: "Studio Rack", layout: "hardware-rack", control: "led", chrome: "rack", surface: "brushed",
      icon: "bold", particles: "none", motion: "instant", radius: 2, uppercase: true,
      fonts: { display: "IBM Plex Mono", body: "IBM Plex Sans", mono: "IBM Plex Mono" },
      c: { bg: "#0b0c0d", bg2: "#17191b", panel: "#1c1f22", panel2: "#24282c", text: "#e7eaee", muted: "#7c848d", accent: "#2bff66", accent2: "#ff3d3d", border: "rgba(255,255,255,.1)", glow: "#2bff66" },
      viz: "gate", blurb: "19-inch rack units, LED ladders, rack ears and screws.",
    },
  ]),
  // ------------------------------------------------------------------ 4. Synthwave
  ...cat("Synthwave", [
    {
      id: "outrun-sunset", name: "Outrun Sunset", layout: "cinema", control: "led", chrome: "hud", surface: "grid",
      icon: "bold", particles: "stars", motion: "smooth", radius: 4, shadow: "glow", uppercase: true,
      fonts: { display: "Monoton", body: "Audiowide", mono: "Share Tech Mono" },
      c: { bg: "#12001f", bg2: "#3a0640", panel: "rgba(40,4,60,.6)", panel2: "rgba(255,90,170,.08)", text: "#ffe6fb", muted: "#c08bd0", accent: "#ff5aa9", accent2: "#ffb43f", border: "rgba(255,90,169,.45)", glow: "#ff5aa9" },
      viz: "gate", blurb: "Chrome sun, neon grid horizon, plasma meters.",
    },
    {
      id: "miami-vice", name: "Miami Vice", layout: "floating-dock", control: "glass", chrome: "minimal", surface: "none",
      icon: "line", particles: "none", motion: "bouncy", radius: 20,
      fonts: { display: "Righteous", body: "Poppins", mono: "IBM Plex Mono" },
      c: { bg: "#0d2a33", bg2: "#123e4a", panel: "rgba(18,62,74,.72)", panel2: "rgba(255,121,198,.08)", text: "#f2fffd", muted: "#86b8bb", accent: "#ff79c6", accent2: "#38e8d6", border: "rgba(56,232,214,.3)", glow: "#38e8d6" },
      viz: "balloon", blurb: "Pastel teal and flamingo pink, rounded glass dock.",
    },
    {
      id: "vhs-glitch", name: "VHS Glitch", layout: "bottom-bar", control: "pixel", chrome: "brutal", surface: "scanlines",
      icon: "pixel", particles: "none", motion: "instant", radius: 0, borderW: 2, shadow: "hard", uppercase: true,
      fonts: { display: "VT323", body: "VT323", mono: "VT323" },
      c: { bg: "#0a0a0c", bg2: "#18181d", panel: "rgba(20,20,26,.9)", panel2: "rgba(0,255,255,.06)", text: "#f0f0f0", muted: "#8b8b95", accent: "#00f6ff", accent2: "#ff2a6d", border: "#00f6ff", glow: "#ff2a6d" },
      viz: "graffiti", blurb: "Tracking errors, RGB split, PLAY ▶ on-screen display.",
    },
    {
      id: "laser-grid", name: "Laser Grid", layout: "left-rail", control: "led", chrome: "hud", surface: "grid",
      icon: "hairline", particles: "none", motion: "snappy", radius: 0, shadow: "glow",
      fonts: { display: "Orbitron", body: "Exo 2", mono: "Share Tech Mono" },
      c: { bg: "#000806", bg2: "#001a12", panel: "rgba(0,26,18,.8)", panel2: "rgba(0,255,140,.06)", text: "#d8ffe9", muted: "#5ea884", accent: "#00ff8c", accent2: "#00b3ff", border: "rgba(0,255,140,.45)", glow: "#00ff8c" },
      viz: "gate", blurb: "Vector-display lasers on a wireframe floor.",
    },
    {
      id: "midnight-drive", name: "Midnight Drive", layout: "cinema", control: "fader", chrome: "minimal", surface: "stars",
      icon: "line", particles: "stars", motion: "smooth", radius: 12,
      fonts: { display: "Syncopate", body: "Exo 2", mono: "Share Tech Mono" },
      c: { bg: "#05031a", bg2: "#140b3c", panel: "rgba(20,11,60,.55)", panel2: "rgba(140,110,255,.07)", text: "#ebe6ff", muted: "#8d84c4", accent: "#8c6bff", accent2: "#ff6bd1", border: "rgba(140,107,255,.3)", glow: "#8c6bff" },
      viz: "silk", blurb: "Empty highway at night, starfield and tail-light reds.",
    },
  ]),
  // ------------------------------------------------------------------ 5. Minimalist
  ...cat("Minimalist", [
    {
      id: "swiss-typography", name: "Swiss Typography", layout: "left-rail", control: "fader", chrome: "brutal", surface: "none",
      icon: "bold", particles: "none", motion: "instant", radius: 0, borderW: 2, shadow: "none", uppercase: true,
      fonts: { display: "Archivo Black", body: "Inter Tight", mono: "IBM Plex Mono" },
      c: { bg: "#ffffff", bg2: "#f2f2f2", panel: "#ffffff", panel2: "#f4f4f4", text: "#111111", muted: "#6e6e6e", accent: "#e30613", accent2: "#111111", border: "#111111", glow: "#e30613" },
      viz: "albumart", blurb: "International style grid, Helvetica-esque bold, red rule.",
    },
    {
      id: "obsidian-oled", name: "Obsidian OLED", layout: "floating-dock", control: "fader", chrome: "minimal", surface: "none",
      icon: "hairline", particles: "none", motion: "smooth", radius: 14,
      fonts: { display: "Manrope", body: "Manrope", mono: "JetBrains Mono" },
      c: { bg: "#000000", bg2: "#050505", panel: "#0a0a0a", panel2: "#111111", text: "#f5f5f5", muted: "#6b6b6b", accent: "#ffffff", accent2: "#9a9a9a", border: "rgba(255,255,255,.07)", glow: "#ffffff" },
      viz: "glow", blurb: "True-black pixels off, white-only accents.",
    },
    {
      id: "pure-paper", name: "Pure Paper", layout: "bottom-bar", control: "ink", chrome: "paper", surface: "paper",
      icon: "hairline", particles: "none", motion: "smooth", radius: 2, shadow: "none",
      fonts: { display: "Libre Baskerville", body: "Lora", mono: "Courier Prime" },
      c: { bg: "#faf7f0", bg2: "#f1ece0", panel: "#fffdf8", panel2: "#f5f0e4", text: "#22201c", muted: "#8a857a", accent: "#22201c", accent2: "#a0522d", border: "rgba(34,32,28,.15)", glow: "#a0522d" },
      viz: "ink", blurb: "A well-set book page with pencil-thin controls.",
    },
    {
      id: "monochrome-ink", name: "Monochrome Ink", layout: "left-rail", control: "ink", chrome: "paper", surface: "paper",
      icon: "line", particles: "none", motion: "smooth", radius: 0, shadow: "none",
      fonts: { display: "Cormorant Garamond", body: "Space Mono", mono: "Space Mono" },
      c: { bg: "#f4f4f2", bg2: "#e8e8e5", panel: "#fbfbfa", panel2: "#efefec", text: "#0d0d0d", muted: "#777", accent: "#0d0d0d", accent2: "#555", border: "rgba(0,0,0,.2)", glow: "#000" },
      viz: "ink", blurb: "Black ink only. Brush-stroke sliders.",
    },
    {
      id: "frosted-glass", name: "Frosted Glass", layout: "floating-dock", control: "glass", chrome: "mica", surface: "mica",
      icon: "line", particles: "none", motion: "smooth", radius: 20,
      fonts: { display: "Manrope", body: "Manrope", mono: "JetBrains Mono" },
      c: { bg: "#dfe6f0", bg2: "#c9d4e3", panel: "rgba(255,255,255,.55)", panel2: "rgba(255,255,255,.3)", text: "#18202c", muted: "#5d6b7d", accent: "#4a6cf7", accent2: "#a06cf7", border: "rgba(255,255,255,.7)", glow: "#4a6cf7" },
      viz: "balloon", blurb: "Windows 11 Mica/Acrylic frosted layers.",
    },
  ]),
  // ------------------------------------------------------------------ 6. Cosmic & Sci-Fi
  ...cat("Cosmic & Sci-Fi", [
    {
      id: "event-horizon", name: "Event Horizon", layout: "cinema", control: "glass", chrome: "hud", surface: "stars",
      icon: "hairline", particles: "stars", motion: "smooth", radius: 999, shadow: "glow",
      fonts: { display: "Michroma", body: "Exo 2", mono: "Share Tech Mono" },
      c: { bg: "#000000", bg2: "#140700", panel: "rgba(20,8,0,.55)", panel2: "rgba(255,140,40,.07)", text: "#ffeedd", muted: "#a07e60", accent: "#ff8a1f", accent2: "#ffd59a", border: "rgba(255,138,31,.3)", glow: "#ff8a1f" },
      viz: "gate", blurb: "Accretion-disk orange around absolute black.",
    },
    {
      id: "nebula-dust", name: "Nebula Dust", layout: "floating-dock", control: "glass", chrome: "minimal", surface: "stars",
      icon: "line", particles: "stars", motion: "bouncy", radius: 24,
      fonts: { display: "Comfortaa", body: "Nunito", mono: "IBM Plex Mono" },
      c: { bg: "#0d0619", bg2: "#2a0f3d", panel: "rgba(42,15,61,.55)", panel2: "rgba(255,120,220,.08)", text: "#fbe9ff", muted: "#b08ac8", accent: "#ff78dc", accent2: "#7a9cff", border: "rgba(255,120,220,.3)", glow: "#ff78dc" },
      viz: "balloon", blurb: "Soft pink-violet nebula clouds.",
    },
    {
      id: "solar-flare", name: "Solar Flare", layout: "bottom-bar", control: "led", chrome: "hud", surface: "noise",
      icon: "bold", particles: "embers", motion: "snappy", radius: 4, shadow: "glow", uppercase: true,
      fonts: { display: "Orbitron", body: "Rajdhani", mono: "Share Tech Mono" },
      c: { bg: "#140300", bg2: "#3a0a00", panel: "rgba(58,10,0,.78)", panel2: "rgba(255,180,0,.08)", text: "#fff1d6", muted: "#c58a5a", accent: "#ffb000", accent2: "#ff3d00", border: "rgba(255,176,0,.4)", glow: "#ff5a00" },
      viz: "glow", blurb: "Coronal mass ejection: plasma bars and embers.",
    },
    {
      id: "deep-space-telemetry", name: "Deep Space Telemetry", layout: "hardware-rack", control: "led", chrome: "hud", surface: "scanlines",
      icon: "line", particles: "none", motion: "instant", radius: 0, shadow: "none", uppercase: true,
      fonts: { display: "Share Tech Mono", body: "IBM Plex Mono", mono: "IBM Plex Mono" },
      c: { bg: "#020203", bg2: "#0b0c10", panel: "rgba(14,15,20,.95)", panel2: "rgba(255,190,60,.05)", text: "#ffd98a", muted: "#8a7550", accent: "#ffbe3c", accent2: "#3cd2ff", border: "rgba(255,190,60,.35)", glow: "#ffbe3c" },
      viz: "gate", blurb: "Mission-control consoles streaming amber data.",
    },
    {
      id: "cryo-stasis", name: "Cryo Stasis", layout: "left-rail", control: "glass", chrome: "mica", surface: "holo",
      icon: "hairline", particles: "snow", motion: "smooth", radius: 16,
      fonts: { display: "Exo 2", body: "Exo 2", mono: "Share Tech Mono" },
      c: { bg: "#e6f6fb", bg2: "#c8e8f2", panel: "rgba(255,255,255,.6)", panel2: "rgba(0,180,220,.07)", text: "#0e2c38", muted: "#5a8796", accent: "#00a8d6", accent2: "#7be0ff", border: "rgba(0,168,214,.25)", glow: "#7be0ff" },
      viz: "silk", blurb: "Frozen pods, ice-blue glass, slow breath of frost.",
    },
  ]),
  // ------------------------------------------------------------------ 7. Brutalist
  ...cat("Brutalist", [
    {
      id: "neo-brutal-yellow", name: "Neo-Brutal Yellow", layout: "bottom-bar", control: "pixel", chrome: "brutal", surface: "none",
      icon: "bold", particles: "none", motion: "instant", radius: 0, borderW: 3, shadow: "hard", uppercase: true,
      fonts: { display: "Archivo Black", body: "Space Grotesk", mono: "Space Mono" },
      c: { bg: "#ffe600", bg2: "#ffd000", panel: "#ffffff", panel2: "#fff7b0", text: "#000000", muted: "#333333", accent: "#000000", accent2: "#ff4fa3", border: "#000000", glow: "#000000" },
      viz: "graffiti", blurb: "Hard black borders, offset shadows, zero apologies.",
    },
    {
      id: "concrete-raw", name: "Concrete Raw", layout: "left-rail", control: "fader", chrome: "brutal", surface: "concrete",
      icon: "bold", particles: "none", motion: "instant", radius: 0, borderW: 2, shadow: "hard", uppercase: true,
      fonts: { display: "Space Grotesk", body: "Space Grotesk", mono: "Space Mono" },
      c: { bg: "#8f8f8c", bg2: "#7a7a77", panel: "rgba(200,200,196,.92)", panel2: "rgba(0,0,0,.05)", text: "#141414", muted: "#3d3d3b", accent: "#141414", accent2: "#d4462a", border: "#141414", glow: "#d4462a" },
      viz: "albumart", blurb: "Board-formed concrete, stencilled labels.",
    },
    {
      id: "terminal-green", name: "Terminal Green", layout: "left-rail", control: "pixel", chrome: "brutal", surface: "scanlines",
      icon: "pixel", particles: "none", motion: "instant", radius: 0, borderW: 1, shadow: "glow",
      fonts: { display: "VT323", body: "IBM Plex Mono", mono: "VT323" },
      c: { bg: "#000000", bg2: "#031003", panel: "rgba(0,20,0,.9)", panel2: "rgba(0,255,70,.05)", text: "#33ff66", muted: "#1a8a3a", accent: "#33ff66", accent2: "#a6ffbf", border: "#33ff66", glow: "#33ff66" },
      viz: "gate", blurb: "Phosphor console, blinking block cursor.",
    },
    {
      id: "blueprint-cad", name: "Blueprint CAD", layout: "hardware-rack", control: "ink", chrome: "minimal", surface: "blueprint",
      icon: "hairline", particles: "none", motion: "snappy", radius: 0, shadow: "none", uppercase: true,
      fonts: { display: "Space Mono", body: "IBM Plex Mono", mono: "Space Mono" },
      c: { bg: "#0b3a7a", bg2: "#0e4590", panel: "rgba(11,58,122,.75)", panel2: "rgba(255,255,255,.05)", text: "#e8f1ff", muted: "#9cb9e6", accent: "#ffffff", accent2: "#ffd36b", border: "rgba(255,255,255,.55)", glow: "#ffffff" },
      viz: "ink", blurb: "Drafting-table linework with dimension callouts.",
    },
    {
      id: "zine-collage", name: "Zine Collage", layout: "floating-dock", control: "pixel", chrome: "brutal", surface: "paper",
      icon: "bold", particles: "none", motion: "bouncy", radius: 0, borderW: 3, shadow: "hard",
      fonts: { display: "Permanent Marker", body: "Courier Prime", mono: "Courier Prime" },
      c: { bg: "#f4efe6", bg2: "#e9e1d2", panel: "#ffffff", panel2: "#ffe3f1", text: "#111", muted: "#555", accent: "#ff2d87", accent2: "#1e5bff", border: "#111", glow: "#ff2d87" },
      viz: "graffiti", blurb: "Photocopied, taped and scrawled DIY punk zine.",
    },
  ]),
  // ------------------------------------------------------------------ 8. Luxury
  ...cat("Luxury", [
    {
      id: "gold-marble", name: "Gold & Marble", layout: "floating-dock", control: "rotary", chrome: "minimal", surface: "marble",
      icon: "hairline", particles: "none", motion: "smooth", radius: 8, uppercase: true,
      fonts: { display: "Cinzel", body: "Cormorant Garamond", mono: "IBM Plex Mono" },
      c: { bg: "#efece6", bg2: "#e2ddd3", panel: "rgba(255,255,255,.8)", panel2: "rgba(184,146,60,.08)", text: "#2a241a", muted: "#8a7d66", accent: "#b8923c", accent2: "#6e5520", border: "rgba(184,146,60,.45)", glow: "#d9b45a" },
      viz: "albumart", blurb: "Carrara marble with brushed-gold dials.",
    },
    {
      id: "midnight-velvet", name: "Midnight Velvet", layout: "cinema", control: "rotary", chrome: "minimal", surface: "velvet",
      icon: "hairline", particles: "none", motion: "smooth", radius: 16, shadow: "glow",
      fonts: { display: "Playfair Display", body: "Cormorant Garamond", mono: "IBM Plex Mono" },
      c: { bg: "#12041c", bg2: "#2a0b3c", panel: "rgba(42,11,60,.6)", panel2: "rgba(214,175,92,.08)", text: "#f5e8ff", muted: "#a98bbd", accent: "#d6af5c", accent2: "#b05cd6", border: "rgba(214,175,92,.35)", glow: "#d6af5c" },
      viz: "silk", blurb: "Plush aubergine velvet, gilt trim.",
    },
    {
      id: "rose-gold-silk", name: "Rose Gold Silk", layout: "floating-dock", control: "glass", chrome: "minimal", surface: "silk",
      icon: "line", particles: "none", motion: "smooth", radius: 22,
      fonts: { display: "DM Serif Display", body: "Poppins", mono: "IBM Plex Mono" },
      c: { bg: "#f6e4df", bg2: "#ecd0c8", panel: "rgba(255,245,242,.72)", panel2: "rgba(196,120,100,.08)", text: "#3a2420", muted: "#9a7068", accent: "#c4786a", accent2: "#e7b5a3", border: "rgba(196,120,106,.3)", glow: "#e7b5a3" },
      viz: "silk", blurb: "Flowing satin sheen in rose gold.",
    },
    {
      id: "champagne-lounge", name: "Champagne Lounge", layout: "bottom-bar", control: "rotary", chrome: "minimal", surface: "noise",
      icon: "hairline", particles: "bubbles", motion: "smooth", radius: 10, uppercase: true,
      fonts: { display: "Marcellus", body: "Tenor Sans", mono: "IBM Plex Mono" },
      c: { bg: "#0f0d0a", bg2: "#1f1a12", panel: "rgba(31,26,18,.85)", panel2: "rgba(240,215,160,.06)", text: "#f6ead2", muted: "#a8977a", accent: "#e8cf98", accent2: "#c9a25a", border: "rgba(232,207,152,.28)", glow: "#e8cf98" },
      viz: "balloon", blurb: "Art-deco lounge, rising bubbles, brass dials.",
    },
    {
      id: "carbon-fiber", name: "Carbon Fiber", layout: "hardware-rack", control: "led", chrome: "rack", surface: "carbon",
      icon: "bold", particles: "none", motion: "snappy", radius: 6, uppercase: true,
      fonts: { display: "Michroma", body: "Rajdhani", mono: "Share Tech Mono" },
      c: { bg: "#0c0c0d", bg2: "#18181a", panel: "rgba(24,24,26,.92)", panel2: "rgba(255,40,40,.06)", text: "#ececec", muted: "#8a8a8f", accent: "#ff2a2a", accent2: "#d0d0d0", border: "rgba(255,255,255,.12)", glow: "#ff2a2a" },
      viz: "gate", blurb: "Supercar dash: twill weave and red shift-lights.",
    },
  ]),
  // ------------------------------------------------------------------ 9. Seasonal
  ...cat("Seasonal", [
    {
      id: "cherry-blossom", name: "Cherry Blossom", layout: "floating-dock", control: "ink", chrome: "paper", surface: "paper",
      icon: "hairline", particles: "petals", motion: "smooth", radius: 18,
      fonts: { display: "Shippori Mincho", body: "Nunito", mono: "IBM Plex Mono" },
      c: { bg: "#fff1f4", bg2: "#ffe0e8", panel: "rgba(255,250,251,.78)", panel2: "rgba(240,120,150,.07)", text: "#3b2228", muted: "#a07580", accent: "#e8628a", accent2: "#7a9a5a", border: "rgba(232,98,138,.22)", glow: "#ffb3c8" },
      viz: "ink", blurb: "Sakura petals drift across rice paper.",
    },
    {
      id: "autumn-maple", name: "Autumn Maple", layout: "bottom-bar", control: "rotary", chrome: "minimal", surface: "wood",
      icon: "line", particles: "leaves", motion: "bouncy", radius: 12,
      fonts: { display: "Lora", body: "Nunito", mono: "IBM Plex Mono" },
      c: { bg: "#2b1408", bg2: "#47200c", panel: "rgba(71,32,12,.85)", panel2: "rgba(230,110,40,.08)", text: "#ffe9d6", muted: "#c1906e", accent: "#e8692a", accent2: "#ffbf3f", border: "rgba(232,105,42,.3)", glow: "#e8692a" },
      viz: "animal", blurb: "Maple leaves tumble on warm oak.",
    },
    {
      id: "winter-aurora", name: "Winter Aurora", layout: "cinema", control: "glass", chrome: "minimal", surface: "stars",
      icon: "line", particles: "snow", motion: "smooth", radius: 18,
      fonts: { display: "Quicksand", body: "Quicksand", mono: "IBM Plex Mono" },
      c: { bg: "#020a14", bg2: "#06203a", panel: "rgba(6,32,58,.55)", panel2: "rgba(80,255,180,.07)", text: "#e2fff4", muted: "#7fa9a8", accent: "#4dffb0", accent2: "#a07bff", border: "rgba(77,255,176,.3)", glow: "#4dffb0" },
      viz: "silk", blurb: "Aurora ribbons over a snowy arctic night.",
    },
    {
      id: "summer-solstice", name: "Summer Solstice", layout: "floating-dock", control: "fader", chrome: "minimal", surface: "none",
      icon: "bold", particles: "fireflies", motion: "bouncy", radius: 26,
      fonts: { display: "Poppins", body: "Poppins", mono: "IBM Plex Mono" },
      c: { bg: "#fff6d9", bg2: "#bfe8ff", panel: "rgba(255,255,255,.75)", panel2: "rgba(255,180,0,.1)", text: "#2a2410", muted: "#7f7350", accent: "#ff9d00", accent2: "#00a2ff", border: "rgba(255,157,0,.25)", glow: "#ffcf4a" },
      viz: "balloon", blurb: "Longest day: sunshine yellow and sky blue.",
    },
    {
      id: "monsoon-mist", name: "Monsoon Mist", layout: "left-rail", control: "glass", chrome: "mica", surface: "noise",
      icon: "line", particles: "rain", motion: "smooth", radius: 14,
      fonts: { display: "Josefin Sans", body: "Nunito Sans", mono: "IBM Plex Mono" },
      c: { bg: "#1b2622", bg2: "#2a3a34", panel: "rgba(42,58,52,.65)", panel2: "rgba(150,210,190,.06)", text: "#e3f2ec", muted: "#8fb0a4", accent: "#7fd6b4", accent2: "#c3e88d", border: "rgba(127,214,180,.22)", glow: "#7fd6b4" },
      viz: "ink", blurb: "Grey-green monsoon haze and steady rain.",
    },
  ]),
  // ------------------------------------------------------------------ 10. Retro OS
  ...cat("Retro OS", [
    {
      id: "windows-95", name: "Windows 95 Classic", layout: "bottom-bar", control: "bevel", chrome: "win95", surface: "none",
      icon: "pixel", particles: "none", motion: "instant", radius: 0, borderW: 2, shadow: "none",
      fonts: { display: "Pixelify Sans", body: "Pixelify Sans", mono: "VT323" },
      c: { bg: "#008080", bg2: "#007070", panel: "#c0c0c0", panel2: "#d4d0c8", text: "#000000", muted: "#1c1c1c", accent: "#000080", accent2: "#1084d0", border: "#808080", glow: "#000080" },
      viz: "albumart", blurb: "Teal desktop, bevelled grey dialogs, navy title bars.",
    },
    {
      id: "aqua-glass", name: "Aqua Glass", layout: "floating-dock", control: "glass", chrome: "aqua", surface: "pinstripe",
      icon: "line", particles: "none", motion: "bouncy", radius: 12,
      fonts: { display: "Nunito Sans", body: "Nunito Sans", mono: "IBM Plex Mono" },
      c: { bg: "#e9eef4", bg2: "#dfe5ec", panel: "rgba(250,251,253,.92)", panel2: "rgba(60,130,230,.08)", text: "#1b1b1b", muted: "#6c7480", accent: "#2f7ff0", accent2: "#7cbaff", border: "rgba(0,0,0,.15)", glow: "#7cbaff" },
      viz: "balloon", blurb: "Lickable gel buttons, pinstripes, traffic lights.",
    },
    {
      id: "amber-crt", name: "Amber CRT", layout: "left-rail", control: "pixel", chrome: "brutal", surface: "scanlines",
      icon: "pixel", particles: "none", motion: "instant", radius: 0, shadow: "glow", uppercase: true,
      fonts: { display: "VT323", body: "VT323", mono: "VT323" },
      c: { bg: "#0d0700", bg2: "#1a0e00", panel: "rgba(26,14,0,.92)", panel2: "rgba(255,176,0,.05)", text: "#ffb000", muted: "#9a6a00", accent: "#ffb000", accent2: "#ffd36b", border: "#ffb000", glow: "#ffb000" },
      viz: "gate", blurb: "Monochrome amber phosphor with bloom.",
    },
    {
      id: "commodore-64", name: "Commodore 64", layout: "bottom-bar", control: "pixel", chrome: "brutal", surface: "none",
      icon: "pixel", particles: "none", motion: "instant", radius: 0, borderW: 4, shadow: "none", uppercase: true,
      fonts: { display: "Silkscreen", body: "Silkscreen", mono: "VT323" },
      c: { bg: "#6c5eb5", bg2: "#5b4fa0", panel: "#352879", panel2: "#40318d", text: "#d8d3ff", muted: "#c9c3ff", accent: "#ffffff", accent2: "#b8c76f", border: "#a59cf0", glow: "#a59cf0" },
      viz: "animal", blurb: "READY. Blue-on-blue BASIC screen with a fat border.",
    },
    {
      id: "frutiger-aero", name: "Frutiger Aero", layout: "floating-dock", control: "glass", chrome: "mica", surface: "aero",
      icon: "duotone", particles: "bubbles", motion: "bouncy", radius: 18, shadow: "glow",
      fonts: { display: "Nunito", body: "Nunito", mono: "IBM Plex Mono" },
      c: { bg: "#bfe9ff", bg2: "#8fd47a", panel: "rgba(255,255,255,.5)", panel2: "rgba(0,160,255,.1)", text: "#0b2a3a", muted: "#4f7487", accent: "#0098ff", accent2: "#38c23a", border: "rgba(255,255,255,.85)", glow: "#7fd8ff" },
      viz: "balloon", blurb: "Glossy sky, grass, water droplets — 2008 optimism.",
    },
  ]),
  // ------------------------------------------------------------------ 11. Mobile OS (design languages of phone software)
  ...cat("Mobile OS", [
    {
      id: "nothing-os", name: "Nothing OS", layout: "floating-dock", control: "led", chrome: "minimal", surface: "none",
      icon: "line", particles: "none", motion: "snappy", radius: 22, shadow: "none",
      fonts: { display: "Doto", body: "Space Grotesk", mono: "Space Mono" },
      c: { bg: "#000000", bg2: "#0b0b0b", panel: "rgba(18,18,18,.96)", panel2: "rgba(255,255,255,.06)", text: "#ffffff", muted: "#8c8c8c", accent: "#d71921", accent2: "#ffffff", border: "rgba(255,255,255,.14)", glow: "#d71921" },
      viz: "gate", blurb: "Monochrome dot-matrix type, a single glyph-red signal and rounded widget tiles on a dot grid.",
    },
    {
      id: "pixel-material", name: "Pixel Material You", layout: "bottom-bar", control: "glass", chrome: "minimal", surface: "none",
      icon: "line", particles: "none", motion: "smooth", radius: 16, shadow: "none",
      fonts: { display: "Roboto Flex", body: "Roboto Flex", mono: "Roboto Mono" },
      c: { bg: "#141218", bg2: "#141218", panel: "#1d1b20", panel2: "#2b2930", text: "#e6e0e9", muted: "#cac4d0", accent: "#d0bcff", accent2: "#ccc2dc", border: "#49454f", glow: "#d0bcff" },
      viz: "silk", blurb: "Material 3 tonal surfaces, pill indicators, a squircle play button and soft dynamic colour.",
    },
    {
      id: "one-ui", name: "One UI", layout: "bottom-bar", control: "glass", chrome: "minimal", surface: "none",
      icon: "line", particles: "none", motion: "smooth", radius: 26, shadow: "none",
      fonts: { display: "Inter Tight", body: "Inter", mono: "Roboto Mono" },
      c: { bg: "#f3f3f3", bg2: "#f3f3f3", panel: "#fcfcfc", panel2: "rgba(0,0,0,.05)", text: "#0a0a0a", muted: "#787878", accent: "#3e91ff", accent2: "#0072de", border: "rgba(0,0,0,.06)", glow: "#3e91ff" },
      viz: "horizon", blurb: "Big airy headers, content within thumb's reach and generously rounded white cards.",
    },
    {
      id: "ios", name: "iOS", layout: "floating-dock", control: "glass", chrome: "minimal", surface: "none",
      icon: "line", particles: "none", motion: "smooth", radius: 10, shadow: "none",
      fonts: { display: "Inter Tight", body: "Inter", mono: "JetBrains Mono" },
      c: { bg: "#f2f2f7", bg2: "#f2f2f7", panel: "#ffffff", panel2: "rgba(118,118,128,.12)", text: "#000000", muted: "#8a8a8e", accent: "#007aff", accent2: "#34c759", border: "rgba(60,60,67,.29)", glow: "#007aff" },
      viz: "albumart", blurb: "Frosted translucent bars, grouped inset lists, system blue and green switches.",
    },
    {
      id: "metro-phone", name: "Windows Phone Metro", layout: "left-rail", control: "fader", chrome: "minimal", surface: "none",
      icon: "line", particles: "none", motion: "snappy", radius: 0, borderW: 2, shadow: "none",
      fonts: { display: "Segoe UI", body: "Segoe UI", mono: "Consolas" },
      c: { bg: "#000000", bg2: "#000000", panel: "#1d1d1d", panel2: "rgba(255,255,255,.08)", text: "#ffffff", muted: "#a0a0a0", accent: "#1ba1e2", accent2: "#a4c400", border: "rgba(255,255,255,.22)", glow: "#1ba1e2" },
      viz: "glow", blurb: "Live-tile colour blocks, huge light lowercase headings, flat edges and tilt on touch.",
    },
  ]),
];

export const CATEGORIES = Array.from(new Set(THEMES.map((t) => t.category)));
/** The app's own look, used on first launch. */
export const DEFAULT_THEME = "driftkord-black";

let customDef: Theme | null = null;
/** The user's Custom theme (built from their settings); null when there is none yet. */
export function registerCustomTheme(t: Theme | null) {
  customDef = t;
}
export function themeById(id: string): Theme {
  if (id === "custom" && customDef) return customDef;
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
}

// ------------------------------------------------------------------ application
const SYSTEM_FONTS = new Set(["Segoe UI", "Consolas"]);
const loadedFonts = new Set<string>();

function loadFonts(t: Theme) {
  const fams = [t.fonts.display, t.fonts.body, t.fonts.mono].filter((f) => !SYSTEM_FONTS.has(f) && !loadedFonts.has(f));
  if (!fams.length) return;
  fams.forEach((f) => loadedFonts.add(f));
  const q = fams.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@300;400;500;600;700`).join("&");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  // Single-weight families reject the weight axis; fall back to plain family on error.
  link.href = `https://fonts.googleapis.com/css2?${q}&display=swap`;
  link.onerror = () => {
    const plain = document.createElement("link");
    plain.rel = "stylesheet";
    plain.href = `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}`).join("&")}&display=swap`;
    document.head.appendChild(plain);
  };
  document.head.appendChild(link);
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** WCAG relative luminance of a #rrggbb colour (-1 if it isn't one). */
function relLum(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return -1;
  const n = parseInt(m[1], 16);
  const ch = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

// ---- adaptive palette layer (album-art colours on top of the active theme)
let current: Theme | null = null;
let override: Partial<Palette> | null = null;

function setColorVars(c: Palette) {
  const s = document.documentElement.style;
  s.setProperty("--bg", c.bg);
  s.setProperty("--bg2", c.bg2);
  s.setProperty("--panel", c.panel);
  s.setProperty("--panel2", c.panel2);
  s.setProperty("--text", c.text);
  s.setProperty("--muted", c.muted);
  s.setProperty("--accent", c.accent);
  s.setProperty("--accent2", c.accent2);
  s.setProperty("--border", c.border);
  s.setProperty("--glow", c.glow);
}

/** Overlay colours (or null to restore the theme's own). Transitions smoothly via @property. */
export function getPaletteOverride(): Partial<Palette> | null {
  return override;
}

export function setPaletteOverride(o: Partial<Palette> | null) {
  override = o && Object.keys(o).length ? o : null;
  if (current) setColorVars({ ...current.c, ...(override ?? {}) });
  document.documentElement.classList.toggle("adaptive-on", !!override);
}

export function applyTheme(t: Theme) {
  loadFonts(t);
  current = t;
  const root = document.documentElement;
  const s = root.style;
  const c = t.c;
  setColorVars({ ...c, ...(override ?? {}) });
  s.setProperty("--radius", `${Math.min(t.radius, 40)}px`);
  s.setProperty("--radius-pill", `${t.radius >= 999 ? 999 : Math.min(t.radius * 2, 999)}px`);
  s.setProperty("--bw", `${t.borderW}px`);
  const fallback = `"Segoe UI Variable", "Segoe UI", system-ui, sans-serif`;
  s.setProperty("--font-display", `"${t.fonts.display}", ${fallback}`);
  s.setProperty("--font-body", `"${t.fonts.body}", ${fallback}`);
  s.setProperty("--font-mono", `"${t.fonts.mono}", Consolas, monospace`);
  s.setProperty("--icon-stroke", { hairline: "1", line: "1.75", bold: "2.6", pixel: "2.5", duotone: "1.75" }[t.icon]);
  s.setProperty("--ease", { snappy: "cubic-bezier(.2,.9,.3,1)", smooth: "cubic-bezier(.4,0,.2,1)", bouncy: "cubic-bezier(.34,1.56,.64,1)", instant: "steps(1,end)" }[t.motion]);
  s.setProperty("--dur", { snappy: "140ms", smooth: "320ms", bouncy: "420ms", instant: "0ms" }[t.motion]);
  const shadow = {
    none: "none",
    soft: "0 10px 30px rgba(0,0,0,.25)",
    hard: `${Math.max(3, t.borderW * 2)}px ${Math.max(3, t.borderW * 2)}px 0 ${c.border}`,
    glow: `0 0 18px color-mix(in srgb, ${c.glow} 55%, transparent), inset 0 0 12px color-mix(in srgb, ${c.glow} 12%, transparent)`,
  }[t.shadow];
  s.setProperty("--shadow", shadow);
  // text on accent-coloured fills (selected tab, play button, primary buttons): the theme's
  // background colour when that reads well, otherwise black or white — whichever contrasts more
  const cr = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const la = relLum(c.accent), lb = relLum(c.bg);
  const onAccent = la < 0 || lb < 0 || cr(la, lb) >= 3 ? c.bg : cr(la, 0) > cr(la, 1) ? "#000000" : "#ffffff";
  s.setProperty("--on-accent", onAccent);
  const light = luminance(c.bg) > 0.55;
  root.dataset.tone = light ? "light" : "dark";
  root.className = [
    `layout-${t.layout}`, `control-${t.control}`, `chrome-${t.chrome}`, `surface-${t.surface}`,
    `icon-${t.icon}`, `motion-${t.motion}`, `shadow-${t.shadow}`, t.uppercase ? "upper" : "", `theme-${t.id}`,
    override ? "adaptive-on" : "",
    root.classList.contains("hud-window") ? "hud-window" : "",
  ].join(" ");
}
