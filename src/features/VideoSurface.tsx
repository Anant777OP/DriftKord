// The area where the music video appears (Now Playing stage or full-screen player). The video
// itself is a separate muted view placed exactly over this box; the box shows status underneath.
import { useEffect, useRef } from "react";
import { Icon } from "../controls";
import { useStore } from "../store";
import { nextVideo, nudgeVideo, refindVideo, registerSurface, SurfaceKind } from "../video";

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
export function VideoBar() {
  const info = useStore((s) => s.videoInfo);
  if (info.status !== "ready" && info.status !== "searching") return null;
  return (
    <div className="video-bar">
      <span className="vb-title ellipsis" title={`${info.title} — ${info.channel}`}>{info.title ? <>▶ {info.title} <small>· {info.channel}</small></> : "Loading…"}</span>
      <span className="vb-tools">
        {info.total > 1 && <button className="btn small ghost" onClick={nextVideo} title="Show the next search result">Wrong video? Next ({info.index + 1}/{info.total})</button>}
        <button className="btn small ghost" onClick={refindVideo} title="Forget this song's saved video and search YouTube again">Search again</button>
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
