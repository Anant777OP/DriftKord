// Acoustic DNA & Dynamic Range X-Ray, Mood-Terrain 3D Library Map, Harmonic Auto-DJ.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, QueueItem, Track, trackToItem } from "../api";
import { Panel, Slider, Toggle } from "../controls";
import { djScore, enqueue, harmonicScore, parseCamelot, playItems, scheduleNext, tempoRatio } from "../player";
import { getState, live, setState, toast, useStore } from "../store";

// ================================================================== X-Ray
function Goniometer() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = c.clientWidth;
      if (c.width !== s) { c.width = s; c.height = s; }
      const cs = getComputedStyle(document.documentElement);
      const bg = cs.getPropertyValue("--panel2").trim() || "#000", acc = cs.getPropertyValue("--accent").trim();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = "rgba(128,128,128,.35)";
      ctx.beginPath();
      ctx.moveTo(s / 2, 0); ctx.lineTo(s / 2, s); ctx.moveTo(0, s / 2); ctx.lineTo(s, s / 2);
      ctx.moveTo(0, 0); ctx.lineTo(s, s); ctx.moveTo(s, 0); ctx.lineTo(0, s);
      ctx.stroke();
      ctx.fillStyle = acc;
      const g = live.frame.gonio;
      for (let i = 0; i + 1 < g.length; i += 2) {
        const x = s / 2 + g[i] * s * 0.45, y = s / 2 - g[i + 1] * s * 0.45;
        ctx.fillRect(x, y, 2, 2);
      }
      ctx.fillStyle = cs.getPropertyValue("--muted").trim();
      ctx.font = "11px monospace";
      ctx.fillText("M", s / 2 + 4, 12); ctx.fillText("L", 6, 14); ctx.fillText("R", s - 14, 14); ctx.fillText("S", s - 12, s / 2 - 4);
      void bg;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="gonio" />;
}

function LiveMeters() {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 80);
    return () => clearInterval(id);
  }, []);
  const f = live.frame;
  const corr = f.correlation;
  const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -96);
  return (
    <div className="live-meters">
      <div className="corr">
        <div className="corr-scale"><span>−1</span><span>0</span><span>+1</span></div>
        <div className="corr-track"><div className="corr-dot" style={{ left: `${((corr + 1) / 2) * 100}%` }} /></div>
        <div className="muted small">Phase correlation {corr.toFixed(2)} {corr < 0 ? "⚠ out of phase" : corr > 0.95 ? "(near mono)" : ""}</div>
      </div>
      <div className="peak-rms">
        {[0, 1].map((ch) => (
          <div key={ch} className="pr-row">
            <span>{ch ? "R" : "L"}</span>
            <div className="pr-bar"><div className="rms" style={{ width: `${Math.max(0, (db(f.rms[ch]) + 60) / 60) * 100}%` }} /><div className="pk" style={{ left: `${Math.max(0, (db(f.peak[ch]) + 60) / 60) * 100}%` }} /></div>
            <span className="mono">{db(f.peak[ch]).toFixed(1)} dBFS</span>
          </div>
        ))}
      </div>
      <div className="crest">Crest factor <strong className="mono">{f.crestDb.toFixed(1)} dB</strong></div>
    </div>
  );
}

function Spectrogram() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      ctx.drawImage(c, -2, 0);
      const b = live.frame.bands;
      for (let i = 0; i < b.length; i++) {
        const v = b[i];
        ctx.fillStyle = `hsl(${260 - v * 260},90%,${8 + v * 55}%)`;
        ctx.fillRect(w - 2, h - ((i + 1) / b.length) * h, 2, h / b.length + 1);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="spectrogram" />;
}

export function XRay() {
  const st = useStore((s) => s.status);
  const ltas = useStore((s) => s.ltas);
  const tracks = useStore((s) => s.tracks);
  const queue = useStore((s) => s.queue);
  const qi = useStore((s) => s.queueIndex);
  const item = queue[qi];
  const track = tracks.find((t) => t.id === item?.trackId);
  const dr = track?.dr ?? st?.runningDr ?? null;
  const drClass = dr == null ? "" : dr >= 14 ? "dr-great" : dr >= 8 ? "dr-ok" : "dr-bad";
  const W = 600, H = 180;
  const path = ltas ? ltas.db.map((d, i) => {
    const x = (Math.log(ltas.freqs[i] / 20) / Math.log((ltas.sampleRate / 2) / 20)) * W;
    const y = H - ((Math.max(-140, d) + 140) / 140) * H;
    return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ") : "";
  const cutX = ltas && ltas.cutoffHz ? (Math.log(ltas.cutoffHz / 20) / Math.log((ltas.sampleRate / 2) / 20)) * W : null;
  const fakeTracks = tracks.filter((t) => t.verdict?.startsWith("FAKE") || t.verdict?.startsWith("Suspicious"));
  return (
    <div className="view xray">
      <div className="grid3">
        <Panel title="Dynamic Range">
          <div className={`dr-big ${drClass}`}>{dr != null ? `DR${Math.round(dr)}` : "—"}</div>
          <div className="muted small">{track?.dr ? "Full-track (offline scan)" : "Running estimate"} · TT-DR method (3 s blocks, top-20% RMS vs 2nd peak)</div>
          {track?.lufs ? <div className="kv"><span>Integrated loudness</span><strong>{track.lufs.toFixed(1)} LUFS</strong></div> : null}
          <LiveMeters />
        </Panel>
        <Panel title="Stereo Goniometer"><Goniometer /></Panel>
        <Panel title="Spectrogram"><Spectrogram /></Panel>
      </div>
      <Panel title="Lossless Authenticity Verifier">
        <svg viewBox={`0 0 ${W} ${H}`} className="ltas" preserveAspectRatio="none">
          {[100, 1000, 10000, 16000, 20000].map((f) => {
            if (!ltas || f > ltas.sampleRate / 2) return null;
            const x = (Math.log(f / 20) / Math.log((ltas.sampleRate / 2) / 20)) * W;
            return <g key={f}><line x1={x} x2={x} y1={0} y2={H} className="grid" /><text x={x + 3} y={12} className="lbl">{f >= 1000 ? `${f / 1000}k` : f}</text></g>;
          })}
          <path d={path} className="curve" />
          {cutX != null && <line x1={cutX} x2={cutX} y1={0} y2={H} className="cutoff" />}
        </svg>
        <div className={`verdict ${ltas?.verdict.startsWith("FAKE") || ltas?.verdict.startsWith("Suspicious") ? "bad" : ltas?.verdict.startsWith("Authentic") ? "good" : ""}`}>
          {ltas?.verdict ?? "Play a track to analyse its long-term spectrum."}
        </div>
        {track?.verdict && <div className="muted small">Offline scan of the whole file: {track.verdict}{track.cutoffHz ? ` (cutoff ${(track.cutoffHz / 1000).toFixed(1)} kHz)` : ""}</div>}
        {fakeTracks.length > 0 && (
          <details className="fake-list">
            <summary>{fakeTracks.length} suspicious files in your library</summary>
            {fakeTracks.slice(0, 200).map((t) => (
              <div key={t.id} className="row small"><span>{t.artist} — {t.title}</span><span className="muted">{t.verdict}</span></div>
            ))}
          </details>
        )}
      </Panel>
    </div>
  );
}

// ================================================================== Mood-Terrain 3D Map
interface MapPoint { x: number; y: number; z: number; item: QueueItem; track?: Track; hue: number }

function camelotAngle(c?: string | null) {
  const p = parseCamelot(c);
  return p ? ((p.n - 1) / 12) * Math.PI * 2 : 0;
}

export function MoodMap() {
  const tracks = useStore((s) => s.tracks);
  const queue = useStore((s) => s.queue);
  const qi = useStore((s) => s.queueIndex);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<MapPoint | null>(null);
  const cam = useRef({ yaw: 0.6, pitch: 0.55, dist: 3.2, tx: 0, ty: 0.2, tz: 0 });
  const points = useMemo<MapPoint[]>(() => {
    const pts: MapPoint[] = [];
    for (const t of tracks) {
      if (!t.bpm) continue;
      const a = camelotAngle(t.camelot);
      const r = 0.25 + Math.max(0, Math.min(1, (t.bpm - 70) / 110)) * 0.85;
      pts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, y: (t.energy ?? 0.5) * 0.9, item: trackToItem(t), track: t, hue: (a / (Math.PI * 2)) * 360 });
    }
    // YouTube items in the queue: unknown analysis → an "uncharted" orbit above the terrain
    queue.filter((q) => q.kind === "youtube").forEach((q, i, arr) => {
      const a = (i / Math.max(1, arr.length)) * Math.PI * 2;
      pts.push({ x: Math.cos(a) * 1.25, z: Math.sin(a) * 1.25, y: 1.15, item: q, hue: 0 });
    });
    return pts;
  }, [tracks, queue]);

  const heights = useMemo(() => {
    const N = 40;
    const grid = new Float32Array(N * N);
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        const x = (i / (N - 1)) * 2.4 - 1.2, z = (j / (N - 1)) * 2.4 - 1.2;
        let h = 0;
        for (const p of points) {
          if (!p.track) continue;
          const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
          h += Math.exp(-d2 / 0.02) * (0.3 + p.y);
        }
        grid[i * N + j] = h;
      }
    let mx = 0;
    grid.forEach((v) => (mx = Math.max(mx, v)));
    if (mx > 0) for (let k = 0; k < grid.length; k++) grid[k] = (grid[k] / mx) * 0.45;
    return { grid, N };
  }, [points]);

  const curId = queue[qi]?.trackId;
  const projected = useRef<{ p: MapPoint; sx: number; sy: number }[]>([]);

  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    const keys = new Set<string>();
    const kd = (e: KeyboardEvent) => keys.add(e.key.toLowerCase());
    const ku = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const k = cam.current;
      const sp = 0.02;
      const fwd = [Math.sin(k.yaw), Math.cos(k.yaw)];
      if (keys.has("w") || keys.has("arrowup")) { k.tx -= fwd[0] * sp; k.tz -= fwd[1] * sp; }
      if (keys.has("s") || keys.has("arrowdown")) { k.tx += fwd[0] * sp; k.tz += fwd[1] * sp; }
      if (keys.has("a") || keys.has("arrowleft")) k.yaw -= 0.02;
      if (keys.has("d") || keys.has("arrowright")) k.yaw += 0.02;
      if (keys.has("q")) k.ty += sp;
      if (keys.has("e")) k.ty -= sp;
      k.yaw += 0.0007; // gentle drift
      const cy = Math.cos(k.yaw), sy = Math.sin(k.yaw), cp = Math.cos(k.pitch), spp = Math.sin(k.pitch);
      const proj = (x: number, y: number, z: number) => {
        x -= k.tx; y -= k.ty; z -= k.tz;
        const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
        const y2 = y * cp - z1 * spp, z2 = y * spp + z1 * cp + k.dist;
        const f = (Math.min(w, h) * 0.9) / Math.max(0.1, z2);
        return [w / 2 + x1 * f, h / 2 - y2 * f, z2] as const;
      };
      const cs = getComputedStyle(document.documentElement);
      const bg = cs.getPropertyValue("--bg").trim(), acc = cs.getPropertyValue("--accent").trim(), muted = cs.getPropertyValue("--muted").trim();
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      // terrain wireframe
      const { grid, N } = heights;
      ctx.lineWidth = 1;
      for (let i = 0; i < N; i++) {
        ctx.beginPath();
        for (let j = 0; j < N; j++) {
          const x = (i / (N - 1)) * 2.4 - 1.2, z = (j / (N - 1)) * 2.4 - 1.2;
          const [px, py] = proj(x, grid[i * N + j], z);
          j ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.strokeStyle = `color-mix(in srgb, ${acc} 30%, transparent)`;
        ctx.stroke();
        ctx.beginPath();
        for (let j = 0; j < N; j++) {
          const z = (i / (N - 1)) * 2.4 - 1.2, x = (j / (N - 1)) * 2.4 - 1.2;
          const [px, py] = proj(x, grid[j * N + i], z);
          j ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.stroke();
      }
      // Camelot wheel labels
      ctx.fillStyle = muted;
      ctx.font = "11px monospace";
      for (let n = 1; n <= 12; n++) {
        const a = ((n - 1) / 12) * Math.PI * 2;
        const [px, py] = proj(Math.cos(a) * 1.35, 0, Math.sin(a) * 1.35);
        ctx.fillText(`${n}A/${n}B`, px - 16, py);
      }
      // stars
      const pr: { p: MapPoint; sx: number; sy: number; z: number }[] = [];
      for (const p of points) {
        const [sx, sy2, z] = proj(p.x, p.y + 0.05, p.z);
        pr.push({ p, sx, sy: sy2, z });
      }
      pr.sort((a, b) => b.z - a.z);
      const beat = live.frame.bass;
      for (const q of pr) {
        const isCur = q.p.track && q.p.track.id === curId;
        const r = Math.max(1.5, (isCur ? 9 : 3.5) / q.z * 2.5) * (isCur ? 1 + beat * 0.6 : 1);
        ctx.fillStyle = q.p.item.kind === "youtube" ? "#ff4040" : `hsl(${q.p.hue},85%,${isCur ? 70 : 60}%)`;
        ctx.shadowColor = ctx.fillStyle as string;
        ctx.shadowBlur = isCur ? 25 : 6;
        ctx.beginPath();
        ctx.arc(q.sx, q.sy, r, 0, Math.PI * 2);
        ctx.fill();
        // stalk to the terrain
        if (isCur) {
          const [bx, by] = proj(q.p.x, 0, q.p.z);
          ctx.strokeStyle = acc;
          ctx.beginPath(); ctx.moveTo(q.sx, q.sy); ctx.lineTo(bx, by); ctx.stroke();
        }
      }
      ctx.shadowBlur = 0;
      projected.current = pr;
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, [points, heights, curId]);

  const dragging = useRef<{ x: number; y: number } | null>(null);
  const pick = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best: MapPoint | null = null, bd = 14;
    for (const q of projected.current) {
      const d = Math.hypot(q.sx - mx, q.sy - my);
      if (d < bd) { bd = d; best = q.p; }
    }
    return best;
  };
  const buildSetFrom = (start: Track) => {
    const pool = getState().tracks.filter((t) => t.bpm && t.id !== start.id);
    const set = [start];
    for (let i = 0; i < 24 && pool.length; i++) {
      const cur = set[set.length - 1];
      pool.sort((a, b) => djScore(cur, b) - djScore(cur, a));
      set.push(pool.shift()!);
    }
    playItems(set.map(trackToItem));
    toast(`Harmonic flight path: ${set.length} tracks`);
  };
  return (
    <div className="view moodmap">
      <div className="toolbar">
        <h2 className="view-title">Mood-Terrain Map</h2>
        <span className="muted small">Floor = Camelot key wheel (angle) × BPM (radius) · height = energy · red = YouTube (uncharted). Drag to orbit · wheel to zoom · WASD/QE to fly · click a star to play.</span>
        <button className="btn" onClick={() => api.analyzeLibrary().then(() => toast("Analysing un-scanned tracks…"))}>Analyse library</button>
      </div>
      <div className="map-wrap">
        <canvas ref={canvas} className="map-canvas"
          onPointerDown={(e) => { dragging.current = { x: e.clientX, y: e.clientY }; (e.target as Element).setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => {
            if (dragging.current) {
              cam.current.yaw += (e.clientX - dragging.current.x) * 0.006;
              cam.current.pitch = Math.max(0.05, Math.min(1.45, cam.current.pitch + (e.clientY - dragging.current.y) * 0.005));
              dragging.current = { x: e.clientX, y: e.clientY };
            } else setHover(pick(e));
          }}
          onPointerUp={(e) => {
            const moved = dragging.current && Math.hypot(e.clientX - dragging.current.x, e.clientY - dragging.current.y) > 3;
            dragging.current = null;
            if (moved) return;
            const p = pick(e);
            if (p) enqueue([p.item], true);
          }}
          onWheel={(e) => { cam.current.dist = Math.max(1.2, Math.min(8, cam.current.dist * (e.deltaY > 0 ? 1.08 : 0.92))); }} />
        {hover && (
          <div className="map-tip">
            <strong>{hover.item.title}</strong><br />{hover.item.artist}
            {hover.track && <><br /><span className="muted">{hover.track.bpm?.toFixed(0)} BPM · {hover.track.musicalKey} ({hover.track.camelot}) · energy {(hover.track.energy ?? 0).toFixed(2)}</span></>}
            {hover.track && <div><button className="btn small" onClick={() => buildSetFrom(hover.track!)}>Fly a harmonic set from here</button></div>}
          </div>
        )}
        {points.length === 0 && <div className="map-empty">No analysed tracks yet. Add music, then press “Analyse library”.</div>}
      </div>
    </div>
  );
}

// ================================================================== Harmonic Auto-DJ
function CamelotWheel({ current, next }: { current?: string | null; next?: string | null }) {
  const cur = parseCamelot(current);
  const S = 240, C = 120;
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="camelot">
      {Array.from({ length: 12 }, (_, i) => {
        const n = i + 1;
        return (["B", "A"] as const).map((l, ring) => {
          const r0 = ring ? 52 : 82, r1 = ring ? 82 : 112;
          const a0 = ((i - 0.5) / 12) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 0.5) / 12) * Math.PI * 2 - Math.PI / 2;
          const code = `${n}${l}`;
          const score = current ? harmonicScore(current, code) : 0;
          const p = (r: number, a: number) => `${C + Math.cos(a) * r},${C + Math.sin(a) * r}`;
          const am = (a0 + a1) / 2, rm = (r0 + r1) / 2;
          return (
            <g key={code}>
              <path d={`M${p(r0, a0)} L${p(r1, a0)} A${r1} ${r1} 0 0 1 ${p(r1, a1)} L${p(r0, a1)} A${r0} ${r0} 0 0 0 ${p(r0, a0)}Z`}
                className={`cw-seg ${cur && cur.n === n && cur.l === l ? "cur" : ""} ${next === code ? "next" : ""}`}
                style={{ fill: `hsla(${(i / 12) * 360},70%,55%,${0.12 + score * 0.75})` }} />
              <text x={C + Math.cos(am) * rm} y={C + Math.sin(am) * rm + 4} className="cw-lbl">{code}</text>
            </g>
          );
        });
      })}
    </svg>
  );
}

export function AutoDj() {
  const cfg = useStore((s) => s.autoDj);
  const queue = useStore((s) => s.queue);
  const qi = useStore((s) => s.queueIndex);
  const tracks = useStore((s) => s.tracks);
  const set = (p: Partial<typeof cfg>) => {
    setState({ autoDj: { ...cfg, ...p } });
    setTimeout(scheduleNext, 10);
  };
  const cur = tracks.find((t) => t.id === queue[qi]?.trackId);
  const nxtItem = queue[qi + 1];
  const nxt = tracks.find((t) => t.id === nxtItem?.trackId);
  const generate = () => {
    const start = cur ?? tracks.find((t) => t.bpm);
    if (!start) return toast("Analyse your library first (BPM/key needed).");
    const pool = tracks.filter((t) => t.bpm && t.id !== start.id);
    const setL = [start];
    for (let i = 0; i < 30 && pool.length; i++) {
      const c = setL[setL.length - 1];
      pool.sort((a, b) => djScore(c, b) - djScore(c, a) + (Math.random() - 0.5) * 0.04);
      setL.push(pool.shift()!);
    }
    playItems(setL.map(trackToItem));
    set({ enabled: true });
    toast(`Generated a ${setL.length}-track harmonic set`);
  };
  const tr = tempoRatio(cur?.bpm, nxt?.bpm);
  return (
    <div className="view">
      <div className="grid2">
        <Panel title="Harmonic Auto-DJ Crossfader" actions={<Toggle on={cfg.enabled} onChange={(v) => set({ enabled: v })} label="Auto-DJ" />}>
          <Slider value={cfg.crossfade / 16} onChange={(v) => set({ crossfade: Math.round(v * 16 * 2) / 2 })} label="Crossfade" display={cfg.crossfade ? `${cfg.crossfade}s (bar-snapped)` : "Gapless"} />
          <div className="row wrap">
            <Toggle on={cfg.harmonic} onChange={(v) => set({ harmonic: v })} label="Harmonic re-ordering (Camelot)" />
            <Toggle on={cfg.beatmatch} onChange={(v) => set({ beatmatch: v })} label="Beat-match (varispeed ±8%) & cue on first beat" />
          </div>
          <button className="btn primary" onClick={generate}>Generate harmonic set from {cur ? "current track" : "library"}</button>
          <p className="muted small">
            Local → local transitions are mixed sample-accurately in the Rust engine (equal-power, tempo-matched, then glide back to 1.0×).
            Local ⇄ YouTube transitions are volume-crossfaded between the engine and the YouTube window.
          </p>
        </Panel>
        <Panel title="Next transition">
          <CamelotWheel current={cur?.camelot} next={nxt?.camelot} />
          <div className="transition">
            <div><strong>{cur?.title ?? queue[qi]?.title ?? "—"}</strong><div className="muted">{cur?.bpm?.toFixed(1)} BPM · {cur?.camelot}</div></div>
            <div className="arrow">→</div>
            <div><strong>{nxtItem?.title ?? "—"}</strong><div className="muted">{nxt ? `${nxt.bpm?.toFixed(1)} BPM · ${nxt.camelot}` : nxtItem?.kind === "youtube" ? "YouTube (no analysis)" : ""}</div></div>
          </div>
          {cur && nxt && (
            <div className="kv-list">
              <div className="kv"><span>Harmonic match</span><strong>{Math.round(harmonicScore(cur.camelot, nxt.camelot) * 100)}%</strong></div>
              <div className="kv"><span>Tempo adjust</span><strong>{tr === 1 ? "none" : `${((tr - 1) * 100).toFixed(1)}%`}</strong></div>
              <div className="kv"><span>Overall mix score</span><strong>{Math.round(djScore(cur, nxt) * 100)}</strong></div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
