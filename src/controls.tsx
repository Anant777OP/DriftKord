// Morphing control widgets, icon set and theme-specific window chrome.
// Every slider in the app goes through <Slider>, which renders a completely different widget
// per theme: rotary aluminium dial, LED/plasma ladder, brutalist pixel blocks, zen ink stroke,
// frosted glass capsule, studio fader, or a Windows 95 trackbar.
import { customAsTheme } from "./customTheme";
import React, { useCallback, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "./store";
import { themeById, Control, Theme } from "./themes";

export function useTheme(): Theme {
  const id = useStore((s) => s.themeId);
  // the Custom theme keeps the id "custom" while its layout, controls and chrome change
  const custom = useStore((s) => (s.themeId === "custom" ? s.customTheme : null));
  return useMemo(() => (id === "custom" && custom ? customAsTheme(custom) : themeById(id)), [id, custom]);
}

// ================================================================== Icons
const P: Record<string, string> = {
  play: "M7 4.5v15l12.5-7.5z",
  pause: "M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z",
  next: "M5 5l10 7-10 7zM17 5h2.5v14H17z",
  prev: "M19 5L9 12l10 7zM4.5 5H7v14H4.5z",
  stop: "M6 6h12v12H6z",
  shuffle: "M3 7h4l10 10h4M17 4l3 3-3 3M3 17h4l3-3M14 10l3-3h4M17 14l3 3-3 3",
  repeat: "M4 11V8a2 2 0 0 1 2-2h12l-3-3M20 13v3a2 2 0 0 1-2 2H6l3 3",
  repeatOne: "M4 11V8a2 2 0 0 1 2-2h12l-3-3M20 13v3a2 2 0 0 1-2 2H6l3 3M12 9.5v5",
  volume: "M4 9h4l5-4v14l-5-4H4zM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12",
  mute: "M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6",
  volumeLow: "M4 9h4l5-4v14l-5-4H4zM16 9.5a3.5 3.5 0 0 1 0 5",
  nowplaying: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z",
  library: "M4 4h3v16H4zM9.5 4h3v16h-3zM15 5l3-1 3.5 15.5-3 .8z",
  queue: "M4 6h12M4 11h12M4 16h7M16 14v6l5-3z",
  playlists: "M4 5h16M4 10h16M4 15h9M17 13a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM19 15V8",
  youtube: "M3 8.5c0-2 1.2-3 3-3.2C8 5.1 10 5 12 5s4 .1 6 .3c1.8.2 3 1.2 3 3.2v7c0 2-1.2 3-3 3.2-2 .2-4 .3-6 .3s-4-.1-6-.3c-1.8-.2-3-1.2-3-3.2zM10 9v6l5-3z",
  eq: "M6 4v16M12 4v16M18 4v16M3.5 14h5M9.5 8h5M15.5 16h5",
  timemachine: "M12 4a8 8 0 1 0 8 8M12 8v4l3 2M20 4v4h-4",
  moodmap: "M3 19l5-9 4 5 3-4 6 8zM8 5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3zM17 4l.8 1.6 1.7.3-1.2 1.2.3 1.7-1.6-.8-1.6.8.3-1.7-1.2-1.2 1.7-.3z",
  autodj: "M7 6a5 5 0 1 0 0 10a5 5 0 1 0 0-10zM17 8a5 5 0 1 0 0 10a5 5 0 1 0 0-10zM7 10.2a.8.8 0 1 0 0 1.6a.8.8 0 1 0 0-1.6zM17 12.2a.8.8 0 1 0 0 1.6a.8.8 0 1 0 0-1.6z",
  stems: "M4 19V9M8 19V5M12 19v-7M16 19V7M20 19v-4",
  soundstage: "M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H4zM17 14h3v6h-3z",
  xray: "M3 12h4l2-6 4 12 2-6h6",
  metadata: "M3 12l9-9h8v8l-9 9zM15.5 7a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z",
  settings: "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 14H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1A2 2 0 1 1 6.9 4.4l.1.1A1.6 1.6 0 0 0 9.7 3.4V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z",
  themes: "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4-4-7.4-9-7.4zM7.5 11.5a1 1 0 1 0 0 .1zM10.5 7.5a1 1 0 1 0 0 .1zM15.5 7.5a1 1 0 1 0 0 .1z",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  folder: "M3 6h6l2 2h10v11H3z",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM15.5 15.5L20 20",
  close: "M6 6l12 12M18 6L6 18",
  home: "M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10",
  soundscapes: "M3 17c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2 1 3 1.5M12 3c1.5 2.5 4 4 4 7a4 4 0 0 1-8 0c0-3 2.5-4.5 4-7z",
  min: "M5 12h14",
  max: "M5 5h14v14H5z",
  cinema: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  lyrics: "M4 6h16M4 11h10M4 16h13M18 14v6",
  disc: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4z",
  hud: "M3 7h18v10H3zM7 11h6M7 14h3",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  heart: "M12 20s-7-4.5-9-9a4.5 4.5 0 0 1 9-3 4.5 4.5 0 0 1 9 3c-2 4.5-9 9-9 9z",
  check: "M5 12l5 5 9-10",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z",
  infinity: "M6.5 8.5a3.5 3.5 0 1 0 0 7c3 0 8-7 11-7a3.5 3.5 0 1 1 0 7c-3 0-8-7-11-7z",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  drag: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  right: "M9 6l6 6-6 6",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3M9 21h6",
  import: "M12 3v12M7 10l5 5 5-5M4 17v3h16v-3",
  cast: "M3 18a3 3 0 0 1 3 3M3 14a7 7 0 0 1 7 7M3 10a11 11 0 0 1 11 11M3 7V5h18v14h-5",
  chip: "M7 7h10v10H7zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4",
};

export function Icon({ name, size = 20, className, title }: { name: keyof typeof P | string; size?: number; className?: string; title?: string }) {
  const t = useTheme();
  const d = P[name] ?? P.disc;
  const filled = ["play", "pause", "next", "prev", "stop"].includes(name);
  const pixel = t.icon === "pixel";
  const duo = t.icon === "duotone";
  return (
    <svg
      className={`icon ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : duo ? "currentColor" : "none"}
      fillOpacity={filled ? 1 : duo ? 0.22 : 0}
      stroke="currentColor"
      strokeWidth={filled ? (pixel ? 0 : 0.6) : "var(--icon-stroke)"}
      strokeLinecap={pixel ? "square" : "round"}
      strokeLinejoin={pixel ? "miter" : "round"}
      shapeRendering={pixel ? "crispEdges" : "geometricPrecision"}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}

export function IconButton({ icon, onClick, title, active, size = 20, className, big }: {
  icon: string; onClick?: () => void; title: string; active?: boolean; size?: number; className?: string; big?: boolean;
}) {
  return (
    <button className={`icon-btn ${active ? "active" : ""} ${big ? "big" : ""} ${className ?? ""}`} onClick={onClick} title={title} aria-label={title}>
      <Icon name={icon} size={size} />
    </button>
  );
}

// ================================================================== Slider (morphing)
export interface SliderProps {
  value: number;
  onChange?: (v: number) => void;
  onCommit?: (v: number) => void;
  orientation?: "h" | "v";
  role?: "progress" | "volume" | "param";
  label?: string;
  display?: string;
  size?: number;
  bipolar?: boolean;
  /** force a particular widget family regardless of theme */
  kind?: Control;
  className?: string;
  buffered?: number;
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function useDrag(
  orientation: "h" | "v",
  mode: "absolute" | "relative",
  value: number,
  onChange?: (v: number) => void,
  onCommit?: (v: number) => void,
) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useRef({ dragging: false, start: 0, startVal: 0, last: value });
  const calc = useCallback(
    (e: PointerEvent | React.PointerEvent) => {
      const el = ref.current;
      if (!el) return value;
      if (mode === "relative") {
        const delta = state.current.start - e.clientY + (e.clientX - (state.current as any).startX) * 0.5;
        return clamp01(state.current.startVal + delta / (e.shiftKey ? 800 : 180));
      }
      const r = el.getBoundingClientRect();
      return orientation === "h" ? clamp01((e.clientX - r.left) / r.width) : clamp01(1 - (e.clientY - r.top) / r.height);
    },
    [orientation, mode, value],
  );
  const onPointerDown = (e: React.PointerEvent) => {
    if (!onChange && !onCommit) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    state.current = { dragging: true, start: e.clientY, startVal: value, last: value };
    (state.current as any).startX = e.clientX;
    if (mode === "absolute") {
      const v = calc(e);
      state.current.last = v;
      onChange?.(v);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!state.current.dragging) return;
    const v = calc(e);
    state.current.last = v;
    onChange?.(v);
  };
  const onPointerUp = () => {
    if (!state.current.dragging) return;
    state.current.dragging = false;
    onCommit?.(state.current.last);
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!onChange && !onCommit) return;
    const v = clamp01(value + (e.deltaY < 0 ? 0.02 : -0.02));
    onChange?.(v);
    onCommit?.(v);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    let v = value;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") v = clamp01(value + step);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") v = clamp01(value - step);
    else return;
    e.preventDefault();
    onChange?.(v);
    onCommit?.(v);
  };
  return { ref, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onWheel, onKeyDown } };
}

export function Slider(props: SliderProps) {
  const t = useTheme();
  const kind = props.kind ?? t.control;
  switch (kind) {
    case "rotary":
      return <Knob {...props} />;
    case "led":
      return <LedBar {...props} />;
    case "pixel":
      return <PixelBar {...props} />;
    case "ink":
      return <InkStroke {...props} />;
    case "glass":
      return <GlassSlider {...props} />;
    case "bevel":
      return <BevelTrack {...props} />;
    default:
      return <Fader {...props} />;
  }
}

function Label({ p }: { p: SliderProps }) {
  if (!p.label && !p.display) return null;
  return (
    <div className="ctl-label">
      {p.label && <span className="ctl-name">{p.label}</span>}
      {p.display && <span className="ctl-value">{p.display}</span>}
    </div>
  );
}

// --- Rotary aluminium dial ----------------------------------------------------------------
export function Knob(p: SliderProps) {
  const size = p.size ?? (p.role === "progress" ? 64 : 52);
  const { ref, handlers } = useDrag("v", "relative", p.value, p.onChange, p.onCommit);
  const a0 = -135, a1 = 135;
  const ang = a0 + (a1 - a0) * clamp01(p.value);
  const r = size / 2;
  const arc = (from: number, to: number, rad: number) => {
    const toXY = (deg: number) => {
      const rr = (deg - 90) * (Math.PI / 180);
      return [r + rad * Math.cos(rr), r + rad * Math.sin(rr)];
    };
    const [x0, y0] = toXY(from);
    const [x1, y1] = toXY(to);
    const large = to - from > 180 ? 1 : 0;
    return `M${x0} ${y0} A${rad} ${rad} 0 ${large} 1 ${x1} ${y1}`;
  };
  const ticks = Array.from({ length: 11 }, (_, i) => a0 + ((a1 - a0) * i) / 10);
  return (
    <div className={`ctl ctl-knob role-${p.role ?? "param"} ${p.className ?? ""}`}>
      <div ref={ref} className="knob" style={{ width: size, height: size }} tabIndex={0} role="slider"
        aria-valuenow={Math.round(p.value * 100)} aria-label={p.label} {...handlers}>
        <svg width={size} height={size} className="knob-ring">
          {ticks.map((d, i) => {
            const rr = (d - 90) * (Math.PI / 180);
            return <line key={i} x1={r + (r - 2) * Math.cos(rr)} y1={r + (r - 2) * Math.sin(rr)} x2={r + (r - 6) * Math.cos(rr)} y2={r + (r - 6) * Math.sin(rr)} className="knob-tick" />;
          })}
          <path d={arc(a0, a1, r - 9)} className="knob-track" />
          {p.value > 0.001 && <path d={arc(p.bipolar ? Math.min(0, ang) : a0, p.bipolar ? Math.max(0, ang) : ang, r - 9)} className="knob-fill" />}
        </svg>
        <div className="knob-cap" style={{ inset: size * 0.2, transform: `rotate(${ang}deg)` }}>
          <div className="knob-pointer" />
        </div>
      </div>
      <Label p={p} />
    </div>
  );
}

// --- Segmented LED / plasma ladder ---------------------------------------------------------
export function LedBar(p: SliderProps) {
  const o = p.orientation ?? "h";
  const n = p.role === "progress" ? 48 : o === "v" ? 16 : 20;
  const { ref, handlers } = useDrag(o, "absolute", p.value, p.onChange, p.onCommit);
  const lit = Math.round(clamp01(p.value) * n);
  return (
    <div className={`ctl ctl-led ${o} role-${p.role ?? "param"} ${p.className ?? ""}`}>
      <div ref={ref} className="led-track" tabIndex={0} role="slider" aria-label={p.label} aria-valuenow={Math.round(p.value * 100)} {...handlers}>
        {Array.from({ length: n }, (_, i) => {
          const frac = i / (n - 1);
          const zone = p.role === "volume" ? (frac > 0.85 ? "hot" : frac > 0.65 ? "warm" : "") : "";
          return <span key={i} className={`led ${i < lit ? "on" : ""} ${zone} ${i === lit - 1 ? "head" : ""}`} />;
        })}
      </div>
      <Label p={p} />
    </div>
  );
}

// --- Brutalist pixel blocks ----------------------------------------------------------------
export function PixelBar(p: SliderProps) {
  const o = p.orientation ?? "h";
  const n = p.role === "progress" ? 32 : 12;
  const { ref, handlers } = useDrag(o, "absolute", p.value, p.onChange, p.onCommit);
  const lit = Math.round(clamp01(p.value) * n);
  return (
    <div className={`ctl ctl-pixel ${o} role-${p.role ?? "param"} ${p.className ?? ""}`}>
      <div ref={ref} className="pixel-track" tabIndex={0} role="slider" aria-label={p.label} aria-valuenow={Math.round(p.value * 100)} {...handlers}>
        {Array.from({ length: n }, (_, i) => <span key={i} className={`px ${i < lit ? "on" : ""}`} />)}
      </div>
      <Label p={p} />
    </div>
  );
}

// --- Zen ink stroke ------------------------------------------------------------------------
export function InkStroke(p: SliderProps) {
  const o = p.orientation ?? "h";
  const { ref, handlers } = useDrag(o, "absolute", p.value, p.onChange, p.onCommit);
  const v = clamp01(p.value);
  // tapered brush path in a 100×10 box
  const w = v * 100;
  const brush = `M0 5 C ${w * 0.3} 3.6, ${w * 0.7} 3.2, ${w} 4.2 C ${w + 1.2} 5, ${w + 1.2} 5.6, ${w} 6 C ${w * 0.7} 6.9, ${w * 0.3} 6.6, 0 5.4 Z`;
  return (
    <div className={`ctl ctl-ink ${o} role-${p.role ?? "param"} ${p.className ?? ""}`}>
      <div ref={ref} className="ink-track" tabIndex={0} role="slider" aria-label={p.label} aria-valuenow={Math.round(v * 100)} {...handlers}>
        <svg viewBox="0 0 101 10" preserveAspectRatio="none" className="ink-svg">
          <line x1="0" y1="5" x2="100" y2="5" className="ink-hair" />
          {v > 0.002 && <path d={brush} className="ink-brush" />}
        </svg>
        <span className="ink-dot" style={o === "h" ? { left: `${v * 100}%` } : { bottom: `${v * 100}%` }} />
      </div>
      <Label p={p} />
    </div>
  );
}

// --- Frosted glass capsule -----------------------------------------------------------------
export function GlassSlider(p: SliderProps) {
  const o = p.orientation ?? "h";
  const { ref, handlers } = useDrag(o, "absolute", p.value, p.onChange, p.onCommit);
  const v = clamp01(p.value);
  return (
    <div className={`ctl ctl-glass ${o} role-${p.role ?? "param"} ${p.className ?? ""}`}>
      <div ref={ref} className="glass-track" tabIndex={0} role="slider" aria-label={p.label} aria-valuenow={Math.round(v * 100)} {...handlers}>
        {p.buffered != null && <div className="glass-buffer" style={o === "h" ? { width: `${p.buffered * 100}%` } : { height: `${p.buffered * 100}%` }} />}
        <div className="glass-fill" style={o === "h" ? { width: `${v * 100}%` } : { height: `${v * 100}%` }} />
        <div className="glass-thumb" style={o === "h" ? { left: `${v * 100}%` } : { bottom: `${v * 100}%` }} />
      </div>
      <Label p={p} />
    </div>
  );
}

// --- Studio fader ---------------------------------------------------------------------------
export function Fader(p: SliderProps) {
  const o = p.orientation ?? "h";
  const { ref, handlers } = useDrag(o, "absolute", p.value, p.onChange, p.onCommit);
  const v = clamp01(p.value);
  return (
    <div className={`ctl ctl-fader ${o} role-${p.role ?? "param"} ${p.className ?? ""}`}>
      <div ref={ref} className="fader-track" tabIndex={0} role="slider" aria-label={p.label} aria-valuenow={Math.round(v * 100)} {...handlers}>
        <div className="fader-groove" />
        <div className="fader-fill" style={o === "h" ? { width: `${v * 100}%` } : { height: `${v * 100}%` }} />
        <div className="fader-cap" style={o === "h" ? { left: `${v * 100}%` } : { bottom: `${v * 100}%` }} />
      </div>
      <Label p={p} />
    </div>
  );
}

// --- Windows 95 trackbar --------------------------------------------------------------------
export function BevelTrack(p: SliderProps) {
  const o = p.orientation ?? "h";
  const { ref, handlers } = useDrag(o, "absolute", p.value, p.onChange, p.onCommit);
  const v = clamp01(p.value);
  return (
    <div className={`ctl ctl-bevel ${o} role-${p.role ?? "param"} ${p.className ?? ""}`}>
      <div ref={ref} className="bevel-track" tabIndex={0} role="slider" aria-label={p.label} aria-valuenow={Math.round(v * 100)} {...handlers}>
        <div className="bevel-groove" />
        {p.role === "progress" && <div className="bevel-progress" style={{ width: `${v * 100}%` }} />}
        <div className="bevel-thumb" style={o === "h" ? { left: `${v * 100}%` } : { bottom: `${v * 100}%` }} />
      </div>
      <Label p={p} />
    </div>
  );
}

// ================================================================== Toggle / Segmented
export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className={`toggle ${on ? "on" : ""}`}>
      <button type="button" className="toggle-sw" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
        <span className="toggle-knob" />
      </button>
      {label && <span>{label}</span>}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Panel({ title, children, className, actions }: { title?: React.ReactNode; children: React.ReactNode; className?: string; actions?: React.ReactNode }) {
  return (
    <section className={`panel ${className ?? ""}`}>
      {(title || actions) && (
        <header className="panel-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

// ================================================================== Window chrome
export function TitleBar() {
  const t = useTheme();
  const w = getCurrentWindow();
  const btn = (kind: "min" | "max" | "close") => (e: React.MouseEvent) => {
    e.stopPropagation();
    const p = kind === "min" ? w.minimize() : kind === "max" ? w.toggleMaximize() : w.close();
    p.catch((err) => console.error("window control failed", err));
  };
  const name = "DriftKord";
  switch (t.chrome) {
    case "aqua":
      return (
        <div className="titlebar tb-aqua" data-tauri-drag-region>
          <div className="traffic">
            <button className="tl close" onClick={btn("close")} aria-label="Close" />
            <button className="tl min" onClick={btn("min")} aria-label="Minimize" />
            <button className="tl max" onClick={btn("max")} aria-label="Zoom" />
          </div>
          <div className="tb-title" data-tauri-drag-region>{name}</div>
        </div>
      );
    case "win95":
      return (
        <div className="titlebar tb-win95" data-tauri-drag-region>
          <div className="tb-title" data-tauri-drag-region>
            <Icon name="disc" size={14} /> {name}
          </div>
          <div className="w95-btns">
            <button onClick={btn("min")} aria-label="Minimize">_</button>
            <button onClick={btn("max")} aria-label="Maximize">□</button>
            <button onClick={btn("close")} aria-label="Close">✕</button>
          </div>
        </div>
      );
    case "hud":
      return (
        <div className="titlebar tb-hud" data-tauri-drag-region>
          <div className="tb-title" data-tauri-drag-region>
            <span className="hud-bracket">[</span> DRIFT//KORD <span className="hud-bracket">]</span>
            <span className="hud-sys">SYS.OK</span>
          </div>
          <div className="tb-btns">
            <button onClick={btn("min")} aria-label="Minimize">—</button>
            <button onClick={btn("max")} aria-label="Maximize">▢</button>
            <button onClick={btn("close")} aria-label="Close">✕</button>
          </div>
        </div>
      );
    case "rack":
      return (
        <div className="titlebar tb-rack" data-tauri-drag-region>
          <span className="screw" /><span className="screw" />
          <div className="tb-title" data-tauri-drag-region>
            <span className="brand">DRIFTKORD</span> <span className="model">HI-FI · DK-1</span>
          </div>
          <div className="tb-btns">
            <button onClick={btn("min")} aria-label="Minimize"><Icon name="min" size={14} /></button>
            <button onClick={btn("max")} aria-label="Maximize"><Icon name="max" size={12} /></button>
            <button onClick={btn("close")} aria-label="Close"><Icon name="close" size={14} /></button>
          </div>
          <span className="screw" /><span className="screw" />
        </div>
      );
    case "paper":
      return (
        <div className="titlebar tb-paper" data-tauri-drag-region>
          <div className="tb-title" data-tauri-drag-region>Drift<em>Kord</em></div>
          <div className="tb-btns">
            <button onClick={btn("min")} aria-label="Minimize">一</button>
            <button onClick={btn("max")} aria-label="Maximize">口</button>
            <button onClick={btn("close")} aria-label="Close">×</button>
          </div>
        </div>
      );
    case "brutal":
      return (
        <div className="titlebar tb-brutal" data-tauri-drag-region>
          <div className="tb-title" data-tauri-drag-region>DRIFTKORD</div>
          <div className="tb-btns">
            <button onClick={btn("min")} aria-label="Minimize">MIN</button>
            <button onClick={btn("max")} aria-label="Maximize">MAX</button>
            <button onClick={btn("close")} aria-label="Close">X</button>
          </div>
        </div>
      );
    case "mica":
      return (
        <div className="titlebar tb-mica" data-tauri-drag-region>
          <div className="tb-title" data-tauri-drag-region><Icon name="disc" size={16} /> {name}</div>
          <div className="tb-btns win11">
            <button onClick={btn("min")} aria-label="Minimize"><Icon name="min" size={14} /></button>
            <button onClick={btn("max")} aria-label="Maximize"><Icon name="max" size={12} /></button>
            <button className="close" onClick={btn("close")} aria-label="Close"><Icon name="close" size={14} /></button>
          </div>
        </div>
      );
    default:
      return (
        <div className="titlebar tb-minimal" data-tauri-drag-region>
          <div className="tb-title" data-tauri-drag-region>{name}</div>
          <div className="tb-btns dots">
            <button onClick={btn("min")} aria-label="Minimize" />
            <button onClick={btn("max")} aria-label="Maximize" />
            <button className="close" onClick={btn("close")} aria-label="Close" />
          </div>
        </div>
      );
  }
}
