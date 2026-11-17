// Settings → Playback engine (RAM playback, resampler, Atmos/multichannel rendering, FFmpeg) and
// Cast to network players (UPnP / DLNA).
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, EngineOptions, Renderer } from "../api";
import { casting, startCast, stopCast } from "../cast";
import { Icon, Panel, Segmented, Toggle } from "../controls";
import { toast, useStore } from "../store";
import { updateDsp } from "../player";

/** Mono, volume curve, playback speed and pitch. (ReplayGain lives on the EQ page, spatial
 *  options on the Soundstage page and under Playback engine.) */
export function PlaybackPanel() {
  const dsp = useStore((s) => s.dsp);
  const speed = dsp.speed ?? 1;
  const [text, setText] = useState(String(speed));
  useEffect(() => setText(String(Math.round(speed * 1000) / 1000)), [speed]);
  const setSpeed = (v: number) => updateDsp({ speed: Math.round(Math.min(100, Math.max(0.01, v)) * 1000) / 1000 });
  // log slider: 0.01× … 1× … 100×, with 1× in the middle
  const toT = (v: number) => (Math.log10(v) + 2) / 4;
  const fromT = (t: number) => Math.pow(10, t * 4 - 2);
  return (
    <Panel title="Playback">
      <div className="pb-row">
        <div><b>Mono Audio</b><small>Combine left and right channels into mono</small></div>
        <Toggle on={!!dsp.mono} onChange={(v) => updateDsp({ mono: v })} />
      </div>
      <div className="pb-row">
        <div><b>Exponential Volume</b><small>Logarithmic volume curve for finer low-volume control</small></div>
        <Toggle on={!!dsp.expVolume} onChange={(v) => updateDsp({ expVolume: v })} />
      </div>
      <div className="pb-row wrap">
        <div><b>Playback Speed</b><small>Adjust playback speed (0.01× – 100×)</small></div>
        <div className="pb-speed">
          <input type="range" className="eqs-range" min={0} max={1000} value={Math.round(toT(speed) * 1000)}
            onChange={(e) => { let v = fromT(Number(e.target.value) / 1000); if (Math.abs(Math.log10(v)) < 0.02) v = 1; setSpeed(v < 1 ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10); }} />
          <input className="eqs-input pb-num" value={text} inputMode="decimal" aria-label="Playback speed"
            onChange={(e) => setText(e.target.value)}
            onBlur={() => { const v = parseFloat(text); if (isFinite(v) && v > 0) setSpeed(v); else setText(String(speed)); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          <span className="muted">×</span>
          <button className="btn small" onClick={() => setSpeed(1)} disabled={speed === 1}>Reset</button>
        </div>
      </div>
      <div className="pb-row">
        <div><b>Preserve Pitch</b><small>Keep the original key when changing speed</small></div>
        <Toggle on={dsp.preservePitch !== false} onChange={(v) => updateDsp({ preservePitch: v })} />
      </div>
      <p className="muted small">Speed applies to local files (streaming services use their own speed). Any of these leaves the bit-perfect path while active; DSD over PCM always plays at 1×.</p>
    </Panel>
  );
}

export function EnginePanel() {
  const [o, setO] = useState<EngineOptions | null>(null);
  const [ff, setFf] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    api.getEngineOptions().then(setO).catch(() => {});
    api.ffmpegStatus().then(setFf).catch(() => setFf(null));
  }, []);
  if (!o) return null;
  const save = (p: Partial<EngineOptions>) => {
    const n = { ...o, ...p };
    setO(n);
    api.setEngineOptions(n).then(() => { if ("ffmpegPath" in p) api.ffmpegStatus().then(setFf); }).catch((e) => toast(String(e)));
  };
  return (
    <Panel title="Playback engine">
      <Toggle on={o.ramBuffer} onChange={(v) => save({ ramBuffer: v })} label="RAM playback — load each track (and the next) fully into memory" />
      {o.ramBuffer && (
        <label className="field"><span>Largest file kept in RAM</span>
          <select value={o.ramLimitMb} onChange={(e) => save({ ramLimitMb: Number(e.target.value) })}>
            {[256, 512, 1024, 2048, 4096].map((m) => <option key={m} value={m}>{m >= 1024 ? `${m / 1024} GB` : `${m} MB`}</option>)}
          </select>
        </label>
      )}
      <label className="field"><span>Sample-rate conversion (only when the device can't switch to the file's rate)</span></label>
      <Segmented value={o.resampler} onChange={(v) => save({ resampler: v })} options={[{ value: "sinc", label: "High precision (sinc)" }, { value: "fast", label: "Fast (Hermite)" }]} />
      <label className="field"><span>Dolby Atmos &amp; multichannel files — binaural for headphones, stereo downmix for speakers</span></label>
      <Segmented value={o.spatial} onChange={(v) => save({ spatial: v })} options={[{ value: "binaural", label: "Binaural" }, { value: "stereo", label: "Stereo" }]} />
      <div className="kv-list">
        <div className="kv"><span>Dolby Digital / Digital Plus / Atmos (E-AC-3)</span><strong>Windows decoder</strong></div>
        <div className="kv"><span>Dolby TrueHD (Atmos), DTS, WavPack, Opus</span><strong>{ff === undefined ? "…" : ff ? "FFmpeg found" : "Needs FFmpeg"}</strong></div>
      </div>
      {ff && <p className="muted small ellipsis" title={ff}>FFmpeg: {ff}</p>}
      <div className="row wrap">
        <button className="btn small" onClick={async () => {
          const p = await open({ title: "Locate ffmpeg.exe", filters: [{ name: "ffmpeg", extensions: ["exe"] }] });
          if (typeof p === "string") save({ ffmpegPath: p });
        }}>{ff ? "Use a different FFmpeg…" : "Locate ffmpeg.exe…"}</button>
        {o.ffmpegPath && <button className="btn small ghost" onClick={() => save({ ffmpegPath: "" })}>Find automatically</button>}
      </div>
      <p className="muted small">
        Atmos in E-AC-3 (.ec3, .m4a/.mp4 from streaming downloads) is decoded by Windows' own Dolby decoder;
        the bed and objects are rendered to binaural stereo for headphones. TrueHD Atmos (.mka/.mkv/.thd) needs FFmpeg
        (free; e.g. <code>winget install ffmpeg</code>). Lossless PCM is never resampled when the device can switch rates.
      </p>
    </Panel>
  );
}

export function CastPanel() {
  const cast = useStore((s) => s.cast);
  const castState = useStore((s) => s.castState);
  const [list, setList] = useState<Renderer[]>([]);
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    setBusy(true);
    try {
      const r = await api.dlnaDiscover();
      setList(r);
      if (!r.length) toast("No network players found");
    } finally { setBusy(false); }
  };
  return (
    <Panel title="Cast to a network player (UPnP / DLNA)" actions={cast ? <span className="cast-badge"><Icon name="cast" size={12} /> {cast.name}</span> : undefined}>
      <div className="row wrap">
        <button className="btn primary" disabled={busy} onClick={scan}>{busy ? "Searching…" : "Find players"}</button>
        {cast && <button className="btn" onClick={() => stopCast()}>Stop casting</button>}
      </div>
      <div className="cast-list">
        {list.map((r) => (
          <div key={r.id} className={`cast-dev ${cast?.id === r.id ? "on" : ""}`}>
            <Icon name="cast" size={18} />
            <div className="grow"><b>{r.name}</b><small>{r.model || r.id}</small></div>
            {cast?.id === r.id
              ? <span className="muted small">{castState ? castState.toLowerCase().replace(/_/g, " ") : "connecting…"}</span>
              : <button className="btn small" onClick={() => startCast(r).catch((e) => toast(String(e)))}>Cast</button>}
          </div>
        ))}
      </div>
      <p className="muted small">
        Streams your local files to network streamers, DACs and receivers. FLAC/WAV/ALAC/AIFF/MP3 are sent byte-for-byte
        (bit-perfect — the player decodes the original); CUE tracks, DSD, APE, SACD images and Dolby files are sent as
        lossless 24-bit WAV. Windows may ask once to allow DriftKord on your private network.{casting() ? "" : ""}
      </p>
    </Panel>
  );
}
