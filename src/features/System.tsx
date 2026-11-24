// Streaming panel (YouTube Music, Spotify, Apple Music, TIDAL, Amazon Music), Metadata editor, Settings (output / ASIO / shell / focus), Theme gallery, Focus HUD.
import { open } from "@tauri-apps/plugin-dialog";
import { CastPanel, EnginePanel, PlaybackPanel } from "./Engine";
import { emit, listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, DeviceInfo, FocusConfig, fmtTime, OutputConfig, QueueItem, ShellStatus, TagData, TagPatch, Track } from "../api";
import { Icon, IconButton, Panel, Segmented, Slider, Toggle } from "../controls";
import { enqueue, toggleHud } from "../player";
import { AdaptiveMode, getState, live, setState, toast, useStore } from "../store";
import { itemService, serviceById, SERVICES } from "../streaming";
import { applyTheme, CATEGORIES, setPaletteOverride, THEMES, themeById } from "../themes";
import { useCover } from "./Library";
import { IntegrationsPanel } from "./Integrations";
import { CustomThemeEditor, ModsManager } from "./CustomThemeEditor";
import { applyCustomExtras, customAsTheme, customFrom, CUSTOM_ID, normalizeCustom } from "../customTheme";
import { registerCustomTheme } from "../themes";

// ================================================================== Streaming (YouTube Music, Spotify, Apple Music, TIDAL, Amazon Music)
export function Streaming() {
  const svcId = useStore((s) => s.streamService);
  const svc = serviceById(svcId);
  const isYt = svc.id === "youtube";
  const ytMain = useStore((s) => s.yt);
  const reported = useStore((s) => s.streams[svc.id]);
  const ad = useStore((s) => s.adblock);
  const activeSvc = useStore((s) => (s.ytActive ? itemService(s.queue[s.queueIndex]) : null));
  const streams = useStore((s) => s.streams);
  const cinema = useStore((s) => s.cinema);
  const fullPlayer = useStore((s) => s.fullPlayer);
  const integrated = useStore((s) => s.ytIntegrated);
  const routed = useStore((s) => s.ytRouteEngine);
  const themeId = useStore((s) => s.themeId);
  const [showShield, setShowShield] = useState(false);
  const [unloaded, setUnloaded] = useState<string[]>([]);
  const isUnloaded = unloaded.includes(svc.id);
  const host = useRef<HTMLDivElement>(null);
  const yt = isYt ? reported ?? ytMain : reported;
  const current: QueueItem | null = yt?.videoId
    ? { kind: "youtube", videoId: yt.videoId, title: yt.title, artist: yt.artist, album: yt.album, duration: yt.duration, artUrl: yt.artUrl }
    : null;
  const shield = isYt && showShield;

  // Keep the selected service's embedded view glued to the host area of this page.
  useEffect(() => {
    const el = host.current;
    if (!el || isUnloaded) {
      api.ytHide().catch(() => {});
      return;
    }
    let raf = 0;
    let last = "";
    const place = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (getState().cinema || getState().fullPlayer || shield) {
          if (last !== "hidden") api.ytHide().catch(() => {});
          last = "hidden";
          return;
        }
        // The service page is a separate layer drawn above DriftKord, so it must never reach past
        // the visible page area — otherwise it hides the player bar, tab bar or a floating player.
        const h = el.getBoundingClientRect();
        const area = (el.closest(".main") as HTMLElement | null)?.getBoundingClientRect() ?? h;
        let top = Math.max(h.top, area.top), bottom = Math.min(h.bottom, area.bottom);
        const left = Math.max(h.left, area.left), right = Math.min(h.right, area.right);
        // floating player docks (bottom) sit on top of the page area: stop above them
        document.querySelectorAll<HTMLElement>(".transport-dock, .app > .transport").forEach((d) => {
          if (getComputedStyle(d).position !== "fixed") return;
          const b = d.getBoundingClientRect();
          const overlapsX = b.left < right && b.right > left;
          if (overlapsX && b.top < bottom && b.bottom > top) {
            if (b.top > (top + bottom) / 2) bottom = b.top - 8; else top = b.bottom + 8;
          }
        });
        const r = { left, top, width: right - left, height: bottom - top };
        const key = [r.left, r.top, r.width, r.height].map(Math.round).join(",");
        if (key === last || r.width < 20 || r.height < 20) return;
        last = key;
        api.ytShowAt(r.left, r.top, r.width, r.height, svc.id).catch((e) => toast(String(e)));
      });
    };
    const ro = new ResizeObserver(place);
    ro.observe(el);
    ro.observe(document.documentElement);
    window.addEventListener("resize", place);
    const main = el.closest(".main");
    main?.addEventListener("scroll", place);
    const iv = window.setInterval(place, 500); // catches layout shifts (theme switch, panels opening)
    place();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", place);
      main?.removeEventListener("scroll", place);
      window.clearInterval(iv);
      api.ytHide().catch(() => {});
    };
  }, [cinema, fullPlayer, shield, themeId, svc.id, isUnloaded]);

  // hide the service's own player bar while DriftKord's player bar is in charge (re-sent after page loads)
  useEffect(() => {
    if (isUnloaded) return;
    const send = () => api.ytControl("integrated", integrated ? 1 : 0, svc.id).catch(() => {});
    send();
    const t = window.setTimeout(send, 3000); // a freshly created view may still be loading
    return () => window.clearTimeout(t);
  }, [integrated, yt?.url, svc.id, isUnloaded]);

  const pick = (id: string) => {
    setShowShield(false);
    setState({ streamService: id });
  };
  const ctl = (cmd: string) => api.ytControl(cmd, undefined, svc.id).catch(() => {});
  const closeService = async () => {
    if (activeSvc === svc.id) {
      setState({ ytActive: false });
      live.playing = false;
    }
    await api.streamClose(svc.id).catch((e) => toast(String(e)));
    setUnloaded((u) => [...u, svc.id]);
    toast(`${svc.name} closed — your sign-in is kept`);
  };
  const reopen = () => setUnloaded((u) => u.filter((x) => x !== svc.id));

  return (
    <div className="view yt-view">
      <div className="stream-tabs" role="tablist">
        {SERVICES.map((s) => {
          const st = streams[s.id];
          const playing = activeSvc === s.id && st && !st.paused;
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={s.id === svc.id}
              className={`stream-tab ${s.id === svc.id ? "on" : ""}`}
              style={{ ["--svc" as string]: s.color }}
              onClick={() => pick(s.id)}
              title={`${s.name} — ${s.note}`}
            >
              <span className="stream-dot" />
              {s.name}
              {playing && <span className="stream-live" title="Playing now">▶</span>}
            </button>
          );
        })}
      </div>
      <div className="yt-toolbar">
        <div className="yt-nav">
          <IconButton icon="prev" title="Back" size={15} onClick={() => ctl("back")} />
          <IconButton icon="next" title="Forward" size={15} onClick={() => ctl("forward")} />
          <IconButton icon="refresh" title="Reload" size={15} onClick={() => ctl("reload")} />
          <IconButton icon={isYt ? "youtube" : "home"} title={`${svc.name} home`} size={16} onClick={() => { reopen(); api.ytOpen(undefined, svc.id).catch((e) => toast(String(e))); }} />
        </div>
        {current && (
          <div className="yt-now-chip" title={`${current.title} — ${current.artist}`}>
            {current.artUrl && <img src={current.artUrl} alt="" />}
            <span className="ellipsis">{current.title}</span>
            {isYt && <button className="btn small" onClick={() => enqueue([current])} title="Add to DriftKord's queue"><Icon name="plus" size={12} /> Queue</button>}
            {activeSvc !== svc.id && (
              <button className="btn small" onClick={() => { setState((s) => ({ queue: [...s.queue, current], queueIndex: s.queue.length, ytActive: true, yt: yt ?? null })); api.stop(); }} title="Control this song from DriftKord's player bar">Make current</button>
            )}
          </div>
        )}
        <span title={`Use DriftKord's player bar and hide ${svc.name}'s own play/pause bar`}><Toggle on={integrated} onChange={(v) => setState({ ytIntegrated: v })} label="DriftKord controls" /></span>
        {isYt ? (
          <>
            <span title="Play YouTube Music through DriftKord's audio engine: EQ, Time-Machine, stems, soundstage, crossfeed, ducking and your chosen output device"><Toggle on={routed} onChange={(v) => setState({ ytRouteEngine: v })} label="Route through DriftKord" /></span>
            <button className={`btn small shield-badge ${showShield ? "on" : ""}`} onClick={() => setShowShield(!showShield)} title="Ad & tracker shield details">
              🛡 {ad.blocked.toLocaleString()}
            </button>
          </>
        ) : (
          <span
            className="sp-badge warn stream-drm"
            title={`${svc.name} protects its audio with DRM, so it plays through ${svc.name}'s own player. DriftKord's player bar, media keys, Focus HUD, lyrics and visualizers work with it; EQ and other DSP effects can't be applied.`}
          >
            🔒 DRM · DSP off
          </span>
        )}
        {!isUnloaded && (
          <IconButton icon="close" title={`Close ${svc.name} to free memory (you stay signed in)`} size={14} onClick={closeService} />
        )}
      </div>
      {shield ? (
        <Panel title="Ad & Tracker Shield" actions={<button className="btn small" onClick={() => setShowShield(false)}>Back to YouTube Music</button>}>
          <div className="shield">
            <div className="shield-num">{ad.blocked.toLocaleString()}</div>
            <div className="muted">requests blocked at the network layer</div>
            <div className="muted small">{ad.inspected.toLocaleString()} inspected · {yt?.adsSkipped ?? 0} residual ad slots auto-skipped</div>
          </div>
          <ul className="bullets">
            <li><strong>Network:</strong> ad and tracker requests are answered locally with HTTP 403 before they leave your PC.</li>
            <li><strong>Scriptlets:</strong> ad entries are removed from YouTube's player data.</li>
            <li><strong>Cosmetic:</strong> promo banners, upsell dialogs and ad slots are hidden.</li>
            <li><strong>Fallback:</strong> any ad that still renders is muted, fast-forwarded and skipped.</li>
            <li>The embedded page has no access to DriftKord's commands or your files.</li>
          </ul>
        </Panel>
      ) : isUnloaded ? (
        <div className="yt-host">
          <div className="yt-host-placeholder">
            <span className="stream-dot big" style={{ ["--svc" as string]: svc.color }} />
            {svc.name} is closed.
            <button className="btn" onClick={reopen}>Open {svc.name}</button>
          </div>
        </div>
      ) : (
        <div className="yt-host" ref={host}>
          <div className="yt-host-placeholder">
            {isYt ? <Icon name="youtube" size={40} /> : <span className="stream-dot big" style={{ ["--svc" as string]: svc.color }} />}
            Loading {svc.name}…
            {!isYt && <span className="muted small">Sign in once — DriftKord remembers it. Requires: {svc.note}.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
// ================================================================== Metadata editor
const FIELDS: [keyof TagPatch, string][] = [
  ["title", "Title"], ["artist", "Artist"], ["album", "Album"], ["albumArtist", "Album artist"], ["genre", "Genre"],
  ["year", "Year"], ["trackNo", "Track #"], ["discNo", "Disc #"], ["composer", "Composer"], ["comment", "Comment"],
];
/** Classical / collector tags (Conductor, Label, Dynamic Range…). */
const MORE_FIELDS: [keyof TagPatch, string][] = [
  ["conductor", "Conductor"], ["work", "Work"], ["label", "Label"], ["publisher", "Publisher"], ["catalog", "Catalog #"],
  ["isrc", "ISRC"], ["lyricist", "Lyricist"], ["remixer", "Remixer"], ["mood", "Mood"], ["bpm", "BPM"],
  ["initialKey", "Key"], ["dynamicRange", "Dynamic Range"], ["copyright", "Copyright"],
];

export function Metadata() {
  const selection = useStore((s) => s.selection);
  const tracks = useStore((s) => s.tracks);
  const sel = useMemo(() => tracks.filter((t) => selection.includes(t.id)), [tracks, selection]);
  const [tags, setTags] = useState<TagData[]>([]);
  const [patch, setPatch] = useState<TagPatch>({});
  const [pattern, setPattern] = useState("%track% - %artist% - %title%");
  const [preview, setPreview] = useState<[string, TagPatch][]>([]);
  const [busy, setBusy] = useState(false);
  const cover = useCover(sel[0]?.path);
  useEffect(() => {
    setPatch({});
    setPreview([]);
    Promise.all(sel.slice(0, 200).map((t) => api.readTags(t.path).catch(() => null))).then((r) => setTags(r.filter(Boolean) as TagData[]));
  }, [selection.join(",")]);
  const common = (k: keyof TagData) => {
    const vals = new Set(tags.map((t) => String(t[k] ?? "")));
    return vals.size === 1 ? [...vals][0] : null;
  };
  const paths = sel.map((t) => t.path);
  const save = async () => {
    if (!Object.keys(patch).length) return;
    setBusy(true);
    try {
      const n = await api.writeTags(paths, patch);
      toast(`Updated tags in ${n} file${n === 1 ? "" : "s"}`);
      setPatch({});
    } catch (e) {
      toast(String(e));
    }
    setBusy(false);
  };
  if (!sel.length) {
    return (
      <div className="view">
        <Panel title="Metadata editor">
          <p className="muted">Select one or more tracks in the Library and choose “Edit tags”. Batch edits only change the fields you touch.</p>
          <button className="btn" onClick={() => setState({ view: "library" })}>Go to library</button>
        </Panel>
      </div>
    );
  }
  return (
    <div className="view metadata">
      <div className="grid2">
        <Panel title={`Tags — ${sel.length} file${sel.length > 1 ? "s" : ""}`} actions={<button className="btn primary" onClick={save} disabled={busy || !Object.keys(patch).length}>Save changes</button>}>
          <div className="form-grid">
            {FIELDS.map(([k, label]) => {
              const c = common(k as keyof TagData);
              return (
                <label key={k}>
                  <span>{label}</span>
                  <input value={patch[k] ?? c ?? ""} placeholder={c === null ? "‹multiple values›" : ""} onChange={(e) => setPatch({ ...patch, [k]: e.target.value })} className={patch[k] !== undefined ? "dirty" : ""} />
                </label>
              );
            })}
          </div>
          <details className="tag-more" open={MORE_FIELDS.some(([k]) => patch[k] !== undefined || !!common(k as keyof TagData))}>
            <summary>More tags — conductor, label, catalog, ISRC, dynamic range…</summary>
            <div className="form-grid">
              {MORE_FIELDS.map(([k, label]) => {
                const c = common(k as keyof TagData);
                return (
                  <label key={k}>
                    <span>{label}</span>
                    <input value={patch[k] ?? c ?? ""} placeholder={c === null ? "‹multiple values›" : ""} onChange={(e) => setPatch({ ...patch, [k]: e.target.value })} className={patch[k] !== undefined ? "dirty" : ""} />
                  </label>
                );
              })}
            </div>
            {sel.length === 1 && sel[0].dr != null && !(patch.dynamicRange ?? common("dynamicRange" as keyof TagData)) && (
              <button className="btn small" onClick={() => setPatch({ ...patch, dynamicRange: `DR${Math.round(sel[0].dr!)}` })}>Fill Dynamic Range from analysis (DR{Math.round(sel[0].dr)})</button>
            )}
          </details>
          {sel.length === 1 && (
            <label className="lyrics-field">
              <span>Embedded lyrics</span>
              <textarea value={patch.lyrics ?? tags[0]?.lyrics ?? ""} onChange={(e) => setPatch({ ...patch, lyrics: e.target.value })} rows={6} />
            </label>
          )}
          {tags[0] && <p className="muted small">{tags[0].format} · tag: {tags[0].tagType}</p>}
        </Panel>
        <div className="col">
          <Panel title="Cover art">
            <div className="cover-edit">
              {cover ? <img src={cover} alt="" /> : <div className="np-cover empty"><Icon name="disc" size={40} /></div>}
              <div className="col">
                <button className="btn" onClick={async () => {
                  const f = await open({ filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }] });
                  if (typeof f === "string") { await api.setCover(paths, f); toast("Cover embedded"); }
                }}>Embed image…</button>
                <button className="btn danger" onClick={async () => { await api.removeCover(paths); toast("Cover removed"); }}>Remove cover</button>
              </div>
            </div>
          </Panel>
          <Panel title="Tags from filename">
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} className="wide" />
            <p className="muted small">Tokens: %artist% %title% %album% %albumartist% %track% %disc% %year% %genre%</p>
            <div className="row">
              <button className="btn" onClick={async () => setPreview(await api.tagsFromFilename(paths, pattern))}>Preview</button>
              <button className="btn primary" disabled={!preview.length} onClick={async () => {
                setBusy(true);
                for (const [p, tp] of preview) await api.writeTags([p], tp).catch(() => {});
                setBusy(false);
                setPreview([]);
                toast("Applied filename tags");
              }}>Apply</button>
            </div>
            {preview.slice(0, 8).map(([p, tp]) => (
              <div key={p} className="small mono">{Object.entries(tp).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" · ")}</div>
            ))}
          </Panel>
          <Panel title="ReplayGain 2.0 scanner (EBU R128)">
            <div className="row">
              <button className="btn" disabled={busy} onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.computeReplaygain(paths, false, true);
                  toast(`Track gain written to ${r.length} files`);
                } catch (e) { toast(String(e)); }
                setBusy(false);
              }}>Scan as tracks</button>
              <button className="btn" disabled={busy} onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.computeReplaygain(paths, true, true);
                  toast(`Album gain ${r[0]?.albumGain?.toFixed(2)} dB written to ${r.length} files`);
                } catch (e) { toast(String(e)); }
                setBusy(false);
              }}>Scan as album</button>
            </div>
            <div className="small">
              {sel.slice(0, 10).map((t: Track) => (
                <div key={t.id} className="row"><span className="ellipsis">{t.title}</span><span className="mono muted">{t.rgTrackGain != null ? `${t.rgTrackGain.toFixed(2)} dB` : "—"}</span></div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

// ================================================================== Settings
export function Settings() {
  const [out, setOut] = useState<OutputConfig | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [asio, setAsio] = useState<string[]>([]);
  const [asioOk, setAsioOk] = useState(false);
  const [shell, setShell] = useState<ShellStatus | null>(null);
  const [focus, setFocus] = useState<FocusConfig | null>(null);
  const [onlineLyrics, setOnlineLyrics] = useState(false);
  const [onlineBios, setOnlineBios] = useState(true);
  const status = useStore((s) => s.status);
  const fstate = useStore((s) => s.focus);
  const hudOpen = useStore((s) => s.hudOpen);
  const hudOpacity = useStore((s) => s.hudOpacity);
  const hudScale = useStore((s) => s.hudScale);
  useEffect(() => {
    api.getOutput().then(setOut);
    api.listDevices().then(setDevices).catch(() => {});
    api.asioAvailable().then((ok) => { setAsioOk(ok); if (ok) api.listAsioDevices().then(setAsio); });
    api.shellStatus().then(setShell);
    api.getFocusConfig().then(setFocus);
    api.getSetting("onlineLyrics").then((v) => setOnlineLyrics(v !== "false"));
    api.getSetting("onlineBios").then((v) => setOnlineBios(v !== "false"));
  }, []);
  const saveOut = (o: OutputConfig) => {
    setOut(o);
    api.setOutput(o).then(() => toast("Output updated"));
  };
  const saveFocus = (f: FocusConfig) => {
    setFocus(f);
    api.setFocusConfig(f);
  };
  return (
    <div className="view settings">
      <div className="grid2">
        <Panel title="Audio output">
          {out && (
            <>
              <Segmented value={out.mode} onChange={(m) => saveOut({ ...out, mode: m })} options={[
                { value: "exclusive", label: "WASAPI Exclusive" }, { value: "shared", label: "WASAPI Shared" }, { value: "asio", label: "ASIO" },
              ]} />
              {out.mode !== "asio" ? (
                <label className="field"><span>Device</span>
                  <select value={out.deviceId ?? ""} onChange={(e) => saveOut({ ...out, deviceId: e.target.value || null })}>
                    <option value="">System default</option>
                    {devices.map((d) => <option key={d.id} value={d.id}>{d.name}{d.isDefault ? " (default)" : ""}</option>)}
                  </select>
                </label>
              ) : asio.length ? (
                <>
                  <label className="field"><span>ASIO driver</span>
                    <select value={out.asioDevice ?? ""} onChange={(e) => saveOut({ ...out, asioDevice: e.target.value || null })}>
                      <option value="">First available</option>
                      {asio.map((d) => <option key={d}>{d}</option>)}
                    </select>
                  </label>
                  <button className="btn small" onClick={() => api.asioControlPanel(out.asioDevice || asio[0]).catch((e) => toast(String(e)))}>Driver control panel…</button>
                </>
              ) : (
                <p className="muted small">No ASIO driver is installed. Install your DAC maker's ASIO driver and it appears here — WASAPI Exclusive is already bit-perfect for almost every DAC.{asioOk ? "" : ""}</p>
              )}
              <Toggle on={out.dop} onChange={(v) => saveOut({ ...out, dop: v })} label="DSD over PCM (DoP) for .dsf files in exclusive mode" />
              <div className="kv-list">
                <div className="kv"><span>Status</span><strong>{status?.output.open ? `${status.output.backend} · ${status.output.deviceName}` : "Closed (opens on play)"}</strong></div>
                {status?.output.open && <div className="kv"><span>Format</span><strong>{status.output.float ? "32-bit float" : `${status.output.bits}-in-${status.output.containerBits} bit`} @ {status.output.rate} Hz</strong></div>}
                {status?.output.error && <div className="kv warn"><span>Note</span><strong>{status.output.error}</strong></div>}
              </div>
              <p className="muted small">Exclusive mode switches the DAC to each file's native rate/bit-depth automatically. For a bit-perfect path keep volume at 100% and all DSP off (the Signal Path HUD confirms it).</p>
            </>
          )}
        </Panel>
        <PlaybackPanel />
        <EnginePanel />
        <CastPanel />
        <Panel title="Windows integration">
          {shell && (
            <>
              <div className="kv"><span>Explorer integration</span><strong>{shell.registered ? "Registered" : "Not registered"}</strong></div>
              <p className="muted small">Adds “Play with / Add to queue” to audio files, “Add folder to library” to folders, and lists the app in Open with… and Default apps (per-user, no admin).</p>
              <div className="row wrap">
                <button className="btn primary" onClick={async () => { await api.shellRegister(); setShell(await api.shellStatus()); toast("Shell integration registered"); }}>{shell.registered ? "Re-register" : "Register"}</button>
                {shell.registered && <button className="btn" onClick={async () => { await api.shellUnregister(); setShell(await api.shellStatus()); }}>Unregister</button>}
                <button className="btn" onClick={() => api.openDefaultApps()}>Set as default player…</button>
              </div>
              {shell.registeredExe && !shell.registeredExe.includes(shell.exePath) && <p className="warn small">Registered for a different copy of the app — click Re-register.</p>}
            </>
          )}
          <p className="muted small">Media keys, the Windows 11 media flyout and lock-screen controls work automatically (System Media Transport Controls).</p>
        </Panel>
        <Panel title="Game & Focus Ducking">
          {focus && (
            <>
              <Toggle on={focus.enabled} onChange={(v) => saveFocus({ ...focus, enabled: v })} label="Detect full-screen games and voice calls" />
              <Slider value={focus.gameDuck} onChange={(v) => saveFocus({ ...focus, gameDuck: Math.round(v * 100) / 100 })} label="Music level during games" display={`${Math.round(focus.gameDuck * 100)}%`} />
              <Slider value={focus.callDuck} onChange={(v) => saveFocus({ ...focus, callDuck: Math.round(v * 100) / 100 })} label="Music level during calls" display={`${Math.round(focus.callDuck * 100)}%`} />
              <Toggle on={focus.autoHud} onChange={(v) => saveFocus({ ...focus, autoHud: v })} label="Show translucent HUD overlay while gaming" />
              <div className="kv"><span>Now</span><strong>{fstate.call ? `Call (${fstate.callApp})` : fstate.game ? `Game (${fstate.fullscreenApp})` : "Normal"}</strong></div>
              <div className="hud-look">
                <Slider value={(hudOpacity - 0.25) / 0.75} onChange={(v) => { setState({ hudOpacity: Math.round((0.25 + v * 0.75) * 100) / 100 }); if (!hudOpen) toggleHud(true); }}
                  label="HUD transparency" display={`% see-through`} />
                <Slider value={(hudScale - 0.75) / 0.85} onChange={(v) => { setState({ hudScale: Math.round((0.75 + v * 0.85) * 20) / 20 }); if (!hudOpen) toggleHud(true); }}
                  label="HUD size" display={`%`} />
                <div className="row wrap">
                  {([["S", 0.8], ["M", 1], ["L", 1.25], ["XL", 1.5]] as const).map(([n, v]) => (
                    <button key={n} className={`btn small ${Math.abs(hudScale - v) < 0.01 ? "on" : ""}`} onClick={() => { setState({ hudScale: v }); if (!hudOpen) toggleHud(true); }}>{n}</button>
                  ))}
                  <button className="btn small ghost" onClick={() => setState({ hudOpacity: 0.92, hudScale: 1 })}>Reset</button>
                </div>
                <p className="muted small">The HUD turns fully solid while your mouse is over it.</p>
              </div>
              <button className="btn" onClick={() => toggleHud()}>{hudOpen ? "Hide HUD" : "Show HUD"}</button>
            </>
          )}
        </Panel>
        <Panel title="Lyrics & privacy">
          <Toggle on={onlineLyrics} onChange={(v) => { setOnlineLyrics(v); api.setSetting("onlineLyrics", String(v)); }} label="Find lyrics online automatically (LRCLIB)" />
          <p className="muted small">On by default. Lyrics are found automatically for local files and every streaming service: embedded lyrics and .lrc files first, then lrclib.net (only the title, artist, album and length are sent). Results are cached on this PC.</p>
          <Toggle on={onlineBios} onChange={(v) => { setOnlineBios(v); api.setSetting("onlineBios", String(v)); }} label="Show artist biographies (MusicBrainz + Wikipedia)" />
          <p className="muted small">Only the artist's name is sent. Biographies are cached on this PC for two weeks.</p>
        </Panel>
      </div>
      <IntegrationsPanel />
      <Panel title="Mods" className="int-panel"><ModsManager /></Panel>
      <p className="credits">App built by <b>Anant Rastogi</b></p>
    </div>
  );
}

// ================================================================== Theme gallery
export function Themes() {
  const themeId = useStore((s) => s.themeId);
  const custom = useStore((s) => s.customTheme);
  const [cat, setCat] = useState<string>(themeById(themeId).category);
  const pick = (id: string) => {
    setState({ themeId: id });
    applyTheme(themeById(id));
  };
  /** Switch to the Custom theme, creating it from the current theme the first time. */
  const pickCustom = () => {
    if (!custom) setState({ customTheme: customFrom(themeById(themeId)) });
    setState({ themeId: CUSTOM_ID });
    setCat("Custom");
  };
  return (
    <div className="view themes">
      <div className="toolbar">
        <h2 className="view-title">Themes <span className="muted">· {THEMES.length} full-UI transformations</span></h2>
        <button className="btn" onClick={() => pick(THEMES[Math.floor(Math.random() * THEMES.length)].id)}>Surprise me</button>
      </div>
      <AdaptivePanel />
      <div className="cat-tabs">
        {CATEGORIES.map((c) => <button key={c} className={c === cat ? "on" : ""} onClick={() => setCat(c)}>{c}</button>)}
        <button className={`cat-custom ${cat === "Custom" ? "on" : ""}`} onClick={() => setCat("Custom")}>✦ Custom</button>
      </div>
      {cat === "Custom" && (
        <div className="theme-grid">
          <button className={`theme-card custom-card ${themeId === CUSTOM_ID ? "on" : ""}`} onClick={pickCustom}>
            <div className="tc-preview"><div className="custom-swatches">
              {(custom ? [custom.theme.c.accent, custom.theme.c.accent2, custom.theme.c.bg, custom.theme.c.text] : ["#ff6a00", "#5ce1ff", "#1b1c20", "#eceef2"]).map((c, i) => <span key={i} style={{ background: c }} />)}
            </div></div>
            <div className="tc-name">{custom?.name ?? "Your own theme"}</div>
            <div className="tc-meta">{themeId === CUSTOM_ID ? "Active — customise it below" : custom ? "Click to use it" : "Starts as a copy of your current theme"}</div>
            <div className="tc-blurb">Change every element: layout, controls, colours, fonts, shapes, background, navigation, CSS and mods.</div>
          </button>
        </div>
      )}
      {cat === "Custom" && themeId === CUSTOM_ID && <CustomThemeEditor />}
      {cat === "Custom" && themeId !== CUSTOM_ID && custom && <p className="muted small">Select the card to switch to your custom theme and open its settings.</p>}
      <div className="theme-grid">
        {cat !== "Custom" && THEMES.filter((t) => t.category === cat).map((t) => (
          <button key={t.id} className={`theme-card ${t.id === themeId ? "on" : ""}`} onClick={() => pick(t.id)}
            style={{ background: `linear-gradient(135deg, ${t.c.bg}, ${t.c.bg2})`, color: t.c.text, borderRadius: Math.min(t.radius, 18), borderColor: t.c.border, fontFamily: `"${t.fonts.body}", sans-serif` }}>
            <div className="tc-preview">
              <div className={`tc-layout tc-${t.layout}`} style={{ borderColor: t.c.accent }}>
                <span style={{ background: t.c.accent }} /><span style={{ background: t.c.accent2 }} /><span style={{ background: t.c.panel }} />
              </div>
            </div>
            <div className="tc-name" style={{ fontFamily: `"${t.fonts.display}", sans-serif`, color: t.c.accent }}>{t.name}</div>
            <div className="tc-meta">{t.layout.replace("-", " ")} · {t.control} controls · {t.chrome} chrome · {t.surface}</div>
            <div className="tc-blurb">{t.blurb}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ================================================================== Focus HUD (separate transparent always-on-top window)
// The HUD runs in its own lightweight webview: it only listens to backend broadcasts and sends
// commands back to the main window, so it costs almost nothing while a game is running.
export function Hud() {
  const [info, setInfo] = useState<{ title: string; artist: string; ytActive: boolean; service?: string }>({ title: "DriftKord", artist: "", ytActive: false });
  const [st, setSt] = useState<{ pos: number; dur: number; playing: boolean }>({ pos: 0, dur: 0, playing: false });
  const [focus, setFocus] = useState({ game: false, call: false, fullscreenApp: "", callApp: "", duck: 1 });
  useEffect(() => {
    const un: Promise<() => void>[] = [
      listen<{ title: string; artist: string; ytActive: boolean; service?: string }>("hud-info", (e) => setInfo(e.payload)),
      listen<any>("audio-status", (e) => { if (!infoRef.ytActive) setSt({ pos: e.payload.position, dur: e.payload.duration, playing: e.payload.state === "playing" }); }),
      // only the streaming service that is playing: paused ones in the background keep reporting 0:00
      listen<any>("yt-state", (e) => { if (infoRef.ytActive && (e.payload.service ?? "youtube") === infoRef.service) setSt({ pos: e.payload.position, dur: e.payload.duration, playing: !e.payload.paused }); }),
      listen<any>("focus-state", (e) => setFocus(e.payload)),
      // live theme sync from the main window (theme + album-art colours)
      listen<{ themeId: string; override: Record<string, string> | null; opacity?: number; scale?: number; custom?: any }>("hud-theme", (e) => {
        if (e.payload.custom) {
          const c = normalizeCustom(e.payload.custom, themeById("sony-walkman-1989"));
          registerCustomTheme(customAsTheme(c));
          applyCustomExtras(null);
        }
        setState({ themeId: e.payload.themeId });
        applyTheme(themeById(e.payload.themeId));
        setPaletteOverride(e.payload.override as any);
        const root = document.documentElement.style;
        root.setProperty("--hud-opacity", String(e.payload.opacity ?? 0.92));
        root.setProperty("--hud-scale", String(e.payload.scale ?? 1));
      }),
    ];
    emit("hud-command", "hello");
    return () => { un.forEach((p) => p.then((f) => f())); };
  }, []);
  infoRef.ytActive = info.ytActive;
  infoRef.service = info.service ?? "youtube";
  const cmd = (c: string) => emit("hud-command", c);
  return (
    <div className="hud" data-tauri-drag-region>
      <div className="hud-chrome" data-tauri-drag-region>
        <span className="hud-brand" data-tauri-drag-region>DriftKord</span>
        <span className="hud-mode" data-tauri-drag-region>{focus.call ? "CALL" : focus.game ? "GAME" : "HUD"}</span>
      </div>
      <div className="hud-row" data-tauri-drag-region>
        <div className="hud-meta" data-tauri-drag-region>
          <div className="hud-title">{info.title}</div>
          <div className="hud-artist">{info.artist}</div>
        </div>
        <div className="hud-ctl">
          <button onClick={() => cmd("prev")} aria-label="Previous"><Icon name="prev" size={14} /></button>
          <button onClick={() => cmd("toggle")} aria-label="Play/Pause"><Icon name={st.playing ? "pause" : "play"} size={14} /></button>
          <button onClick={() => cmd("next")} aria-label="Next"><Icon name="next" size={14} /></button>
          <button onClick={() => { emit("hud-command", "closed"); api.showHud(false); }} aria-label="Close HUD"><Icon name="close" size={12} /></button>
        </div>
      </div>
      <div className="hud-bar"><div style={{ width: `${st.dur ? (st.pos / st.dur) * 100 : 0}%` }} /></div>
      <div className="hud-foot">{focus.call ? `Call · ${focus.callApp} · ducked ${Math.round(focus.duck * 100)}%` : focus.game ? `Game · ${focus.fullscreenApp} · ducked ${Math.round(focus.duck * 100)}%` : "Focus HUD"} · {fmtTime(st.pos)} / {fmtTime(st.dur)}</div>
    </div>
  );
}
const infoRef = { ytActive: false, service: "youtube" };
// ================================================================== Adaptive colours
const ADAPTIVE_OPTS: { value: AdaptiveMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "accent", label: "Accents from album art" },
  { value: "full", label: "Full adaptive (accents + backgrounds)" },
];

export function AdaptivePanel() {
  const mode = useStore((s) => s.adaptive);
  const swatches = useStore((s) => s.adaptiveSwatches);
  const cover = useStore((s) => s.cover);
  return (
    <Panel title="Adaptive colours" className="adaptive-panel">
      <Segmented value={mode} onChange={(v) => setState({ adaptive: v })} options={ADAPTIVE_OPTS} />
      <div className="adaptive-preview">
        {cover && mode !== "off" && <img src={cover} alt="" />}
        <div className="swatches">
          {mode !== "off" && swatches.map((c, i) => <span key={i} className={`swatch ${i === 0 ? "cur-accent" : ""}`} style={{ background: c }} title={c} />)}
        </div>
        <span className="muted small">
          {mode === "off"
            ? "Every theme uses its own colours."
            : !cover
              ? "Play something with cover art to see it in action."
              : swatches.length
                ? "Colours picked from the current cover. Layout, controls and fonts still come from the theme."
                : "This cover is greyscale (or can't be read), so the theme's own colours are used."}
        </span>
      </div>
      <p className="muted small">Accents are brightened or darkened automatically so text and buttons stay readable on every theme.</p>
    </Panel>
  );
}
