// Custom theme editor (Vivaldi-style): sections on the left, every change applies live.
// Only shown while the Custom theme is selected.
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { api, ModInfo } from "../api";
import { customFrom, CustomTheme, ElementId, ELEMENTS, ElementStyle, normalizeCustom, splitColor, withAlpha } from "../customTheme";
import { EXAMPLE_CSS, EXAMPLE_JS, forgetMod, isEnabled, lastModError, reloadStyleMod, setModEnabled } from "../mods";
import { NAV } from "../nav";
import { Slider } from "../controls";
import { getState, setState, toast, useStore } from "../store";
import { CATEGORIES, Palette, THEMES, themeById } from "../themes";
import { VISUALIZERS } from "../visualizers";

type Tab = "start" | "layout" | "controls" | "colors" | "type" | "shape" | "sizes" | "background" | "player" | "elements" | "nav" | "motion" | "css" | "mods" | "share";
const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "start", label: "Start", hint: "Presets, name, reset" },
  { id: "layout", label: "Layout", hint: "Structure, window chrome, texture, icons" },
  { id: "controls", label: "Controls & buttons", hint: "Sliders, buttons, hover & focus" },
  { id: "colors", label: "Colours", hint: "Every colour in the palette" },
  { id: "type", label: "Typography", hint: "Fonts, weights, sizes, spacing" },
  { id: "shape", label: "Shape & depth", hint: "Corners, borders, glass, shadows" },
  { id: "sizes", label: "Sizes & density", hint: "Scale, spacing, sidebar, icons" },
  { id: "background", label: "Background", hint: "Wallpaper, gradients, grain" },
  { id: "player", label: "Player & lyrics", hint: "Album art, progress bar, lyrics" },
  { id: "elements", label: "Elements", hint: "Style each part separately" },
  { id: "nav", label: "Navigation", hint: "Order, hide and rename pages" },
  { id: "motion", label: "Motion & effects", hint: "Animation, particles, visualizer" },
  { id: "css", label: "Custom CSS", hint: "Write your own styles" },
  { id: "mods", label: "Mods", hint: "Install local style & script mods" },
  { id: "share", label: "Import & export", hint: "Save, share and load themes" },
];

const OPTS = {
  layout: [["bottom-bar", "Bottom bar"], ["floating-dock", "Floating dock"], ["left-rail", "Icon rail"], ["hardware-rack", "Hardware rack"], ["cinema", "Cinema"]],
  control: [["rotary", "Rotary knobs"], ["fader", "Faders"], ["led", "LED segments"], ["pixel", "Pixel blocks"], ["ink", "Ink strokes"], ["glass", "Glass"], ["bevel", "Bevelled"]],
  chrome: [["minimal", "Minimal"], ["mica", "Windows 11 Mica"], ["aqua", "Aqua"], ["win95", "Windows 95"], ["hud", "HUD"], ["rack", "Rack"], ["paper", "Paper"], ["brutal", "Brutal"]],
  surface: [["none", "None"], ["noise", "Film grain"], ["brushed", "Brushed metal"], ["scanlines", "CRT scanlines"], ["mica", "Mica"], ["paper", "Paper"], ["carbon", "Carbon fibre"], ["grid", "Neon grid"], ["marble", "Marble"], ["velvet", "Velvet"], ["holo", "Holographic"], ["concrete", "Concrete"], ["blueprint", "Blueprint"], ["stars", "Starfield"], ["silk", "Silk"], ["wood", "Wood"], ["pinstripe", "Pinstripe"], ["aero", "Aero"]],
  icon: [["line", "Line"], ["bold", "Bold"], ["hairline", "Hairline"], ["pixel", "Pixel"], ["duotone", "Duotone"]],
  particles: [["none", "None"], ["rain", "Rain"], ["snow", "Snow"], ["petals", "Petals"], ["leaves", "Leaves"], ["stars", "Stars"], ["bubbles", "Bubbles"], ["embers", "Embers"], ["fireflies", "Fireflies"]],
  motion: [["snappy", "Snappy"], ["smooth", "Smooth"], ["bouncy", "Bouncy"], ["instant", "Instant"]],
  shadow: [["none", "None"], ["soft", "Soft"], ["hard", "Hard offset"], ["glow", "Glow"]],
} as const;

const PALETTE: { key: keyof Palette; name: string; hint: string }[] = [
  { key: "bg", name: "Background", hint: "Window background" },
  { key: "bg2", name: "Background 2", hint: "Second gradient colour" },
  { key: "panel", name: "Panels", hint: "Boxes and bars" },
  { key: "panel2", name: "Raised", hint: "Buttons, hover, inputs" },
  { key: "text", name: "Text", hint: "Main text" },
  { key: "muted", name: "Secondary text", hint: "Hints and labels" },
  { key: "accent", name: "Accent", hint: "Highlights, play button" },
  { key: "accent2", name: "Accent 2", hint: "Second highlight" },
  { key: "border", name: "Borders", hint: "Outlines and dividers" },
  { key: "glow", name: "Glow", hint: "Glows and LEDs" },
];

const FONT_SUGGESTIONS = [...new Set([
  "Segoe UI Variable", "Segoe UI", "Arial", "Verdana", "Georgia", "Times New Roman", "Trebuchet MS", "Consolas", "Cascadia Code",
  ...THEMES.flatMap((t) => [t.fonts.display, t.fonts.body, t.fonts.mono]),
])].sort();

// ------------------------------------------------------------------ small fields
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="ce-field">
      <span className="ce-label">{label}{hint && <small>{hint}</small>}</span>
      <span className="ce-control">{children}</span>
    </label>
  );
}
function Range({ label, hint, value, min, max, step = 0.01, unit = "", fmt, onChange }: {
  label: string; hint?: string; value: number; min: number; max: number; step?: number; unit?: string; fmt?: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      <output>{fmt ? fmt(value) : `${+value.toFixed(2)}${unit}`}</output>
    </Field>
  );
}
function Select<T extends string>({ label, hint, value, options, onChange }: { label: string; hint?: string; value: T; options: readonly (readonly [string, string])[]; onChange: (v: T) => void }) {
  return (
    <Field label={label} hint={hint}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
      </select>
    </Field>
  );
}
function Check({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Field label={label} hint={hint}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </Field>
  );
}
function ColorField({ label, hint, value, onChange, allowEmpty }: { label: string; hint?: string; value: string | undefined; onChange: (v: string | undefined) => void; allowEmpty?: boolean }) {
  const { hex, alpha } = splitColor(value);
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  return (
    <Field label={label} hint={hint}>
      <span className="ce-swatch" style={{ background: value || "transparent" }}>
        <input type="color" value={hex} onChange={(e) => onChange(withAlpha(e.target.value, alpha))} aria-label={`${label} colour`} />
      </span>
      <input type="range" min={0} max={1} step={0.01} value={value ? alpha : 1} className="ce-alpha" title="Opacity"
        onChange={(e) => onChange(withAlpha(hex, +e.target.value))} aria-label={`${label} opacity`} />
      <input className="ce-text" value={text} spellCheck={false} placeholder={allowEmpty ? "theme default" : ""}
        onChange={(e) => setText(e.target.value)} onBlur={() => onChange(text.trim() || (allowEmpty ? undefined : value))} />
      {allowEmpty && value && <button type="button" className="ce-x" title="Use theme default" onClick={() => onChange(undefined)}>×</button>}
    </Field>
  );
}
function FontField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Field label={label} hint="Any Google Font or font installed on Windows">
      <input list="ce-fonts" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() && onChange(text.trim())}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} style={{ fontFamily: `"${value}"` }} />
    </Field>
  );
}

// ------------------------------------------------------------------ background image: shrink big photos so the theme stays light
async function fileToBackground(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const max = 2560;
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement("canvas");
    cv.width = Math.round(img.naturalWidth * k);
    cv.height = Math.round(img.naturalHeight * k);
    cv.getContext("2d")!.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function saveCustomBackground(dataUrl: string | null) {
  setState({ customBg: dataUrl });
  await api.setSetting("customBg", dataUrl ?? "").catch(() => {});
}

// ------------------------------------------------------------------ mods manager (also used in Settings)
export function ModsManager() {
  const [mods, setMods] = useState<ModInfo[]>([]);
  const [, bump] = useState(0);
  const [confirmJs, setConfirmJs] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const refresh = () => api.modsList().then(setMods).catch((e) => toast(String(e)));
  useEffect(() => { refresh(); }, []);
  const importFiles = async () => {
    const picked = await open({ multiple: true, filters: [{ name: "DriftKord mods", extensions: ["css", "js", "dktheme", "json"] }] });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (!paths.length) return;
    try { const added = await api.modsImport(paths as string[]); toast(`${added.length} mod${added.length === 1 ? "" : "s"} added — switch them on below`); refresh(); }
    catch (e) { toast(String(e)); }
  };
  const toggle = async (m: ModInfo, on: boolean) => {
    if (on && m.kind === "js" && confirmJs !== m.file) { setConfirmJs(m.file); return; }
    setConfirmJs(null);
    const needsRestart = await setModEnabled(m, on);
    if (needsRestart) setRestart(true);
    bump((x) => x + 1);
  };
  const applyThemeMod = async (m: ModInfo) => {
    try {
      const data = JSON.parse(await api.modsRead(m.file));
      setState({ customTheme: normalizeCustom(data.theme ? data : data.customTheme ?? data, themeById(getState().themeId)), themeId: "custom" });
      if (typeof data.background === "string") await saveCustomBackground(data.background);
      toast(`Applied "${m.name}"`);
    } catch (e) { toast(`Can't read that theme: ${e}`); }
  };
  const writeExample = async (kind: "css" | "js") => {
    const file = kind === "css" ? "example-rounded-art.css" : "example-song-toast.js";
    await api.modsWrite(file, kind === "css" ? EXAMPLE_CSS : EXAMPLE_JS);
    toast(`Created ${file} in your mods folder`);
    refresh();
  };
  return (
    <div className="mods">
      <div className="row wrap">
        <button className="btn primary" onClick={importFiles}>Add mod files…</button>
        <button className="btn" onClick={() => api.modsOpenFolder()}>Open mods folder</button>
        <button className="btn" onClick={refresh}>Rescan</button>
        <button className="btn ghost" onClick={() => writeExample("css")}>New example style mod</button>
        <button className="btn ghost" onClick={() => writeExample("js")}>New example script mod</button>
      </div>
      {restart && (
        <div className="ce-note">A script mod was switched off — restart DriftKord to unload it. <button className="btn small" onClick={() => location.reload()}>Reload now</button></div>
      )}
      {mods.length === 0 ? (
        <p className="muted small">No mods yet. Add <b>.css</b> style mods, <b>.js</b> script mods or <b>.dktheme</b> theme files — or drop them into the mods folder and press Rescan.</p>
      ) : (
        <ul className="mod-list">
          {mods.map((m) => (
            <li key={m.file} className={`mod ${isEnabled(m.file) ? "on" : ""}`}>
              <span className={`mod-kind k-${m.kind}`}>{m.kind === "theme" ? "THEME" : m.kind.toUpperCase()}</span>
              <div className="mod-main">
                <strong>{m.name}</strong>
                <small>{m.description || m.file}{m.author ? ` · by ${m.author}` : ""}{m.version ? ` · v${m.version}` : ""}</small>
                {lastModError[m.file] && <small className="warn">Error: {lastModError[m.file]}</small>}
                {confirmJs === m.file && (
                  <div className="ce-note warn">
                    Script mods run inside DriftKord with the same access as the app (your library, settings and accounts). Only switch on mods you wrote or trust.
                    <div className="row"><button className="btn small primary" onClick={() => toggle(m, true)}>I trust it — switch on</button><button className="btn small ghost" onClick={() => setConfirmJs(null)}>Cancel</button></div>
                  </div>
                )}
              </div>
              <div className="mod-actions">
                {m.kind === "theme" ? (
                  <button className="btn small primary" onClick={() => applyThemeMod(m)}>Apply</button>
                ) : (
                  <label className="mod-switch"><input type="checkbox" checked={isEnabled(m.file)} onChange={(e) => toggle(m, e.target.checked)} /> On</label>
                )}
                {m.kind === "css" && isEnabled(m.file) && <button className="btn small ghost" title="Re-read the file after editing it" onClick={() => reloadStyleMod(m).then(() => toast("Reloaded"))}>↻</button>}
                <button className="btn small ghost" title="Delete this mod" onClick={async () => { await forgetMod(m.file); await api.modsRemove(m.file); refresh(); }}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <details className="small muted">
        <summary>Writing mods</summary>
        <p>Style mods are plain CSS and apply instantly. Script mods receive a <code>DriftKord</code> object: <code>getState()</code>, <code>setState()</code>, <code>subscribe(fn)</code>, <code>onSongChange(fn)</code>, <code>addStyle(css)</code>, <code>toast(msg)</code>, <code>live</code> (60 fps audio data) and <code>api</code> (player commands). Put <code>@name</code>, <code>@description</code>, <code>@author</code> and <code>@version</code> in the first comment.</p>
      </details>
    </div>
  );
}

// ------------------------------------------------------------------ visual pickers
interface Choice<T extends string> { value: T; name: string; hint?: string; preview?: React.ReactNode }
function Picker<T extends string>({ label, hint, value, choices, onChange, size = "m" }: {
  label: string; hint?: string; value: T; choices: Choice<T>[]; onChange: (v: T) => void; size?: "s" | "m" | "l";
}) {
  return (
    <div className="ce-picker">
      <div className="ce-label">{label}{hint && <small>{hint}</small>}</div>
      <div className={`ce-choices size-${size}`} role="radiogroup" aria-label={label}>
        {choices.map((c) => (
          <button key={c.value} role="radio" aria-checked={value === c.value} className={`ce-choice ${value === c.value ? "on" : ""}`} onClick={() => onChange(c.value)} title={c.hint}>
            {c.preview && <span className="ce-prev">{c.preview}</span>}
            <span className="ce-choice-name">{c.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Tiny wireframes of each layout. */
function LayoutSketch({ l }: { l: string }) {
  const R = (x: number, y: number, w: number, h: number, k: string) => <rect x={x} y={y} width={w} height={h} rx={1.5} className={`sk-${k}`} />;
  const parts: Record<string, React.ReactNode> = {
    "bottom-bar": <>{R(0, 0, 60, 4, "t")}{R(0, 5, 14, 27, "n")}{R(15, 5, 45, 27, "m")}{R(0, 33, 60, 7, "p")}</>,
    "floating-dock": <>{R(0, 0, 60, 4, "t")}{R(0, 5, 60, 4, "n")}{R(0, 10, 60, 30, "m")}{R(10, 32, 40, 6, "p")}</>,
    "left-rail": <>{R(0, 0, 60, 4, "t")}{R(0, 5, 8, 35, "p")}{R(9, 5, 5, 35, "n")}{R(15, 5, 45, 35, "m")}</>,
    "hardware-rack": <>{R(0, 0, 60, 4, "t")}{R(0, 5, 60, 9, "p")}{R(0, 15, 60, 4, "n")}{R(0, 20, 60, 20, "m")}</>,
    cinema: <>{R(0, 0, 60, 4, "t")}{R(0, 5, 60, 4, "n")}{R(0, 10, 60, 23, "m")}{R(0, 34, 60, 6, "p")}</>,
  };
  return <svg viewBox="0 0 60 40" className="ce-sketch">{parts[l]}</svg>;
}
function ChromeSketch({ c }: { c: string }) {
  return <span className={`ce-chrome-sk ck-${c}`}><i /><b>DriftKord</b><em>— ☐ ✕</em></span>;
}
function SurfaceSwatch({ s }: { s: string }) {
  return <span className={`ce-surf sf-${s}`} />;
}
function IconSample({ w }: { w: string }) {
  const stroke = { hairline: 1, line: 1.75, bold: 2.6, pixel: 2.5, duotone: 1.75 }[w] ?? 1.75;
  return (
    <svg viewBox="0 0 48 20" className="ce-iconsk" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap={w === "pixel" ? "square" : "round"}>
      <path d="M3 4v12l9-6z" fill={w === "duotone" ? "currentColor" : "none"} fillOpacity={0.3} />
      <path d="M20 14V7l9-2v7" /><circle cx="18" cy="14" r="2" /><circle cx="27" cy="12" r="2" />
      <path d="M36 10a5 5 0 1 0 10 0a5 5 0 1 0-10 0M41 7v3l2 1" />
    </svg>
  );
}

// search terms per section, so "corner" finds Shape, "lyric" finds Player & lyrics…
const KEYWORDS: Record<Tab, string> = {
  start: "preset start reset random name copy mobile",
  layout: "layout dock rail sidebar rack cinema chrome window title bar surface texture icons scrollbar",
  controls: "controls slider knob fader led pixel glass buttons filled outline ghost pill hover focus selection highlight",
  colors: "colour color palette accent background text border glow gradient adaptive",
  type: "font typography text size letter spacing line height weight bold uppercase",
  shape: "corner radius round border shadow glass blur opacity transparency panel",
  sizes: "size scale zoom density compact spacious sidebar width icon navigation labels",
  background: "background wallpaper image gradient mesh radial grain noise blur darken",
  player: "player play button album art cover progress bar thickness lyrics font align glow notification toast",
  elements: "element title bar navigation player bar panels buttons inputs cards lyrics visualizer notifications",
  nav: "navigation pages order hide rename menu",
  motion: "motion animation speed particles visualizer effects",
  css: "css code style custom advanced",
  mods: "mods plugins scripts extensions install",
  share: "import export share save file backup",
};

// ------------------------------------------------------------------ undo / redo (session history of the custom theme)
const history: { past: CustomTheme[]; future: CustomTheme[]; last: CustomTheme | null; timer: number | undefined } = { past: [], future: [], last: null, timer: undefined };
function recordHistory(current: CustomTheme) {
  // group rapid changes (dragging a slider) into one undo step
  window.clearTimeout(history.timer);
  const before = history.last;
  history.timer = window.setTimeout(() => {
    if (before && before !== current) {
      history.past.push(before);
      if (history.past.length > 80) history.past.shift();
      history.future = [];
    }
    history.last = current;
  }, 450);
}

// The page area is rebuilt when the layout changes; remember where you were in the editor.
const memory: { tab: Tab; el: ElementId; query: string; scroll: number | null } = { tab: "start", el: "transport", query: "", scroll: null };
const mainEl = () => document.querySelector<HTMLElement>(".app > .main");

// ------------------------------------------------------------------ the editor
export function CustomThemeEditor() {
  const ct = useStore((s) => s.customTheme);
  const bg = useStore((s) => s.customBg);
  const adaptive = useStore((s) => s.adaptive);
  const [tab, setTabState] = useState<Tab>(memory.tab);
  const [query, setQueryState] = useState(memory.query);
  const [el, setElState] = useState<ElementId>(memory.el);
  const setTab = (t: Tab) => { memory.tab = t; setTabState(t); };
  const setQuery = (q: string) => { memory.query = q; setQueryState(q); };
  const setEl = (x: ElementId) => { memory.el = x; setElState(x); };
  // back to the same scroll position after a layout switch rebuilt the page
  useEffect(() => {
    if (memory.scroll === null) return;
    const y = memory.scroll;
    memory.scroll = null;
    requestAnimationFrame(() => requestAnimationFrame(() => { const m = mainEl(); if (m) m.scrollTop = y; }));
  }, []);
  const [, rerender] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [cssDraft, setCssDraft] = useState(ct?.css ?? "");
  useEffect(() => setCssDraft(ct?.css ?? ""), [ct?.css]);
  const undo = () => {
    window.clearTimeout(history.timer);
    const cur = getState().customTheme;
    const prev = history.past.pop();
    if (!prev || !cur) return;
    history.future.push(cur);
    history.last = prev;
    setState({ customTheme: prev });
    rerender((x) => x + 1);
  };
  const redo = () => {
    const cur = getState().customTheme;
    const nxt = history.future.pop();
    if (!nxt || !cur) return;
    history.past.push(cur);
    history.last = nxt;
    setState({ customTheme: nxt });
    rerender((x) => x + 1);
  };
  useEffect(() => { if (ct && !history.last) history.last = ct; }, [ct]);
  useEffect(() => { if (ct) recordHistory(ct); }, [ct]);
  // Ctrl+Z / Ctrl+Y inside the editor
  useEffect(() => {
    const k = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (ev.ctrlKey && ev.key.toLowerCase() === "z") { ev.preventDefault(); undo(); }
      else if (ev.ctrlKey && (ev.key.toLowerCase() === "y" || (ev.shiftKey && ev.key.toLowerCase() === "z"))) { ev.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  if (!ct) return null;


  const upd = (patch: Partial<CustomTheme>) => setState((s) => ({ customTheme: { ...(s.customTheme ?? ct), ...patch } }));
  const updT = (patch: Partial<CustomTheme["theme"]>) => {
    if (patch.layout && patch.layout !== ct.theme.layout) memory.scroll = mainEl()?.scrollTop ?? null;
    setState((s) => { const c = s.customTheme ?? ct; return { customTheme: { ...c, theme: { ...c.theme, ...patch } } }; });
  };
  const updC = (k: keyof Palette, v: string) => setState((s) => { const c = s.customTheme ?? ct; return { customTheme: { ...c, theme: { ...c.theme, c: { ...c.theme.c, [k]: v } } } }; });
  const updEl = (id: ElementId, patch: Partial<ElementStyle> | null) => setState((s) => {
    const c = s.customTheme ?? ct;
    const next = { ...c.elements };
    if (patch === null) delete next[id];
    else {
      const merged: ElementStyle = { ...(next[id] ?? {}), ...patch };
      (Object.keys(merged) as (keyof ElementStyle)[]).forEach((k) => merged[k] === undefined && delete merged[k]);
      next[id] = merged;
    }
    return { customTheme: { ...c, elements: next } };
  });
  const T = ct.theme;
  const e = ct.elements[el] ?? {};
  const elInfo = ELEMENTS.find((x) => x.id === el)!;
  const q = query.trim().toLowerCase();
  const visibleTabs = q ? TABS.filter((t) => (t.label + " " + t.hint + " " + KEYWORDS[t.id]).toLowerCase().includes(q)) : TABS;

  const navOrder = [...ct.nav.order.filter((id) => NAV.some((n) => n.id === id)), ...NAV.filter((n) => !ct.nav.order.includes(n.id)).map((n) => n.id)];
  const moveNav = (id: string, d: -1 | 1) => {
    const o = [...navOrder];
    const i = o.indexOf(id), j = i + d;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    upd({ nav: { ...ct.nav, order: o } });
  };
  const startFrom = (id: string) => {
    const t = THEMES.find((x) => x.id === id);
    if (!t) return;
    const fresh = customFrom(t);
    setState({ customTheme: { ...fresh, name: ct.name, css: ct.css, nav: ct.nav, elements: ct.elements } });
    toast(`Now based on ${t.name} — your name, CSS, navigation and element styles were kept`);
  };

  const randomPalette = () => {
    const h = Math.floor(Math.random() * 360), h2 = (h + 120 + Math.floor(Math.random() * 120)) % 360;
    const dark = Math.random() < 0.7;
    const hsl = (hh: number, s: number, l: number) => {
      const a = s * Math.min(l, 1 - l);
      const f = (n: number) => { const k = (n + hh / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0"); };
      return `#${f(0)}${f(8)}${f(4)}`;
    };
    updT({ c: dark
      ? { bg: hsl(h, 0.35, 0.07), bg2: hsl(h, 0.4, 0.13), panel: withAlpha(hsl(h, 0.3, 0.14), 0.9), panel2: withAlpha(hsl(h, 0.6, 0.6), 0.08), text: hsl(h, 0.2, 0.94), muted: hsl(h, 0.15, 0.62), accent: hsl(h, 0.9, 0.6), accent2: hsl(h2, 0.85, 0.65), border: withAlpha(hsl(h, 0.6, 0.6), 0.28), glow: hsl(h, 0.9, 0.6) }
      : { bg: hsl(h, 0.35, 0.95), bg2: hsl(h, 0.4, 0.88), panel: withAlpha("#ffffff", 0.85), panel2: withAlpha(hsl(h, 0.5, 0.45), 0.08), text: hsl(h, 0.3, 0.12), muted: hsl(h, 0.12, 0.42), accent: hsl(h, 0.75, 0.45), accent2: hsl(h2, 0.7, 0.5), border: withAlpha(hsl(h, 0.3, 0.2), 0.15), glow: hsl(h, 0.75, 0.5) } });
  };

  const exportTheme = async () => {
    const path = await save({ defaultPath: `${(ct.name || "my-theme").replace(/[^\w\- ]+/g, "").trim() || "my-theme"}.dktheme`, filters: [{ name: "DriftKord theme", extensions: ["dktheme", "json"] }] });
    if (!path) return;
    const withBg = !!bg && (await ask("Include your background image in the file? It makes the file bigger.", { title: "Export theme" }));
    await api.saveTextFile(path, JSON.stringify({ ...ct, ...(withBg ? { background: bg } : {}) }, null, 2));
    toast("Theme exported");
  };
  const importTheme = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const next = normalizeCustom(data, themeById(getState().themeId));
      setState({ customTheme: next });
      if (typeof data.background === "string") await saveCustomBackground(data.background);
      toast(`Imported "${next.name}"`);
    } catch (err) { toast(`That file isn't a DriftKord theme (${err})`); }
  };

  const fieldsFor = (id: Tab) => {
    switch (id) {
      case "start": return (
        <>
          <p className="muted small">Pick any of the {THEMES.length} themes as a starting point. Everything stays editable afterwards; your name, CSS, navigation and element styles are kept.</p>
          {CATEGORIES.map((cat) => (
            <div key={cat} className="ce-presets">
              <div className="ce-group-title">{cat}</div>
              <div className="ce-preset-row">
                {THEMES.filter((t) => t.category === cat).map((t) => (
                  <button key={t.id} className={`ce-preset ${ct.basedOn === t.id ? "on" : ""}`} onClick={() => startFrom(t.id)} title={t.blurb}
                    style={{ background: `linear-gradient(135deg, ${t.c.bg}, ${t.c.bg2})`, color: t.c.text, borderColor: ct.basedOn === t.id ? t.c.accent : undefined }}>
                    <span className="ce-preset-dots"><i style={{ background: t.c.accent }} /><i style={{ background: t.c.accent2 }} /><i style={{ background: t.c.panel }} /></span>
                    <span style={{ fontFamily: `"${t.fonts.display}", sans-serif` }}>{t.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="row wrap">
            <button className="btn" onClick={randomPalette}>🎲 Random colours</button>
            <button className="btn ghost" onClick={async () => { if (await ask("Reset the whole custom theme to its starting preset?", { title: "Reset custom theme" })) { setState({ customTheme: customFrom(themeById(ct.basedOn)) }); saveCustomBackground(null); } }}>Reset everything</button>
          </div>
        </>
      );
      case "layout": return (
        <>
          <Picker label="Layout" hint="Where navigation and the player sit" value={T.layout} size="l" onChange={(v) => updT({ layout: v })}
            choices={OPTS.layout.map(([v, n]) => ({ value: v, name: n, preview: <LayoutSketch l={v} /> }))} />
          <Picker label="Window chrome" hint="Title bar and window button style" value={T.chrome} onChange={(v) => updT({ chrome: v })}
            choices={OPTS.chrome.map(([v, n]) => ({ value: v, name: n, preview: <ChromeSketch c={v} /> }))} />
          <Picker label="Surface texture" hint="The material behind everything" value={T.surface} size="s" onChange={(v) => updT({ surface: v })}
            choices={OPTS.surface.map(([v, n]) => ({ value: v, name: n, preview: <SurfaceSwatch s={v} /> }))} />
          <Picker label="Icons" value={T.icon} size="s" onChange={(v) => updT({ icon: v })}
            choices={OPTS.icon.map(([v, n]) => ({ value: v, name: n, preview: <IconSample w={v} /> }))} />
          <Select label="Scrollbars" value={ct.scrollbars} options={[["normal", "Normal"], ["thin", "Thin"], ["hidden", "Hidden"]]} onChange={(v) => upd({ scrollbars: v })} />
        </>
      );
      case "controls": return (
        <>
          <Picker label="Sliders & knobs" hint="Each preview is a real control — try it" value={T.control} onChange={(v) => updT({ control: v })}
            choices={OPTS.control.map(([v, n]) => ({ value: v, name: n, preview: <span className="ce-ctl-prev" onClick={(ev) => ev.stopPropagation()}><Slider kind={v} value={0.62} role="param" /></span> }))} />
          <Picker label="Buttons" value={ct.buttonStyle} onChange={(v) => upd({ buttonStyle: v })}
            choices={([["theme", "Theme"], ["filled", "Filled"], ["outline", "Outline"], ["ghost", "Text only"], ["pill", "Pill"]] as const).map(([v, n]) => ({ value: v, name: n, preview: <span className={`ce-btn-prev bp-${v}`}>Button</span> }))} />
          <Picker label="Play button shape" value={ct.playShape} size="s" onChange={(v) => upd({ playShape: v })}
            choices={([["theme", "Theme"], ["circle", "Circle"], ["squircle", "Squircle"], ["square", "Square"]] as const).map(([v, n]) => ({ value: v, name: n, preview: <span className={`ce-play-prev pp-${v}`}>▶</span> }))} />
          <ColorField allowEmpty label="Hover colour" hint="Behind buttons and menu items you point at" value={ct.hoverColor ?? undefined} onChange={(v) => upd({ hoverColor: v ?? null })} />
          <ColorField allowEmpty label="Text selection" value={ct.selectionColor ?? undefined} onChange={(v) => upd({ selectionColor: v ?? null })} />
          <ColorField allowEmpty label="Keyboard focus ring" value={ct.focusColor ?? undefined} onChange={(v) => upd({ focusColor: v ?? null })} />
        </>
      );
      case "colors": return (
        <>
          {adaptive !== "off" && (
            <div className="ce-note warn">
              Adaptive colours are on, so the album art currently decides the accent{adaptive === "full" ? " and background" : ""} colours instead of the ones below.
              <div className="row"><button className="btn small primary" onClick={() => setState({ adaptive: "off" })}>Use my colours</button></div>
            </div>
          )}
          <div className="ce-palette-strip">{PALETTE.map((p) => <i key={p.key} style={{ background: T.c[p.key] }} title={p.name} />)}</div>
          <div className="ce-grid">
            {PALETTE.map((p) => <ColorField key={p.key} label={p.name} hint={p.hint} value={T.c[p.key]} onChange={(v) => v && updC(p.key, v)} />)}
          </div>
          <Check label="Gradient accents" hint="Play button and primary buttons blend Accent → Accent 2" value={ct.accentGradient} onChange={(v) => upd({ accentGradient: v })} />
          <div className="row wrap"><button className="btn" onClick={randomPalette}>🎲 Random colours</button></div>
        </>
      );
      case "type": return (
        <>
          <FontField label="Headings font" value={T.fonts.display} onChange={(v) => updT({ fonts: { ...T.fonts, display: v } })} />
          <FontField label="Body font" value={T.fonts.body} onChange={(v) => updT({ fonts: { ...T.fonts, body: v } })} />
          <FontField label="Numbers & code font" value={T.fonts.mono} onChange={(v) => updT({ fonts: { ...T.fonts, mono: v } })} />
          <div className="ce-type-prev">
            <strong style={{ fontFamily: `"${T.fonts.display}"`, fontWeight: ct.headingWeight || undefined }}>Heading Aa</strong>
            <span style={{ fontFamily: `"${T.fonts.body}"`, fontWeight: ct.bodyWeight || undefined }}>The quick brown fox jumps over the lazy dog.</span>
            <code style={{ fontFamily: `"${T.fonts.mono}"` }}>3:42 · 24-bit / 96 kHz</code>
          </div>
          <Range label="Text size" value={ct.textScale} min={0.85} max={1.4} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => upd({ textScale: v })} />
          <Range label="Heading weight" value={ct.headingWeight} min={0} max={900} step={100} fmt={(v) => (v ? String(v) : "theme")} onChange={(v) => upd({ headingWeight: v })} />
          <Range label="Body weight" value={ct.bodyWeight} min={0} max={700} step={100} fmt={(v) => (v ? String(v) : "theme")} onChange={(v) => upd({ bodyWeight: v })} />
          <Range label="Letter spacing" value={ct.letterSpacing} min={-0.02} max={0.15} step={0.005} unit=" em" onChange={(v) => upd({ letterSpacing: v })} />
          <Range label="Line height" value={ct.lineHeight} min={1.2} max={1.9} step={0.05} onChange={(v) => upd({ lineHeight: v })} />
          <Check label="UPPERCASE headings & buttons" value={T.uppercase} onChange={(v) => updT({ uppercase: v })} />
        </>
      );
      case "shape": return (
        <>
          <Range label="Corner roundness" value={T.radius} min={0} max={30} step={1} unit=" px" onChange={(v) => updT({ radius: v })} />
          <Range label="Border thickness" value={T.borderW} min={0} max={6} step={1} unit=" px" onChange={(v) => updT({ borderW: v })} />
          <Picker label="Shadows" value={T.shadow} size="s" onChange={(v) => updT({ shadow: v })}
            choices={OPTS.shadow.map(([v, n]) => ({ value: v, name: n, preview: <span className={`ce-shadow-prev sh-${v}`} /> }))} />
          <Range label="Panel opacity" hint="Lower = see-through panels" value={ct.panelOpacity} min={0.2} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => upd({ panelOpacity: v })} />
          <Range label="Glass blur" hint="Frosted-glass blur behind panels and bars" value={ct.glassBlur} min={0} max={30} step={1} unit=" px" onChange={(v) => upd({ glassBlur: v })} />
        </>
      );
      case "sizes": return (
        <>
          <Range label="UI scale" hint="Make everything bigger or smaller" value={ct.uiScale} min={0.8} max={1.3} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => upd({ uiScale: v })} />
          <Picker label="Density" hint="Space inside and between things" value={ct.density} size="s" onChange={(v) => upd({ density: v })}
            choices={([["compact", "Compact"], ["comfortable", "Comfortable"], ["spacious", "Spacious"]] as const).map(([v, n]) => ({ value: v, name: n, preview: <span className={`ce-dens d-${v}`}><i /><i /><i /></span> }))} />
          <Picker label="Navigation" value={ct.navMode} size="s" onChange={(v) => upd({ navMode: v })}
            choices={[{ value: "labels", name: "Icons + labels" }, { value: "icons", name: "Icons only" }]} />
          {T.layout === "bottom-bar" && ct.navMode === "labels" && (
            <Range label="Sidebar width" value={ct.sidebarWidth} min={160} max={340} step={5} unit=" px" onChange={(v) => upd({ sidebarWidth: v })} />
          )}
          <Range label="Icon size" value={ct.iconScale} min={0.8} max={1.5} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => upd({ iconScale: v })} />
        </>
      );
      case "background": return (
        <>
          <div className="ce-bg-preview" style={{ backgroundImage: bg ? `url("${bg}")` : undefined }}>{!bg && <span className="muted">No image — colours / gradient below are used</span>}</div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={async (ev) => {
            const f = ev.target.files?.[0];
            ev.target.value = "";
            if (!f) return;
            try { await saveCustomBackground(await fileToBackground(f)); toast("Background set"); } catch { toast("Couldn't read that image"); }
          }} />
          <div className="row wrap">
            <button className="btn primary" onClick={() => fileRef.current?.click()}>Choose image…</button>
            {bg && <button className="btn ghost" onClick={() => saveCustomBackground(null)}>Remove image</button>}
          </div>
          {bg ? (
            <>
              <Select label="Fit" value={ct.bgFit} options={[["cover", "Fill window"], ["contain", "Fit whole image"], ["tile", "Tile"]]} onChange={(v) => upd({ bgFit: v })} />
              <Range label="Blur" value={ct.bgBlur} min={0} max={40} step={1} unit=" px" onChange={(v) => upd({ bgBlur: v })} />
              <Range label="Darken" hint="Keeps text readable over busy pictures" value={ct.bgDim} min={0} max={0.9} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => upd({ bgDim: v })} />
            </>
          ) : (
            <>
              <Picker label="Colour fill" value={ct.bgMode} size="s" onChange={(v) => upd({ bgMode: v })}
                choices={([["theme", "Theme"], ["solid", "Solid"], ["linear", "Gradient"], ["radial", "Spotlight"], ["mesh", "Mesh"]] as const).map(([v, n]) => ({
                  value: v, name: n,
                  preview: <span className="ce-bgm" style={{ background: v === "theme" ? `linear-gradient(135deg, ${T.c.bg}, ${T.c.bg2})` : v === "solid" ? ct.bgColors[0] : v === "linear" ? `linear-gradient(${ct.bgAngle}deg, ${ct.bgColors[0]}, ${ct.bgColors[1]})` : v === "radial" ? `radial-gradient(circle at 30% 20%, ${ct.bgColors[1]}, ${ct.bgColors[0]} 70%)` : `radial-gradient(at 15% 20%, ${ct.bgColors[2]} 0, transparent 45%), radial-gradient(at 85% 15%, ${ct.bgColors[1]} 0, transparent 50%), ${ct.bgColors[0]}` }} />,
                }))} />
              {ct.bgMode !== "theme" && (
                <>
                  <ColorField label="Colour 1" value={ct.bgColors[0]} onChange={(v) => v && upd({ bgColors: [v, ct.bgColors[1], ct.bgColors[2]] })} />
                  {ct.bgMode !== "solid" && <ColorField label="Colour 2" value={ct.bgColors[1]} onChange={(v) => v && upd({ bgColors: [ct.bgColors[0], v, ct.bgColors[2]] })} />}
                  {ct.bgMode === "mesh" && <ColorField label="Colour 3" value={ct.bgColors[2]} onChange={(v) => v && upd({ bgColors: [ct.bgColors[0], ct.bgColors[1], v] })} />}
                  {ct.bgMode === "linear" && <Range label="Angle" value={ct.bgAngle} min={0} max={360} step={5} unit="°" onChange={(v) => upd({ bgAngle: v })} />}
                </>
              )}
            </>
          )}
          <Range label="Film grain" value={ct.grain} min={0} max={0.3} step={0.01} fmt={(v) => (v ? `${Math.round(v * 100)}%` : "off")} onChange={(v) => upd({ grain: v })} />
          <p className="muted small">Tip: lower Panel opacity and add Glass blur (Shape & depth) to let the background show through.</p>
        </>
      );
      case "player": return (
        <>
          <Picker label="Album art shape" value={ct.artShape} size="s" onChange={(v) => upd({ artShape: v })}
            choices={([["theme", "Theme"], ["square", "Square"], ["rounded", "Rounded"], ["circle", "Circle"]] as const).map(([v, n]) => ({ value: v, name: n, preview: <span className={`ce-art-prev ap-${v}`} /> }))} />
          <Range label="Progress bar thickness" hint="Fader and glass controls" value={ct.progressThickness} min={0} max={14} step={1} fmt={(v) => (v ? `${v} px` : "theme")} onChange={(v) => upd({ progressThickness: v })} />
          <Picker label="Notifications" value={ct.toastPos} size="s" onChange={(v) => upd({ toastPos: v })} choices={[{ value: "bottom", name: "Bottom" }, { value: "top", name: "Top" }]} />
          <div className="ce-subhead">Lyrics</div>
          <FontField label="Lyrics font" value={ct.lyricsFont || T.fonts.display} onChange={(v) => upd({ lyricsFont: v === T.fonts.display ? "" : v })} />
          <Range label="Lyrics size" value={ct.lyricsScale} min={0.7} max={1.8} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => upd({ lyricsScale: v })} />
          <ColorField allowEmpty label="Current line colour" value={ct.lyricsActive ?? undefined} onChange={(v) => upd({ lyricsActive: v ?? null })} />
          <Picker label="Alignment" value={ct.lyricsAlign} size="s" onChange={(v) => upd({ lyricsAlign: v })} choices={[{ value: "left", name: "Left" }, { value: "center", name: "Centred" }]} />
          <Check label="Glow on the current line" value={ct.lyricsGlow} onChange={(v) => upd({ lyricsGlow: v })} />
        </>
      );
      case "elements": return (
        <div className="ce-el">
          <ul className="ce-el-list">
            {ELEMENTS.map((x) => (
              <li key={x.id}><button className={`${el === x.id ? "on" : ""} ${ct.elements[x.id] ? "changed" : ""}`} onClick={() => setEl(x.id)}>{x.name}{ct.elements[x.id] && <i title="Customised" />}</button></li>
            ))}
          </ul>
          <div className="ce-el-form">
            <p className="muted small">{elInfo.hint}. Leave a setting empty to keep the theme's look.</p>
            {elInfo.canHide && <Check label="Hide it" value={!!e.hidden} onChange={(v) => updEl(el, { hidden: v || undefined })} />}
            <ColorField allowEmpty label="Background" value={e.bg} onChange={(v) => updEl(el, { bg: v })} />
            <ColorField allowEmpty label="Text" value={e.text} onChange={(v) => updEl(el, { text: v })} />
            <ColorField allowEmpty label="Border colour" value={e.border} onChange={(v) => updEl(el, { border: v })} />
            <Range label="Border thickness" value={e.borderW ?? -1} min={-1} max={8} step={1} fmt={(v) => (v < 0 ? "theme" : `${v} px`)} onChange={(v) => updEl(el, { borderW: v < 0 ? undefined : v })} />
            <Range label="Corners" value={e.radius ?? -1} min={-1} max={40} step={1} fmt={(v) => (v < 0 ? "theme" : `${v} px`)} onChange={(v) => updEl(el, { radius: v < 0 ? undefined : v })} />
            <Range label="Opacity" value={e.opacity ?? 1} min={0.1} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => updEl(el, { opacity: v >= 1 ? undefined : v })} />
            <Range label="Text size" value={e.fontScale ?? 1} min={0.7} max={1.6} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => updEl(el, { fontScale: v === 1 ? undefined : v })} />
            <Range label="Padding" value={e.padding ?? -1} min={-1} max={40} step={1} fmt={(v) => (v < 0 ? "theme" : `${v} px`)} onChange={(v) => updEl(el, { padding: v < 0 ? undefined : v })} />
            <Range label="Glass blur" value={e.blur ?? 0} min={0} max={30} step={1} unit=" px" onChange={(v) => updEl(el, { blur: v || undefined })} />
            <Select label="Shadow" value={e.shadow ?? "inherit"} options={[["inherit", "Theme"], ["none", "None"], ["soft", "Soft"], ["glow", "Glow"]]} onChange={(v) => updEl(el, { shadow: v === "inherit" ? undefined : v })} />
            <button className="btn small ghost" onClick={() => updEl(el, null)}>Reset {elInfo.name}</button>
          </div>
        </div>
      );
      case "nav": return (
        <>
          <p className="muted small">Reorder pages, hide the ones you don't use, or rename them. Themes can't be hidden, so you can always get back here.</p>
          <ul className="ce-nav">
            {navOrder.map((id, i) => {
              const n = NAV.find((x) => x.id === id)!;
              const hidden = ct.nav.hidden.includes(id);
              return (
                <li key={id} className={hidden ? "off" : ""}>
                  <span className="ce-nav-move">
                    <button disabled={i === 0} onClick={() => moveNav(id, -1)} aria-label="Move up">▲</button>
                    <button disabled={i === navOrder.length - 1} onClick={() => moveNav(id, 1)} aria-label="Move down">▼</button>
                  </span>
                  <input value={ct.nav.labels[id] ?? ""} placeholder={n.label} onChange={(ev) => upd({ nav: { ...ct.nav, labels: { ...ct.nav.labels, [id]: ev.target.value } } })} aria-label={`Label for ${n.label}`} />
                  <label className="mod-switch">
                    <input type="checkbox" checked={!hidden} disabled={id === "themes"}
                      onChange={(ev) => upd({ nav: { ...ct.nav, hidden: ev.target.checked ? ct.nav.hidden.filter((x) => x !== id) : [...ct.nav.hidden, id] } })} /> Show
                  </label>
                </li>
              );
            })}
          </ul>
          <button className="btn small ghost" onClick={() => upd({ nav: { order: [], hidden: [], labels: {} } })}>Reset navigation</button>
        </>
      );
      case "motion": return (
        <>
          <Picker label="Motion feel" value={T.motion} size="s" onChange={(v) => updT({ motion: v })}
            choices={OPTS.motion.map(([v, n]) => ({ value: v, name: n, preview: <span className={`ce-motion m-${v}`}><i /></span> }))} />
          <Range label="Animation speed" value={ct.animSpeed} min={0.25} max={2} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => upd({ animSpeed: v })} />
          <Check label="Turn off animations" value={ct.reduceMotion} onChange={(v) => upd({ reduceMotion: v })} />
          <Picker label="Ambient particles" value={T.particles} size="s" onChange={(v) => updT({ particles: v })}
            choices={OPTS.particles.map(([v, n]) => ({ value: v, name: n }))} />
          <Select label="Default visualizer" value={T.viz} options={VISUALIZERS.map((v) => [v.id, v.name] as const)} onChange={(v) => updT({ viz: v })} />
        </>
      );
      case "css": return (
        <>
          <p className="muted small">Applies on top of everything else. Useful variables: <code>--bg --panel --panel2 --text --muted --accent --accent2 --border --radius --font-display --font-body</code>.</p>
          <textarea className="ce-css" value={cssDraft} spellCheck={false} onChange={(ev) => setCssDraft(ev.target.value)}
            onKeyDown={(ev) => { if (ev.ctrlKey && ev.key === "Enter") { upd({ css: cssDraft }); toast("CSS applied"); } }}
            placeholder={".transport { border-top: 2px solid var(--accent); }\n.nav button.on { font-weight: 800; }"} />
          <div className="row wrap">
            <button className="btn primary" onClick={() => { upd({ css: cssDraft }); toast("CSS applied"); }}>Apply (Ctrl+Enter)</button>
            <button className="btn ghost" onClick={() => setCssDraft(ct.css)}>Undo changes</button>
          </div>
        </>
      );
      case "mods": return <ModsManager />;
      case "share": return (
        <>
          <p className="muted small">Themes are saved as <b>.dktheme</b> files you can back up or share. Anyone can load them here or through Mods.</p>
          <input ref={importRef} type="file" accept=".dktheme,.json" hidden onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ""; if (f) importTheme(f); }} />
          <div className="row wrap">
            <button className="btn primary" onClick={exportTheme}>Export theme…</button>
            <button className="btn" onClick={() => importRef.current?.click()}>Import theme…</button>
            <button className="btn" onClick={async () => { const file = `${(ct.name || "my-theme").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "my-theme"}.dktheme`; await api.modsWrite(file, JSON.stringify(ct, null, 2)); toast(`Saved to your mods folder as ${file}`); }}>Save to mods folder</button>
          </div>
        </>
      );
    }
  };

  const active = visibleTabs.some((t) => t.id === tab) ? tab : visibleTabs[0]?.id ?? tab;
  const info = TABS.find((t) => t.id === active)!;
  return (
    <section className="ce">
      <datalist id="ce-fonts">{FONT_SUGGESTIONS.map((f) => <option key={f} value={f} />)}</datalist>
      <header className="ce-head">
        <div>
          <div className="ce-kicker">Custom theme · based on {themeById(ct.basedOn).name}</div>
          <input className="ce-name" value={ct.name} onChange={(ev) => upd({ name: ev.target.value })} aria-label="Theme name" />
        </div>
        <div className="ce-tools">
          <input className="ce-search" type="search" placeholder="Search settings…" value={query} onChange={(ev) => setQuery(ev.target.value)} aria-label="Search customization settings" />
          <button className="btn small" disabled={!history.past.length} onClick={undo} title="Undo (Ctrl+Z)">↶ Undo</button>
          <button className="btn small" disabled={!history.future.length} onClick={redo} title="Redo (Ctrl+Y)">↷ Redo</button>
        </div>
      </header>
      <div className="ce-body">
        <nav className="ce-tabs" aria-label="Customization sections">
          {visibleTabs.map((t) => (
            <button key={t.id} className={active === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
              <strong>{t.label}</strong><small>{t.hint}</small>
            </button>
          ))}
          {!visibleTabs.length && <p className="muted small">Nothing matches “{query}”.</p>}
        </nav>
        <div className="ce-pane">
          <h3>{info.label}<small className="muted"> — {info.hint}</small></h3>
          {fieldsFor(active)}
        </div>
      </div>
    </section>
  );
}
