// Soundscapes tab: ambient scenes and a layer mixer that play underneath your music.
import { useEffect, useRef, useState } from "react";
import { Segmented, Slider, Toggle } from "../controls";
import { BEATS, BeatMode, LAYERS, LayerId, meter, SCENES } from "../soundscapes";
import { getState, setState, SoundscapeState, useStore } from "../store";

const ICONS: Record<LayerId, string> = {
  rain: "M7 15l-1 3M12 15l-1 4M17 15l-1 3M6 12a4 4 0 0 1 .5-8 5 5 0 0 1 9.5 1.5A3.5 3.5 0 0 1 18 12z",
  thunder: "M6 11a4 4 0 0 1 .5-8 5 5 0 0 1 9.5 1.5A3.5 3.5 0 0 1 18 11M13 11l-3 5h4l-3 5",
  wind: "M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7",
  ocean: "M2 12c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2M2 17c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2M6 7c2-2 4-3 7-2",
  stream: "M4 6c3 0 3 3 6 3s3-3 6-3 3 3 4 3M4 12c3 0 3 3 6 3s3-3 6-3 3 3 4 3M4 18h16",
  birds: "M3 9c2-1 4-1 5 1 1-2 3-2 5-1M12 15c2-1 4-1 5 1 1-2 3-2 5-1M4 18c1.5-.8 3-.8 4 .8",
  crickets: "M12 3a6 6 0 1 0 6 9 5 5 0 0 1-6-9zM5 19l2-3M19 19l-2-3",
  fire: "M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-6 1 1 2 2 2 4 1-2 1-5 1-8z",
  white: "M3 12h2l1-5 2 10 2-12 2 14 2-10 2 8 2-6 1 1h2",
  pink: "M3 12h2l2-4 2 8 2-6 2 5 2-4 2 3 2-2h2",
  brown: "M3 13c2-3 3-3 5 0s3 3 5 0 3-3 5 0 2 2 3 1",
  binaural: "M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H4zM17 14h3v6h-3zM10 10h4",
};

function LayerIcon({ id, size = 22 }: { id: LayerId; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[id]} />
    </svg>
  );
}

const update = (patch: Partial<SoundscapeState>) => setState((s) => ({ soundscape: { ...s.soundscape, ...patch } }));
const TIMERS = [
  { value: "0", label: "Off" }, { value: "15", label: "15m" }, { value: "30", label: "30m" }, { value: "60", label: "1h" }, { value: "90", label: "90m" },
];

// ------------------------------------------------------------------ animated hero backdrop
function Atmosphere({ layers, playing }: { layers: SoundscapeState["layers"]; playing: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  useEffect(() => {
    const cv = ref.current!;
    const g = cv.getContext("2d")!;
    type P = { x: number; y: number; v: number; s: number; a: number; kind: string };
    let parts: P[] = [];
    let raf = 0, energy = 0, t = 0;
    const spawn = (kind: string, w: number, h: number): P => ({
      x: Math.random() * w,
      y: kind === "ember" ? h + 10 : kind === "rain" ? -20 : Math.random() * h,
      v: kind === "rain" ? 9 + Math.random() * 7 : kind === "ember" ? 0.6 + Math.random() * 1.4 : 0.15 + Math.random() * 0.35,
      s: kind === "rain" ? 10 + Math.random() * 14 : 1 + Math.random() * 2.4,
      a: 0.25 + Math.random() * 0.55,
      kind,
    });
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const L = layersRef.current;
      energy += ((playingRef.current ? meter() : 0) - energy) * 0.08;
      t += 1 / 60;
      const kinds: string[] = [];
      if (L.rain) kinds.push("rain");
      if (L.fire) kinds.push("ember");
      if (!kinds.length || L.birds || L.stream || L.crickets || L.white || L.pink || L.brown || L.binaural || L.wind || L.ocean) kinds.push("mote");
      const target = playingRef.current ? (L.rain ? 140 : 60) : 24;
      while (parts.length < target) parts.push(spawn(kinds[Math.floor(Math.random() * kinds.length)], w, h));
      if (parts.length > target) parts.length = target;
      // ocean / wind: soft horizontal waves
      if (L.ocean || L.wind) {
        g.lineWidth = 1.5;
        for (let k = 0; k < 4; k++) {
          g.strokeStyle = `rgba(255,255,255,${0.06 + energy * 0.12})`;
          g.beginPath();
          const base = h * (0.55 + k * 0.1);
          for (let x = 0; x <= w; x += 12) g.lineTo(x, base + Math.sin(x / 90 + t * (0.6 + k * 0.2)) * (8 + energy * 18));
          g.stroke();
        }
      }
      for (const p of parts) {
        if (p.kind === "rain") {
          p.y += p.v; p.x -= 1.2;
          g.strokeStyle = `rgba(220,235,255,${p.a * 0.5})`;
          g.lineWidth = 1;
          g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x + 2, p.y - p.s); g.stroke();
          if (p.y > h + 20) Object.assign(p, spawn("rain", w, h));
        } else if (p.kind === "ember") {
          p.y -= p.v * (1 + energy * 2); p.x += Math.sin(t * 2 + p.s * 9) * 0.6;
          g.fillStyle = `rgba(255,${150 + Math.floor(p.s * 30)},80,${p.a * (p.y / h)})`;
          g.beginPath(); g.arc(p.x, p.y, p.s, 0, Math.PI * 2); g.fill();
          if (p.y < -10) Object.assign(p, spawn("ember", w, h));
        } else {
          p.y -= p.v; p.x += Math.sin(t + p.s * 7) * 0.3;
          const r = p.s * (1 + energy * 1.6);
          g.fillStyle = `rgba(255,255,255,${p.a * (0.35 + energy * 0.6)})`;
          g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fill();
          if (p.y < -10) { Object.assign(p, spawn("mote", w, h)); p.y = h + 5; }
        }
      }
      cv.style.setProperty("--energy", energy.toFixed(3));
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="sc-atmo" />;
}

export function Soundscapes() {
  const sc = useStore((s) => s.soundscape);
  const exclusive = useStore((s) => !s.ytActive && (s.status?.signalPath ?? []).some((p) => /exclusive/i.test(p)) && s.status?.state === "playing");
  const scene = SCENES.find((x) => x.id === sc.scene);
  const colors = scene?.colors ?? ["#20263a", "#4a5578", "#c3cbe6"];
  const active = LAYERS.filter((l) => (sc.layers[l.id] ?? 0) > 0);
  const [timerPick, setTimerPick] = useState("0");
  const [, tick] = useState(0);
  useEffect(() => { const id = window.setInterval(() => tick((x) => x + 1), 20000); return () => window.clearInterval(id); }, []);

  const pickScene = (id: string) => {
    const s = SCENES.find((x) => x.id === id)!;
    update({ scene: id, layers: { ...s.layers }, playing: true });
  };
  const setLevel = (id: LayerId, v: number) => {
    const layers = { ...getState().soundscape.layers };
    if (v <= 0.001) delete layers[id]; else layers[id] = Math.round(v * 100) / 100;
    update({ layers, scene: null });
  };
  const toggleLayer = (id: LayerId) => setLevel(id, (sc.layers[id] ?? 0) > 0 ? 0 : 0.5);

  return (
    <div className="view sc-view">
      <section className={`sc-hero ${sc.playing ? "on" : ""}`} style={{ ["--c1" as string]: colors[0], ["--c2" as string]: colors[1], ["--c3" as string]: colors[2] }}>
        <Atmosphere layers={sc.layers} playing={sc.playing} />
        <div className="sc-hero-body">
          <button className="sc-play" onClick={() => update({ playing: !sc.playing })} aria-label={sc.playing ? "Pause soundscape" : "Play soundscape"} disabled={!active.length}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              {sc.playing ? <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /> : <path d="M8 5l11 7-11 7z" />}
            </svg>
          </button>
          <div className="sc-hero-text">
            <div className="sc-kicker">{sc.playing ? "Now playing" : "Soundscape"}</div>
            <h2 className="sc-title">{scene?.name ?? (active.length ? "Custom mix" : "Pick a scene")}</h2>
            <div className="sc-sub">{scene?.mood ?? (active.length ? active.map((l) => l.name).join(" · ") : "Ambient sound that plays under your music")}</div>
          </div>
          <div className="sc-hero-ctl">
            <Slider value={sc.master} onChange={(v) => update({ master: Math.round(v * 100) / 100 })} label="Soundscape volume" display={`${Math.round(sc.master * 100)}%`} />
            <div className="sc-row">
              <span className="muted small">Timer</span>
              <Segmented value={sc.timerEndsAt ? timerPick : "0"}
                options={TIMERS} onChange={(v) => { setTimerPick(v); update({ timerEndsAt: v === "0" ? null : Date.now() + +v * 60000, playing: v === "0" ? sc.playing : true }); }} />
              {sc.timerEndsAt && <span className="sc-chip">{Math.max(1, Math.ceil((sc.timerEndsAt - Date.now()) / 60000))} min left</span>}
            </div>
            <Toggle on={sc.pauseWithMusic} onChange={(v) => update({ pauseWithMusic: v })} label="Pause when music pauses" />
          </div>
        </div>
      </section>

      {exclusive && (
        <div className="sc-note">Your music is using <strong>WASAPI Exclusive</strong> output, which keeps the speakers to itself, so Windows can't mix soundscapes in. Switch output to Shared in Settings to hear both together.</div>
      )}

      <h3 className="sc-h">Scenes</h3>
      <div className="sc-scenes">
        {SCENES.map((s) => (
          <button key={s.id} className={`sc-scene ${sc.scene === s.id ? "on" : ""}`} onClick={() => pickScene(s.id)}
            style={{ ["--c1" as string]: s.colors[0], ["--c2" as string]: s.colors[1], ["--c3" as string]: s.colors[2] }}>
            <span className="sc-scene-icons">{(Object.keys(s.layers) as LayerId[]).map((id) => <LayerIcon key={id} id={id} size={16} />)}</span>
            <span className="sc-scene-name">{s.name}</span>
            <span className="sc-scene-mood">{s.mood}</span>
            {sc.scene === s.id && sc.playing && <span className="sc-eq" aria-hidden><i /><i /><i /></span>}
          </button>
        ))}
      </div>

      <h3 className="sc-h">Mixer <span className="muted small">— turn layers on and blend your own</span></h3>
      {(["Weather", "Nature", "Focus"] as const).map((group) => (
        <div key={group} className="sc-group">
          <div className="sc-group-name">{group}</div>
          <div className="sc-layers">
            {LAYERS.filter((l) => l.group === group).map((l) => {
              const v = sc.layers[l.id] ?? 0;
              return (
                <div key={l.id} className={`sc-layer ${v > 0 ? "on" : ""}`}>
                  <button className="sc-layer-head" onClick={() => toggleLayer(l.id)} aria-pressed={v > 0} title={l.hint}>
                    <span className="sc-layer-icon"><LayerIcon id={l.id} /></span>
                    <span className="sc-layer-text"><span className="sc-layer-name">{l.name}</span><span className="sc-layer-hint">{l.hint}</span></span>
                  </button>
                  <Slider value={v} onChange={(x) => setLevel(l.id, x)} label={`${l.name} level`} display={v > 0 ? `${Math.round(v * 100)}%` : "Off"} />
                  {l.id === "binaural" && v > 0 && (
                    <Segmented value={sc.beat} onChange={(m: BeatMode) => update({ beat: m })}
                      options={(Object.keys(BEATS) as BeatMode[]).map((m) => ({ value: m, label: BEATS[m].label.split(" · ")[0] }))} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <p className="muted small sc-foot">All sounds are generated live on your PC — nothing is downloaded and they never repeat exactly. Soundscapes play through Windows alongside your music and keep going on other pages.</p>
    </div>
  );
}
