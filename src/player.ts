// Unified queue controller: local files (Rust engine, gapless/crossfade) and YouTube Music items
// (embedded window) in one queue, plus the Harmonic Auto-DJ, SMTC sync, lyrics/cover loading,
// launch-argument / drag-drop handling and the focus HUD switch.
import { emit, listen } from "@tauri-apps/api/event";
import { itemService, serviceById } from "./streaming";
import { initSoundscapes } from "./scapeCtl";
import { cleanSongTitle, refetchLyrics } from "./lyrics";
export { cleanSongTitle };
import { getPaletteOverride } from "./themes";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, on, QueueItem, Track, trackToItem, DspParams } from "./api";
import { castSeek } from "./cast";
import { defaultAutoPlay, getState, live, setState, subscribe, toast, LyricLine } from "./store";
import { isSynced, parseLrc } from "./visualizers";
import { endShuffleSession, ensureUpcoming, loadAutoPlayState, loadResume, recordCompleted, recordSkip, runAutostart, saveResume, sleepTick } from "./autoplay";

// ------------------------------------------------------------------ Harmonic helpers (Camelot wheel)
export function parseCamelot(c?: string | null): { n: number; l: "A" | "B" } | null {
  const m = /^(\d{1,2})([AB])$/.exec(c ?? "");
  return m ? { n: parseInt(m[1], 10), l: m[2] as "A" | "B" } : null;
}

/** 1 = perfect, 0 = clash. */
export function harmonicScore(a?: string | null, b?: string | null): number {
  const x = parseCamelot(a), y = parseCamelot(b);
  if (!x || !y) return 0.4;
  const d = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  if (d === 0 && x.l === y.l) return 1;
  if (d === 0) return 0.85; // relative major/minor
  if (d === 1 && x.l === y.l) return 0.9; // adjacent on the wheel
  if (d === 2 && x.l === y.l) return 0.55; // energy boost
  if (d === 1) return 0.45; // diagonal
  return Math.max(0, 0.25 - d * 0.03);
}

/** Tempo ratio to make `next` match `cur`, handling half/double time. */
export function tempoRatio(cur?: number | null, next?: number | null): number {
  if (!cur || !next) return 1;
  let n = next;
  while (n < cur * 0.7) n *= 2;
  while (n > cur * 1.4) n /= 2;
  const r = cur / n;
  return r >= 0.92 && r <= 1.08 ? r : 1;
}

export function bpmScore(cur?: number | null, next?: number | null): number {
  if (!cur || !next) return 0.4;
  let n = next;
  while (n < cur * 0.7) n *= 2;
  while (n > cur * 1.4) n /= 2;
  return Math.max(0, 1 - Math.abs(cur - n) / (cur * 0.12));
}

export function djScore(cur: Track | undefined, cand: Track): number {
  if (!cur) return 0.5;
  const e = 1 - Math.min(1, Math.abs((cur.energy ?? 0.5) - (cand.energy ?? 0.5)) * 2);
  return harmonicScore(cur.camelot, cand.camelot) * 0.5 + bpmScore(cur.bpm, cand.bpm) * 0.35 + e * 0.15;
}

function trackOf(item?: QueueItem): Track | undefined {
  if (!item || item.kind !== "local") return undefined;
  const s = getState();
  return s.tracks.find((t) => t.id === item.trackId) ?? s.tracks.find((t) => t.path === item.path);
}

// ------------------------------------------------------------------ queue navigation
function nextIndex(from: number): number {
  ensureUpcoming(); // Endless Auto-Play tops the queue up before we look ahead
  const s = getState();
  const n = s.queue.length;
  if (!n) return -1;
  if (s.repeat === "one") return from;
  if (s.shuffle) {
    if (n === 1) return s.repeat === "all" ? 0 : -1;
    let r = from;
    while (r === from) r = Math.floor(Math.random() * n);
    return r;
  }
  if (from + 1 < n) return from + 1;
  return s.repeat === "all" ? 0 : -1;
}

function prevIndex(from: number): number {
  const s = getState();
  if (!s.queue.length) return -1;
  return from - 1 >= 0 ? from - 1 : s.repeat === "all" ? s.queue.length - 1 : 0;
}

/** Auto-DJ: move the most compatible of the next 12 items into the next slot (and extend from the library at the end). */
function autoDjArrange() {
  const s = getState();
  if (!s.autoDj.enabled || s.shuffle || s.repeat === "one") return;
  const cur = trackOf(s.queue[s.queueIndex]);
  if (!cur) return;
  const q = [...s.queue];
  const start = s.queueIndex + 1;
  if (start >= q.length) {
    // extend the set from the library with the best harmonic match not played recently
    const recent = new Set(q.slice(Math.max(0, q.length - 50)).map((i) => i.trackId));
    const cands = s.tracks.filter((t) => !recent.has(t.id) && t.bpm);
    if (!cands.length) return;
    const best = cands.map((t) => ({ t, sc: djScore(cur, t) + Math.random() * 0.05 })).sort((a, b) => b.sc - a.sc)[0];
    q.push(trackToItem(best.t));
    setState({ queue: q });
    return;
  }
  if (!s.autoDj.harmonic) return;
  let best = start, bestScore = -1;
  for (let i = start; i < Math.min(q.length, start + 12); i++) {
    const t = trackOf(q[i]);
    const sc = t ? djScore(cur, t) : 0.3;
    if (sc > bestScore + 0.08) { bestScore = sc; best = i; }
  }
  if (best !== start) {
    const [it] = q.splice(best, 1);
    q.splice(start, 0, it);
    setState({ queue: q });
  }
}

let scheduledNext = -1;

/** Tell the engine what follows (gapless or crossfade with beat-matching). */
export async function scheduleNext() {
  const s = getState();
  const cur = s.queue[s.queueIndex];
  if (!cur || cur.kind !== "local") {
    scheduledNext = -1;
    return;
  }
  if (s.sleep.endOfTrack) {
    scheduledNext = -1;
    await api.setNext(null).catch(() => {});
    return;
  }
  autoDjArrange();
  const st = getState();
  const ni = nextIndex(st.queueIndex);
  const next = st.queue[ni];
  if (ni < 0 || !next || next.kind !== "local" || !next.path) {
    scheduledNext = -1;
    await api.setNext(null).catch(() => {});
    return;
  }
  const a = trackOf(cur), b = trackOf(next);
  let xfade = 0, tempo = 1, startAt = 0;
  if (st.autoDj.enabled && st.autoDj.crossfade > 0) {
    xfade = st.autoDj.crossfade;
    if (a?.bpm) {
      // snap the mix length to whole bars
      const bar = (4 * 60) / a.bpm;
      xfade = Math.max(bar, Math.round(xfade / bar) * bar);
    }
    if (st.autoDj.beatmatch) {
      tempo = tempoRatio(a?.bpm, b?.bpm);
      startAt = b?.firstBeat && b.firstBeat < 20 ? b.firstBeat : 0;
    }
  }
  scheduledNext = ni;
  try {
    await api.setNext(next.path, next.trackId ?? null, xfade, tempo, startAt);
  } catch (e) {
    toast(`Cannot pre-load next track: ${e}`);
  }
}

// ------------------------------------------------------------------ playback entry points
let rampTimer: number | undefined;
function rampEngineVolume(from: number, to: number, ms: number, done?: () => void) {
  window.clearInterval(rampTimer);
  const t0 = performance.now();
  rampTimer = window.setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    api.setVolume(from + (to - from) * k).catch(() => {});
    if (k >= 1) {
      window.clearInterval(rampTimer);
      done?.();
    }
  }, 60);
}

/** Streaming service of the current song (only meaningful while a streaming source is active). */
const activeSvc = () => {
  const s = getState();
  return itemService(s.queue[s.queueIndex]);
};
/** Send a control command to the streaming service that is playing. */
const svcControl = (cmd: string, arg?: number) => api.ytControl(cmd, arg, activeSvc());

function ytUrl(videoId: string) {
  return `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

export async function playIndex(i: number, opts: { fadeInMs?: number; startAt?: number } = {}) {
  const s = getState();
  const item = s.queue[i];
  if (!item) return;
  setState({ queueIndex: i, lyrics: null });
  if (item.kind === "local" && item.path) {
    if (s.ytActive) {
      api.ytControl(opts.fadeInMs ? "fadeOut" : "pause", opts.fadeInMs, itemService(s.queue[s.queueIndex])).catch(() => {});
      setState({ ytActive: false });
    }
    try {
      const userVol = s.dsp.volume;
      if (opts.fadeInMs) await api.setVolume(0);
      await api.playFile(item.path, item.trackId ?? null, opts.startAt);
      if (opts.fadeInMs) rampEngineVolume(0, userVol, opts.fadeInMs);
    } catch (e) {
      toast(`Cannot play ${item.title}: ${e}`);
    }
  } else if (item.kind === "youtube" && item.videoId && itemService(item) !== "youtube") {
    // Spotify / Apple Music / TIDAL / Amazon Music: resume that service's own player
    const svc = itemService(item);
    const prevSvc = s.ytActive ? itemService(s.queue[s.queueIndex]) : null;
    if (prevSvc && prevSvc !== svc) api.ytControl("pause", undefined, prevSvc).catch(() => {});
    if (!opts.fadeInMs) await api.stop().catch(() => {});
    setState({ ytActive: true, cover: item.artUrl ?? null });
    try {
      const loaded = await api.streamLoaded();
      if (!loaded.includes(svc)) {
        await api.ytOpen(undefined, svc);
        toast(`Opening ${serviceById(svc).name} — pick the song there to continue`);
      } else if (opts.fadeInMs) {
        await api.ytControl("startSilent", undefined, svc);
        await api.ytControl("play", undefined, svc);
        setTimeout(() => api.ytControl("fadeIn", opts.fadeInMs, svc).catch(() => {}), 300);
      } else await api.ytControl("play", undefined, svc);
    } catch (e) {
      toast(`${serviceById(svc).name}: ${e}`);
    }
    onItemStarted(item);
  } else if (item.kind === "youtube" && item.videoId) {
    if (s.ytActive && itemService(s.queue[s.queueIndex]) !== "youtube") api.ytControl("pause", undefined, itemService(s.queue[s.queueIndex])).catch(() => {});
    if (!opts.fadeInMs) await api.stop().catch(() => {});
    setState({ ytActive: true, cover: item.artUrl ?? null });
    try {
      await api.ytOpen(ytUrl(item.videoId));
      if (opts.fadeInMs) {
        setTimeout(() => api.ytControl("startSilent", undefined, "youtube").catch(() => {}), 300);
        setTimeout(() => api.ytControl("fadeIn", opts.fadeInMs, "youtube").catch(() => {}), 1500);
      }
    } catch (e) {
      toast(`YouTube Music: ${e}`);
    }
    onItemStarted(item);
  }
}

export function playItems(items: QueueItem[], start = 0) {
  endShuffleSession();
  setState({ queue: items });
  playIndex(start);
}

export function enqueue(items: QueueItem[], playNext = false) {
  const s = getState();
  const q = [...s.queue];
  if (playNext && s.queueIndex >= 0) q.splice(s.queueIndex + 1, 0, ...items);
  else q.push(...items);
  setState({ queue: q });
  if (s.queueIndex < 0 && q.length) playIndex(0);
  else scheduleNext();
  toast(`${items.length} item${items.length === 1 ? "" : "s"} added to queue`);
}

export async function togglePlay() {
  const s = getState();
  if (s.ytActive) return svcControl("toggle").catch(() => {});
  if (!s.status || s.status.state === "stopped") {
    if (s.queueIndex >= 0) return playIndex(s.queueIndex);
    if (s.queue.length) return playIndex(0);
    return;
  }
  await api.pause(s.status.state === "playing");
}

export function next() {
  const s = getState();
  // continue with the service's own up-next list (Spotify & co. always use their own queue)
  if (s.ytActive && (nextIndex(s.queueIndex) < 0 || activeSvc() !== "youtube")) {
    svcControl("next").catch(() => {});
    return;
  }
  // skip learning: leaving a local song within its first 30 s counts as a skip
  const cur = s.queue[s.queueIndex];
  if (!s.ytActive && cur?.trackId && s.status && s.status.duration > 60 && s.status.position < 30) recordSkip(cur.trackId);
  const ni = nextIndex(s.queueIndex);
  if (ni >= 0) playIndex(ni);
  else api.stop();
}

export function prev() {
  const s = getState();
  if (!s.ytActive && (s.status?.position ?? 0) > 4) return api.seek(0);
  if (s.ytActive && (s.queueIndex <= 0 || (s.yt?.position ?? 0) > 4 || activeSvc() !== "youtube")) return svcControl("prev").catch(() => {});
  const pi = prevIndex(s.queueIndex);
  if (pi >= 0) playIndex(pi);
}

export async function seek(secs: number) {
  if (getState().ytActive) {
    // move DriftKord's bar right away; the service's next report confirms the new position
    live.position = secs;
    live.positionAt = performance.now();
    return svcControl("seek", secs);
  }
  live.position = secs;
  live.positionAt = performance.now();
  castSeek(secs);
  return api.seek(secs);
}

export async function setVolume(v: number) {
  setState((s) => ({ dsp: { ...s.dsp, volume: v } }));
  // when YouTube is routed through the engine, the engine's volume applies and YouTube stays at 100%
  if (getState().ytActive && !(getState().ytRouteEngine && activeSvc() === "youtube")) svcControl("volume", v).catch(() => {});
  return api.setVolume(v);
}

let dspTimer: number | undefined;
export function updateDsp(patch: Partial<DspParams>) {
  setState((s) => ({ dsp: { ...s.dsp, ...patch } }));
  window.clearTimeout(dspTimer);
  dspTimer = window.setTimeout(() => api.setDsp(getState().dsp).catch((e) => toast(String(e))), 30);
}

// ------------------------------------------------------------------ per-track side effects
// ---- per-song lyric timing offset (saved between sessions)
let lyricOffsets: Record<string, number> = {};
let offsetsLoaded = false;
const lyricKey = (it?: QueueItem) => (!it ? "" : it.kind === "youtube" ? (it.videoId?.startsWith("svc:") ? it.videoId : `yt:${it.videoId ?? it.title}`) : it.path ?? "");

async function loadLyricOffsets() {
  if (offsetsLoaded) return;
  offsetsLoaded = true;
  try {
    const raw = await api.getSetting("lyricOffsets");
    if (raw) lyricOffsets = JSON.parse(raw);
  } catch { /* none yet */ }
}

/** Nudge lyrics for the current song (+ = show lyrics earlier). */
export function setLyricOffset(v: number) {
  const s = getState();
  const key = lyricKey(s.queue[s.queueIndex]);
  const val = Math.round(Math.max(-30, Math.min(30, v)) * 10) / 10;
  setState({ lyricOffset: val });
  if (!key) return;
  if (val === 0) delete lyricOffsets[key];
  else lyricOffsets[key] = val;
  api.setSetting("lyricOffsets", JSON.stringify(lyricOffsets)).catch(() => {});
}

async function onItemStarted(item: QueueItem) {
  await loadLyricOffsets();
  setState({ lyricOffset: lyricOffsets[lyricKey(item)] ?? 0 });
  if (item.kind === "local" && item.path) {
    if (item.trackId) api.recordPlay(item.trackId).catch(() => {});
    api.getCover(item.path).then((c) => {
      setState({ cover: c });
      syncSmtc();
    });
    // lyrics are found by the lyrics engine (lyrics.ts), which watches the current song
  }
  syncSmtc();
}


/** Show or hide the Focus HUD overlay. */
export function toggleHud(show?: boolean) {
  const next = show ?? !getState().hudOpen;
  setState({ hudOpen: next });
  api.showHud(next).catch(() => {});
}

/** User asked for synced lyrics: turn on auto-lookup and fetch for the current song right away. */
export async function getSyncedLyricsNow(): Promise<boolean> {
  await api.setSetting("onlineLyrics", "true").catch(() => {});
  refetchLyrics();
  return true;
}


/** Look up time-synced lyrics on LRCLIB (opt-in; sends title/artist only). */
export async function fetchLrclib(title: string, artist: string, album: string, duration: number): Promise<LyricLine[] | null> {
  // YouTube gives video titles and sometimes a channel/playlist name instead of the artist
  // ("Top Music Videos"); LRCLIB wants the plain song title and the real artist.
  artist = artist.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").replace(/\s+Official$/i, "").trim();
  title = cleanSongTitle(title, artist);
  const search = async (params: Record<string, string>): Promise<any[]> => {
    try {
      const r = await fetch(`https://lrclib.net/api/search?${new URLSearchParams(params)}`);
      if (!r.ok) return [];
      const a = await r.json();
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  };
  const gap = (x: any) => (duration > 0 && x.duration ? Math.abs(x.duration - duration) : 999);
  /** best synced result; `strict` requires the recording length to match (used when the artist is unknown) */
  const pickSynced = (arr: any[], strict: boolean) => {
    const synced = arr.filter((x) => x.syncedLyrics).sort((a, b) => gap(a) - gap(b));
    const best = synced[0];
    if (!best) return null;
    if (duration > 0) return gap(best) <= (strict ? 5 : 8) ? best : null;
    return strict ? null : best;
  };
  try {
    // 1) exact match (title + artist + album + duration ±2 s)
    const q = new URLSearchParams({ track_name: title, artist_name: artist });
    if (album) q.set("album_name", album);
    if (duration) q.set("duration", String(Math.round(duration)));
    try {
      const r = await fetch(`https://lrclib.net/api/get?${q}`);
      if (r.ok) {
        const j = await r.json();
        if (j.syncedLyrics) return parseLrc(j.syncedLyrics);
      }
    } catch { /* fall through to search */ }
    // 2) title + artist search, closest length wins
    const byArtist = artist ? await search({ track_name: title, artist_name: artist }) : [];
    let hit = pickSynced(byArtist, false);
    if (hit) return parseLrc(hit.syncedLyrics);
    // 3) the artist may be wrong (channel name): title only, but the length must match this recording
    const byTitle = await search({ track_name: title });
    hit = pickSynced(byTitle, true);
    if (hit) return parseLrc(hit.syncedLyrics);
    // 4) free-text search as a last resort
    const free = await search({ q: `${title} ${artist}`.trim() });
    hit = pickSynced(free, true);
    if (hit) return parseLrc(hit.syncedLyrics);
    // nothing synced: plain lyrics from the artist search (shown in the panel, not on the visualizer)
    const plain = [...byArtist, ...byTitle].find((x) => x.plainLyrics);
    return plain ? parseLrc(plain.plainLyrics) : null;
  } catch {
    return null;
  }
}
let smtcTimer: number | undefined;
export function syncSmtc() {
  window.clearTimeout(smtcTimer);
  smtcTimer = window.setTimeout(() => {
    const s = getState();
    const item = s.queue[s.queueIndex];
    if (!item) return;
    const playing = s.ytActive ? !(s.yt?.paused ?? true) : s.status?.state === "playing";
    emit("hud-info", { title: s.ytActive ? s.yt?.title || item.title : item.title, artist: s.ytActive ? s.yt?.artist || item.artist : item.artist, ytActive: s.ytActive, service: itemService(item) }).catch(() => {});
    api.smtcUpdate({
      title: s.ytActive ? s.yt?.title || item.title : item.title,
      artist: s.ytActive ? s.yt?.artist || item.artist : item.artist,
      album: item.album ?? "",
      cover: s.cover?.startsWith("data:") ? s.cover : null,
      duration: s.ytActive ? s.yt?.duration ?? 0 : s.status?.duration ?? 0,
      position: s.ytActive ? s.yt?.position ?? 0 : s.status?.position ?? 0,
      playing,
    }).catch(() => {});
  }, 150);
}

// YouTube switches songs inside its own page (up-next, clicks): metadata arrives in pieces
// (URL first, then title/artist, then duration), so wait for it to settle before fetching lyrics.
let ytSettleTimer: number | undefined;
function scheduleYtSongStarted() {
  window.clearTimeout(ytSettleTimer);
  ytSettleTimer = window.setTimeout(() => {
    const s = getState();
    const item = s.queue[s.queueIndex];
    if (!s.ytActive || item?.kind !== "youtube") return;
    const fresh = s.yt && s.yt.videoId === item.videoId && s.yt.duration ? { ...item, duration: s.yt.duration } : item;
    if (fresh !== item) {
      const q = [...s.queue];
      q[s.queueIndex] = fresh;
      setState({ queue: q });
    }
    onItemStarted(fresh);
  }, 1500);
}
// ------------------------------------------------------------------ cross-source Auto-DJ (local ⇄ YouTube)
let crossSourceBusy = false;
function maybeCrossSourceMix(remaining: number) {
  const s = getState();
  // routed YouTube shares the engine with local files: switch at the track boundary instead of overlapping
  if (!s.autoDj.enabled || crossSourceBusy || s.ytRouteEngine) return;
  const ni = nextIndex(s.queueIndex);
  const cur = s.queue[s.queueIndex], next = s.queue[ni];
  if (!cur || !next || cur.kind === next.kind) return;
  // Spotify & co. continue with their own up-next list
  if (itemService(cur) !== "youtube" || itemService(next) !== "youtube") return;
  const xf = Math.max(2, s.autoDj.crossfade);
  if (remaining > xf || remaining <= 0.2) return;
  crossSourceBusy = true;
  const ms = remaining * 1000;
  if (cur.kind === "local") {
    const userVol = s.dsp.volume;
    rampEngineVolume(userVol, 0, ms, () => {
      api.stop().catch(() => {});
      api.setVolume(userVol).catch(() => {});
    });
  }
  playIndex(ni, { fadeInMs: ms }).finally(() => setTimeout(() => (crossSourceBusy = false), ms + 1500));
}

// ------------------------------------------------------------------ launch args / drag & drop
export async function handlePaths(paths: string[], mode: "play" | "enqueue" = "play") {
  const files = paths.filter(Boolean);
  if (!files.length) return;
  try {
    const tracks = await api.importPaths(files);
    if (!tracks.length) return;
    const items = tracks.map(trackToItem);
    if (mode === "enqueue") enqueue(items);
    else {
      const s = getState();
      const q = [...s.queue];
      const at = Math.max(0, s.queueIndex + 1);
      q.splice(at, 0, ...items);
      setState({ queue: q });
      playIndex(at);
    }
  } catch (e) {
    toast(String(e));
  }
}

export async function handleArgs(args: string[]) {
  let mode: "play" | "enqueue" = "play";
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--enqueue") mode = "enqueue";
    else if (a === "--add-folder" && args[i + 1]) {
      await api.libraryAddFolder(args[++i]).catch((e) => toast(String(e)));
      toast("Folder added — scanning…");
    } else if (!a.startsWith("--")) paths.push(a);
  }
  if (paths.length) handlePaths(paths, mode);
}

// ------------------------------------------------------------------ init: wire all events
let started = false;
export async function initPlayer() {
  if (started) return;
  started = true;

  const [tracks, dsp] = await Promise.all([api.libraryTracks().catch(() => []), api.getDsp().catch(() => null)]);
  setState({ tracks, ...(dsp ? { dsp } : {}) });
  try {
    const saved = await api.getSetting("queue");
    if (saved) {
      const { queue, index } = JSON.parse(saved);
      setState({ queue: queue ?? [], queueIndex: Math.min(index ?? -1, (queue ?? []).length - 1) });
    }
    const prefs = await api.getSetting("prefs");
    if (prefs) {
      const p = JSON.parse(prefs);
      const d = defaultAutoPlay();
      if (p.autoPlay) p.autoPlay = { ...d, ...p.autoPlay, filters: { ...d.filters, ...(p.autoPlay.filters ?? {}) } };
      setState(p);
    }
  } catch { /* first run */ }
  await Promise.all([loadAutoPlayState(), loadResume()]);
  initSoundscapes();
  api.getSetting("customBg").then((b) => { if (b) setState({ customBg: b }); }).catch(() => {});
  setInterval(() => { sleepTick(); }, 1000);
  setInterval(saveResume, 5000);

  on.frame((f) => {
    live.frame = f;
    if (f.beat) {
      live.beats++;
      live.lastBeatAt = performance.now();
    }
  });

  let lastState = "";
  on.status((st) => {
    const s = getState();
    if (!s.ytActive) {
      live.position = st.position;
      live.positionAt = performance.now();
      live.playing = st.state === "playing";
    }
    setState({ status: st });
    if (st.state !== lastState) {
      lastState = st.state;
      syncSmtc();
    }
    if (st.state === "playing" && st.duration > 0) maybeCrossSourceMix(st.duration - st.position);
  });

  on.ltas((l) => setState({ ltas: l }));

  // visualizers follow YouTube audio via process loopback while the YouTube source is active
  // YouTube audio: routed through the engine (full DSP) or, if routing is off, only observed via
  // process loopback for the visualizers.
  let lastYt = false, lastRoute = false;
  subscribe(() => {
    const s = getState();
    // Spotify / Apple Music / TIDAL / Amazon Music are DRM-protected: never routed, loopback only
    const route = s.ytActive && s.ytRouteEngine && itemService(s.queue[s.queueIndex]) === "youtube";
    if (s.ytActive === lastYt && route === lastRoute) return;
    lastYt = s.ytActive;
    lastRoute = route;
    api.ytRoute(route).catch(() => {});
    api.setLoopback(s.ytActive && !route).catch(() => {});
  });

  on.engine((ev) => {
    if (ev.type === "trackChanged") {
      const s = getState();
      let idx = s.queue.findIndex((q, i) => i === scheduledNext && q.path === ev.path);
      if (idx < 0) idx = s.queue[s.queueIndex]?.path === ev.path ? s.queueIndex : s.queue.findIndex((q) => q.path === ev.path);
      if (idx >= 0) {
        const prev = s.queue[s.queueIndex];
        if ((ev.gapless || ev.crossfade) && prev?.trackId && prev !== s.queue[idx]) recordCompleted(prev.trackId);
        setState({ queueIndex: idx, lyrics: null, lastTransition: { gapless: ev.gapless, crossfade: ev.crossfade, at: Date.now() } });
        onItemStarted(s.queue[idx]);
      }
      scheduledNext = -1;
      setTimeout(scheduleNext, 50);
    } else if (ev.type === "ended") {
      const s = getState();
      const cur = s.queue[s.queueIndex];
      if (cur?.trackId) recordCompleted(cur.trackId);
      if (s.sleep.endOfTrack) {
        setState({ sleep: { endsAt: null, endOfTrack: false } });
        toast("Stopped after the song (sleep timer)");
        return;
      }
      if (!crossSourceBusy) next();
    } else if (ev.type === "error") {
      toast(ev.message);
    }
  });

  on.yt((y) => {
    const svc = y.service ?? "youtube";
    setState((st) => ({ streams: { ...st.streams, [svc]: y } }));
    const s = getState();
    const curSvc = s.ytActive ? itemService(s.queue[s.queueIndex]) : null;
    // You started something inside a streaming service itself: make it DriftKord's current song.
    if ((!s.ytActive || svc !== curSvc) && y.kind === "play" && y.videoId && !crossSourceBusy) {
      if (s.status?.state === "playing") api.pause(true).catch(() => {});
      const item: QueueItem = { kind: "youtube", videoId: y.videoId, title: y.title, artist: y.artist, album: y.album, duration: y.duration, artUrl: y.artUrl };
      const q = [...s.queue];
      const at = Math.max(0, s.queueIndex + 1);
      q.splice(at, 0, item);
      setState({ queue: q, queueIndex: at, ytActive: true, yt: y, cover: y.artUrl ?? null, lyrics: null });
      live.position = y.position;
      live.positionAt = performance.now();
      live.playing = !y.paused;
      onItemStarted(item);
      return;
    }
    // reports from a service that isn't the current source only update its own tab
    if (!s.ytActive) {
      if (svc === "youtube") setState({ yt: y });
      return;
    }
    if (svc !== curSvc) return;
    setState({ yt: y });
    // self-heal: the page may have (re)loaded after routing was decided
    if (svc === "youtube" && y.kind === "state" && y.routed !== undefined && y.routed !== s.ytRouteEngine) api.ytControl("route", s.ytRouteEngine ? 1 : 0, "youtube").catch(() => {});
    // routed: keep the engine's stream in step with YouTube's own play/pause (frees the device when paused)
    if (svc === "youtube" && s.ytRouteEngine && (y.kind === "pause" || y.kind === "play")) api.pause(y.kind === "pause").catch(() => {});
    live.position = y.position;
    live.positionAt = performance.now();
    live.playing = !y.paused;
    if (y.artUrl && s.cover !== y.artUrl) setState({ cover: y.artUrl });
    // keep the queue item metadata in sync with what's actually playing
    const cur = s.queue[s.queueIndex];
    if (cur?.kind === "youtube" && y.videoId && (cur.videoId !== y.videoId || cur.title !== y.title) && y.title) {
      const songChanged = cur.videoId !== y.videoId || cur.title !== y.title;
      const q = [...s.queue];
      q[s.queueIndex] = { ...cur, videoId: y.videoId, title: y.title, artist: y.artist, album: y.album, duration: y.duration, artUrl: y.artUrl };
      // YouTube moved to another song on its own: drop the old lyrics immediately…
      setState(songChanged ? { queue: q, lyrics: null, lyricOffset: 0 } : { queue: q });
      // …and look up the new song's lyrics/cover once YouTube has settled its title and length.
      if (songChanged) scheduleYtSongStarted();
    }
    if (y.kind === "ended" && s.sleep.endOfTrack) {
      setState({ sleep: { endsAt: null, endOfTrack: false } });
      toast("Stopped after the song (sleep timer)");
    } else if (y.kind === "ended" && !crossSourceBusy && svc === "youtube") {
      const nx = nextIndex(s.queueIndex);
      if (nx >= 0 && s.queue[nx].kind === "youtube" && s.queue[s.queueIndex]?.kind === "youtube") playIndex(nx);
      else if (nx >= 0) playIndex(nx);
    }
    if (!y.paused && y.duration > 0) maybeCrossSourceMix(y.duration - y.position);
    syncSmtc();
  });

  on.adblock((a) => setState({ adblock: a }));
  on.scan((p) => setState({ scan: p.finished ? null : p }));
  on.analysis((p) => setState({ analysis: p.finished ? null : p }));
  let libTimer: number | undefined;
  on.libraryChanged(() => {
    window.clearTimeout(libTimer);
    libTimer = window.setTimeout(async () => setState({ tracks: await api.libraryTracks().catch(() => getState().tracks) }), 250);
  });

  on.mediaKey((k) => {
    if (k === "play" || k === "pause" || k === "toggle") togglePlay();
    else if (k === "next") next();
    else if (k === "prev") prev();
    else if (k === "stop") api.stop();
    else if (k.startsWith("seek:")) seek(parseFloat(k.slice(5)));
  });

  on.focus(async (f) => {
    setState({ focus: f });
    const cfg = await api.getFocusConfig().catch(() => null);
    if (cfg?.autoHud) toggleHud(f.game || f.call);
  });

  listen<string>("hud-command", (e) => {
    const c = e.payload;
    if (c === "toggle") togglePlay();
    else if (c === "next") next();
    else if (c === "prev") prev();
    else if (c === "hello") {
      syncSmtc();
      sendHudTheme(true);
      setState({ hudOpen: true });
    } else if (c === "closed") setState({ hudOpen: false });
  });

  // keep the HUD window dressed in the current theme (and album-art colours)
  let lastHudKey = "";
  const sendHudTheme = (force = false) => {
    const s = getState();
    const ov = getPaletteOverride();
    const key = s.themeId + JSON.stringify(ov) + (s.themeId === "custom" ? JSON.stringify(s.customTheme) : "") + s.hudOpacity + "|" + s.hudScale;
    if (!force && key === lastHudKey) return;
    const scaleChanged = !lastHudKey.endsWith(`|${s.hudScale}`);
    lastHudKey = key;
    emit("hud-theme", { themeId: s.themeId, override: ov, opacity: s.hudOpacity, scale: s.hudScale, custom: s.themeId === "custom" ? s.customTheme : null }).catch(() => {});
    if (force || scaleChanged) api.setHudScale(s.hudScale).catch(() => {});
  };
  subscribe(() => sendHudTheme());

  // The user closed the YouTube window themselves: stop treating YouTube as the active source.
  listen("yt-closed", () => {
    if (getState().ytActive) {
      setState({ ytActive: false, yt: null });
      live.playing = false;
      toast("YouTube Music window closed");
    }
  });

  // Minimised / hidden: ask the engine for only a few visual frames per second.
  const syncFps = () => {
    const f = getState().focus;
    api.setFrameRate(document.hidden ? 4 : f.game || f.call ? 10 : 60).catch(() => {});
  };
  document.addEventListener("visibilitychange", syncFps);

  on.openArgs((args) => handleArgs(args));
  api.getLaunchArgs().then((args) => {
    // files passed on the command line win over auto-start
    if (args.some((a) => !a.startsWith("--"))) handleArgs(args);
    else { handleArgs(args); runAutostart(); }
  }).catch(() => runAutostart());

  getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") handlePaths(e.payload.paths, "enqueue");
  });

  api.adblockStats().then((a) => setState({ adblock: a })).catch(() => {});
  api.getFocusState().then((f) => setState({ focus: f })).catch(() => {});

  // persist queue + prefs
  let saveTimer: number | undefined;
  let lastQ: unknown = null, lastPrefs = "";
  setInterval(() => {
    const s = getState();
    if (s.queue !== lastQ) {
      lastQ = s.queue;
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => api.setSetting("queue", JSON.stringify({ queue: s.queue, index: s.queueIndex })), 500);
    }
    const prefs = JSON.stringify({ themeId: s.themeId, visualizer: s.visualizer, autoDj: s.autoDj, shuffle: s.shuffle, repeat: s.repeat, autoPlay: s.autoPlay, adaptive: s.adaptive, hudOpacity: s.hudOpacity, hudScale: s.hudScale, streamService: s.streamService, videoMode: s.videoMode, customTheme: s.customTheme, soundscape: { ...s.soundscape, playing: false, timerEndsAt: null }, ytIntegrated: s.ytIntegrated, ytRouteEngine: s.ytRouteEngine });
    if (prefs !== lastPrefs) {
      lastPrefs = prefs;
      api.setSetting("prefs", prefs).catch(() => {});
    }
  }, 1000);
}
