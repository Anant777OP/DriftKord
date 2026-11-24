// Music videos for whatever is playing (local files and every streaming service).
//
//  1. find: searches YouTube for the song's official video and scores the results (title & artist
//     match, "official", verified channel, a length close to the song's; lyric/live/cover/remix
//     uploads are pushed down). The choice is remembered per song.
//  2. show: a muted video view is placed over whichever "video surface" is on screen — the Now
//     Playing stage or the full-screen player — and parked when neither is visible.
//  3. sync: the video follows the music's position (minus any audio buffered before your speakers)
//     with gentle speed nudges for small drift and a jump for big ones; it pauses with the music.
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { currentSong, Ident, songFor } from "./lyrics";
import { getState, live, livePosition, setState, subscribe } from "./store";

export type VideoStatus = "off" | "searching" | "ready" | "none" | "offline";
export interface VideoInfo { status: VideoStatus; title: string; channel: string; index: number; total: number; offset: number; reason?: string; more?: boolean; loadingMore?: boolean; quality?: string; levels?: string[] }

/** Video quality choices: id is YouTube's level name. */
export const VIDEO_QUALITIES: { id: string; label: string }[] = [
  { id: "auto", label: "Auto" }, { id: "medium", label: "360p" }, { id: "large", label: "480p" }, { id: "hd720", label: "720p" },
  { id: "hd1080", label: "1080p" }, { id: "hd1440", label: "1440p" }, { id: "hd2160", label: "4K" }, { id: "max", label: "Max" },
];
export const qualityLabel = (q?: string) => ({ tiny: "144p", small: "240p", medium: "360p", large: "480p", hd720: "720p", hd1080: "1080p", hd1440: "1440p", hd2160: "4K", highres: "8K" } as Record<string, string>)[q ?? ""] ?? "";
let wantQuality = "hd1080";
api.getSetting("videoQuality").then((v) => { if (v) wantQuality = v; }).catch(() => {});
export const getVideoQuality = () => wantQuality;
/** Choose the video quality (remembered). */
export function setVideoQuality(q: string) {
  wantQuality = q;
  api.setSetting("videoQuality", q).catch(() => {});
  api.videoQuality(q).catch(() => {});
}

interface Cand { id: string; title: string; channel: string; duration: number; verified: boolean; score: number }
interface VState { id: string | null; t: number; d: number; paused: boolean; ready: boolean; at: number }

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const words = (s: string) => norm(s).split(" ").filter((w) => w.length > 1 || /\d/.test(w));
const share = (a: string[], b: string) => { const B = new Set(words(b)); return a.length ? a.filter((w) => B.has(w)).length / a.length : 0; };

const JUNK = /\b(lyrics?|lyrical|audio|visuali[sz]er|live|cover|remix|reaction|karaoke|8d|slowed|reverb|nightcore|instrumental|sped up|teaser|trailer|shorts?|tutorial|piano|guitar|dance practice|fan ?made|edit|(?:dance |club )?mix|mashup|jukebox|reprise|unplugged|lo-?fi|vertical|subtitulado|sub español|traducida|tradução|legendado|letra)\b/i;
function score(c: Omit<Cand, "score">, song: Ident): number {
  const tw = words(song.title), aw = words(song.artist.split(/,|&|feat\.?|ft\.?/i)[0] ?? song.artist);
  const ts = share(tw, c.title);
  if (ts < 0.6) return -99;
  const as = Math.max(share(aw, c.title), share(aw, c.channel));
  let s = ts * 6 + as * 3;
  if (/official\s*(music\s*)?video|\bm\/?v\b/i.test(c.title)) s += 3;
  if (c.verified || /vevo$/i.test(c.channel) || share(aw, c.channel) > 0.6) s += 2;
  const junk = c.title.match(JUNK);
  if (junk && !new RegExp(junk[0], "i").test(song.title)) s -= 4;
  // a dubbed/regional version (e.g. "(Kannada)") when the song itself isn't that version
  const dub = c.title.match(/\b(hindi|tamil|telugu|kannada|malayalam|bengali|marathi|punjabi|gujarati|dubbed)\b/i);
  if (dub && !new RegExp(`\\b${dub[1]}\\b`, "i").test(`${song.title} ${song.album ?? ""}`)) s -= 3;
  if (song.duration > 0 && c.duration > 0) {
    const diff = c.duration - song.duration;
    if (diff < -15 || diff > 150) s -= 5; else s += 2 - Math.abs(diff) / 60;
  }
  return s;
}

// ------------------------------------------------------------------ state
let song: Ident | null = null;
let cands: Cand[] = [];
let pick = 0;
let offset = 0;
let vs: VState = { id: null, t: 0, d: 0, paused: true, ready: false, at: 0 };
let token = 0;
let lastRate = 1;
const pending = new Map<string, (items: Omit<Cand, "score">[] | null, next: string) => void>();
interface Found { items: Omit<Cand, "score">[]; next: string }
// endless "Wrong video? Next": the search's next-page token, and other searches to try after that
let nextToken = "";
let moreQuery = "";
let altIdx = 0;
let loadingMore = false;
const ALTS = (s: Ident) => {
  const a = s.artist ? s.artist.split(/,|&/)[0].trim() : "";
  return [`${a} ${s.title}`, `${a} ${s.title} live`, `${a} ${s.title} lyrics`, `${s.title} ${a} cover`, `${s.title} ${a} remix`, `${s.title}`].map((q) => q.trim());
};
let tagSeq = 0;

const info = (patch: Partial<VideoInfo>) => setState((s) => ({ videoInfo: { ...s.videoInfo, ...patch } }));
const cacheKey = (k: string) => `vid:${k}`;
async function saveChoice() {
  if (!song) return;
  await api.setSetting(cacheKey(song.key), JSON.stringify({ cands: cands.slice(0, Math.max(30, pick + 1)), pick, offset, at: Date.now() })).catch(() => {});
}

/** Ask the video view to search; several searches (current + next song) can be in flight. */
function searchOnce(query: string, cont = ""): Promise<Found | null> {
  return new Promise((resolve) => {
    const tag = `q${++tagSeq}`;
    const done = (items: Omit<Cand, "score">[] | null, next = "") => { window.clearTimeout(timer); window.clearTimeout(retry); pending.delete(tag); resolve(items ? { items, next } : null); };
    const timer = window.setTimeout(() => done(null), 15000);
    // nothing back yet (page was busy)? ask once more
    const retry = window.setTimeout(() => { if (pending.has(tag)) api.videoSearch(query, tag, cont || undefined).catch(() => {}); }, 5000);
    pending.set(tag, done);
    api.videoSearch(query, tag, cont || undefined).catch(() => done(null));
  });
}
const queryFor = (s: Ident) => `${s.artist ? s.artist.split(/,|&/)[0].trim() + " " : ""}${s.title} official music video`;
function rank(items: Omit<Cand, "score">[], s: Ident, ytId: string | null | undefined): Cand[] {
  const all = items.map((c) => ({ ...c, score: score(c, s) + (c.id === ytId ? 50 : 0) }));
  // good matches first (best first), then everything else the search found
  const good = all.filter((c) => c.score > -50).sort((a, b) => b.score - a.score);
  const rest = all.filter((c) => c.score <= -50);
  return [...good, ...rest];
}

/** Look up the next song's video in the background so it starts instantly. */
async function prefetchNext() {
  const s = getState();
  const ident = songFor(s.queue[s.queueIndex + 1]);
  if (!ident) return;
  const have = await api.getSetting(cacheKey(ident.key)).catch(() => null);
  if (have) return;
  const found = await searchOnce(queryFor(ident));
  if (!found) return;
  const ranked = rank(found.items, ident, null);
  if (ranked.length) await api.setSetting(cacheKey(ident.key), JSON.stringify({ cands: ranked.slice(0, 6), pick: 0, offset: 0, at: Date.now() })).catch(() => {});
}

let openSeq = 0;
/** Last thing YouTube said that stopped a video (shown with "Can't play the music video"). */
let lastReason = "";
function openPick(fallbacks = 0) {
  const c = cands[pick];
  if (!c) return;
  const my = ++openSeq;
  const stillWaiting = () => my === openSeq && getState().videoMode && getState().videoInfo.status === "searching";
  // ask again once (it never restarts a page that's still loading); if this video still won't start,
  // quietly try the next-best match (up to twice) before saying it can't be reached. A late start
  // still turns the video on.
  window.setTimeout(() => { if (stillWaiting()) api.videoOpen(c.id, Math.max(0, livePosition() + offset)).catch(() => {}); }, 6000);
  window.setTimeout(() => {
    if (!stillWaiting()) return;
    if (fallbacks < 2 && pick + 1 < cands.length) { pick++; openPick(fallbacks + 1); return; }
    window.setTimeout(() => { if (stillWaiting()) info({ status: "offline", reason: lastReason }); }, 12000);
  }, 13000);
  vs = { id: null, t: 0, d: 0, paused: true, ready: false, at: 0 };
  lastRate = 1;
  info({ status: "searching", title: c.title, channel: c.channel, index: pick, total: cands.length, offset });
  api.videoOpen(c.id, Math.max(0, livePosition() + offset)).catch(() => info({ status: "offline" }));
}

async function find(s: Ident) {
  const my = ++token;
  song = s;
  cands = [];
  pick = 0;
  offset = 0;
  nextToken = "";
  moreQuery = "";
  altIdx = 0;
  info({ status: "searching", title: "", channel: "", index: 0, total: 0, offset: 0, more: true, loadingMore: false });
  // remembered choice for this song?
  try {
    const raw = await api.getSetting(cacheKey(s.key));
    if (raw && my === token) {
      const c = JSON.parse(raw);
      if (Array.isArray(c.cands) && c.cands.length) {
        cands = c.cands; pick = Math.min(c.pick ?? 0, cands.length - 1); offset = c.offset ?? 0;
        // automatic pick: re-rank with the current scoring (picks you chose yourself are kept)
        if (!c.pick) { const ytId = getState().ytActive ? getState().yt?.videoId : null; const r = rank(cands, s, ytId); if (r.length) cands = r; }
        openPick();
        return;
      }
    }
  } catch { /* search instead */ }
  const found = await searchOnce(queryFor(s));
  if (my !== token) return;
  if (!found) { info({ status: "offline", reason: lastReason }); return; }
  nextToken = found.next;
  moreQuery = queryFor(s);
  // when YouTube Music itself is the source, its own video id is a perfect match
  const ytId = getState().ytActive ? getState().yt?.videoId : null;
  cands = rank(found.items, s, ytId);
  // "Search again": don't land on the video that was just showing
  if (avoidId && cands.length > 1) {
    const i = cands.findIndex((c) => c.id === avoidId);
    if (i >= 0) cands.push(...cands.splice(i, 1));
  }
  avoidId = null;
  if (!cands.length) { info({ status: "none", title: "", channel: "", total: 0 }); return; }
  saveChoice();
  openPick();
}

/** Fetch more results: YouTube's next page, then other searches for the same song. Returns how many were added. */
async function loadMore(): Promise<number> {
  if (!song || loadingMore) return 0;
  const s = song;
  const my = token;
  loadingMore = true;
  info({ loadingMore: true });
  let added = 0;
  try {
    for (let tries = 0; tries < 4 && added === 0; tries++) {
      let found: Found | null = null;
      if (nextToken) found = await searchOnce(moreQuery, nextToken);
      else if (!moreQuery) { moreQuery = queryFor(s); found = await searchOnce(moreQuery); }
      else if (altIdx < ALTS(s).length) { moreQuery = ALTS(s)[altIdx++]; found = await searchOnce(moreQuery); }
      else break;
      if (my !== token) return 0;
      if (!found) { nextToken = ""; continue; }
      nextToken = found.next;
      const have = new Set(cands.map((c) => c.id));
      const fresh = rank(found.items.filter((c) => !have.has(c.id)), s, null);
      cands.push(...fresh);
      added += fresh.length;
    }
  } finally {
    loadingMore = false;
    if (my === token) info({ loadingMore: false, total: cands.length, more: !!nextToken || altIdx < ALTS(s).length });
  }
  return added;
}

/** Show the next search result instead (wrong video). Endless: more results load as you go. */
export async function nextVideo() {
  if (loadingMore) return;
  if (pick + 1 >= cands.length) {
    const added = await loadMore();
    if (!added) {
      if (cands.length < 2) return;
      pick = -1; // nothing more anywhere: start over from the best match
    }
  }
  pick += 1;
  offset = 0;
  saveChoice();
  openPick();
  // keep one page ahead so the next click is instant
  if (cands.length - pick <= 3) loadMore();
}
/** Shift the video against the music (seconds, + = video later in the song). */
export function nudgeVideo(delta: number | null) {
  offset = delta === null ? 0 : Math.round((offset + delta) * 4) / 4;
  info({ offset });
  saveChoice();
}
/** Search again from scratch for the current song. */
let avoidId: string | null = null;
export async function refindVideo() {
  if (!song) return;
  avoidId = getState().videoInfo.status === "ready" ? cands[pick]?.id ?? null : null;
  await api.setSetting(cacheKey(song.key), "").catch(() => {});
  find(song);
}

// ------------------------------------------------------------------ where the video is shown
export type SurfaceKind = "full" | "nowplaying" | "cinema";
const surfaces = new Map<SurfaceKind, HTMLElement>();
export function registerSurface(kind: SurfaceKind, el: HTMLElement | null) {
  if (el) surfaces.set(kind, el); else surfaces.delete(kind);
  placeSoon();
}
function visibleRect(el: HTMLElement) {
  const h = el.getBoundingClientRect();
  let top = Math.max(h.top, 0), bottom = Math.min(h.bottom, innerHeight);
  let left = Math.max(h.left, 0), right = Math.min(h.right, innerWidth);
  const overlay = !!el.closest(".fp, .cinema");
  const page = overlay ? null : (el.closest(".main") as HTMLElement | null)?.getBoundingClientRect();
  if (page) { top = Math.max(top, page.top); bottom = Math.min(bottom, page.bottom); left = Math.max(left, page.left); right = Math.min(right, page.right); }
  if (!overlay) {
    document.querySelectorAll<HTMLElement>(".transport-dock, .app > .transport").forEach((d) => {
      if (getComputedStyle(d).position !== "fixed") return;
      const b = d.getBoundingClientRect();
      if (b.left < right && b.right > left && b.top < bottom && b.bottom > top) {
        if (b.top > (top + bottom) / 2) bottom = b.top - 8; else top = b.bottom + 8;
      }
    });
  }
  return { left, top, width: right - left, height: bottom - top };
}
let lastPlace = "";
let placeRaf = 0;
function activeSurface(): HTMLElement | null {
  const s = getState();
  if (!s.videoMode || s.videoInfo.status !== "ready") return null;
  // Cinema Mode covers everything, so it wins; the visualizer page under it has no video
  if (s.cinema) { const c = surfaces.get("cinema"); return c?.isConnected ? c : null; }
  const full = surfaces.get("full");
  if (s.fullPlayer && full?.isConnected) return full;
  const np = surfaces.get("nowplaying");
  if (!s.fullPlayer && np?.isConnected) return np;
  return null;
}
function placeSoon() {
  cancelAnimationFrame(placeRaf);
  placeRaf = requestAnimationFrame(place);
}
function place() {
  const el = activeSurface();
  if (!el) {
    if (lastPlace !== "hidden") { api.videoHide().catch(() => {}); api.videoCmd("pause").catch(() => {}); }
    lastPlace = "hidden";
    return;
  }
  const r = visibleRect(el);
  const key = [r.left, r.top, r.width, r.height].map(Math.round).join(",");
  if (key === lastPlace || r.width < 40 || r.height < 30) return;
  lastPlace = key;
  api.videoShowAt(r.left, r.top, r.width, r.height).catch(() => {});
}

// ------------------------------------------------------------------ sync
function syncTick() {
  if (!activeSurface() || !vs.ready) return;
  const s = getState();
  const playing = s.ytActive ? !(s.yt?.paused ?? true) : s.status?.state === "playing";
  const want = livePosition() - live.lyricLatency + offset;
  const vt = vs.t + (!vs.paused ? (performance.now() - vs.at) / 1000 * lastRate : 0);
  // the video follows the playback speed (YouTube plays 0.25×–2×)
  const base = s.ytActive ? 1 : Math.max(0.25, Math.min(2, s.dsp.speed ?? 1));
  if (want < 0 || (vs.d > 0 && want > vs.d - 0.3)) {
    // before the video starts / after it ends: hold a still frame
    if (!vs.paused) api.videoCmd("pause").catch(() => {});
    return;
  }
  if (!playing) {
    if (!vs.paused) api.videoCmd("pause").catch(() => {});
    if (Math.abs(vt - want) > 0.4) api.videoCmd("seek", want).catch(() => {});
    return;
  }
  if (vs.paused) { api.videoCmd("seek", want + 0.1).catch(() => {}); api.videoCmd("play").catch(() => {}); return; }
  const drift = vt - want;
  if (Math.abs(drift) > 0.7) {
    api.videoCmd("seek", want + 0.2).catch(() => {}); // a little ahead: seeking takes a moment
    if (lastRate !== base) { lastRate = base; api.videoCmd("rate", base).catch(() => {}); }
    return;
  }
  const rate = base * (Math.abs(drift) < 0.05 ? 1 : Math.max(0.94, Math.min(1.06, 1 - drift * 0.5)));
  if (Math.abs(rate - lastRate) > 0.01) { lastRate = rate; api.videoCmd("rate", rate).catch(() => {}); }
}

let started = false;
export function initVideo() {
  if (started) return;
  started = true;
  listen<any>("video-event", (e) => {
    const p = e.payload;
    if (p.kind === "diag") {
      lastReason = String(p.reason || "");
      if (getState().videoInfo.status === "offline") info({ reason: lastReason });
      return;
    }
    if (p.kind === "results") {
      if (p.error) lastReason = String(p.error).replace(/^Error:\s*/, "");
      const cb = pending.get(p.tag || "");
      cb?.(Array.isArray(p.items) ? p.items : null, String(p.next || ""));
      return;
    }
    if (p.kind === "state") {
      const expected = cands[pick]?.id;
      // only the video chosen for the current song counts (not the previous one, nor YouTube autoplay)
      if (!expected || p.id !== expected) return;
      const wasReady = vs.ready;
      vs = { id: p.id, t: p.t, d: p.d, paused: p.paused, ready: !!p.ready, at: performance.now() };
      const vi = getState().videoInfo;
      if (p.q && (p.q !== vi.quality || (p.lv || []).length !== (vi.levels || []).length)) info({ quality: p.q, levels: p.lv || [] });
      if (vs.ready && vi.status !== "ready") {
        info({ status: "ready" });
        api.videoQuality(wantQuality).catch(() => {}); // the page may have been reloaded
        window.setTimeout(prefetchNext, 1500);
      }
      if (vs.ready !== wasReady) placeSoon();
    }
  });
  // follow the current song while video mode is on
  let lastKey = "";
  let warmed = false;
  const check = () => {
    const s = getState();
    if (s.videoMode && !warmed) { warmed = true; api.videoWarm().catch(() => {}); }
    if (!s.videoMode) {
      if (lastKey) { lastKey = ""; token++; song = null; info({ status: "off" }); placeSoon(); }
      return;
    }
    const id = currentSong();
    const key = id?.key ?? "";
    if (key === lastKey) return;
    lastKey = key;
    if (!id) { token++; info({ status: "off" }); placeSoon(); return; }
    find(id);
  };
  subscribe(() => { check(); placeSoon(); });
  window.addEventListener("resize", placeSoon);
  window.setInterval(() => { check(); place(); syncTick(); }, 250);
}
