// Play tracker for scrobbling (Last.fm, Libre.fm, ListenBrainz, Maloja) and Discord Rich Presence.
// Works the same for local files and every streaming service.
//
// Scrobble rule (Last.fm's, used for all services): the song is longer than 30 s and you listened to
// at least half of it or 4 minutes, whichever comes first. Seeking or pausing doesn't count as listening.
import { api, IntegrationsConfig, Presence, ScrobblePlay, ServiceResult } from "./api";
import { cleanSongTitle } from "./player";
import { getState, livePosition, setState } from "./store";
import { itemService } from "./streaming";

let cfg: IntegrationsConfig | null = null;

export async function reloadIntegrations() {
  cfg = await api.integrationsGet().catch(() => null);
  if (cfg && !cfg.discord.enabled) api.discordClear().catch(() => {});
  lastPresenceKey = "";
}

const anyScrobbler = () =>
  !!cfg && ((cfg.lastfm.enabled && !!cfg.lastfm.session) || (cfg.librefm.enabled && !!cfg.librefm.session) ||
    (cfg.listenbrainz.enabled && !!cfg.listenbrainz.token) || (cfg.maloja.enabled && !!cfg.maloja.url));

interface Current { key: string; play: ScrobblePlay; played: number; nowSent: boolean; scrobbled: boolean; lastPos: number }
let cur: Current | null = null;
let lastTick = 0;

/** What's playing right now, cleaned up for scrobbling. */
function snapshot() {
  const s = getState();
  const item = s.queue[s.queueIndex];
  if (!item) return null;
  const source = s.ytActive ? itemService(item) : "local";
  let title = s.ytActive ? s.yt?.title || item.title : item.title;
  let artist = s.ytActive ? s.yt?.artist || item.artist : item.artist;
  const album = (s.ytActive ? s.yt?.album || item.album : item.album) ?? "";
  if (source === "youtube") {
    // YouTube gives video titles and channel names ("Queen - Topic", "QueenVEVO")
    artist = artist.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").replace(/\s+Official$/i, "").trim();
    title = cleanSongTitle(title, artist);
  }
  const duration = Math.round((s.ytActive ? s.yt?.duration : s.status?.duration) ?? item.duration ?? 0);
  const playing = s.ytActive ? !(s.yt?.paused ?? true) : s.status?.state === "playing";
  const position = livePosition();
  const artUrl = s.ytActive ? s.yt?.artUrl ?? null : null;
  if (!title || !artist) return null;
  return { key: `${source}|${artist}|${title}`.toLowerCase(), title, artist, album, duration, playing, position, artUrl, source };
}

function log(kind: "scrobble" | "nowplaying", p: ScrobblePlay, results: ServiceResult[]) {
  if (!results.length) return;
  setState((s) => ({ scrobbleLog: [{ title: p.title, artist: p.artist, at: Date.now(), kind, results }, ...s.scrobbleLog].slice(0, 12) }));
}

function tick() {
  const now = performance.now();
  const dt = lastTick ? Math.min(2, (now - lastTick) / 1000) : 0;
  lastTick = now;
  const snap = snapshot();
  if (!snap) return;

  // a new song, or the same song started over (repeat-one / replay)
  const restarted = cur && cur.key === snap.key && snap.position < 3 && cur.lastPos > Math.max(20, snap.duration - 15);
  if (!cur || cur.key !== snap.key || restarted) {
    cur = {
      key: snap.key,
      play: { artist: snap.artist, title: snap.title, album: snap.album, duration: snap.duration, startedAt: Math.floor(Date.now() / 1000 - snap.position), source: snap.source },
      played: 0, nowSent: false, scrobbled: false, lastPos: snap.position,
    };
  }
  if (snap.duration && !cur.play.duration) cur.play.duration = snap.duration;
  // count only real listening: playing, and the position moved about as much as the clock did
  const moved = snap.position - cur.lastPos;
  if (snap.playing && moved > 0 && moved < dt + 1.5) cur.played += Math.min(dt, moved + 0.25);
  cur.lastPos = snap.position;

  if (anyScrobbler()) {
    if (!cur.nowSent && snap.playing && cur.played >= 2) {
      cur.nowSent = true;
      const p = { ...cur.play };
      api.scrobbleNowPlaying(p).then((r) => { if (r.some((x) => !x.ok)) log("nowplaying", p, r); }).catch(() => {});
    }
    const d = cur.play.duration;
    const needed = d > 30 ? Math.min(d / 2, 240) : d === 0 ? 240 : Infinity;
    if (!cur.scrobbled && cur.played >= needed) {
      cur.scrobbled = true;
      const p = { ...cur.play };
      api.scrobbleSubmit(p, cur.played).then((r) => log("scrobble", p, r)).catch(() => {});
    }
  }
  presence(snap);
}

// ------------------------------------------------------------------ Discord Rich Presence
let lastPresenceKey = "";
let lastPresenceAt = 0;
let pending: Presence | null = null;
let sending = false;

function presence(snap: NonNullable<ReturnType<typeof snapshot>>) {
  if (!cfg?.discord.enabled || !cfg.discord.appId) return;
  // update on song change, play/pause and seeks; Discord itself counts the time between
  const bucket = Math.round((Date.now() / 1000 - snap.position) / 3);
  const key = `${snap.key}|${snap.playing}|${snap.playing ? bucket : 0}`;
  if (key === lastPresenceKey) return;
  lastPresenceKey = key;
  pending = { title: snap.title, artist: snap.artist, album: snap.album, playing: snap.playing, position: snap.position, duration: snap.duration, artUrl: snap.artUrl, source: snap.source };
  flushPresence();
}

function flushPresence() {
  if (sending || !pending) return;
  // Discord accepts about 5 updates per 20 s: keep ≥ 4 s apart, always sending the latest state
  const wait = 4000 - (Date.now() - lastPresenceAt);
  if (wait > 0) { window.setTimeout(flushPresence, wait); return; }
  const p = pending;
  pending = null;
  sending = true;
  lastPresenceAt = Date.now();
  api.discordUpdate(p)
    .then(() => { if (getState().discordError) setState({ discordError: null }); })
    .catch((e) => { setState({ discordError: String(e) }); lastPresenceKey = ""; })
    .finally(() => { sending = false; if (pending) flushPresence(); });
}

let started = false;
export async function initIntegrations() {
  if (started) return;
  started = true;
  await reloadIntegrations();
  window.setInterval(tick, 1000);
  // send scrobbles that were saved while offline
  const flush = () => { if (anyScrobbler()) api.scrobbleFlush().catch(() => {}); };
  window.setTimeout(flush, 15000);
  window.setInterval(flush, 5 * 60 * 1000);
}
