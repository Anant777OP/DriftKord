// Now Playing view, Live Signal Path HUD, and Lyric-Reactive Cinema Mode.
import { useEffect, useRef, useState } from "react";
import { api, fmtRate } from "../api";
import { Icon, IconButton, Panel, Segmented } from "../controls";
import { getSyncedLyricsNow, setLyricOffset } from "../player";
import { useOwnLyrics } from "../lyrics";
import { LyricsEmpty, LyricsStatusChip } from "./LyricsTools";
import { live } from "../store";
import { VideoBar, VideoSurface } from "./VideoSurface";
import { ArtistPanel } from "./ArtistBio";
import { shuffleAll } from "../autoplay";
import { setState, toast, useStore, VizId } from "../store";
import { isSynced, parseLrc, Visualizer, VISUALIZERS, lyricAt } from "../visualizers";
import { livePosition } from "../store";
import { itemService, serviceById } from "../streaming";

export function SignalPath({ compact }: { compact?: boolean }) {
  const st = useStore((s) => s.status);
  const lt = useStore((s) => s.lastTransition);
  const ytActive = useStore((s) => s.ytActive);
  const ytRouted = useStore((s) => s.ytRouteEngine);
  const svc = useStore((s) => (s.ytActive ? itemService(s.queue[s.queueIndex]) : "youtube"));
  if (ytActive && (!ytRouted || svc !== "youtube")) {
    const info = serviceById(svc);
    return (
      <div className={`signal-path ${compact ? "compact" : ""}`}>
        <span className="sp-node">{info.name} stream</span><span className="sp-arrow">→</span>
        <span className="sp-node">WebView2 · Windows mixer</span>
        <span className="sp-badge warn" title={info.drm ? "DRM-protected: plays through the service's own player; DriftKord's DSP can't be applied" : undefined}>{info.drm ? "DRM · DSP off" : "Not bit-perfect"}</span>
      </div>
    );
  }
  if (!st || !st.signalPath.length) {
    return <div className={`signal-path ${compact ? "compact" : ""}`}><span className="sp-node muted">Idle — no signal</span></div>;
  }
  const recent = lt && Date.now() - lt.at < 15_000;
  return (
    <div className={`signal-path ${compact ? "compact" : ""}`} title={st.signalPath.join("  →  ")}>
      {st.signalPath.map((n, i) => (
        <span key={i} className="sp-seg">
          {i > 0 && <span className="sp-arrow">→</span>}
          <span className={`sp-node ${i === 0 ? "src" : i === st.signalPath.length - 1 ? "out" : ""}`}>{n}</span>
        </span>
      ))}
      {st.bitPerfect ? <span className="sp-badge ok">BIT-PERFECT</span> : <span className="sp-badge">Processed</span>}
      {recent && (
        <span className={`sp-badge ${lt!.gapless ? "ok" : ""}`}>
          {lt!.crossfade ? "Crossfaded" : lt!.gapless ? "Gapless ✓" : "Format switch"}
        </span>
      )}
      {st.output.error && <span className="sp-badge warn" title={st.output.error}>⚠ {st.output.fellBack ? "Shared fallback" : "Output"}</span>}
    </div>
  );
}

export function VizPicker() {
  const viz = useStore((s) => s.visualizer);
  const videoMode = useStore((s) => s.videoMode);
  return (
    <div className="viz-picker" role="tablist" aria-label="Visualizer">
      <button className={`viz-video ${videoMode ? "on" : ""}`} title="Show the song's official music video, synced to your music (found on YouTube, muted)" onClick={() => setState({ videoMode: !videoMode })}>
        <Icon name="cinema" size={13} /> Music video
      </button>
      {VISUALIZERS.map((v) => (
        <button key={v.id} className={!videoMode && viz === v.id ? "on" : ""} title={v.desc} onClick={() => setState({ visualizer: v.id as VizId, videoMode: false })}>
          {v.name}
        </button>
      ))}
    </div>
  );
}

export function NowPlaying() {
  const queue = useStore((s) => s.queue);
  const qi = useStore((s) => s.queueIndex);
  const cover = useStore((s) => s.cover);
  const viz = useStore((s) => s.visualizer);
  const lyrics = useStore((s) => s.lyrics);
  const lyricOffset = useStore((s) => s.lyricOffset);
  const st = useStore((s) => s.status);
  const yt = useStore((s) => s.yt);
  const ytActive = useStore((s) => s.ytActive);
  const tracks = useStore((s) => s.tracks);
  const [showLyrics, setShowLyrics] = useState(true);
  const adaptive = useStore((s) => s.adaptive);
  const videoMode = useStore((s) => s.videoMode);
  const item = queue[qi];
  const track = item?.trackId ? tracks.find((t) => t.id === item.trackId) : undefined;
  const title = ytActive ? yt?.title || item?.title : item?.title;
  const artist = ytActive ? yt?.artist || item?.artist : item?.artist;
  const duration = ytActive ? yt?.duration ?? 0 : st?.duration ?? 0;

  return (
    <div className={`nowplaying ${videoMode ? "video-mode" : ""}`}>
      <div className={videoMode ? "np-video" : "np-stage"}>
        {videoMode ? <VideoSurface kind="nowplaying" className="np-video-stage" /> : <Visualizer viz={viz} cover={cover} lyrics={lyrics} duration={duration} showLyrics={showLyrics} lyricOffset={lyricOffset} />}
        <div className="np-overlay">
          <div className="np-meta">
            {cover ? <img className="np-cover" src={cover} alt="" /> : <div className="np-cover empty"><Icon name="disc" size={48} /></div>}
            <div>
              <div className="np-title">{title || "Nothing playing"}</div>
              {!item && tracks.length > 0 && <button className="btn primary np-shuffle" onClick={shuffleAll}><Icon name="shuffle" size={16} /> Shuffle all {tracks.length} songs</button>}
              <div className="np-artist">{artist}{item?.album ? ` — ${item.album}` : ""}</div>
              <div className="np-tags">
                {ytActive && <span className="chip yt">{serviceById(itemService(item)).name}</span>}
                {st?.info && !ytActive && <span className="chip">{st.info.codec}</span>}
                {st?.info?.spatial && !ytActive && <span className="chip" title="Multichannel / Dolby Atmos rendered for your output (Settings → Playback engine)">{st.info.spatial}</span>}
                {st?.info && !ytActive && st.info.bits > 0 && <span className="chip">{st.info.dsd ? "1-bit" : `${st.info.bits}-bit`}</span>}
                {st?.info && !ytActive && <span className="chip">{fmtRate(st.info.dsd ? st.info.dsdRate : st.info.sampleRate)}</span>}
                {track?.bpm ? <span className="chip">{track.bpm.toFixed(0)} BPM</span> : null}
                {track?.camelot ? <span className="chip">{track.musicalKey} · {track.camelot}</span> : null}
                {track?.dr ? <span className="chip">DR{Math.round(track.dr)}</span> : null}
              </div>
            </div>
          </div>
          <div className="np-tools">
            {item && showLyrics && !isSynced(lyrics) && (
              <button className="btn small np-lyric-cta" onClick={() => getSyncedLyricsNow()} title="Search LRCLIB for time-synced lyrics (sends title and artist)">
                <Icon name="lyrics" size={14} /> {lyrics ? "Lyrics aren't timed · Get synced" : "Find synced lyrics"}
              </button>
            )}
            <IconButton icon="lyrics" title={showLyrics ? "Hide lyrics" : "Show lyrics"} active={showLyrics} onClick={() => setShowLyrics(!showLyrics)} />
            <IconButton icon="themes" title={`Adaptive colours: ${adaptive === "off" ? "off" : adaptive === "accent" ? "accents" : "full"} (click to change)`} active={adaptive !== "off"}
              onClick={() => setState({ adaptive: adaptive === "off" ? "accent" : adaptive === "accent" ? "full" : "off" })} />
            <IconButton icon="cinema" title="Lyric-Reactive Cinema Mode" onClick={() => setState({ cinema: true })} />
          </div>
        </div>
      </div>
      {videoMode && <VideoBar />}
      <VizPicker />
      <SignalPath />
      <LyricsPanel />
      <ArtistPanel />
    </div>
  );
}

function stampOf(t: number) {
  const m = Math.floor(Math.max(0, t) / 60);
  const s = Math.max(0, t) - m * 60;
  return `[${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}]`;
}

function LyricsPanel() {
  const lyrics = useStore((s) => s.lyrics);
  const queue = useStore((s) => s.queue);
  const qi = useStore((s) => s.queueIndex);
  const st = useStore((s) => s.status);
  const offset = useStore((s) => s.lyricOffset);
  const [, tick] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [tapping, setTapping] = useState<{ times: number[] } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const item = queue[qi];
  const synced = isSynced(lyrics);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 200);
    return () => clearInterval(id);
  }, []);
  useEffect(() => setTapping(null), [item]);
  const ly = lyricAt(lyrics, livePosition() + offset - live.lyricLatency, st?.duration ?? 0);
  // keep the current line in view
  const curIndex = tapping ? tapping.times.length : ly?.index ?? -1;
  useEffect(() => {
    // Scroll only the lyrics list itself — scrollIntoView() would also scroll the whole page
    // (and drag the visualizer out of view) in layouts where the page is taller than the window.
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-i="${curIndex}"]`);
    if (box && el) {
      const target = Math.max(0, el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2); // box is position:relative
      // hand-rolled easing: native smooth scrolling doesn't run reliably in WebView2
      const from = box.scrollTop;
      const t0 = performance.now();
      let raf = 0;
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / 350);
        box.scrollTop = from + (target - from) * (1 - Math.pow(1 - k, 3));
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      // guarantee the final position even when animation frames are paused (window hidden/minimised)
      const done = window.setTimeout(() => (box.scrollTop = target), 400);
      return () => {
        cancelAnimationFrame(raf);
        window.clearTimeout(done);
      };
    }
  }, [curIndex]);

  const persist = async (text: string, lines: typeof lyrics) => {
    void lines;
    useOwnLyrics(text);
    if (item?.path) {
      await api.saveLyrics(item.path, text);
      toast("Saved .lrc next to the track");
    } else toast("Synced for this session");
  };
  const save = async () => {
    await persist(draft, parseLrc(draft));
    setEditing(false);
  };
  // Tap-to-sync: one tap at the start of each line turns plain lyrics into synced ones.
  const startTapping = () => {
    if (!lyrics) return;
    setTapping({ times: [] });
    toast("Tap “Line starts now” as each line begins");
  };
  const tap = async () => {
    if (!tapping || !lyrics) return;
    const times = [...tapping.times, livePosition()];
    if (times.length >= lyrics.length) {
      const text = lyrics.map((l, i) => `${stampOf(times[i])}${l.text}`).join("\n");
      setTapping(null);
      setLyricOffset(0);
      await persist(text, parseLrc(text));
    } else setTapping({ times });
  };

  return (
    <Panel
      title={<span className="lyr-title">Lyrics <LyricsStatusChip /></span>}
      className="lyrics-panel"
      actions={
        <>
          {synced && !editing && (
            <span className="lyric-offset" title="Shift lyric timing for this song (saved)">
              <button className="btn small" onClick={() => setLyricOffset(offset - 0.5)} aria-label="Lyrics later">−0.5s</button>
              <span className="mono small">{offset === 0 ? "in sync" : `${offset > 0 ? "+" : ""}${offset.toFixed(1)}s`}</span>
              <button className="btn small" onClick={() => setLyricOffset(offset + 0.5)} aria-label="Lyrics earlier">+0.5s</button>
              {offset !== 0 && <button className="btn small ghost" onClick={() => setLyricOffset(0)}>Reset</button>}
            </span>
          )}
          {lyrics && !editing && <button className="btn small" onClick={tapping ? () => setTapping(null) : startTapping}>{tapping ? "Cancel sync" : "Tap to sync"}</button>}
          {item?.path && !tapping && (
            <button className="btn small" onClick={() => {
              setDraft(lyrics ? lyrics.map((l) => (l.time >= 0 ? `${stampOf(l.time)}${l.text}` : l.text)).join("\n") : "");
              setEditing(!editing);
            }}>{editing ? "Cancel" : "Edit .lrc"}</button>
          )}
        </>
      }
    >
      {editing ? (
        <div className="lrc-editor">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="[00:12.50]First line…" />
          <div className="row">
            <button className="btn" onClick={() => setDraft((d) => d + (d.endsWith("\n") || !d ? "" : "\n") + stampOf(livePosition()))}>Insert timestamp at playhead</button>
            <button className="btn primary" onClick={save}>Save</button>
          </div>
        </div>
      ) : lyrics && lyrics.length ? (
        <>
          {tapping ? (
            <div className="tap-bar">
              <button className="btn primary" onClick={tap}>Line starts now ({tapping.times.length + 1}/{lyrics.length})</button>
              <span className="muted small">Press as each highlighted line begins. Tip: seek back a little before the first line.</span>
            </div>
          ) : !synced ? (
            <div className="lyric-note">These lyrics have no timing, so they can’t follow the song. <button className="btn small primary" onClick={() => getSyncedLyricsNow()}>Get synced lyrics</button> or use <b>Tap to sync</b>.</div>
          ) : null}
          <div className="lyrics-scroll" ref={scrollRef}>
            {lyrics.map((l, i) => (
              <div key={i} data-i={i} className={`lyric-line ${i === curIndex ? "current" : ""} ${i < curIndex ? "past" : ""}`} lang="und">{l.text || "♪"}</div>
            ))}
          </div>
        </>
      ) : (
        <LyricsEmpty />
      )}
    </Panel>
  );
}
/** Full-screen Lyric-Reactive Cinema Mode overlay. */
export function CinemaMode() {
  const cinema = useStore((s) => s.cinema);
  const viz = useStore((s) => s.visualizer);
  const cover = useStore((s) => s.cover);
  const lyrics = useStore((s) => s.lyrics);
  const lyricOffset = useStore((s) => s.lyricOffset);
  const st = useStore((s) => s.status);
  const yt = useStore((s) => s.yt);
  const ytActive = useStore((s) => s.ytActive);
  const queue = useStore((s) => s.queue);
  const qi = useStore((s) => s.queueIndex);
  const videoMode = useStore((s) => s.videoMode);
  useEffect(() => {
    if (!cinema) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setState({ cinema: false });
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [cinema]);
  if (!cinema) return null;
  const item = queue[qi];
  if (videoMode) {
    // Music video: the video is a separate layer that nothing can be drawn over, so the title bar sits
    // above it and the lyrics below it.
    return (
      <div className="cinema cinema-video">
        <div className="cinema-top">
          <div className="ellipsis">
            <div className="cinema-title ellipsis">{ytActive ? yt?.title : item?.title}</div>
            <div className="cinema-artist ellipsis">{ytActive ? yt?.artist : item?.artist}</div>
          </div>
          <div className="row">
            <VizPicker />
            <IconButton icon="close" title="Exit cinema (Esc)" onClick={() => setState({ cinema: false })} />
          </div>
        </div>
        <VideoSurface kind="cinema" className="cinema-video-stage" />
        <CinemaLyrics />
      </div>
    );
  }
  return (
    <div className="cinema" onDoubleClick={() => setState({ cinema: false })}>
      <Visualizer viz={viz} cover={cover} lyrics={lyrics} duration={ytActive ? yt?.duration ?? 0 : st?.duration ?? 0} showLyrics bigLyrics lyricOffset={lyricOffset} />
      <div className="cinema-top">
        <div>
          <div className="cinema-title">{ytActive ? yt?.title : item?.title}</div>
          <div className="cinema-artist">{ytActive ? yt?.artist : item?.artist}</div>
        </div>
        <div className="row">
          <VizPicker />
          <IconButton icon="close" title="Exit cinema (Esc)" onClick={() => setState({ cinema: false })} />
        </div>
      </div>
      {!isSynced(lyrics) && (
        <div className="cinema-hint">
          {lyrics ? "These lyrics aren't timed." : "No lyrics for this track."}{" "}
          <button className="btn small primary" onClick={() => getSyncedLyricsNow()}>Get synced lyrics</button>
        </div>
      )}
    </div>
  );
}

/** The current lyric line, large, with the lines either side (Cinema Mode with a music video). */
function CinemaLyrics() {
  const lyrics = useStore((s) => s.lyrics);
  const offset = useStore((s) => s.lyricOffset);
  const st = useStore((s) => s.status);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 150);
    return () => clearInterval(id);
  }, []);
  if (!lyrics || !lyrics.length || !isSynced(lyrics)) {
    return (
      <div className="cinema-lyrics">
        <div className="cl-hint">{lyrics ? "These lyrics aren't timed." : "No lyrics for this track."} <button className="btn small primary" onClick={() => getSyncedLyricsNow()}>Get synced lyrics</button></div>
      </div>
    );
  }
  const ly = lyricAt(lyrics, livePosition() + offset - live.lyricLatency, st?.duration ?? 0);
  const i = ly?.index ?? -1;
  const line = (k: number) => (k >= 0 && k < lyrics.length ? lyrics[k].text || "♪" : "");
  return (
    <div className="cinema-lyrics" lang="und">
      <div className="cl-line cl-prev">{line(i - 1)}</div>
      <div className="cl-line cl-cur" key={i}>{i >= 0 ? line(i) : "♪"}</div>
      <div className="cl-line cl-next">{line(i + 1)}</div>
    </div>
  );
}

export function VizSelectInline() {
  const viz = useStore((s) => s.visualizer);
  return (
    <Segmented value={viz} options={VISUALIZERS.map((v) => ({ value: v.id, label: v.name }))} onChange={(v) => setState({ visualizer: v as VizId })} />
  );
}
