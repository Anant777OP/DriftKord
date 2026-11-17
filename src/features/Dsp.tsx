// DSP panels: 10-band parametric EQ + crossfeed + ReplayGain, Sonic Time-Machine (with era VU meters),
// Live Stem Isolator, and the Binaural Soundstage Sculptor.
import { useEffect, useRef, useState } from "react";
import { DspParams, Speaker } from "../api";
import { EqStudio } from "./EqStudio";
import { Panel, Segmented, Slider, Toggle } from "../controls";
import { updateDsp } from "../player";
import { live, useStore } from "../store";

const lin = (v: number, a: number, b: number) => a + (b - a) * v;
const inv = (x: number, a: number, b: number) => (x - a) / (b - a);
const logv = (v: number, a: number, b: number) => a * Math.pow(b / a, v);
const ilog = (x: number, a: number, b: number) => Math.log(x / a) / Math.log(b / a);

export function Eq() {
  const dsp = useStore((s) => s.dsp);
  return (
    <div className="view dsp-view">
      <EqStudio />
      <div className="grid2">
        <Panel title="Crossfeed (headphones)">
          <Slider value={dsp.crossfeed} onChange={(v) => updateDsp({ crossfeed: Math.round(v * 100) / 100 })} label="Amount" display={dsp.crossfeed ? `${Math.round(dsp.crossfeed * 100)}%` : "Off"} />
          <p className="muted small">Bauer-style: low-passed, 0.3 ms delayed blend of the opposite channel — reduces hard-panned fatigue.</p>
        </Panel>
        <Panel title="ReplayGain">
          <Segmented value={dsp.replaygain} onChange={(v) => updateDsp({ replaygain: v })} options={[{ value: "off", label: "Off" }, { value: "track", label: "Track" }, { value: "album", label: "Album" }]} />
          <Slider value={inv(dsp.rgPreampDb, -12, 12)} onChange={(v) => updateDsp({ rgPreampDb: Math.round(lin(v, -12, 12) * 2) / 2 })} label="Pre-amp" display={`${dsp.rgPreampDb > 0 ? "+" : ""}${dsp.rgPreampDb} dB`} bipolar />
          <p className="muted small">Uses REPLAYGAIN_* tags (scan them in the Metadata editor). Clipping-protected by the stored peak.</p>
        </Panel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Sonic Time-Machine
const ERAS: { id: DspParams["era"]; name: string; year: string; desc: string; meter: "mcintosh" | "walkman" | "vinyl" | "stadium" | "none" }[] = [
  { id: "off", name: "Bypass", year: "—", desc: "Untouched signal.", meter: "none" },
  { id: "tube", name: "Tube Amp", year: "1970s", desc: "Asymmetric triode saturation, even harmonics, warm low-mids, softened top.", meter: "mcintosh" },
  { id: "tape", name: "WM-DD9 Tape", year: "1989", desc: "Tape compression, head-bump, 14.5 kHz roll-off, wow & flutter, hiss.", meter: "walkman" },
  { id: "vinyl", name: "Vinyl Lathe", year: "1960s–80s", desc: "Mono-summed bass, RIAA tilt, crackle and rumble.", meter: "vinyl" },
  { id: "stadium", name: "Live Stadium", year: "Live", desc: "Long pre-delayed reverb with slap-back from the stands.", meter: "stadium" },
  { id: "gramophone", name: "Shellac Gramophone", year: "1925", desc: "Acoustic horn: mono, 200 Hz – 5 kHz with a horn resonance, surface hiss and crackle.", meter: "vinyl" },
  { id: "radio", name: "AM Radio", year: "1950s", desc: "Mono broadcast through a small speaker, squeezed by the station's compressor, with static.", meter: "mcintosh" },
  { id: "jukebox", name: "Diner Jukebox", year: "1962", desc: "Big cabinet: narrow stereo, fat warm bass, rolled-off top, a small room around it.", meter: "mcintosh" },
  { id: "eighttrack", name: "8-Track Cartridge", year: "1974", desc: "Heavy wow & flutter, 9.5 kHz ceiling, bleed from the neighbouring program and hiss.", meter: "walkman" },
  { id: "boombox", name: "Boombox", year: "1986", desc: "Bass-boost button on, bright cones, gentle speaker breakup.", meter: "walkman" },
  { id: "cd", name: "Early CD", year: "1992", desc: "Bright early digital mastering with plain undithered 16-bit truncation.", meter: "walkman" },
  { id: "telephone", name: "Landline Phone", year: "1995", desc: "300 Hz – 3.4 kHz, mono, 8-bit μ-law companding on the line.", meter: "mcintosh" },
  { id: "mp3", name: "128k MP3", year: "2001", desc: "Steep 16 kHz cut-off and a slightly narrower joint-stereo image.", meter: "walkman" },
  { id: "loudness", name: "Loudness War", year: "2008", desc: "Brick-wall compression and limiting: loud, flat, pumping and clipped.", meter: "stadium" },
  { id: "club", name: "Club PA", year: "2012", desc: "Sub-heavy dance-floor system: big low end, glue compression, a hard room.", meter: "stadium" },
  { id: "lofi", name: "Lo-fi Beats", year: "2018", desc: "12-bit, 22 kHz sampler crunch, warped tape, soft crackle.", meter: "vinyl" },
  { id: "hall", name: "Concert Hall", year: "Live", desc: "A large hall: early reflections and a long, slightly dark tail.", meter: "mcintosh" },
];

function VuMeters({ style }: { style: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    const needle = [0, 0];
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const cs = getComputedStyle(document.documentElement);
      const accent = cs.getPropertyValue("--accent").trim(), text = cs.getPropertyValue("--text").trim();
      ctx.clearRect(0, 0, w, h);
      for (let ch = 0; ch < 2; ch++) {
        // VU ballistics: ~300 ms integration
        const db = 20 * Math.log10(Math.max(1e-5, live.frame.rms[ch] * 1.414));
        const vu = Math.max(0, Math.min(1, (db + 26) / 29));
        needle[ch] += (vu - needle[ch]) * 0.09;
        const x0 = (ch * w) / 2, mw = w / 2;
        if (style === "walkman" || style === "stadium") {
          // LED ladder
          const n = 20;
          for (let i = 0; i < n; i++) {
            const on = i / n < needle[ch];
            ctx.fillStyle = on ? (i > n * 0.85 ? "#ff3b3b" : i > n * 0.7 ? "#ffcc00" : style === "walkman" ? accent : "#3cff8f") : "rgba(128,128,128,.15)";
            ctx.fillRect(x0 + 16 + i * ((mw - 32) / n), h * 0.35, (mw - 32) / n - 3, h * 0.3);
          }
          ctx.fillStyle = text;
          ctx.font = `${h * 0.12}px monospace`;
          ctx.fillText(ch ? "R" : "L", x0 + 4, h * 0.55);
        } else {
          // analog needle meter
          const cx = x0 + mw / 2, cy = h * 0.95, r = Math.min(mw * 0.45, h * 0.8);
          const face = ctx.createLinearGradient(0, 0, 0, h);
          if (style === "mcintosh") { face.addColorStop(0, "#0c2a55"); face.addColorStop(1, "#06152c"); }
          else { face.addColorStop(0, "#f2e6c8"); face.addColorStop(1, "#d8c7a0"); }
          ctx.fillStyle = face;
          ctx.fillRect(x0 + 8, 8, mw - 16, h - 16);
          ctx.strokeStyle = style === "mcintosh" ? "#7fd0ff" : "#3a2a10";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cx, cy, r, Math.PI * 1.2, Math.PI * 1.8);
          ctx.stroke();
          ctx.strokeStyle = "#ff3b3b";
          ctx.beginPath();
          ctx.arc(cx, cy, r, Math.PI * 1.68, Math.PI * 1.8);
          ctx.stroke();
          for (let k = 0; k <= 10; k++) {
            const a = Math.PI * (1.2 + 0.6 * (k / 10));
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
            ctx.lineTo(cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10));
            ctx.stroke();
          }
          const a = Math.PI * (1.2 + 0.6 * needle[ch]);
          ctx.strokeStyle = style === "mcintosh" ? "#ffffff" : "#111";
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a) * (r + 6), cy + Math.sin(a) * (r + 6));
          ctx.stroke();
          ctx.fillStyle = style === "mcintosh" ? "#7fd0ff" : "#3a2a10";
          ctx.font = `${h * 0.1}px serif`;
          ctx.fillText("VU", cx - 10, cy - r * 0.35);
          if (style === "mcintosh") {
            ctx.fillStyle = "rgba(90,180,255,.18)";
            ctx.fillRect(x0 + 8, 8, mw - 16, h - 16);
          }
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [style]);
  return <canvas ref={ref} className={`vu-meters vu-${style}`} />;
}

export function TimeMachine() {
  const dsp = useStore((s) => s.dsp);
  const era = ERAS.find((e) => e.id === dsp.era) ?? ERAS[0];
  return (
    <div className="view dsp-view">
      <Panel title="Sonic Time-Machine">
        <div className="era-grid">
          {ERAS.map((e) => (
            <button key={e.id} className={`era-card era-${e.id} ${dsp.era === e.id ? "on" : ""}`} onClick={() => updateDsp({ era: e.id })}>
              <span className="era-year">{e.year}</span>
              <span className="era-name">{e.name}</span>
              <span className="era-desc">{e.desc}</span>
            </button>
          ))}
        </div>
        <VuMeters style={era.meter === "none" ? "walkman" : era.meter} />
        <Slider value={dsp.eraAmount} onChange={(v) => updateDsp({ eraAmount: Math.round(v * 100) / 100 })} label="Era intensity" display={`${Math.round(dsp.eraAmount * 100)}%`} />
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ Stem Isolator
export function Stems() {
  const dsp = useStore((s) => s.dsp);
  const set = (k: keyof DspParams["stems"], v: number) => updateDsp({ stems: { ...dsp.stems, [k]: Math.round(v * 100) / 100 } });
  const preset = (s: DspParams["stems"]) => updateDsp({ stems: s });
  const pct = (v: number) => (v === 0 ? "MUTE" : `${Math.round(v * 100)}%`);
  return (
    <div className="view dsp-view">
      <Panel title="Live Acoustic Stem Isolator — Karaoke & Remix Deck" actions={<>
        <button className="btn" onClick={() => preset({ vocals: 0, drums: 1, bass: 1, other: 1 })}>Karaoke</button>
        <button className="btn" onClick={() => preset({ vocals: 1.6, drums: 0.4, bass: 0.6, other: 0.5 })}>A-cappella-ish</button>
        <button className="btn" onClick={() => preset({ vocals: 0.4, drums: 1.8, bass: 1.6, other: 0.7 })}>Rhythm section</button>
        <button className="btn" onClick={() => preset({ vocals: 1, drums: 1, bass: 1, other: 1 })}>Reset</button>
      </>}>
        <div className="stem-deck">
          {(["vocals", "drums", "bass", "other"] as const).map((k) => (
            <div key={k} className={`stem-ch stem-${k}`}>
              <div className="stem-name">{k.toUpperCase()}</div>
              <Slider orientation="v" value={dsp.stems[k] / 2} onChange={(v) => set(k, v * 2)} label={k} display={pct(dsp.stems[k])} size={64} />
              <div className="row">
                <button className={`btn small ${dsp.stems[k] === 0 ? "on" : ""}`} onClick={() => set(k, dsp.stems[k] === 0 ? 1 : 0)}>M</button>
                <button className="btn small" onClick={() => preset({ vocals: 0, drums: 0, bass: 0, other: 0, [k]: 1.5 } as any)}>S</button>
              </div>
            </div>
          ))}
        </div>
        <p className="muted small">
          Real-time frequency/phase decomposition: vocals = centre-panned (mid) energy in 200 Hz–6.5 kHz, bass = &lt;160 Hz LR4 band,
          drums = transient component (fast/slow envelope ratio), other = side channel + remaining mid. Works on local files;
          YouTube Music audio stays inside the browser engine.
        </p>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ Binaural Soundstage Sculptor
const STAGE_PRESETS: { name: string; note: string; speakers: Speaker[] }[] = [
  { name: "Nearfield studio", note: "Close monitors, tight image", speakers: [{ azimuth: -30, distance: 1.2, source: "L" }, { azimuth: 30, distance: 1.2, source: "R" }] },
  { name: "Mastering room", note: "Classic triangle + centre", speakers: [{ azimuth: -30, distance: 2.2, source: "L" }, { azimuth: 30, distance: 2.2, source: "R" }, { azimuth: 0, distance: 2.4, source: "C" }] },
  { name: "Wide stage", note: "Speakers far apart", speakers: [{ azimuth: -55, distance: 2, source: "L" }, { azimuth: 55, distance: 2, source: "R" }] },
  { name: "Quad / surround", note: "Front and rear pairs", speakers: [{ azimuth: -30, distance: 1.8, source: "L" }, { azimuth: 30, distance: 1.8, source: "R" }, { azimuth: -120, distance: 1.8, source: "L" }, { azimuth: 120, distance: 1.8, source: "R" }] },
  { name: "Concert hall", note: "Distant, spacious", speakers: [{ azimuth: -25, distance: 3.6, source: "L" }, { azimuth: 25, distance: 3.6, source: "R" }, { azimuth: 0, distance: 3.8, source: "C" }] },
];
const sameLayout = (a: Speaker[], b: Speaker[]) => a.length === b.length && a.every((s, i) => s.azimuth === b[i].azimuth && s.distance === b[i].distance && s.source === b[i].source);

function PresetGlyph({ speakers }: { speakers: Speaker[] }) {
  return (
    <svg viewBox="0 0 40 40" className="ss-glyph" aria-hidden>
      <circle cx="20" cy="20" r="17" className="ss-glyph-ring" />
      <circle cx="20" cy="20" r="3" className="ss-glyph-head" />
      {speakers.map((s, i) => {
        const a = (s.azimuth * Math.PI) / 180, d = (s.distance / 4) * 16;
        return <circle key={i} cx={20 + Math.sin(a) * d} cy={20 - Math.cos(a) * d} r="2.6" className={`ss-glyph-spk ch-${s.source}`} />;
      })}
    </svg>
  );
}

export function Soundstage() {
  const dsp = useStore((s) => s.dsp);
  const ref = useRef<SVGSVGElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [sel, setSel] = useState(0);
  const R = 150, C = 180;
  const selIdx = Math.min(sel, dsp.speakers.length - 1);
  const on = dsp.stageEnabled;

  // music level drives the wave animation (no React re-renders)
  useEffect(() => {
    let raf = 0, lvl = 0;
    const tick = () => {
      const f = live.frame;
      const target = live.playing ? Math.min(1, ((f.rms[0] + f.rms[1]) / 2) * 3) : 0;
      lvl += (target - lvl) * 0.15;
      wrap.current?.style.setProperty("--lvl", lvl.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const toXY = (s: Speaker) => {
    const a = (s.azimuth * Math.PI) / 180, d = (s.distance / 4) * R;
    return [C + Math.sin(a) * d, C - Math.cos(a) * d];
  };
  const setSpeaker = (i: number, patch: Partial<Speaker>) =>
    updateDsp({ stageEnabled: true, speakers: dsp.speakers.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const move = (e: React.PointerEvent) => {
    if (drag === null) return;
    const r = ref.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 360 - C, y = ((e.clientY - r.top) / r.height) * 360 - C;
    const az = Math.round((Math.atan2(x, -y) * 180) / Math.PI);
    const dist = Math.max(0.5, Math.min(4, (Math.hypot(x, y) / R) * 4));
    setSpeaker(drag, { azimuth: az, distance: Math.round(dist * 10) / 10 });
  };
  const nudge = (e: React.KeyboardEvent, i: number) => {
    const s = dsp.speakers[i];
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft") setSpeaker(i, { azimuth: Math.max(-180, s.azimuth - step) });
    else if (e.key === "ArrowRight") setSpeaker(i, { azimuth: Math.min(180, s.azimuth + step) });
    else if (e.key === "ArrowUp") setSpeaker(i, { distance: Math.min(4, Math.round((s.distance + 0.1) * 10) / 10) });
    else if (e.key === "ArrowDown") setSpeaker(i, { distance: Math.max(0.5, Math.round((s.distance - 0.1) * 10) / 10) });
    else return;
    e.preventDefault();
  };
  const room = dsp.room;
  const roomHalf = 118 + room * 52;
  const activePreset = STAGE_PRESETS.find((p) => sameLayout(p.speakers, dsp.speakers));

  return (
    <div className={`view dsp-view ss-view ${on ? "is-on" : "is-off"}`} ref={wrap}>
      <header className="ss-head">
        <div>
          <div className="ss-kicker">Headphone spatializer</div>
          <h2 className="ss-h">Soundstage</h2>
          <p className="ss-lead">Place virtual speakers around your head and hear your headphones like a real room.</p>
        </div>
        <div className="ss-head-ctl">
          <span className={`ss-pill ${on ? "on" : ""}`}><i />{on ? "Active" : "Bypassed"}</span>
          <Toggle on={on} onChange={(v) => updateDsp({ stageEnabled: v })} label="Enabled" />
        </div>
      </header>

      <div className="ss-grid">
        <section className="ss-stage-card">
          <svg ref={ref} viewBox="0 0 360 360" className="ss-stage" onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
            <defs>
              <radialGradient id="ss-floor" cx="50%" cy="50%" r="50%">
                <stop offset="0%" className="ss-floor-in" />
                <stop offset="100%" className="ss-floor-out" />
              </radialGradient>
            </defs>
            <circle cx={C} cy={C} r={R + 14} fill="url(#ss-floor)" />
            {/* the virtual room: grows with room size; dashed walls reflect */}
            <rect x={C - roomHalf} y={C - roomHalf} width={roomHalf * 2} height={roomHalf * 2} rx={18} className="ss-room" style={{ opacity: 0.25 + room * 0.75 }} />
            {/* ideal stereo listening wedge (±30°) */}
            <path d={`M${C} ${C} L${C + Math.sin(-Math.PI / 6) * R} ${C - Math.cos(-Math.PI / 6) * R} A${R} ${R} 0 0 1 ${C + Math.sin(Math.PI / 6) * R} ${C - Math.cos(Math.PI / 6) * R} Z`} className="ss-wedge" />
            {[1, 2, 3, 4].map((m) => (
              <g key={m}>
                <circle cx={C} cy={C} r={(m / 4) * R} className="ss-ring" />
                <text x={C + 4} y={C - (m / 4) * R + 11} className="ss-dist">{m} m</text>
              </g>
            ))}
            {Array.from({ length: 36 }, (_, i) => {
              const a = (i * 10 * Math.PI) / 180, major = i % 3 === 0;
              return <line key={i} x1={C + Math.sin(a) * (R + (major ? 4 : 8))} y1={C - Math.cos(a) * (R + (major ? 4 : 8))} x2={C + Math.sin(a) * (R + 12)} y2={C - Math.cos(a) * (R + 12)} className={`ss-tick ${major ? "major" : ""}`} />;
            })}
            {[[0, "0°"], [90, "90°"], [180, "180°"], [-90, "−90°"]].map(([deg, t]) => {
              const a = ((deg as number) * Math.PI) / 180;
              return <text key={String(deg)} x={C + Math.sin(a) * (R + 24)} y={C - Math.cos(a) * (R + 24) + 3} className="ss-deg">{t}</text>;
            })}
            {/* reflections from the walls */}
            {room > 0.05 && dsp.speakers.map((s, i) => {
              const [x, y] = toXY(s);
              const wx = x < C ? C - roomHalf : C + roomHalf;
              return <path key={`r${i}`} d={`M${x} ${y} L${wx} ${(y + C) / 2} L${C} ${C}`} className="ss-reflect" style={{ opacity: room * 0.6 }} />;
            })}
            {/* listener */}
            <g className="ss-head-g">
              <circle cx={C} cy={C} r={30} className="ss-head-halo" />
              <ellipse cx={C - 18} cy={C} rx={4.5} ry={8} className="ss-ear" />
              <ellipse cx={C + 18} cy={C} rx={4.5} ry={8} className="ss-ear" />
              <ellipse cx={C} cy={C} rx={16} ry={19} className="ss-headshape" />
              <path d={`M${C - 5} ${C - 18} L${C} ${C - 25} L${C + 5} ${C - 18}`} className="ss-nose" />
            </g>
            {dsp.speakers.map((s, i) => {
              const [x, y] = toXY(s);
              const a = Math.atan2(C - y, C - x) * (180 / Math.PI) + 90;
              return (
                <g key={i} className={`ss-spk ch-${s.source} ${drag === i ? "dragging" : ""} ${selIdx === i ? "sel" : ""}`} tabIndex={0} role="slider"
                  aria-label={`Speaker ${i + 1} (${s.source}) at ${s.azimuth} degrees, ${s.distance} metres. Arrow keys move it.`} aria-valuenow={s.azimuth}
                  onKeyDown={(e) => nudge(e, i)} onFocus={() => setSel(i)}
                  onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); setDrag(i); setSel(i); }}>
                  <line x1={C} y1={C} x2={x} y2={y} className="ss-beam" />
                  <circle cx={x} cy={y} r={16} className="ss-wave w1" />
                  <circle cx={x} cy={y} r={16} className="ss-wave w2" />
                  <g transform={`rotate(${a} ${x} ${y})`}>
                    <rect x={x - 13} y={y - 15} width={26} height={30} rx={6} className="ss-cab" />
                    <circle cx={x} cy={y + 4} r={7.5} className="ss-cone" />
                    <circle cx={x} cy={y - 8} r={2.8} className="ss-tweeter" />
                  </g>
                  <text x={x} y={y - 23} className="ss-spk-lbl">{s.source}</text>
                </g>
              );
            })}
          </svg>
          <div className="ss-stage-foot">
            <span>Drag speakers · arrow keys fine-tune (Shift = bigger steps)</span>
            {!on && <span className="ss-bypass">Bypassed — turn on to hear it</span>}
          </div>
        </section>

        <aside className="ss-side">
          <section className="ss-card">
            <div className="ss-card-h">Room presets</div>
            <div className="ss-presets">
              {STAGE_PRESETS.map((p) => (
                <button key={p.name} className={`ss-preset ${activePreset === p ? "on" : ""}`} onClick={() => { updateDsp({ stageEnabled: true, speakers: p.speakers }); setSel(0); }}>
                  <PresetGlyph speakers={p.speakers} />
                  <span><strong>{p.name}</strong><small>{p.note}</small></span>
                </button>
              ))}
            </div>
          </section>

          <section className="ss-card">
            <div className="ss-card-h">Room acoustics</div>
            <Slider value={dsp.room} onChange={(v) => updateDsp({ room: Math.round(v * 100) / 100 })} label="Room size / reflections" display={dsp.room < 0.05 ? "Dry" : `${Math.round(dsp.room * 100)}%`} />
            <div className="ss-scale"><span>Dry booth</span><span>Living room</span><span>Hall</span></div>
          </section>

          <section className="ss-card">
            <div className="ss-card-h">
              Speakers <span className="muted small">{dsp.speakers.length} / 8</span>
              <button className="btn small" onClick={() => { updateDsp({ speakers: [...dsp.speakers, { azimuth: 0, distance: 2, source: "C" }] }); setSel(dsp.speakers.length); }} disabled={dsp.speakers.length >= 8}>+ Add</button>
            </div>
            <div className="ss-spk-list">
              {dsp.speakers.map((s, i) => (
                <div key={i} className={`ss-spk-row ch-${s.source} ${selIdx === i ? "sel" : ""}`} onClick={() => setSel(i)}>
                  <span className="ss-badge">{s.source}</span>
                  <div className="ss-spk-meta">
                    <strong>Speaker {i + 1}</strong>
                    <span className="mono">{s.azimuth > 0 ? "+" : ""}{s.azimuth}° · {s.distance.toFixed(1)} m</span>
                  </div>
                  <Segmented value={s.source} onChange={(v) => setSpeaker(i, { source: v })}
                    options={[{ value: "L", label: "L" }, { value: "C", label: "C" }, { value: "R", label: "R" }]} />
                  <button className="ss-x" title="Remove speaker" aria-label={`Remove speaker ${i + 1}`} disabled={dsp.speakers.length <= 1}
                    onClick={(e) => { e.stopPropagation(); updateDsp({ speakers: dsp.speakers.filter((_, k) => k !== i) }); setSel(0); }}>×</button>
                </div>
              ))}
            </div>
            {dsp.speakers[selIdx] && (
              <div className="ss-fine">
                <Slider value={(dsp.speakers[selIdx].azimuth + 180) / 360} onChange={(v) => setSpeaker(selIdx, { azimuth: Math.round(v * 360 - 180) })}
                  label={`Speaker ${selIdx + 1} angle`} display={`${dsp.speakers[selIdx].azimuth}°`} />
                <Slider value={(dsp.speakers[selIdx].distance - 0.5) / 3.5} onChange={(v) => setSpeaker(selIdx, { distance: Math.round((0.5 + v * 3.5) * 10) / 10 })}
                  label={`Speaker ${selIdx + 1} distance`} display={`${dsp.speakers[selIdx].distance.toFixed(1)} m`} />
              </div>
            )}
          </section>

          <p className="muted small ss-note">Spherical-head model: Woodworth ITD, frequency-dependent head shadow (ILD), rear pinna cue, distance delay/attenuation and an early-reflection room.</p>
        </aside>
      </div>
    </div>
  );
}
