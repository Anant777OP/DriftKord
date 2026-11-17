// Lyrics engine: one place that finds, caches and times lyrics for whatever is playing — local files
// and every streaming service alike.
//
//  * automatic: watches the current song and looks lyrics up the moment it changes (no buttons)
//  * thorough: embedded tags / .lrc first, then LRCLIB with several search strategies (exact match,
//    cleaned-up titles, first artist only, free text, title + length) and a scoring step that prefers
//    time-synced lyrics recorded at the same length as what's playing
//  * resilient: results are cached, network failures retry on their own, stale answers for a previous
//    song are ignored, and the next song in the queue is looked up in advance
//  * in sync: the lyric clock compensates for audio buffered between the player and your speakers
import { api, QueueItem } from "./api";
import { getState, live, LyricLine, setState, subscribe } from "./store";
import { itemService } from "./streaming";
import { isSynced, parseLrc } from "./visualizers";

export type LyricsStatus = "idle" | "searching" | "synced" | "plain" | "none" | "offline" | "instrumental";
export interface LyricsInfo {
  status: LyricsStatus;
  /** where the lyrics came from ("LRCLIB", "Embedded", "Local .lrc", "Chosen manually") */
  source: string;
  /** seconds between the lyrics' recording length and the song's (null = unknown) */
  gap: number | null;
}
export interface LyricsCandidate {
  id: number; title: string; artist: string; album: string; duration: number;
  synced: boolean; instrumental: boolean; lrc: string; score: number;
}

// ------------------------------------------------------------------ text helpers
/** Turn YouTube-style titles into plain song titles for lyric lookups. */
export function cleanSongTitle(title: string, artist: string): string {
  let t = title;
  const a = artist.trim();
  if (a) {
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`^\\s*${esc}\\s*[-–—:|]\\s*`, "i"), "");
  }
  const junk = /\s*[([](?:[^)\]]*?(?:official|video|audio|lyric|lyrics|visualizer|visualiser|hd|hq|4k|remaster(?:ed)?|live|mv|m\/v|explicit|clean|full song|with lyrics|hindi|tamil|telugu|punjabi|bengali|marathi|kannada|malayalam|mix|edit|version|mono|stereo|deluxe|bonus|from)[^)\]]*)[)\]]/gi;
  t = t.replace(junk, "");
  t = t.replace(/\s*[-–|]\s*(?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?)\s*$/i, "");
  t = t.replace(/\s+(?:HD|HQ|4K)\s*$/i, "");
  t = t.replace(/\s*\|.*$/, "");
  t = t.replace(/\s*[-–]\s*(?:full\s+(?:song|video|audio)|lyrical(?:\s+video)?|title\s+track|video\s+song)\b.*$/i, "");
  return t.replace(/\s{2,}/g, " ").trim() || title;
}
const cleanArtist = (a: string) => a.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").replace(/\s+Official$/i, "").trim();
const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function sim(a: string, b: string): number {
  const A = new Set(norm(a).split(" ").filter(Boolean)), B = new Set(norm(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach((w) => { if (B.has(w)) hit++; });
  return hit / Math.min(A.size, B.size) * (0.7 + 0.3 * (hit / Math.max(A.size, B.size)));
}
function titleVariants(t: string): string[] {
  const v = [t];
  v.push(t.replace(/\s*[([]?\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]?/gi, ""));
  v.push(t.replace(/\s*[([][^)\]]*[)\]]/g, ""));
  v.push(t.replace(/\s+-\s+.*$/, ""));
  v.push(t.replace(/\s*\(from\s[^)]*\)/gi, ""));
  return [...new Set(v.map((x) => x.replace(/\s{2,}/g, " ").trim()).filter((x) => x.length > 1))];
}
const firstArtist = (a: string) => a.split(/\s*(?:,|&|\/|;|\bfeat\.?|\bft\.?|\bx\b|\band\b)\s*/i)[0].trim() || a;

// ------------------------------------------------------------------ what is playing
export interface Ident { key: string; title: string; artist: string; album: string; duration: number; path: string | null; source: string }
function identOf(item: QueueItem | undefined, live_: boolean): Ident | null {
  if (!item) return null;
  const s = getState();
  const source = item.kind === "local" ? "local" : itemService(item);
  let title = live_ && s.ytActive ? s.yt?.title || item.title : item.title;
  let artist = live_ && s.ytActive ? s.yt?.artist || item.artist : item.artist;
  const album = (live_ && s.ytActive ? s.yt?.album || item.album : item.album) ?? "";
  if (source !== "local") { artist = cleanArtist(artist); title = cleanSongTitle(title, artist); }
  const duration = Math.round((live_ ? (s.ytActive ? s.yt?.duration : s.status?.duration) : 0) || item.duration || 0);
  if (!title) return null;
  const key = item.kind === "local" && item.path ? `file:${item.path}` : `${source}|${norm(artist)}|${norm(title)}`;
  return { key, title, artist, album, duration, path: item.kind === "local" ? item.path ?? null : null, source };
}
const currentIdent = () => { const s = getState(); return identOf(s.queue[s.queueIndex], true); };
/** The current song, cleaned up for online lookups (shared with the music-video finder). */
export const currentSong = currentIdent;
/** Any queue item, cleaned up the same way (used to look the next song up in advance). */
export const songFor = (item: QueueItem | undefined) => identOf(item, false);

// ------------------------------------------------------------------ LRCLIB
const LRCLIB = "https://lrclib.net/api";
class Offline extends Error {}
async function getJson(url: string): Promise<any> {
  const ctl = new AbortController();
  const t = window.setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Offline(`LRCLIB ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e instanceof Offline) throw e;
    throw new Offline(String(e));
  } finally {
    window.clearTimeout(t);
  }
}
function toCandidate(x: any, id: Ident): LyricsCandidate {
  const synced = !!x.syncedLyrics;
  const gap = id.duration > 0 && x.duration ? Math.abs(x.duration - id.duration) : 0;
  const ts = Math.max(sim(id.title, x.trackName ?? ""), ...titleVariants(id.title).map((v) => sim(v, x.trackName ?? "")));
  const as = id.artist ? Math.max(sim(id.artist, x.artistName ?? ""), sim(firstArtist(id.artist), x.artistName ?? "")) : 0.5;
  const score = (synced ? 100 : 0) + ts * 45 + as * 30 - Math.min(gap, 60) * 2.5 + (x.instrumental ? -5 : 0);
  return { id: x.id, title: x.trackName ?? "", artist: x.artistName ?? "", album: x.albumName ?? "", duration: x.duration ?? 0, synced, instrumental: !!x.instrumental, lrc: x.syncedLyrics || x.plainLyrics || "", score };
}
/** Search LRCLIB with progressively looser queries; returns candidates best-first. */
export async function searchLrclib(id: Ident, opts: { thorough?: boolean } = {}): Promise<LyricsCandidate[]> {
  const found = new Map<number, LyricsCandidate>();
  const add = (arr: any) => { for (const x of Array.isArray(arr) ? arr : arr ? [arr] : []) if (x && x.id && !found.has(x.id)) found.set(x.id, toCandidate(x, id)); };
  const good = () => [...found.values()].some((c) => c.synced && c.score >= 100 + 45 * 0.8 + 30 * 0.5 - 2.5 * 2);
  const q = (p: Record<string, string>) => `${LRCLIB}/search?${new URLSearchParams(p)}`;
  const a1 = firstArtist(id.artist);
  const steps: (() => Promise<void>)[] = [];
  if (id.artist && id.duration > 0) steps.push(async () => add(await getJson(`${LRCLIB}/get?${new URLSearchParams({ track_name: id.title, artist_name: id.artist, album_name: id.album, duration: String(id.duration) })}`)));
  if (id.artist) steps.push(async () => add(await getJson(q({ track_name: id.title, artist_name: id.artist }))));
  for (const v of titleVariants(id.title).slice(1)) if (id.artist) steps.push(async () => add(await getJson(q({ track_name: v, artist_name: a1 }))));
  if (a1 !== id.artist) steps.push(async () => add(await getJson(q({ track_name: id.title, artist_name: a1 }))));
  steps.push(async () => add(await getJson(q({ q: `${id.artist ? a1 + " " : ""}${titleVariants(id.title)[titleVariants(id.title).length - 1]}` }))));
  steps.push(async () => add(await getJson(q({ track_name: titleVariants(id.title)[1] ?? id.title }))));
  let failures = 0;
  for (const step of steps) {
    try { await step(); } catch (e) { if (e instanceof Offline) failures++; }
    if (!opts.thorough && good()) break;
  }
  if (failures === steps.length) throw new Offline("LRCLIB unreachable");
  return [...found.values()].sort((a, b) => b.score - a.score);
}

/** Is this candidate safe to show automatically? */
function acceptable(c: LyricsCandidate, id: Ident): boolean {
  const ts = Math.max(...titleVariants(id.title).map((v) => sim(v, c.title)));
  if (ts < 0.5) return false;
  if (!id.duration || !c.duration) return true;
  const gap = Math.abs(c.duration - id.duration);
  return gap <= 4 || (gap <= 20 && (!id.artist || sim(firstArtist(id.artist), c.artist) >= 0.5));
}

// ------------------------------------------------------------------ cache
interface Cached { lrc: string; synced: boolean; source: string; dur: number; at: number; miss?: boolean; instrumental?: boolean }
const cacheKey = (k: string) => `lyr:${k}`;
async function cacheGet(k: string): Promise<Cached | null> {
  try { const raw = await api.getSetting(cacheKey(k)); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function cachePut(k: string, v: Cached) { api.setSetting(cacheKey(k), JSON.stringify(v)).catch(() => {}); }
const MISS_TTL = 2 * 24 * 3600 * 1000;

// ------------------------------------------------------------------ resolve
let token = 0;
let activeKey = "";
let resolvedFor: { key: string; duration: number; matchDur: number } | null = null;

function show(lines: LyricLine[] | null, info: LyricsInfo, tok: number) {
  if (tok !== token) return; // the song changed meanwhile
  setState({ lyrics: lines && lines.length ? lines : null, lyricsInfo: info });
}

async function onlineAllowed() {
  return (await api.getSetting("onlineLyrics").catch(() => null)) !== "false"; // on unless switched off
}

/** Find lyrics for a song. With `apply`, show them (only if it's still the current song). */
async function resolve(id: Ident, tok: number | null, opts: { force?: boolean } = {}): Promise<void> {
  const apply = tok !== null;
  const t = tok ?? -1;
  if (apply) show(null, { status: "searching", source: "", gap: null }, t);

  // 1. embedded tags / sidecar .lrc for local files
  let localPlain: LyricLine[] | null = null;
  if (id.path) {
    const raw = await api.getLyrics(id.path).catch(() => null);
    const lines = raw ? parseLrc(raw) : null;
    if (lines && lines.length && isSynced(lines)) {
      if (apply) show(lines, { status: "synced", source: "Local file", gap: null }, t);
      return;
    }
    if (lines && lines.length) localPlain = lines;
  }

  // 2. cache
  if (!opts.force) {
    const c = await cacheGet(id.key);
    if (c && !c.miss) {
      if (apply) {
        const lines = parseLrc(c.lrc);
        const gap = id.duration && c.dur ? Math.abs(id.duration - c.dur) : null;
        show(lines, { status: c.instrumental ? "instrumental" : c.synced ? "synced" : "plain", source: c.source, gap }, t);
        resolvedFor = { key: id.key, duration: id.duration, matchDur: c.dur };
      }
      return;
    }
    if (c?.miss && Date.now() - c.at < MISS_TTL) {
      if (apply) show(localPlain, { status: localPlain ? "plain" : "none", source: localPlain ? "Local file" : "", gap: null }, t);
      return;
    }
  }

  // 3. online
  if (!(await onlineAllowed())) {
    if (apply) show(localPlain, { status: localPlain ? "plain" : "none", source: localPlain ? "Local file" : "Online lookup is off", gap: null }, t);
    return;
  }
  try {
    const list = await searchLrclib(id);
    const best = list.find((c) => c.synced && acceptable(c, id)) ?? list.find((c) => (c.lrc || c.instrumental) && acceptable(c, id));
    if (!best || (!best.lrc && !best.instrumental)) {
      cachePut(id.key, { lrc: "", synced: false, source: "", dur: 0, at: Date.now(), miss: true });
      if (apply) show(localPlain, { status: localPlain ? "plain" : "none", source: localPlain ? "Local file" : "", gap: null }, t);
      return;
    }
    if (best.instrumental && !best.lrc) {
      cachePut(id.key, { lrc: "", synced: false, source: "LRCLIB", dur: best.duration, at: Date.now(), instrumental: true });
      if (apply) show(null, { status: "instrumental", source: "LRCLIB", gap: null }, t);
      return;
    }
    // local unsynced lyrics win over online unsynced ones
    if (!best.synced && localPlain) {
      if (apply) show(localPlain, { status: "plain", source: "Local file", gap: null }, t);
      return;
    }
    cachePut(id.key, { lrc: best.lrc, synced: best.synced, source: "LRCLIB", dur: best.duration, at: Date.now() });
    if (apply) {
      const gap = id.duration && best.duration ? Math.abs(id.duration - best.duration) : null;
      show(parseLrc(best.lrc), { status: best.synced ? "synced" : "plain", source: "LRCLIB", gap }, t);
      resolvedFor = { key: id.key, duration: id.duration, matchDur: best.duration };
    }
  } catch {
    // offline / server trouble: show what we have and try again shortly
    if (apply) {
      show(localPlain, { status: "offline", source: localPlain ? "Local file" : "", gap: null }, t);
      retryLater(id.key);
    }
  }
}

let retryTimer: number | undefined;
let retryDelay = 5000;
function retryLater(key: string) {
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    const id = currentIdent();
    if (!id || id.key !== key) return;
    retryDelay = Math.min(retryDelay * 2, 120000);
    resolve(id, token);
  }, retryDelay);
}

/** Look up the next song in the queue ahead of time, so its lyrics appear instantly. */
async function prefetchNext() {
  const s = getState();
  const nxt = s.queue[s.queueIndex + 1];
  const id = identOf(nxt, false);
  if (!id || id.source !== "local" && !id.artist) return;
  if (await cacheGet(id.key)) return;
  if (id.path) return; // local files are read instantly anyway
  resolve(id, null).catch(() => {});
}

// ------------------------------------------------------------------ public API
/** Search again for the current song, ignoring the cache. */
export function refetchLyrics() {
  const id = currentIdent();
  if (!id) return;
  token++;
  retryDelay = 5000;
  resolve(id, token, { force: true });
}

/** Manual search (for the "Search lyrics" box). */
export async function searchLyricsManually(title: string, artist: string): Promise<LyricsCandidate[]> {
  const cur = currentIdent();
  const id: Ident = { key: "", title, artist, album: "", duration: cur?.duration ?? 0, path: null, source: cur?.source ?? "local" };
  return (await searchLrclib(id, { thorough: true })).filter((c) => c.lrc);
}

/** Use a hand-picked result for the current song (remembered for next time). */
export function chooseLyrics(c: LyricsCandidate) {
  const id = currentIdent();
  if (!id) return;
  token++;
  cachePut(id.key, { lrc: c.lrc, synced: c.synced, source: "Chosen manually", dur: c.duration, at: Date.now() });
  const gap = id.duration && c.duration ? Math.abs(id.duration - c.duration) : null;
  show(parseLrc(c.lrc), { status: c.synced ? "synced" : "plain", source: "Chosen manually", gap }, token);
}

/** Use lyrics you wrote or synced yourself (tap-to-sync / .lrc editor) for the current song. */
export function useOwnLyrics(lrc: string) {
  const id = currentIdent();
  if (!id) return;
  const lines = parseLrc(lrc);
  cachePut(id.key, { lrc, synced: isSynced(lines), source: "Your edit", dur: id.duration, at: Date.now() });
  token++;
  show(lines, { status: isSynced(lines) ? "synced" : "plain", source: "Your edit", gap: null }, token);
}

let started = false;
export function initLyrics() {
  if (started) return;
  started = true;
  let pendingKey = "";
  let settle: number | undefined;
  const check = () => {
    const id = currentIdent();
    const key = id?.key ?? "";
    if (key !== activeKey) {
      // song changed: clear immediately, then search once its details have settled (streaming
      // pages report title, artist and length in quick succession)
      activeKey = key;
      token++;
      resolvedFor = null;
      retryDelay = 5000;
      window.clearTimeout(retryTimer);
      setState({ lyrics: null, lyricsInfo: { status: id ? "searching" : "idle", source: "", gap: null } });
      pendingKey = key;
      window.clearTimeout(settle);
      if (!id) return;
      settle = window.setTimeout(() => {
        const now = currentIdent();
        if (!now || now.key !== pendingKey) return;
        resolve(now, token).then(() => window.setTimeout(prefetchNext, 3000));
      }, id.source === "local" ? 0 : 900);
      return;
    }
    // the song's length arrived after the first search and the match looks like another version
    if (id && resolvedFor && resolvedFor.key === key && !resolvedFor.duration && id.duration) {
      const mismatch = resolvedFor.matchDur > 0 && Math.abs(resolvedFor.matchDur - id.duration) > 4;
      resolvedFor = { ...resolvedFor, duration: id.duration };
      if (mismatch) resolve(id, token, { force: true });
    }
  };
  subscribe(check);
  window.setInterval(check, 1000);
  check();

  // latency compensation: routed YouTube audio sits in DriftKord's stream buffer before you hear it
  window.setInterval(async () => {
    const s = getState();
    const item = s.queue[s.queueIndex];
    if (s.ytActive && s.ytRouteEngine && item && itemService(item) === "youtube") {
      try {
        const [, bufferedMs] = await api.ytStreamStats();
        live.lyricLatency = Math.max(0, Math.min(1.5, bufferedMs / 1000 + 0.02));
      } catch { /* keep the last value */ }
    } else live.lyricLatency = 0;
  }, 1000);
}
