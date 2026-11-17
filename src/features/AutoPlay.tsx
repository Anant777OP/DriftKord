// Auto-Play view: Shuffle All, endless radio modes, filters, smart rules, smart mixes, sleep timer, auto-start.
import { useEffect, useMemo, useState } from "react";
import { fmtTime } from "../api";
import { Icon, Panel, Segmented, Slider, Toggle } from "../controls";
import { filteredPool, MODES, playSmartMix, setAutoPlay, setSleep, shuffleAll, SMART_MIXES, startRadio } from "../autoplay";
import { useStore } from "../store";

export function SleepCountdown() {
  const sleep = useStore((s) => s.sleep);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!sleep.endsAt) return;
    const id = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [sleep.endsAt]);
  if (sleep.endOfTrack) return <span className="sleep-chip" title="Stops after the current song"><Icon name="moon" size={13} /> end of song</span>;
  if (!sleep.endsAt) return null;
  return <span className="sleep-chip" title="Sleep timer"><Icon name="moon" size={13} /> {fmtTime(Math.max(0, (sleep.endsAt - Date.now()) / 1000))}</span>;
}

export function AutoPlay() {
  const cfg = useStore((s) => s.autoPlay);
  const tracks = useStore((s) => s.tracks);
  const sleep = useStore((s) => s.sleep);
  const queue = useStore((s) => s.queue);
  const qi = useStore((s) => s.queueIndex);
  const pool = useMemo(() => filteredPool(cfg), [cfg, tracks]);
  const genres = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tracks) for (const g of t.genre.split(/[;,/]/).map((x) => x.trim()).filter(Boolean)) m.set(g, (m.get(g) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([g]) => g);
  }, [tracks]);
  const decades = useMemo(() => [...new Set(tracks.filter((t) => t.year).map((t) => Math.floor(t.year! / 10) * 10))].sort(), [tracks]);
  const setF = (p: Partial<typeof cfg.filters>) => setAutoPlay({ filters: { ...cfg.filters, ...p } });
  const toggleIn = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const current = queue[qi];
  const curTrack = current?.trackId ? tracks.find((t) => t.id === current.trackId) : undefined;
  const upcoming = Math.max(0, queue.length - 1 - qi);

  return (
    <div className="view autoplay">
      <div className="autoplay-hero">
        <button className="btn primary hero-btn" onClick={shuffleAll} disabled={!tracks.length}>
          <Icon name="shuffle" size={22} /> Shuffle all music
          <span className="hero-sub">{pool.length.toLocaleString()} songs{pool.length !== tracks.length ? ` (filtered from ${tracks.length.toLocaleString()})` : ""}</span>
        </button>
        <div className="hero-side">
          <Toggle on={cfg.enabled} onChange={(v) => setAutoPlay({ enabled: v })} label="Endless Auto-Play — never let the music stop" />
          <div className="muted small">
            {cfg.enabled ? `On · ${upcoming} songs lined up, more are added automatically.` : "Off · playback stops when the queue ends."}
          </div>
          {curTrack && <button className="btn" onClick={() => startRadio(curTrack)}><Icon name="autodj" size={14} /> Start radio from “{curTrack.title}”</button>}
        </div>
      </div>

      <Panel title="How songs are picked">
        <div className="mode-grid">
          {MODES.map((m) => (
            <button key={m.id} className={`mode-card ${cfg.mode === m.id ? "on" : ""}`} onClick={() => setAutoPlay({ mode: m.id })}>
              <span className="mode-name">{m.name}</span>
              <span className="mode-desc">{m.desc}</span>
            </button>
          ))}
        </div>
      </Panel>

      <div className="grid2">
        <Panel title="Smart rules">
          <Slider value={cfg.noRepeatHours / 72} onChange={(v) => setAutoPlay({ noRepeatHours: Math.round(v * 72) })} label="Don't repeat songs played in the last" display={cfg.noRepeatHours ? `${cfg.noRepeatHours} h` : "Off"} />
          <Slider value={cfg.artistSpacing / 10} onChange={(v) => setAutoPlay({ artistSpacing: Math.round(v * 10) })} label="Songs between the same artist" display={`${cfg.artistSpacing}`} />
          <Toggle on={cfg.favoritesBoost} onChange={(v) => setAutoPlay({ favoritesBoost: v })} label="Play favourites (♥ / high rating) more often" />
          <Toggle on={cfg.skipLearning} onChange={(v) => setAutoPlay({ skipLearning: v })} label="Learn from skips (songs skipped in the first 30 s come up less)" />
        </Panel>
        <Panel title="Filters" actions={<button className="btn small" onClick={() => setF({ genres: [], hiResOnly: false, minRating: 0, decades: [], losslessOnly: false })}>Reset</button>}>
          <div className="row wrap">
            <Toggle on={cfg.filters.losslessOnly} onChange={(v) => setF({ losslessOnly: v })} label="Lossless only" />
            <Toggle on={cfg.filters.hiResOnly} onChange={(v) => setF({ hiResOnly: v })} label="Hi-Res only" />
            <Toggle on={cfg.filters.minRating >= 4} onChange={(v) => setF({ minRating: v ? 4 : 0 })} label="Favourites only" />
          </div>
          {genres.length > 0 && (
            <div className="chip-picker">
              <span className="muted small">Genres</span>
              {genres.map((g) => (
                <button key={g} className={`pick-chip ${cfg.filters.genres.includes(g) ? "on" : ""}`} onClick={() => setF({ genres: toggleIn(cfg.filters.genres, g) })}>{g}</button>
              ))}
            </div>
          )}
          {decades.length > 0 && (
            <div className="chip-picker">
              <span className="muted small">Decades</span>
              {decades.map((d) => (
                <button key={d} className={`pick-chip ${cfg.filters.decades.includes(d) ? "on" : ""}`} onClick={() => setF({ decades: toggleIn(cfg.filters.decades, d) })}>{d}s</button>
              ))}
            </div>
          )}
          <div className="muted small">{pool.length.toLocaleString()} songs match.</div>
        </Panel>
      </div>

      <Panel title="Smart mixes">
        <div className="mix-grid">
          {SMART_MIXES.map((m) => (
            <button key={m.id} className="mix-card" onClick={() => playSmartMix(m.id)}>
              <Icon name="play" size={14} />
              <span className="mix-name">{m.name}</span>
              <span className="mix-desc">{m.desc}</span>
            </button>
          ))}
        </div>
      </Panel>

      <div className="grid2">
        <Panel title="Sleep timer" actions={<span><SleepCountdown /></span>}>
          <div className="row wrap">
            {[15, 30, 45, 60, 90, 120].map((m) => <button key={m} className="btn" onClick={() => setSleep(m)}>{m} min</button>)}
            <button className={`btn ${sleep.endOfTrack ? "on" : ""}`} onClick={() => setSleep("eot")}>End of song</button>
            <button className="btn ghost" onClick={() => setSleep(null)} disabled={!sleep.endsAt && !sleep.endOfTrack}>Cancel</button>
          </div>
          <p className="muted small">Fades out gently over the last 20 seconds, then pauses.</p>
        </Panel>
        <Panel title="When the app starts">
          <Segmented value={cfg.autostart} onChange={(v) => setAutoPlay({ autostart: v })} options={[
            { value: "off", label: "Do nothing" }, { value: "resume", label: "Resume where I left off" }, { value: "shuffle", label: "Shuffle all music" },
          ]} />
          <p className="muted small">“Resume” restarts the last song a couple of seconds before where you stopped. Opening a file from Explorer always takes priority.</p>
        </Panel>
      </div>
    </div>
  );
}

