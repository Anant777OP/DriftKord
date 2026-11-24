// The area where the music video appears (Now Playing stage or full-screen player). The video
// itself is a separate muted view placed exactly over this box; the box shows status underneath.
import { useEffect, useRef } from "react";
import { Icon } from "../controls";
import { useStore } from "../store";
import { useState } from "react";
import { getVideoQuality, nextVideo, nudgeVideo, qualityLabel, refindVideo, registerSurface, setVideoQuality, SurfaceKind, VIDEO_QUALITIES } from "../video";

export function VideoSurface({ kind, className }: { kind: SurfaceKind; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const info = useStore((s) => s.videoInfo);
  useEffect(() => {
    registerSurface(kind, ref.current);
    return () => registerSurface(kind, null);
  }, [kind]);
  return (
    <div className={`video-surface ${className ?? ""}`} ref={ref}>
      <div className="vs-status">
        {info.status === "searching" && <><span className="lyr-spinner" aria-hidden /><span>Finding the music video…</span></>}
        {info.status === "none" && <><Icon name="cinema" size={30} /><span>No music video found for this song.</span><button className="btn small" onClick={refindVideo}>Search again</button></>}
        {info.status === "offline" && <><Icon name="cinema" size={30} /><span>Can't play the music video right now.</span>{info.reason && <small className="vs-reason">YouTube: {info.reason}</small>}<button className="btn small" onClick={refindVideo}>Try again</button></>}
        {info.status === "off" && <span className="muted">Play something to see its music video.</span>}
      </div>
    </div>
  );
}

/** Small bar under the video: what's showing, a different result, and timing nudges. */
function QualityPicker() {
  const info = useStore((s) => s.videoInfo);
  const [q, setQ] = useState(getVideoQuality());
  const now = qualityLabel(info.quality);
  const has = new Set(info.levels ?? []);
  return (
    <label className="vb-quality" title="Video quality. Auto lets YouTube decide (often low, because the player is small); if a video doesn't have the chosen quality, the closest one below plays.">
      <span>Quality</span>
      <select value={q} onChange={(e) => { setQ(e.target.value); setVideoQuality(e.target.value); }}>
        {VIDEO_QUALITIES.map((o) => (
          <option key={o.id} value={o.id}>{o.label}{has.size && o.id !== "auto" && o.id !== "max" && !has.has(o.id) ? " (n/a)" : ""}</option>
        ))}
      </select>
      {now && <small className="vb-now">{now}</small>}
    </label>
  );
}

export function VideoBar() {
  const info = useStore((s) => s.videoInfo);
  if (info.status !== "ready" && info.status !== "searching") return null;
  return (
    <div className="video-bar">
      <span className="vb-title ellipsis" title={`${info.title} — ${info.channel}`}>{info.title ? <>▶ {info.title} <small>· {info.channel}</small></> : "Loading…"}</span>
      <span className="vb-tools">
        {(info.total > 1 || info.more) && (
          <button className="btn small ghost" onClick={() => nextVideo()} disabled={info.loadingMore} title="Show the next search result — more results load automatically, without end">
            {info.loadingMore ? "Finding more…" : <>Wrong video? Next ({info.index + 1}/{info.total}{info.more ? "+" : ""})</>}
          </button>
        )}
        <button className="btn small ghost" onClick={refindVideo} title="Forget this song's saved video and search YouTube again">Search again</button>
        <QualityPicker />
        <span className="vb-offset" title="Music videos sometimes have an intro: shift the video until it matches the song (remembered)">
          <button onClick={() => nudgeVideo(-1)} aria-label="Video earlier">−1s</button>
          <button onClick={() => nudgeVideo(-0.25)} aria-label="Video slightly earlier">−¼</button>
          <span className="mono">{info.offset > 0 ? "+" : ""}{info.offset.toFixed(2)}s</span>
          <button onClick={() => nudgeVideo(0.25)} aria-label="Video slightly later">+¼</button>
          <button onClick={() => nudgeVideo(1)} aria-label="Video later">+1s</button>
          {info.offset !== 0 && <button onClick={() => nudgeVideo(null)}>Reset</button>}
        </span>
      </span>
    </div>
  );
}
