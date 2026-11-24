// Unified application shell. The active theme decides the *architecture*: which navigation
// (sidebar / top tabs / icon rail / rack buttons / auto-hide overlay) and which transport
// (bottom bar / floating dock / vertical rail / rack faceplate / cinema overlay) is mounted.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { api, fmtRate, fmtTime } from "./api";
import { Icon, IconButton, Slider, TitleBar, useTheme } from "./controls";
import { AutoDj, MoodMap, XRay } from "./features/Analysis";
import { Eq, Soundstage, Stems, TimeMachine } from "./features/Dsp";
import { AutoPlay, SleepCountdown } from "./features/AutoPlay";
import { setAutoPlay, toggleFavorite } from "./autoplay";
import { initAdaptive } from "./adaptive";
import { Library, Playlists, Queue } from "./features/Library";
import { CinemaMode, NowPlaying, SignalPath } from "./features/NowPlaying";
import { ArtistBioView } from "./features/ArtistBio";
import { Metadata, Settings, Streaming, Themes } from "./features/System";
import { Soundscapes } from "./features/Soundscapes";
import { initIntegrations } from "./integrations";
import { initLyrics } from "./lyrics";
import { initVideo } from "./video";
import { VideoBar, VideoSurface } from "./features/VideoSurface";
import { NAV, NavItem } from "./nav";
import { applyCustomExtras, customAsTheme, CUSTOM_ID, setCustomBackground } from "./customTheme";
import { initMods } from "./mods";
import { LyricsEmpty, LyricsStatusChip } from "./features/LyricsTools";
import { getSyncedLyricsNow, initPlayer, next, playIndex, prev, seek, setLyricOffset, setVolume, toggleHud, togglePlay } from "./player";
import { itemService, serviceById } from "./streaming";
import { getState, live, livePosition, setState, useStore, ViewId } from "./store";
import { applyTheme, registerCustomTheme, themeById } from "./themes";
import { isSynced, Particles, Visualizer } from "./visualizers";

/** Navigation entries; the Custom theme can reorder, hide and rename them. */
function useNavItems(): NavItem[] {
  const themeId = useStore((s) => s.themeId);
  const nav = useStore((s) => (s.themeId === CUSTOM_ID ? s.customTheme?.nav : undefined));
  if (themeId !== CUSTOM_ID || !nav) return NAV;
  const order = [...nav.order.filter((id) => NAV.some((n) => n.id === id)), ...NAV.filter((n) => !nav.order.includes(n.id)).map((n) => n.id)];
  return order
    .map((id) => NAV.find((n) => n.id === id)!)
    .filter((n) => n.id === "themes" || !nav.hidden.includes(n.id))
    .map((n) => (nav.labels[n.id]?.trim() ? { ...n, label: nav.labels[n.id].trim() } : n));
}

function View({ id }: { id: ViewId }) {
  switch (id) {
    case "library": return <Library />;
    case "autoplay": return <AutoPlay />;
    case "queue": return <Queue />;
    case "playlists": return <Playlists />;
    case "youtube": return <Streaming />;
    case "eq": return <Eq />;
    case "timemachine": return <TimeMachine />;
    case "stems": return <Stems />;
    case "soundstage": return <Soundstage />;
    case "soundscapes": return <Soundscapes />;
    case "moodmap": return <MoodMap />;
    case "autodj": return <AutoDj />;
    case "xray": return <XRay />;
    case "metadata": return <Metadata />;
    case "themes": return <Themes />;
    case "settings": return <Settings />;
    default: return <NowPlaying />;
  }
}

// ------------------------------------------------------------------ navigation variants
/** Horizontal tab bar. When the tabs don't fit, the mouse wheel scrolls it sideways, arrow buttons
 *  appear at the ends, and the current page's tab is always scrolled into view. */
function TabNav({ items, view, go, autohide }: { items: NavItem[]; view: ViewId; go: (id: ViewId) => void; autohide: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const update = () => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => { el.removeEventListener("wheel", wheel); ro.disconnect(); };
  }, []);
  useEffect(() => {
    // keep the current page's tab visible
    const el = ref.current, on = el?.querySelector<HTMLElement>("button.on");
    if (!el || !on) return;
    const l = on.offsetLeft - 40, r = on.offsetLeft + on.offsetWidth + 40;
    if (l < el.scrollLeft) el.scrollLeft = l;
    else if (r > el.scrollLeft + el.clientWidth) el.scrollLeft = r - el.clientWidth;
    update();
  }, [view, items.length]);
  const by = (d: number) => { const el = ref.current; if (el) { el.scrollBy({ left: d * el.clientWidth * 0.7, behavior: "smooth" }); window.setTimeout(update, 400); } };
  return (
    <nav className={`nav nav-tabs-wrap ${autohide ? "autohide" : ""} ${edges.left ? "more-left" : ""} ${edges.right ? "more-right" : ""}`} aria-label="Sections">
      {edges.left && <button className="tabs-arrow left" onClick={() => by(-1)} aria-label="Scroll pages left">‹</button>}
      <div className="nav-tabs" ref={ref} onScroll={update}>
        {items.map((n) => (
          <button key={n.id} className={view === n.id ? "on" : ""} onClick={() => go(n.id)} title={n.label}>
            <Icon name={n.icon} size={16} /><span>{n.label}</span>
          </button>
        ))}
      </div>
      {edges.right && <button className="tabs-arrow right" onClick={() => by(1)} aria-label="Scroll pages right">›</button>}
    </nav>
  );
}

function Nav() {
  const t = useTheme();
  const view = useStore((s) => s.view);
  const go = (id: ViewId) => setState({ view: id });
  const NAV = useNavItems();
  if (t.layout === "left-rail") {
    return (
      <nav className="nav nav-rail" aria-label="Sections">
        {NAV.map((n) => <IconButton key={n.id} icon={n.icon} title={n.label} active={view === n.id} onClick={() => go(n.id)} size={20} />)}
      </nav>
    );
  }
  if (t.layout === "floating-dock" || t.layout === "cinema") {
    return <TabNav items={NAV} view={view} go={go} autohide={t.layout === "cinema"} />;
  }
  if (t.layout === "hardware-rack") {
    return (
      <nav className="nav nav-rack" aria-label="Sections">
        {NAV.map((n) => (
          <button key={n.id} className={`rack-key ${view === n.id ? "on" : ""}`} onClick={() => go(n.id)}>
            <span className="rack-led" /><span>{n.label}</span>
          </button>
        ))}
      </nav>
    );
  }
  const groups = [...new Set(NAV.map((n) => n.group))];
  return (
    <nav className="nav nav-side" aria-label="Sections">
      {groups.map((g) => (
        <div key={g} className="nav-group">
          <div className="nav-group-title">{g}</div>
          {NAV.filter((n) => n.group === g).map((n) => (
            <button key={n.id} className={view === n.id ? "on" : ""} onClick={() => go(n.id)}>
              <Icon name={n.icon} size={18} /><span>{n.label}</span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

// ------------------------------------------------------------------ transport pieces
function useTransport() {
  const st = useStore((s) => s.status);
  const yt = useStore((s) => s.yt);
  const ytActive = useStore((s) => s.ytActive);
  const queue = useStore((s) => s.queue);
  const qi = useStore((s) => s.queueIndex);
  const cover = useStore((s) => s.cover);
  const dsp = useStore((s) => s.dsp);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 200);
    return () => clearInterval(id);
  }, []);
  const item = queue[qi];
  const playing = ytActive ? !(yt?.paused ?? true) : st?.state === "playing";
  const duration = ytActive ? yt?.duration ?? 0 : st?.duration ?? 0;
  const position = Math.min(duration || Infinity, livePosition());
  return {
    item, playing, duration, position, cover, volume: dsp.volume, ytActive, st,
    title: ytActive ? yt?.title || item?.title || "" : item?.title ?? "",
    artist: ytActive ? yt?.artist || item?.artist || "" : item?.artist ?? "",
  };
}

function Progress({ orientation = "h", big }: { orientation?: "h" | "v"; big?: boolean }) {
  const t = useTransport();
  const [drag, setDrag] = useState<number | null>(null);
  const v = drag ?? (t.duration ? t.position / t.duration : 0);
  return (
    <Slider role="progress" orientation={orientation} value={v} size={big ? 84 : undefined}
      onChange={(x) => setDrag(x)} onCommit={(x) => { setDrag(null); if (t.duration) seek(x * t.duration); }}
      label={big ? "Position" : undefined} display={big ? `${fmtTime(v * t.duration)}` : undefined} />
  );
}

// ------------------------------------------------------------------ volume control
let volBeforeMute = 0.7;

export function toggleMute() {
  const v = getState().dsp.volume;
  if (v > 0.001) {
    volBeforeMute = v;
    setVolume(0);
  } else setVolume(volBeforeMute > 0.001 ? volBeforeMute : 0.5);
}

export function nudgeVolume(deltaPct: number) {
  const v = Math.round(getState().dsp.volume * 100);
  setVolume(Math.max(0, Math.min(100, v + deltaPct)) / 100);
}

/** Percentage readout that turns into a text box on click: type 0–100 and press Enter. */
function VolumeNumber({ big }: { big?: boolean }) {
  const vol = useStore((s) => s.dsp.volume);
  const pct = Math.round(vol * 100);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  const commit = () => {
    const n = parseFloat(text.replace(/[^\d.]/g, ""));
    if (!isNaN(n)) setVolume(Math.max(0, Math.min(100, Math.round(n))) / 100);
    setEditing(false);
  };
  const db = vol > 0.0001 ? `${(20 * Math.log10(vol)).toFixed(1)} dB` : "−∞ dB";
  if (editing) {
    return (
      <span className={`vol-num editing ${big ? "big" : ""}`}>
        <input
          ref={inputRef}
          className="vol-input"
          inputMode="numeric"
          maxLength={3}
          value={text}
          aria-label="Volume percent"
          onChange={(e) => setText(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") setEditing(false);
            else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const cur = parseInt(text || String(pct), 10) || 0;
              setText(String(Math.max(0, Math.min(100, cur + (e.key === "ArrowUp" ? 1 : -1)))));
            }
          }}
          onBlur={commit}
        />
        <span className="vol-unit">%</span>
      </span>
    );
  }
  return (
    <button
      className={`vol-num ${big ? "big" : ""} ${pct === 0 ? "muted-vol" : ""}`}
      title={`Volume ${pct}% (${db}) — click to type a value, scroll to fine-tune`}
      onClick={() => { setText(String(pct)); setEditing(true); }}
      onWheel={(e) => nudgeVolume(e.deltaY < 0 ? 1 : -1)}
    >
      {pct}<span className="vol-unit">%</span>
    </button>
  );
}

function Volume({ orientation = "h", size, big }: { orientation?: "h" | "v"; size?: number; big?: boolean }) {
  const vol = useStore((s) => s.dsp.volume);
  const icon = vol <= 0.001 ? "mute" : vol < 0.4 ? "volumeLow" : "volume";
  return (
    <div className={`vol-ctl ${orientation} ${big ? "big" : ""}`}>
      <IconButton icon={icon} title={vol <= 0.001 ? "Unmute (M)" : "Mute (M)"} onClick={toggleMute} size={orientation === "v" ? 18 : 17} className="vol-mute" />
      <div className="vol-slider">
        <Slider role="volume" orientation={orientation} value={vol} size={size} onChange={(v) => setVolume(Math.round(v * 100) / 100)} label="Volume" />
      </div>
      <VolumeNumber big={big} />
    </div>
  );
}

function Buttons({ big }: { big?: boolean }) {
  const t = useTransport();
  const shuffle = useStore((s) => s.shuffle);
  const repeat = useStore((s) => s.repeat);
  return (
    <div className="transport-buttons">
      <IconButton icon="shuffle" title="Shuffle" active={shuffle} onClick={() => setState({ shuffle: !shuffle })} size={16} />
      <IconButton icon="prev" title="Previous (Ctrl+←)" onClick={prev} size={big ? 22 : 18} />
      <IconButton icon={t.playing ? "pause" : "play"} title="Play / Pause (Space)" onClick={togglePlay} big size={big ? 30 : 24} className="play-btn" />
      <IconButton icon="next" title="Next (Ctrl+→)" onClick={next} size={big ? 22 : 18} />
      <IconButton icon={repeat === "one" ? "repeatOne" : "repeat"} title={`Repeat: ${repeat}`} active={repeat !== "off"}
        onClick={() => setState({ repeat: repeat === "off" ? "all" : repeat === "all" ? "one" : "off" })} size={16} />
    </div>
  );
}

/** Album art in the player bar; clicking it opens the full-screen player. */
function CoverMini({ size = 48 }: { size?: number }) {
  const t = useTransport();
  const open = (e: React.SyntheticEvent) => { e.stopPropagation(); e.preventDefault(); setState({ fullPlayer: true }); };
  return (
    <span className="cover-hit" role="button" tabIndex={0} title="Open full-screen player (lyrics & queue)" onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter") open(e); }}>
      {t.cover ? <img className="cover-mini" src={t.cover} alt="" style={{ width: size, height: size }} />
        : <div className="cover-mini empty" style={{ width: size, height: size }}><Icon name="disc" size={size * 0.5} /></div>}
    </span>
  );
}

function Transport() {
  const theme = useTheme();
  const t = useTransport();
  const goNow = () => setState({ view: "nowplaying" });
  const fav = useStore((s) => (t.item?.trackId ? (s.tracks.find((x) => x.id === t.item!.trackId)?.rating ?? 0) >= 4 : false));
  const endless = useStore((s) => s.autoPlay.enabled);
  const hudOpen = useStore((s) => s.hudOpen);
  const extras = (
    <div className="transport-extras">
      <SleepCountdown />
      {t.item?.trackId && <IconButton icon="heart" title={fav ? "Remove from favourites" : "Add to favourites"} active={fav} className={fav ? "fav-on" : ""} onClick={() => toggleFavorite(t.item!.trackId!)} size={16} />}
      <IconButton icon="infinity" title={endless ? "Endless Auto-Play: on" : "Endless Auto-Play: off"} active={endless} onClick={() => setAutoPlay({ enabled: !endless })} size={16} />
      <IconButton icon="cinema" title="Cinema mode (C)" onClick={() => setState({ cinema: true })} size={16} />
      <IconButton icon="hud" title={hudOpen ? "Hide Focus HUD" : "Show Focus HUD"} active={hudOpen} onClick={() => toggleHud()} size={16} />
    </div>
  );
  switch (theme.layout) {
    case "left-rail":
      return (
        <aside className="transport transport-rail">
          <button className="rail-cover" onClick={goNow} title={`${t.title} — ${t.artist}`}><CoverMini size={46} /></button>
          <IconButton icon="prev" title="Previous" onClick={prev} />
          <IconButton icon={t.playing ? "pause" : "play"} title="Play/Pause" onClick={togglePlay} big className="play-btn" size={24} />
          <IconButton icon="next" title="Next" onClick={next} />
          <div className="rail-progress"><Progress orientation="v" /></div>
          <div className="rail-time">{fmtTime(t.position)}</div>
          <div className="rail-volume"><Volume orientation="v" /></div>
          <div className="rail-extras">{extras}</div>
        </aside>
      );
    case "floating-dock":
      return (
        <div className="transport transport-dock">
          <button className="dock-meta" onClick={goNow}>
            <CoverMini size={44} />
            <div className="dock-text"><div className="t-title" title={t.title}>{t.title || "Nothing playing"}</div><div className="t-artist" title={t.artist}>{t.artist}</div></div>
          </button>
          <Buttons />
          <div className="dock-progress">
            <span className="t-time">{fmtTime(t.position)}</span><Progress /><span className="t-time">{fmtTime(t.duration)}</span>
          </div>
          <div className="dock-vol"><Volume /></div>
          {extras}
        </div>
      );
    case "hardware-rack":
      return (
        <div className="transport transport-rack">
          <span className="screw tl" /><span className="screw tr" /><span className="screw bl" /><span className="screw br" />
          <div className="rack-display">
            <CoverMini size={64} />
            <div className="rack-lcd" onClick={goNow}>
              <div className="lcd-top"><span className="lcd-mode">{t.ytActive ? "STREAM" : t.st?.bitPerfect ? "BIT-PERFECT" : t.playing ? "PLAY" : "STOP"}</span><span>{t.st?.info ? `${t.st.info.codec} ${t.st.info.dsd ? "" : t.st.info.bits + "/"}${fmtRate(t.st.info.sampleRate)}` : ""}</span></div>
              <div className="lcd-time">{fmtTime(t.position)}</div>
              <div className="lcd-title"><span>{t.title ? `${t.artist} — ${t.title}` : "NO DISC"}</span></div>
            </div>
          </div>
          <RackMeters />
          <div className="rack-keys"><Buttons big /></div>
          <div className="rack-knobs"><Progress big /><Volume size={84} big /></div>
          {extras}
        </div>
      );
    case "cinema":
      return (
        <div className="transport transport-cinema">
          <div className="cin-meta" onClick={goNow}>
            <CoverMini size={64} />
            <div><div className="t-title big" title={t.title}>{t.title || "Nothing playing"}</div><div className="t-artist" title={t.artist}>{t.artist}</div></div>
          </div>
          <div className="cin-center">
            <Buttons big />
            <div className="dock-progress"><span className="t-time">{fmtTime(t.position)}</span><Progress /><span className="t-time">{fmtTime(t.duration)}</span></div>
          </div>
          <div className="cin-right"><Volume />{extras}</div>
        </div>
      );
    default:
      return (
        <footer className="transport transport-bar">
          <button className="bar-meta" onClick={goNow}>
            <CoverMini size={52} />
            <div className="dock-text"><div className="t-title" title={t.title}>{t.title || "Nothing playing"}</div><div className="t-artist" title={t.artist}>{t.artist}</div></div>
          </button>
          <div className="bar-center">
            <Buttons />
            <div className="dock-progress"><span className="t-time">{fmtTime(t.position)}</span><Progress /><span className="t-time">{fmtTime(t.duration)}</span></div>
          </div>
          <div className="bar-right">
            <Volume />
            {extras}
          </div>
          <div className="bar-signal"><SignalPath compact /></div>
        </footer>
      );
  }
}

function RackMeters() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const acc = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      ctx.clearRect(0, 0, w, h);
      const n = 32;
      for (let ch = 0; ch < 2; ch++) {
        const v = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-5, live.frame.peak[ch])) + 48) / 48));
        for (let i = 0; i < n; i++) {
          ctx.fillStyle = i / n < v ? (i > n * 0.88 ? "#ff3b3b" : i > n * 0.72 ? "#ffc400" : acc) : "rgba(128,128,128,.14)";
          ctx.fillRect(i * (w / n) + 1, ch * (h / 2) + 2, w / n - 2, h / 2 - 4);
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="rack-meters" />;
}

const RESIZE_DIRS = ["North", "South", "East", "West", "NorthEast", "NorthWest", "SouthEast", "SouthWest"] as const;
function ResizeHandles() {
  useEffect(() => {
    const w = getCurrentWindow();
    const sync = () => w.isMaximized().then((m) => document.documentElement.classList.toggle("maximized", m)).catch(() => {});
    sync();
    const un = w.onResized(sync);
    return () => { un.then((f) => f()); };
  }, []);
  return (
    <>
      {RESIZE_DIRS.map((d) => (
        <div key={d} className={`rz rz-${d}`} onPointerDown={(e) => { e.preventDefault(); getCurrentWindow().startResizeDragging(d).catch(() => {}); }} />
      ))}
    </>
  );
}

function Toast() {
  const msg = useStore((s) => s.toast);
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}

function Keyboard() {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement)?.getAttribute?.("role") === "slider") return; // the focused slider handles its own keys
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowRight" && e.ctrlKey) next();
      else if (e.key === "ArrowLeft" && e.ctrlKey) prev();
      else if (e.key === "ArrowRight" && e.shiftKey) seek(livePosition() + 10);
      else if (e.key === "ArrowLeft" && e.shiftKey) seek(Math.max(0, livePosition() - 10));
      else if (e.key.toLowerCase() === "c" && !e.ctrlKey) setState((s) => ({ cinema: !s.cinema }));
      else if (e.key.toLowerCase() === "m" && !e.ctrlKey) toggleMute();
      else if (e.key === "ArrowUp" && !e.ctrlKey) { e.preventDefault(); nudgeVolume(5); }
      else if (e.key === "ArrowDown" && !e.ctrlKey) { e.preventDefault(); nudgeVolume(-5); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return null;
}

// ------------------------------------------------------------------ full-screen player (click the album art)
function FullPlayerLyrics() {
  const lyrics = useStore((s) => s.lyrics);
  const offset = useStore((s) => s.lyricOffset);
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const holdUntil = useRef(0);
  const synced = isSynced(lyrics);

  // follow the song: highlight the current line ~8×/s (no per-frame re-renders)
  useEffect(() => {
    if (!synced || !lyrics) { setActive(-1); return; }
    const id = window.setInterval(() => {
      const pos = livePosition() + offset - live.lyricLatency;
      let i = -1;
      for (let k = 0; k < lyrics.length; k++) if (lyrics[k].time <= pos) i = k;
      setActive((a) => (a === i ? a : i));
    }, 120);
    return () => window.clearInterval(id);
  }, [lyrics, offset, synced]);

  // keep the current line about a third of the way down, unless you're scrolling yourself
  useEffect(() => {
    const el = box.current;
    if (!el || active < 0 || Date.now() < holdUntil.current) return;
    const line = el.querySelector<HTMLElement>(`[data-i="${active}"]`);
    if (!line) return;
    el.scrollTo({ top: Math.max(0, line.offsetTop - el.clientHeight * 0.32), behavior: "smooth" });
  }, [active]);

  if (!lyrics || !lyrics.length) return <div className="fp-empty"><LyricsEmpty big /></div>;
  return (
    <>
      <div className={`fp-lyrics ${synced ? "synced" : "plain"}`} ref={box}
        onWheel={() => (holdUntil.current = Date.now() + 4000)} onPointerDown={() => (holdUntil.current = Date.now() + 4000)}>
        <div className="fp-pad" />
        {lyrics.map((l, i) => {
          const d = active < 0 ? 3 : Math.abs(i - active);
          return (
            <p key={i} data-i={i}
              className={`fp-line ${i === active ? "now" : i < active ? "past" : ""} ${d >= 3 ? "far" : ""}`}
              style={{ ["--d" as string]: Math.min(d, 6) }}
              onClick={synced ? () => { holdUntil.current = 0; seek(Math.max(0, l.time - offset)); } : undefined}
              title={synced ? "Jump here" : undefined}>
              {l.text || "♪"}
            </p>
          );
        })}
        <div className="fp-pad" />
      </div>
      <footer className="fp-foot">
        <LyricsStatusChip long />
        {synced ? (
          <span className="fp-offset" title="Lyrics early/late? Nudge them (saved for this song)">
            <button onClick={() => setLyricOffset(offset - 0.5)} aria-label="Lyrics later">−</button>
            <span>{offset > 0 ? "+" : ""}{offset.toFixed(1)} s</span>
            <button onClick={() => setLyricOffset(offset + 0.5)} aria-label="Lyrics earlier">+</button>
          </span>
        ) : (
          <button className="btn small" onClick={() => getSyncedLyricsNow()}>Get synced version</button>
        )}
      </footer>
    </>
  );
}

function FullPlayerQueue() {
  const queue = useStore((s) => s.queue);
  const qi = useStore((s) => s.queueIndex);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".now")?.scrollIntoView({ block: "center" });
  }, [qi]);
  if (!queue.length) return <div className="fp-empty"><Icon name="queue" size={34} /><p>The queue is empty.</p></div>;
  return (
    <div className="fp-queue" ref={ref}>
      {queue.map((it, i) => (
        <button key={i} className={`fp-q ${i === qi ? "now" : i < qi ? "past" : ""}`} onClick={() => playIndex(i)}>
          <span className="fp-q-n">{i === qi ? <Icon name="volume" size={13} /> : i + 1}</span>
          <span className="fp-q-t"><strong>{it.title}</strong><small>{it.artist}</small></span>
          <span className="fp-q-s">{it.kind === "youtube" ? serviceById(itemService(it)).short : it.duration ? fmtTime(it.duration) : ""}</span>
        </button>
      ))}
    </div>
  );
}

function FullPlayer() {
  const open = useStore((s) => s.fullPlayer);
  const tab = useStore((s) => s.fullPlayerTab);
  const t = useTransport();
  const videoMode = useStore((s) => s.videoMode);
  const [top, setTop] = useState(0);
  useEffect(() => {
    if (!open) return;
    const measure = () => setTop(document.querySelector(".app > .titlebar")?.getBoundingClientRect().bottom ?? 0);
    measure();
    window.addEventListener("resize", measure);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setState({ fullPlayer: false }); };
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener("keydown", esc); };
  }, [open]);
  if (!open) return null;
  const album = t.item?.album;
  return (
    <div className="fp" style={{ top }} role="dialog" aria-label="Full-screen player">
      <div className="fp-bg" aria-hidden>
        {t.cover && <img src={t.cover} alt="" />}
      </div>
      <div className={`fp-body ${videoMode ? "with-video" : ""}`}>
        <section className="fp-left">
          {videoMode ? (
            <div className="fp-video-wrap">
              <VideoSurface kind="full" className="fp-video" />
              <VideoBar />
            </div>
          ) : (
            <button className="fp-art" onClick={() => setState({ fullPlayer: false })} title="Close (Esc)">
              {t.cover ? <img src={t.cover} alt={`${t.title} cover`} /> : <span className="fp-art-empty"><Icon name="disc" size={90} /></span>}
            </button>
          )}
          <div className="fp-meta">
            <h2 className="fp-title" title={t.title}>{t.title || "Nothing playing"}</h2>
            <div className="fp-artist" title={t.artist}>{t.artist}{album ? <span className="fp-album"> · {album}</span> : null}</div>
          </div>
          <div className="fp-progress">
            <span className="t-time">{fmtTime(t.position)}</span>
            <Progress />
            <span className="t-time">{fmtTime(t.duration)}</span>
          </div>
          <div className="fp-controls">
            <Buttons big />
            <Volume />
          </div>
        </section>
        <section className="fp-right">
          <div className="fp-tabs">
            <div className="fp-seg" role="tablist">
              <button role="tab" aria-selected={tab === "queue"} className={tab === "queue" ? "on" : ""} onClick={() => setState({ fullPlayerTab: "queue" })}>
                <Icon name="queue" size={14} /> Queue
              </button>
              <button role="tab" aria-selected={tab === "lyrics"} className={tab === "lyrics" ? "on" : ""} onClick={() => setState({ fullPlayerTab: "lyrics" })}>
                <Icon name="lyrics" size={14} /> Lyrics
              </button>
              <button role="tab" aria-selected={tab === "artist"} className={tab === "artist" ? "on" : ""} onClick={() => setState({ fullPlayerTab: "artist" })}>
                <Icon name="disc" size={14} /> Artist
              </button>
            </div>
            <button className={`fp-vid-toggle ${videoMode ? "on" : ""}`} onClick={() => setState({ videoMode: !videoMode })} title="Show the music video instead of the album art">
              <Icon name="cinema" size={14} /> {videoMode ? "Video" : "Art"}
            </button>
            <IconButton icon="close" title="Close (Esc)" size={16} onClick={() => setState({ fullPlayer: false })} className="fp-close" />
          </div>
          <div className="fp-panel">{tab === "lyrics" ? <FullPlayerLyrics /> : tab === "artist" ? <div className="fp-artist-bio"><ArtistBioView compact /></div> : <FullPlayerQueue />}</div>
        </section>
      </div>
    </div>
  );
}

/** Phone-style themes (iOS, One UI, Material) open every page with a large title. */
const LARGE_TITLE_THEMES = new Set(["ios", "one-ui", "pixel-material"]);
function PageTitle({ view }: { view: ViewId }) {
  const items = useNavItems();
  const label = items.find((n) => n.id === view)?.label ?? NAV.find((n) => n.id === view)?.label ?? "";
  return (
    <>
      {/* iOS: compact centred title that fades in as the large title scrolls away */}
      <div className="ios-navbar" aria-hidden>{label}</div>
      <h1 className="page-hero">{label}</h1>
    </>
  );
}

export default function App() {
  const themeId = useStore((s) => s.themeId);
  const view = useStore((s) => s.view);
  const viz = useStore((s) => s.visualizer);
  const cover = useStore((s) => s.cover);
  const custom = useStore((s) => s.customTheme);
  const customBg = useStore((s) => s.customBg);
  registerCustomTheme(custom ? customAsTheme(custom) : null);
  const theme = themeById(themeId);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      applyTheme(theme);
      setCustomBackground(customBg);
      applyCustomExtras(themeId === CUSTOM_ID && custom ? custom : null);
    });
    return () => cancelAnimationFrame(raf);
  }, [themeId, custom, customBg]);
  useEffect(() => {
    initPlayer().then(() => { initIntegrations(); initLyrics(); initMods(); initVideo(); });
    initAdaptive();
  }, []);
  // cinema layout: idle-hide chrome
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (theme.layout !== "cinema") return;
    let t = 0;
    const wake = () => { setIdle(false); clearTimeout(t); t = window.setTimeout(() => setIdle(true), 3500); };
    window.addEventListener("pointermove", wake);
    wake();
    return () => { window.removeEventListener("pointermove", wake); clearTimeout(t); };
  }, [theme.layout]);
  return (
    <div className={`app ${idle ? "idle" : ""} view-${view}`}>
      <div className="surface" aria-hidden />
      {theme.layout === "cinema" && view !== "nowplaying" && (
        <div className="cinema-bg"><Visualizer viz={viz} cover={cover} fps={30} /></div>
      )}
      <Particles kind={theme.particles} />
      <TitleBar />
      <Nav />
      <main className="main" key={theme.layout}>
        {LARGE_TITLE_THEMES.has(theme.id) && view !== "nowplaying" && view !== "youtube" && <PageTitle view={view} />}
        <View id={view} />
      </main>
      <Transport />
      <CinemaMode />
      <FullPlayer />
      <Toast />
      <Keyboard />
      <ResizeHandles />
    </div>
  );
}
