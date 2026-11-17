// The "Custom" theme: a full theme definition the user edits (layout, controls, chrome, surface,
// fonts, palette, shape, motion…) plus extras no preset has — UI scale, glass, background image,
// per-element styling, navigation order/visibility/labels and free-form CSS.
import type { Theme } from "./themes";

export const CUSTOM_ID = "custom";

export type ElementId =
  | "titlebar" | "nav" | "transport" | "main" | "panels" | "buttons" | "playbutton" | "inputs" | "cards"
  | "lyrics" | "fullplayer" | "visualizer" | "toasts";

export interface ElementStyle {
  bg?: string; text?: string; border?: string; borderW?: number; radius?: number;
  opacity?: number; fontScale?: number; blur?: number; padding?: number; shadow?: "inherit" | "none" | "soft" | "glow"; hidden?: boolean;
}

export const ELEMENTS: { id: ElementId; name: string; hint: string; selector: string; canHide: boolean }[] = [
  { id: "titlebar", name: "Title bar", hint: "Window bar with minimise / maximise / close", selector: ".app > .titlebar", canHide: false },
  { id: "nav", name: "Navigation", hint: "Sidebar, icon rail, tabs or rack buttons", selector: ".app > .nav", canHide: true },
  { id: "transport", name: "Player bar", hint: "Now playing, buttons, progress, volume", selector: ".transport", canHide: false },
  { id: "main", name: "Page area", hint: "Background behind every page", selector: ".main", canHide: false },
  { id: "panels", name: "Panels", hint: "Boxes that group settings and content", selector: ".panel, .ss-card, .ss-stage-card, .sc-layer, .int-card", canHide: false },
  { id: "buttons", name: "Buttons", hint: "Regular buttons and icon buttons", selector: ".btn, .icon-btn:not(.big):not(.play-btn)", canHide: false },
  { id: "playbutton", name: "Play button", hint: "The big play / pause button", selector: ".play-btn, .icon-btn.big", canHide: false },
  { id: "inputs", name: "Text boxes & menus", hint: "Inputs, drop-downs, text areas", selector: "input:not([type=range]):not([type=color]), select, textarea", canHide: false },
  { id: "cards", name: "Cards", hint: "Theme, scene and preset cards", selector: ".theme-card, .sc-scene, .ss-preset, .stream-tab", canHide: false },
  { id: "lyrics", name: "Lyrics", hint: "Lyrics panel and full-screen lyrics", selector: ".lyrics-panel, .fp-line, .lyric-line", canHide: false },
  { id: "fullplayer", name: "Full-screen player", hint: "Opens when you click the album art", selector: ".fp-art, .fp-seg, .fp-q", canHide: false },
  { id: "visualizer", name: "Visualizer stage", hint: "The big visualizer on Now Playing", selector: ".np-stage", canHide: true },
  { id: "toasts", name: "Notifications", hint: "Little messages at the bottom", selector: ".toast", canHide: true },
];

export interface CustomTheme {
  version: 1;
  name: string;
  basedOn: string;
  theme: Omit<Theme, "id" | "name" | "category" | "blurb">;
  uiScale: number;        // 0.8 – 1.3 (zoom)
  textScale: number;      // 0.85 – 1.4
  letterSpacing: number;  // em, -0.02 – 0.15
  lineHeight: number;     // 1.2 – 1.9
  panelOpacity: number;   // 0.2 – 1
  glassBlur: number;      // px 0 – 30
  bgFit: "cover" | "contain" | "tile";
  bgBlur: number;         // px
  bgDim: number;          // 0 – 0.9
  animSpeed: number;      // 0.25 – 2 (multiplies durations)
  reduceMotion: boolean;
  accentGradient: boolean;
  scrollbars: "normal" | "thin" | "hidden";
  elements: Partial<Record<ElementId, ElementStyle>>;
  nav: { order: string[]; hidden: string[]; labels: Record<string, string> };
  css: string;
  // ---- sizes & density
  density: "compact" | "comfortable" | "spacious";
  navMode: "labels" | "icons";
  sidebarWidth: number;   // px (sidebar layouts)
  iconScale: number;      // 0.8 – 1.5
  // ---- buttons & interaction
  buttonStyle: "theme" | "filled" | "outline" | "ghost" | "pill";
  hoverColor: string | null;
  selectionColor: string | null;
  focusColor: string | null;
  headingWeight: number;  // 0 = theme
  bodyWeight: number;     // 0 = theme
  // ---- player
  playShape: "theme" | "circle" | "squircle" | "square";
  artShape: "theme" | "square" | "rounded" | "circle";
  progressThickness: number; // 0 = theme
  toastPos: "bottom" | "top";
  // ---- background gradient & grain
  bgMode: "theme" | "solid" | "linear" | "radial" | "mesh";
  bgAngle: number;
  bgColors: [string, string, string];
  grain: number;          // 0 – 0.3
  // ---- lyrics
  lyricsFont: string;     // "" = theme
  lyricsScale: number;
  lyricsActive: string | null;
  lyricsAlign: "left" | "center";
  lyricsGlow: boolean;
}

export function customFrom(t: Theme): CustomTheme {
  const { id, name, category, blurb, ...rest } = t;
  void id; void category; void blurb;
  return {
    version: 1, name: `My ${name}`, basedOn: t.id, theme: JSON.parse(JSON.stringify(rest)),
    uiScale: 1, textScale: 1, letterSpacing: 0, lineHeight: 1.45, panelOpacity: 1, glassBlur: 0,
    bgFit: "cover", bgBlur: 0, bgDim: 0.35, animSpeed: 1, reduceMotion: false, accentGradient: false, scrollbars: "normal",
    elements: {}, nav: { order: [], hidden: [], labels: {} }, css: "",
    density: "comfortable", navMode: "labels", sidebarWidth: 220, iconScale: 1,
    buttonStyle: "theme", hoverColor: null, selectionColor: null, focusColor: null, headingWeight: 0, bodyWeight: 0,
    playShape: "theme", artShape: "theme", progressThickness: 0, toastPos: "bottom",
    bgMode: "theme", bgAngle: 135, bgColors: [t.c.bg, t.c.bg2, t.c.accent], grain: 0,
    lyricsFont: "", lyricsScale: 1, lyricsActive: null, lyricsAlign: "left", lyricsGlow: true,
  };
}

/** Fill gaps in a stored / imported config with defaults (older exports, hand-written files). */
export function normalizeCustom(x: Partial<CustomTheme> | null | undefined, fallback: Theme): CustomTheme {
  const base = customFrom(fallback);
  if (!x || typeof x !== "object") return base;
  return {
    ...base, ...x,
    theme: { ...base.theme, ...(x.theme ?? {}), fonts: { ...base.theme.fonts, ...(x.theme?.fonts ?? {}) }, c: { ...base.theme.c, ...(x.theme?.c ?? {}) } },
    elements: { ...(x.elements ?? {}) },
    nav: { order: x.nav?.order ?? [], hidden: x.nav?.hidden ?? [], labels: x.nav?.labels ?? {} },
    version: 1,
  };
}

export function customAsTheme(c: CustomTheme): Theme {
  if (c.lyricsFont) loadExtraFont(c.lyricsFont);
  // see-through panels are part of the palette, so album-art adaptive colours keep them
  const op = Math.max(0.05, Math.min(1, c.panelOpacity));
  const pal = op < 1
    ? { ...c.theme.c, panel: `color-mix(in srgb, ${c.theme.c.panel} ${Math.round(op * 100)}%, transparent)`, panel2: `color-mix(in srgb, ${c.theme.c.panel2} ${Math.round(op * 100)}%, transparent)` }
    : c.theme.c;
  return { ...c.theme, c: pal, id: CUSTOM_ID, name: c.name || "Custom", category: "Custom", blurb: "Your own theme — every element is yours to change." };
}

const extraFonts = new Set<string>();
function loadExtraFont(name: string) {
  if (extraFonts.has(name) || /^(Segoe UI|Arial|Verdana|Georgia|Times New Roman|Trebuchet MS|Consolas|Cascadia Code)/i.test(name)) return;
  extraFonts.add(name);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, "+")}:wght@300;400;600;700&display=swap`;
  document.head.appendChild(link);
}

// ------------------------------------------------------------------ colour helpers
/** "#rrggbb" + alpha → css colour */
export function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || a >= 1) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${+a.toFixed(2)})`;
}
/** css colour → { hex, alpha } for colour pickers (accepts #rgb, #rrggbb, rgb(), rgba()) */
export function splitColor(v: string | undefined): { hex: string; alpha: number } {
  if (!v) return { hex: "#000000", alpha: 1 };
  let m = /^#([0-9a-f]{3})$/i.exec(v.trim());
  if (m) return { hex: "#" + m[1].split("").map((ch) => ch + ch).join(""), alpha: 1 };
  m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (m) return { hex: v.trim().toLowerCase(), alpha: 1 };
  const r = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i.exec(v);
  if (r) {
    const hex = "#" + [r[1], r[2], r[3]].map((x) => (+x).toString(16).padStart(2, "0")).join("");
    return { hex, alpha: r[4] !== undefined ? +r[4] : 1 };
  }
  return { hex: "#000000", alpha: 1 };
}

// ------------------------------------------------------------------ apply extras
let bgImage: string | null = null;
export function setCustomBackground(dataUrl: string | null) { bgImage = dataUrl; }
export function getCustomBackground() { return bgImage; }

const DUR = { snappy: 140, smooth: 320, bouncy: 420, instant: 0 } as const;

/** Write the custom theme's extras on top of applyTheme(). Call with null when another theme is active. */
export function applyCustomExtras(c: CustomTheme | null) {
  const root = document.documentElement;
  let style = document.getElementById("dk-custom-theme") as HTMLStyleElement | null;
  if (!c) {
    style?.remove();
    root.style.removeProperty("--custom-bg");
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = "dk-custom-theme";
    document.head.appendChild(style);
  }
  const s = root.style;
  s.setProperty("--dur", `${Math.round(DUR[c.theme.motion] * c.animSpeed)}ms`);
  if (bgImage) s.setProperty("--custom-bg", `url("${bgImage}")`); else s.removeProperty("--custom-bg");

  const R = "html.theme-custom";
  const rules: string[] = [];
  if (c.uiScale !== 1) rules.push(`${R} .app { zoom: ${c.uiScale}; }`);
  rules.push(`${R} body { font-size: ${(14 * c.textScale).toFixed(2)}px; letter-spacing: ${c.letterSpacing}em; line-height: ${c.lineHeight}; }`);
  if (c.textScale !== 1) rules.push(`${R} .btn, ${R} .nav button, ${R} .panel, ${R} .muted.small, ${R} small { font-size: ${c.textScale}em; }`);
  if (c.glassBlur > 0) rules.push(`${R} .panel, ${R} .transport, ${R} .app > .nav, ${R} .app > .titlebar, ${R} .ss-card, ${R} .int-card { backdrop-filter: blur(${c.glassBlur}px) saturate(1.2); -webkit-backdrop-filter: blur(${c.glassBlur}px) saturate(1.2); }`);
  if (bgImage) {
    const fit = c.bgFit === "tile" ? "auto" : c.bgFit;
    rules.push(`${R} .surface { background: var(--custom-bg) center / ${fit} ${c.bgFit === "tile" ? "repeat" : "no-repeat"} fixed !important; filter: blur(${c.bgBlur}px) brightness(${(1 - c.bgDim).toFixed(2)}); transform: scale(${c.bgBlur ? 1.05 : 1}); opacity: 1 !important; }`);
  }
  if (c.accentGradient) rules.push(`${R} .btn.primary, ${R} .play-btn, ${R} .icon-btn.big, ${R} .segmented button.on { background: linear-gradient(135deg, var(--accent), var(--accent2)) !important; border-color: transparent !important; }`);
  if (c.reduceMotion) rules.push(`${R} *, ${R} *::before, ${R} *::after { animation: none !important; transition: none !important; }`);
  if (c.scrollbars === "thin") rules.push(`${R} * { scrollbar-width: thin; } ${R} ::-webkit-scrollbar { width: 6px; height: 6px; }`);
  if (c.scrollbars === "hidden") rules.push(`${R} * { scrollbar-width: none; } ${R} ::-webkit-scrollbar { display: none; }`);
  for (const el of ELEMENTS) {
    const e = c.elements[el.id];
    if (!e) continue;
    const sel = el.selector.split(",").map((x) => `${R} ${x.trim()}`).join(", ");
    if (e.hidden && el.canHide) { rules.push(`${sel} { display: none !important; }`); continue; }
    const d: string[] = [];
    if (e.bg) d.push(`background: ${e.bg} !important`);
    if (e.text) d.push(`color: ${e.text} !important`);
    if (e.border) d.push(`border-color: ${e.border} !important`);
    if (e.borderW !== undefined) d.push(`border-width: ${e.borderW}px !important`, `border-style: solid !important`);
    if (e.radius !== undefined) d.push(`border-radius: ${e.radius}px !important`);
    if (e.opacity !== undefined && e.opacity < 1) d.push(`opacity: ${e.opacity}`);
    if (e.fontScale !== undefined && e.fontScale !== 1) d.push(`font-size: ${e.fontScale}em`);
    if (e.blur) d.push(`backdrop-filter: blur(${e.blur}px)`, `-webkit-backdrop-filter: blur(${e.blur}px)`);
    if (e.padding !== undefined) d.push(`padding: ${e.padding}px !important`);
    if (e.shadow && e.shadow !== "inherit") d.push(`box-shadow: ${{ none: "none", soft: "0 10px 30px rgba(0,0,0,.25)", glow: "0 0 18px color-mix(in srgb, var(--glow) 55%, transparent)" }[e.shadow]} !important`);
    if (d.length) rules.push(`${sel} { ${d.join("; ")}; }`);
  }
  // ---- sizes & density
  const D = { compact: 0.72, comfortable: 1, spacious: 1.3 }[c.density] ?? 1;
  if (D !== 1) {
    rules.push(`${R} .btn { padding: ${Math.round(7 * D)}px ${Math.round(13 * D)}px; }
${R} .panel-head { padding: ${Math.round(12 * D)}px ${Math.round(16 * D)}px; }
${R} .panel-body { padding: ${Math.round(14 * D)}px ${Math.round(16 * D)}px; gap: ${Math.round(12 * D)}px; }
${R} .view, ${R} .grid2 { gap: ${Math.round(14 * D)}px; }
${R} .main { padding: ${Math.round(18 * D)}px; }
${R} .nav-side button { padding-top: ${Math.round(8 * D)}px; padding-bottom: ${Math.round(8 * D)}px; }`);
  }
  if (c.navMode === "icons") rules.push(`${R} .nav-side button span, ${R} .nav-group-title, ${R} .nav-tabs button span { display: none; } ${R} .nav-side button, ${R} .nav-tabs button { justify-content: center; }`);
  if (c.theme.layout === "bottom-bar") {
    const w = c.navMode === "icons" ? 64 : Math.round(c.sidebarWidth);
    rules.push(`${R}.layout-bottom-bar .app { grid-template-columns: ${w}px 1fr; }`);
  }
  if (c.iconScale !== 1) rules.push(`${R} .icon-btn svg, ${R} .nav svg, ${R} .btn svg { transform: scale(${c.iconScale}); }`);
  // ---- buttons & interaction
  const bs = {
    filled: "background: var(--accent) !important; color: var(--bg) !important; border-color: var(--accent) !important;",
    outline: "background: transparent !important; border: max(1px, var(--bw)) solid var(--accent) !important; color: var(--accent) !important;",
    ghost: "background: transparent !important; border-color: transparent !important;",
    pill: "border-radius: 999px !important;",
  }[c.buttonStyle as "filled"];
  if (bs) rules.push(`${R} .btn { ${bs} }`);
  if (c.hoverColor) rules.push(`${R} .btn:hover, ${R} .icon-btn:hover, ${R} .nav button:hover { background: ${c.hoverColor} !important; }`);
  if (c.selectionColor) rules.push(`${R} ::selection { background: ${c.selectionColor}; }`);
  if (c.focusColor) rules.push(`${R} :focus-visible { outline: 2px solid ${c.focusColor} !important; outline-offset: 2px; }`);
  if (c.headingWeight) rules.push(`${R} h1, ${R} h2, ${R} h3, ${R} .view-title, ${R} .panel-head, ${R} .t-title, ${R} .fp-title { font-weight: ${c.headingWeight} !important; }`);
  if (c.bodyWeight) rules.push(`${R} body { font-weight: ${c.bodyWeight}; }`);
  // ---- player
  const ps = { circle: "50%", squircle: "30%", square: "4px" }[c.playShape as "circle"];
  if (ps) rules.push(`${R} .play-btn, ${R} .icon-btn.big { border-radius: ${ps} !important; }`);
  const as = { square: "0", rounded: "14px", circle: "50%" }[c.artShape as "square"];
  if (as !== undefined) rules.push(`${R} .cover-mini, ${R} .np-cover, ${R} .fp-art, ${R} .fp-art img { border-radius: ${as} !important; }`);
  if (c.progressThickness > 0) {
    const h = c.progressThickness;
    rules.push(`${R} .role-progress .fader-fill, ${R} .role-progress .fader-track::before { height: ${h}px !important; margin-top: ${-h / 2}px !important; border-radius: ${h}px; }
${R} .role-progress .glass-track { height: ${h + 4}px !important; }`);
  }
  if (c.toastPos === "top") rules.push(`${R} .toast { top: 64px; bottom: auto !important; }`);
  // ---- background gradient & grain (ignored while a wallpaper image is set)
  if (!bgImage && c.bgMode !== "theme") {
    const [a, b, d3] = c.bgColors;
    const g = {
      solid: a,
      linear: `linear-gradient(${c.bgAngle}deg, ${a}, ${b})`,
      radial: `radial-gradient(circle at 30% 20%, ${b}, ${a} 70%)`,
      mesh: `radial-gradient(at 15% 20%, ${d3} 0, transparent 45%), radial-gradient(at 85% 15%, ${b} 0, transparent 50%), radial-gradient(at 50% 95%, ${b} 0, transparent 55%), ${a}`,
    }[c.bgMode];
    rules.push(`${R} .surface { background: ${g} !important; opacity: 1 !important; }`);
  }
  if (c.grain > 0) {
    const noise = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")";
    rules.push(`${R} .surface::after { content: ""; position: absolute; inset: 0; background-image: ${noise}; opacity: ${c.grain}; mix-blend-mode: overlay; pointer-events: none; }`);
  }
  // ---- lyrics
  const L = `${R} .fp-line, ${R} .lyric-line`;
  const ld: string[] = [];
  if (c.lyricsFont) ld.push(`font-family: "${c.lyricsFont}", var(--font-display) !important`);
  if (c.lyricsAlign === "center") ld.push("text-align: center", "transform-origin: center center !important");
  if (ld.length) rules.push(`${L} { ${ld.join("; ")}; }`);
  if (c.lyricsScale !== 1) rules.push(`${R} .fp-line { font-size: calc(clamp(17px, 1.75vw, 26px) * ${c.lyricsScale}) !important; } ${R} .lyric-line { font-size: ${c.lyricsScale}em; }`);
  if (c.lyricsActive) rules.push(`${R} .fp-line.now, ${R} .lyric-line.current { color: ${c.lyricsActive} !important; }`);
  if (!c.lyricsGlow) rules.push(`${R} .fp-line.now, ${R} .lyric-line.current { text-shadow: none !important; }`);

  rules.push(`/* your CSS */\n${c.css}`);
  style.textContent = rules.join("\n");
}
