// Small lyrics UI pieces shared by the Now Playing panel and the full-screen player:
// a status chip (what the lyrics engine found), an empty state, and a manual search fallback.
import { useLayoutEffect, useRef, useState } from "react";
import { fmtTime } from "../api";
import { Icon } from "../controls";
import { chooseLyrics, LyricsCandidate, refetchLyrics, searchLyricsManually } from "../lyrics";
import { getState, toast, useStore } from "../store";

export function LyricsSearch({ onClose }: { onClose?: () => void }) {
  const s = getState();
  const item = s.queue[s.queueIndex];
  const [title, setTitle] = useState((s.ytActive ? s.yt?.title : item?.title) ?? "");
  const [artist, setArtist] = useState((s.ytActive ? s.yt?.artist : item?.artist) ?? "");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<LyricsCandidate[] | null>(null);
  const run = async () => {
    setBusy(true);
    try { setResults(await searchLyricsManually(title.trim(), artist.trim())); }
    catch { toast("Can't reach the lyrics service right now"); }
    finally { setBusy(false); }
  };
  return (
    <div className="lyr-search" onClick={(e) => e.stopPropagation()}>
      <form className="lyr-search-row" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Song title" aria-label="Song title" />
        <input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Artist" aria-label="Artist" />
        <button className="btn small primary" disabled={busy || !title.trim()}>{busy ? "Searching…" : "Search"}</button>
        {onClose && <button type="button" className="btn small ghost" onClick={onClose}>Close</button>}
      </form>
      {results && (
        results.length ? (
          <ul className="lyr-results">
            {results.slice(0, 12).map((c) => (
              <li key={c.id}>
                <button onClick={() => { chooseLyrics(c); toast("Lyrics set for this song"); onClose?.(); }}>
                  <span className="lyr-res-main"><strong>{c.title}</strong><small>{c.artist}{c.album ? ` · ${c.album}` : ""}</small></span>
                  <span className={`lyr-badge ${c.synced ? "ok" : ""}`}>{c.synced ? "Synced" : "Text only"}</span>
                  <span className="lyr-dur">{c.duration ? fmtTime(c.duration) : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="muted small">Nothing found — try a shorter title or just the main artist.</p>
      )}
    </div>
  );
}

/** The manual-search box, placed so it always fits in the window (opens upward near the bottom). */
function LyricsPopover({ anchor, onClose }: { anchor: React.RefObject<HTMLSpanElement | null>; onClose: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = ref.current;
      if (!a || !p) return;
      const margin = 12;
      const w = Math.min(540, window.innerWidth - margin * 2);
      const h = p.offsetHeight;
      const below = window.innerHeight - a.bottom - margin, above = a.top - margin;
      const up = h > below && above > below;
      const maxH = Math.max(160, (up ? above : below) - 6);
      const left = Math.min(Math.max(margin, a.left), window.innerWidth - w - margin);
      setPos(up ? { left, bottom: window.innerHeight - a.top + 6, width: w, maxHeight: maxH } : { left, top: a.bottom + 6, width: w, maxHeight: maxH });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", place);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", esc, true);
    return () => { ro.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("keydown", esc, true); };
  }, []);
  return <span ref={ref} className="lyr-pop" style={pos}><LyricsSearch onClose={onClose} /></span>;
}

export function LyricsStatusChip({ long }: { long?: boolean }) {
  const info = useStore((s) => s.lyricsInfo);
  const has = useStore((s) => !!s.lyrics?.length);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLSpanElement>(null);
  const label = {
    idle: "",
    searching: "Finding lyrics…",
    synced: `Synced${info.source ? ` · ${info.source}` : ""}`,
    plain: `Not time-synced${info.source ? ` · ${info.source}` : ""}`,
    none: "No lyrics found",
    offline: has ? "Offline · will retry" : "Offline — retrying automatically",
    instrumental: "Instrumental",
  }[info.status];
  if (!label) return null;
  const versionNote = info.status === "synced" && info.gap !== null && info.gap > 4 ? `Lyrics are from a version ${Math.round(info.gap)} s ${""}different in length — nudge timing with − / + if needed` : "";
  return (
    <span ref={chipRef} className={`lyr-chip st-${info.status}`} title={versionNote || undefined}>
      <i />{label}{versionNote && " ⚠"}
      {long && info.status === "synced" && <span className="muted"> · click a line to jump</span>}
      <button className="lyr-chip-btn" onClick={() => setOpen(!open)} title="Search for lyrics by hand">Search</button>
      <button className="lyr-chip-btn" onClick={() => refetchLyrics()} title="Look again online">↻</button>
      {open && <LyricsPopover anchor={chipRef} onClose={() => setOpen(false)} />}
    </span>
  );
}

export function LyricsEmpty({ big }: { big?: boolean }) {
  const info = useStore((s) => s.lyricsInfo);
  const [search, setSearch] = useState(false);
  const msg = {
    idle: "Play something to see its lyrics.",
    searching: "Finding lyrics…",
    synced: "", plain: "",
    none: "No lyrics found for this song.",
    offline: "You're offline — DriftKord will try again automatically.",
    instrumental: "♪ Instrumental — no lyrics in this one.",
  }[info.status];
  return (
    <div className={`lyr-empty ${big ? "big" : ""}`}>
      {info.status === "searching" ? <span className="lyr-spinner" aria-hidden /> : <Icon name="lyrics" size={big ? 34 : 22} />}
      <p>{msg}</p>
      {(info.status === "none" || info.status === "offline") && (
        <div className="row wrap">
          <button className="btn small primary" onClick={() => setSearch(!search)}>Search by hand</button>
          <button className="btn small" onClick={() => refetchLyrics()}>Try again</button>
        </div>
      )}
      {search && <LyricsSearch onClose={() => setSearch(false)} />}
    </div>
  );
}
