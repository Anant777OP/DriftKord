// Auto-Play: Shuffle All (true no-repeat shuffle bag), endless radio with several selection modes,
// Start Radio from a track, smart mixes, skip learning, favourites, sleep timer, auto-start/resume.
import { api, QueueItem, Track, trackToItem } from "./api";
import { djScore, playIndex, playItems, scheduleNext } from "./player";
import { AutoMode, AutoPlayConfig, getState, setState, toast } from "./store";

export type { AutoMode, AutoPlayConfig, SleepState } from "./store";
export { defaultAutoPlay } from "./store";

export const MODES: { id: AutoMode; name: string; desc: string }[] = [
  { id: "random", name: "Pure Shuffle", desc: "Every song once, in random order, before anything repeats." },
  { id: "smart", name: "Smart Shuffle", desc: "Random, but favours favourites and fresh songs, avoids recent repeats, skipped songs and same-artist runs." },
  { id: "mood", name: "Mood Flow", desc: "Each next song is close in energy, brightness and tempo to the current one." },
  { id: "harmonic", name: "Harmonic DJ", desc: "Picks key-compatible songs at a similar BPM (uses the Auto-DJ crossfade if on)." },
  { id: "discovery", name: "Discovery", desc: "Prefers songs you have never or rarely played." },
];

// ------------------------------------------------------------------ persistent bits
let skips: Record<string, number> = {};
let bag: number[] = []; // remaining ids for Pure Shuffle / Shuffle All
/** True while a "Shuffle all" run is dealing songs from the bag. */
let shuffleSession = false;
export function endShuffleSession() {
  shuffleSession = false;
}
let saveTimer: number | undefined;
function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    api.setSetting("skips", JSON.stringify(skips)).catch(() => {});
    api.setSetting("shuffleBag", JSON.stringify(bag)).catch(() => {});
  }, 1000);
}

export async function loadAutoPlayState() {
  try {
    const s = await api.getSetting("skips");
    if (s) skips = JSON.parse(s);
    const b = await api.getSetting("shuffleBag");
    if (b) bag = JSON.parse(b);
  } catch { /* first run */ }
}

export function recordSkip(id: number) {
  skips[id] = (skips[id] ?? 0) + 1;
  persist();
}
export function recordCompleted(id: number) {
  if (skips[id]) {
    skips[id] = Math.max(0, skips[id] - 1);
    persist();
  }
}

// ------------------------------------------------------------------ filtering + weighting
const isLossless = (t: Track) => /FLAC|ALAC|WAV|AIFF|DSD/i.test(t.codec);
const isHiRes = (t: Track) => t.bitDepth >= 24 || t.sampleRate > 48000 || t.bitDepth === 1;

export function filteredPool(cfg = getState().autoPlay): Track[] {
  const f = cfg.filters;
  return getState().tracks.filter((t) => {
    if (t.verdict === "Unreadable") return false;
    if (f.genres.length && !f.genres.some((g) => t.genre.toLowerCase().includes(g.toLowerCase()))) return false;
    if (f.hiResOnly && !isHiRes(t)) return false;
    if (f.losslessOnly && !isLossless(t)) return false;
    if (f.minRating > 0 && t.rating < f.minRating) return false;
    if (f.decades.length && !(t.year && f.decades.includes(Math.floor(t.year / 10) * 10))) return false;
    return true;
  });
}

function weight(t: Track, cfg: AutoPlayConfig, seed: Track | undefined, now: number): number {
  let w = 1;
  switch (cfg.mode) {
    case "smart":
      if (t.playCount === 0) w *= 1.3;
      break;
    case "discovery":
      w *= 1 / Math.pow(1 + t.playCount, 1.5);
      break;
    case "mood":
      if (seed) {
        const de = (t.energy ?? 0.5) - (seed.energy ?? 0.5);
        const db = (t.brightness ?? 0.5) - (seed.brightness ?? 0.5);
        const dt = t.bpm && seed.bpm ? (t.bpm - seed.bpm) / 40 : 0.3;
        w *= Math.exp(-(de * de * 6 + db * db * 3 + dt * dt * 2) * 4);
      }
      break;
    case "harmonic":
      if (seed) w *= Math.pow(djScore(seed, t), 3);
      break;
  }
  if (cfg.favoritesBoost) w *= 1 + t.rating * 0.35;
  if (cfg.skipLearning) w *= Math.pow(0.55, skips[t.id] ?? 0);
  if (cfg.noRepeatHours > 0 && t.lastPlayed && now - t.lastPlayed < cfg.noRepeatHours * 3600) w *= 0.03;
  return Math.max(w, 1e-6);
}

function weightedPick<T>(items: T[], weights: number[]): number {
  const total = weights.reduce((s, v) => s + v, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return items.length - 1;
}

function shuffled<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/** Pick `n` tracks to follow `seed`, honouring the mode, filters and spacing rules. */
export function pickTracks(n: number, seed?: Track, recentQueue: QueueItem[] = []): Track[] {
  const cfg = getState().autoPlay;
  const pool = filteredPool(cfg);
  if (!pool.length) return [];
  const byId = new Map(pool.map((t) => [t.id, t]));
  const recentIds = new Set(recentQueue.slice(-Math.min(200, Math.floor(pool.length * 0.7))).map((q) => q.trackId));
  const out: Track[] = [];

  if (cfg.mode === "random") {
    for (let k = 0; k < n; k++) {
      bag = bag.filter((id) => byId.has(id));
      if (!bag.length) bag = shuffled(pool.map((t) => t.id));
      // keep artist spacing where possible by looking a few items ahead in the bag
      const lastArtists = [...recentQueue.map((q) => q.artist), ...out.map((t) => t.artist)].slice(-cfg.artistSpacing);
      let idx = bag.findIndex((id, i) => i < 12 && !lastArtists.includes(byId.get(id)!.artist));
      if (idx < 0) idx = 0;
      const [id] = bag.splice(idx, 1);
      out.push(byId.get(id)!);
    }
    persist();
    return out;
  }

  const now = Date.now() / 1000;
  let cur = seed;
  for (let k = 0; k < n; k++) {
    const lastArtists = [...recentQueue.map((q) => q.artist), ...out.map((t) => t.artist)].slice(-cfg.artistSpacing);
    const taken = new Set(out.map((t) => t.id));
    let cands = pool.filter((t) => !taken.has(t.id) && !recentIds.has(t.id) && !lastArtists.includes(t.artist));
    if (!cands.length) cands = pool.filter((t) => !taken.has(t.id) && t.id !== cur?.id);
    if (!cands.length) break;
    const ws = cands.map((t) => weight(t, cfg, cur, now));
    const t = cands[weightedPick(cands, ws)];
    out.push(t);
    if (cfg.mode === "mood" || cfg.mode === "harmonic") cur = t;
  }
  return out;
}

// ------------------------------------------------------------------ queue maintenance
function trackOfItem(it?: QueueItem) {
  return it?.trackId ? getState().tracks.find((t) => t.id === it.trackId) : undefined;
}

/** Keep at least 3 upcoming songs when Endless Auto-Play is on. Returns true if songs were added. */
export function ensureUpcoming(): boolean {
  const s = getState();
  if ((!s.autoPlay.enabled && !shuffleSession) || s.repeat === "one") return false;
  const upcoming = s.queue.length - 1 - s.queueIndex;
  if (upcoming >= 3) return false;
  let picks: Track[];
  if (shuffleSession) {
    // deal the next songs from the shuffle bag; when it runs out, stop unless Endless is on
    const byId = new Map(filteredPool().map((t) => [t.id, t]));
    bag = bag.filter((id) => byId.has(id));
    if (!bag.length) {
      if (!s.autoPlay.enabled) { shuffleSession = false; return false; }
      bag = shuffled([...byId.keys()]);
    }
    picks = bag.splice(0, 25).map((id) => byId.get(id)!);
    persist();
  } else {
    const seed = trackOfItem(s.queue[s.queue.length - 1]) ?? trackOfItem(s.queue[s.queueIndex]);
    picks = pickTracks(10 - Math.max(0, upcoming), seed, s.queue);
  }
  if (!picks.length) return false;
  let q = [...s.queue, ...picks.map(trackToItem)];
  let qi = s.queueIndex;
  // trim long history so the queue never grows without bound
  if (qi > 150) {
    const cut = qi - 100;
    q = q.slice(cut);
    qi -= cut;
  }
  setState({ queue: q, queueIndex: qi });
  return true;
}

// ------------------------------------------------------------------ one-click actions
export function shuffleAll() {
  const pool = filteredPool();
  if (!pool.length) {
    toast(getState().tracks.length ? "No songs match the Auto-Play filters." : "Your library is empty — add a music folder first.");
    return;
  }
  // True shuffle: every song once, random order, dealt into the queue in batches of 25.
  const cfg = getState().autoPlay;
  bag = shuffled(pool.map((t) => t.id));
  const first = bag.splice(0, 25);
  const byId = new Map(pool.map((t) => [t.id, t]));
  setState({ shuffle: false, repeat: "off" });
  playItems(first.map((id) => trackToItem(byId.get(id)!)), 0);
  shuffleSession = true; // after playItems, which ends any previous session
  persist();
  toast(`Shuffling all ${pool.length} songs${cfg.enabled ? " · endless" : ""}`);
}

export function startRadio(seed: Track) {
  setState((s) => ({ autoPlay: { ...s.autoPlay, enabled: true, mode: s.autoPlay.mode === "random" ? "mood" : s.autoPlay.mode }, shuffle: false, repeat: "off" }));
  const picks = pickTracks(10, seed, [trackToItem(seed)]);
  playItems([seed, ...picks].map(trackToItem), 0);
  toast(`Radio started from “${seed.title}”`);
}

export function setAutoPlay(patch: Partial<AutoPlayConfig>) {
  setState((s) => ({ autoPlay: { ...s.autoPlay, ...patch } }));
  if (patch.enabled) {
    if (getState().queueIndex < 0) shuffleAll();
    else ensureUpcoming();
  }
  setTimeout(scheduleNext, 20);
}

export type SmartMix = "favorites" | "mostPlayed" | "recentlyAdded" | "neverPlayed" | "hires" | "energetic" | "chill" | "forgotten";
export const SMART_MIXES: { id: SmartMix; name: string; desc: string }[] = [
  { id: "favorites", name: "Favourites", desc: "Songs you rated 4★ or more" },
  { id: "mostPlayed", name: "Most Played", desc: "Your top 100" },
  { id: "recentlyAdded", name: "Recently Added", desc: "Last 100 added" },
  { id: "neverPlayed", name: "Never Played", desc: "Hidden gems" },
  { id: "forgotten", name: "Forgotten Favourites", desc: "Loved but not heard for a month" },
  { id: "hires", name: "Hi-Res Showcase", desc: "24-bit / high sample rate / DSD" },
  { id: "energetic", name: "Energy Boost", desc: "High-energy tracks" },
  { id: "chill", name: "Chill", desc: "Low-energy, mellow tracks" },
];

export function playSmartMix(id: SmartMix) {
  const all = getState().tracks;
  const now = Date.now() / 1000;
  let list: Track[] = [];
  switch (id) {
    case "favorites": list = shuffled(all.filter((t) => t.rating >= 4)); break;
    case "mostPlayed": list = [...all].filter((t) => t.playCount > 0).sort((a, b) => b.playCount - a.playCount).slice(0, 100); break;
    case "recentlyAdded": list = [...all].sort((a, b) => b.addedAt - a.addedAt).slice(0, 100); break;
    case "neverPlayed": list = shuffled(all.filter((t) => t.playCount === 0)).slice(0, 150); break;
    case "forgotten": list = shuffled(all.filter((t) => (t.rating >= 4 || t.playCount >= 5) && (!t.lastPlayed || now - t.lastPlayed > 30 * 86400))).slice(0, 100); break;
    case "hires": list = shuffled(all.filter(isHiRes)).slice(0, 150); break;
    case "energetic": list = shuffled(all.filter((t) => (t.energy ?? 0) >= 0.62)).slice(0, 120); break;
    case "chill": list = shuffled(all.filter((t) => t.energy != null && t.energy <= 0.4)).slice(0, 120); break;
  }
  if (!list.length) {
    toast(id === "energetic" || id === "chill" ? "No analysed tracks yet — the library analysis is still running." : "No songs match this mix yet.");
    return;
  }
  setState({ shuffle: false });
  playItems(list.map(trackToItem), 0);
  toast(`${SMART_MIXES.find((m) => m.id === id)!.name}: ${list.length} songs`);
}

// ------------------------------------------------------------------ favourites
export async function toggleFavorite(trackId: number) {
  const t = getState().tracks.find((x) => x.id === trackId);
  if (!t) return;
  const rating = t.rating >= 4 ? 0 : 5;
  await api.setRating(trackId, rating);
  setState((s) => ({ tracks: s.tracks.map((x) => (x.id === trackId ? { ...x, rating } : x)) }));
  toast(rating ? "Added to favourites ♥" : "Removed from favourites");
}

// ------------------------------------------------------------------ sleep timer
export function setSleep(minutes: number | "eot" | null) {
  if (minutes === null) {
    setState({ sleep: { endsAt: null, endOfTrack: false } });
    toast("Sleep timer off");
  } else if (minutes === "eot") {
    setState({ sleep: { endsAt: null, endOfTrack: true } });
    toast("Stopping after this song");
  } else {
    setState({ sleep: { endsAt: Date.now() + minutes * 60_000, endOfTrack: false } });
    toast(`Sleep timer: ${minutes} min`);
  }
  setTimeout(scheduleNext, 20);
}

let fading = false;
/** Called once a second: fades out over the last 20 s, then pauses. */
export function sleepTick() {
  const s = getState();
  const end = s.sleep.endsAt;
  if (!end || fading) return;
  const left = end - Date.now();
  if (left > 20_000) return;
  fading = true;
  const startVol = s.dsp.volume;
  const t0 = Date.now();
  const iv = window.setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / Math.max(1000, left));
    const v = startVol * (1 - k);
    if (getState().ytActive) api.ytControl("volume", v).catch(() => {});
    else api.setVolume(v).catch(() => {});
    if (k >= 1) {
      window.clearInterval(iv);
      if (getState().ytActive) api.ytControl("pause").catch(() => {});
      else api.pause(true).catch(() => {});
      setTimeout(() => {
        api.setVolume(startVol).catch(() => {});
        if (getState().ytActive) api.ytControl("volume", startVol).catch(() => {});
      }, 400);
      setState({ sleep: { endsAt: null, endOfTrack: false } });
      fading = false;
      toast("Good night — playback paused by the sleep timer");
    }
  }, 200);
}

// ------------------------------------------------------------------ auto-start / resume
let resumeInfo: { index: number; pos: number } | null = null;
export async function loadResume() {
  try {
    const r = await api.getSetting("resume");
    resumeInfo = r ? JSON.parse(r) : null;
  } catch { resumeInfo = null; }
}

export function saveResume() {
  const s = getState();
  if (s.queueIndex < 0 || s.ytActive || s.status?.state !== "playing") return;
  api.setSetting("resume", JSON.stringify({ index: s.queueIndex, pos: s.status.position })).catch(() => {});
}

export function runAutostart() {
  const s = getState();
  if (s.autoPlay.autostart === "shuffle") {
    if (s.tracks.length) shuffleAll();
  } else if (s.autoPlay.autostart === "resume" && s.queue.length) {
    const idx = resumeInfo && resumeInfo.index < s.queue.length ? resumeInfo.index : Math.max(0, s.queueIndex);
    playIndex(idx, { startAt: resumeInfo?.index === idx ? Math.max(0, resumeInfo.pos - 2) : 0 });
  }
}
