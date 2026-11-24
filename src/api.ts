// Typed bridge to the Rust backend (commands + events).
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

// ------------------------------------------------------------------ types (mirror Rust structs)
export interface StreamInfo {
  codec: string; sampleRate: number; bits: number; channels: number; duration: number;
  lossless: boolean; dsd: boolean; dop: boolean; dsdRate: number;
  /** multichannel/Atmos rendering, e.g. "8ch → binaural" */
  spatial?: string;
}
export interface OutputState {
  open: boolean; backend: string; exclusive: boolean; rate: number; bits: number; containerBits: number;
  float: boolean; deviceName: string; error?: string | null; fellBack: boolean;
}
export interface AudioStatus {
  state: "playing" | "paused" | "stopped"; path?: string | null; trackId?: number | null;
  position: number; duration: number; info?: StreamInfo | null; nextPath?: string | null;
  output: OutputState; signalPath: string[]; bitPerfect: boolean; resampling: boolean;
  lastTransitionGapless?: boolean | null; runningDr?: number | null; volume: number; duck: number;
}
export interface Frame {
  bands: number[]; bass: number; mid: number; treble: number; rms: [number, number]; peak: [number, number];
  correlation: number; gonio: number[]; beat: boolean; crestDb: number; position: number; playing: boolean;
}
export interface Ltas { freqs: number[]; db: number[]; cutoffHz: number; verdict: string; sampleRate: number }
export interface OutputConfig { mode: "exclusive" | "shared" | "asio"; deviceId?: string | null; asioDevice?: string | null; dop: boolean }
export interface DeviceInfo { id: string; name: string; isDefault: boolean }
export type EqKind = "peak" | "lowshelf" | "highshelf" | "lowpass" | "highpass" | "bandpass" | "notch" | "allpass";
export type EqChannel = "st" | "l" | "r" | "m" | "s";
export interface EqBand { freq: number; gainDb: number; q: number; kind: EqKind; channel?: EqChannel; enabled?: boolean }
export type EraId = "off" | "tube" | "tape" | "vinyl" | "stadium" | "gramophone" | "radio" | "jukebox" | "eighttrack" | "boombox" | "cd" | "telephone" | "mp3" | "loudness" | "club" | "lofi" | "hall";
export interface EngineOptions { ramBuffer: boolean; ramLimitMb: number; resampler: "sinc" | "fast"; spatial: "binaural" | "stereo"; ffmpegPath: string }
export interface ArtistBio {
  name: string; found: boolean; kind: string; description: string; origin: string; active: string; genres: string[];
  image?: string | null; summary: string; sections: { title: string; text: string }[];
  wikipediaUrl?: string | null; musicbrainzUrl?: string | null; fetchedAt: number;
}
export interface Renderer { id: string; name: string; model: string; avUrl: string; rcUrl: string }
export interface CastStatus { state: string; position: number; duration: number }
export interface Speaker { azimuth: number; distance: number; source: "L" | "R" | "C" }
export interface DspParams {
  eqEnabled: boolean; preampDb: number; bands: EqBand[]; crossfeed: number;
  replaygain: "off" | "track" | "album"; rgPreampDb: number;
  era: EraId; eraAmount: number;
  stems: { vocals: number; drums: number; bass: number; other: number };
  stageEnabled: boolean; speakers: Speaker[]; room: number; volume: number;
  mono: boolean; expVolume: boolean; speed: number; preservePitch: boolean;
}
export interface Track {
  id: number; path: string; title: string; artist: string; album: string; albumArtist: string; genre: string;
  year?: number | null; trackNo?: number | null; discNo?: number | null; duration: number; sampleRate: number;
  bitDepth: number; channels: number; codec: string; bitrate: number; fileSize: number;
  rgTrackGain?: number | null; rgTrackPeak?: number | null; rgAlbumGain?: number | null; rgAlbumPeak?: number | null;
  hasCover: boolean; bpm?: number | null; firstBeat?: number | null; musicalKey?: string | null; camelot?: string | null;
  energy?: number | null; brightness?: number | null; lufs?: number | null; dr?: number | null; cutoffHz?: number | null;
  verdict?: string | null; playCount: number; lastPlayed?: number | null; rating: number; addedAt: number;
}
// ---- integrations (Discord Rich Presence, scrobbling)
export interface LastfmCfg { enabled: boolean; apiKey: string; secret: string; session: string; user: string }
export interface IntegrationsConfig {
  discord: { enabled: boolean; appId: string; onlineArt: boolean; showWhenPaused: boolean };
  lastfm: LastfmCfg;
  librefm: LastfmCfg;
  listenbrainz: { enabled: boolean; token: string; user: string; url: string };
  maloja: { enabled: boolean; url: string; key: string };
}
export interface ScrobblePlay { artist: string; title: string; album: string; duration: number; startedAt: number; source: string }
export interface ServiceResult { service: string; ok: boolean; message: string }
export interface Presence { title: string; artist: string; album: string; playing: boolean; position: number; duration: number; artUrl: string | null; source: string }
export interface ModInfo { file: string; kind: "css" | "js" | "theme"; name: string; description: string; author: string; version: string; size: number }
export interface QueueItem {
  kind: "local" | "youtube"; trackId?: number | null; path?: string | null; videoId?: string | null;
  title: string; artist: string; album?: string | null; duration?: number | null; artUrl?: string | null;
}
export interface Playlist { id: number; name: string; count: number; createdAt: number }
export interface TagData {
  path: string; title: string; artist: string; album: string; albumArtist: string; genre: string;
  year?: number | null; trackNo?: number | null; discNo?: number | null; comment: string; composer: string;
  lyrics: string; tagType: string; hasCover: boolean; format: string;
  conductor: string; label: string; publisher: string; lyricist: string; remixer: string; work: string; isrc: string;
  catalog: string; mood: string; bpm: string; initialKey: string; copyright: string; dynamicRange: string;
}
export const EXTRA_TAGS = ["conductor", "label", "publisher", "lyricist", "remixer", "work", "isrc", "catalog", "mood", "bpm", "initialKey", "copyright", "dynamicRange"] as const;
export type ExtraTag = (typeof EXTRA_TAGS)[number];
export type TagPatch = Partial<Record<"title" | "artist" | "album" | "albumArtist" | "genre" | "year" | "trackNo" | "discNo" | "comment" | "composer" | "lyrics" | ExtraTag, string>>;
export interface ScanProgress { done: number; total: number; current: string; finished: boolean; added: number; removed: number }
export interface AnalysisProgress { done: number; total: number; current: string; finished: boolean }
export interface TrackAnalysis {
  bpm: number; firstBeat: number; key: string; camelot: string; energy: number; brightness: number;
  lufs: number; peak: number; dr: number; cutoffHz: number; verdict: string;
}
export interface YtState {
  kind: "state" | "ended" | "play" | "pause"; videoId: string | null; title: string; artist: string; album: string;
  artUrl: string | null; position: number; duration: number; paused: boolean; volume: number; adsSkipped: number; url: string; routed?: boolean; service?: string;
}
export interface FocusConfig { enabled: boolean; gameDuck: number; callDuck: number; autoHud: boolean }
export interface FocusState { game: boolean; fullscreenApp: string; call: boolean; callApp: string; duck: number }
export interface ShellStatus { registered: boolean; exePath: string; registeredExe?: string | null }
export type EngineEvent =
  | { type: "trackChanged"; path: string; trackId?: number | null; gapless: boolean; crossfade: boolean }
  | { type: "ended" }
  | { type: "error"; message: string };

// ------------------------------------------------------------------ commands
export const api = {
  listDevices: () => invoke<DeviceInfo[]>("list_devices"),
  listAsioDevices: () => invoke<string[]>("list_asio_devices"),
  asioControlPanel: (name: string) => invoke<void>("asio_control_panel", { name }),
  getEngineOptions: () => invoke<EngineOptions>("get_engine_options"),
  setEngineOptions: (options: EngineOptions) => invoke<void>("set_engine_options", { options }),
  ffmpegStatus: () => invoke<string | null>("ffmpeg_status"),
  dlnaDiscover: () => invoke<Renderer[]>("dlna_discover"),
  setCastMute: (on: boolean) => invoke<void>("set_cast_mute", { on }),
  dlnaPlay: (renderer: Renderer, path: string, title: string, artist: string, album: string, start: number) => invoke<void>("dlna_play", { renderer, path, title, artist, album, start }),
  dlnaControl: (renderer: Renderer, cmd: "play" | "pause" | "stop" | "seek" | "volume", arg?: number) => invoke<void>("dlna_control", { renderer, cmd, arg: arg ?? null }),
  dlnaStatus: (renderer: Renderer) => invoke<CastStatus>("dlna_status", { renderer }),
  asioAvailable: () => invoke<boolean>("asio_available"),
  getOutput: () => invoke<OutputConfig>("get_output"),
  setOutput: (cfg: OutputConfig) => invoke<void>("set_output", { cfg }),
  playFile: (path: string, trackId?: number | null, startAt?: number) => invoke<StreamInfo>("play_file", { path, trackId: trackId ?? null, startAt: startAt ?? null }),
  setNext: (path: string | null, trackId?: number | null, xfade = 0, tempo = 1, startAt = 0) =>
    invoke<void>("set_next", { path, trackId: trackId ?? null, xfade, tempo, startAt }),
  pause: (paused: boolean) => invoke<void>("pause", { paused }),
  stop: () => invoke<void>("stop"),
  seek: (secs: number) => invoke<void>("seek", { secs }),
  setVolume: (volume: number) => invoke<void>("set_volume", { volume }),
  getDsp: () => invoke<DspParams>("get_dsp"),
  setDsp: (params: DspParams) => invoke<void>("set_dsp", { params }),
  getStatus: () => invoke<AudioStatus>("get_status"),
  setFrameRate: (fps: number) => invoke<void>("set_frame_rate", { fps }),
  setLoopback: (on: boolean) => invoke<void>("set_loopback", { on }),
  libraryFolders: () => invoke<string[]>("library_folders"),
  libraryAddFolder: (path: string) => invoke<void>("library_add_folder", { path }),
  libraryRemoveFolder: (path: string) => invoke<void>("library_remove_folder", { path }),
  libraryRescan: () => invoke<void>("library_rescan"),
  libraryTracks: () => invoke<Track[]>("library_tracks"),
  libraryTrack: (id: number) => invoke<Track | null>("library_track", { id }),
  importPaths: (paths: string[]) => invoke<Track[]>("import_paths", { paths }),
  analyzeLibrary: () => invoke<void>("analyze_library"),
  analyzeTrack: (id: number) => invoke<TrackAnalysis>("analyze_track", { id }),
  recordPlay: (id: number) => invoke<void>("record_play", { id }),
  setRating: (id: number, rating: number) => invoke<void>("set_rating", { id, rating }),
  playlists: () => invoke<Playlist[]>("playlists_list"),
  playlistCreate: (name: string) => invoke<number>("playlist_create", { name }),
  playlistRename: (id: number, name: string) => invoke<void>("playlist_rename", { id, name }),
  playlistDelete: (id: number) => invoke<void>("playlist_delete", { id }),
  playlistItems: (id: number) => invoke<QueueItem[]>("playlist_items", { id }),
  playlistSetItems: (id: number, items: QueueItem[]) => invoke<void>("playlist_set_items", { id, items }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  readTags: (path: string) => invoke<TagData>("read_tags", { path }),
  writeTags: (paths: string[], patch: TagPatch) => invoke<number>("write_tags", { paths, patch }),
  getCover: (path: string) => invoke<string | null>("get_cover", { path }),
  setCover: (paths: string[], image: string) => invoke<void>("set_cover", { paths, image }),
  removeCover: (paths: string[]) => invoke<void>("remove_cover", { paths }),
  tagsFromFilename: (paths: string[], pattern: string) => invoke<[string, TagPatch][]>("tags_from_filename", { paths, pattern }),
  getLyrics: (path: string) => invoke<string | null>("get_lyrics", { path }),
  saveLyrics: (path: string, text: string) => invoke<void>("save_lyrics", { path, text }),
  computeReplaygain: (paths: string[], album: boolean, write: boolean) =>
    invoke<{ path: string; lufs: number; trackGain: number; trackPeak: number; albumGain?: number; albumPeak?: number }[]>("compute_replaygain", { paths, album, write }),
  revealInExplorer: (path: string) => invoke<void>("reveal_in_explorer", { path }),
  shellStatus: () => invoke<ShellStatus>("shell_status"),
  shellRegister: () => invoke<void>("shell_register"),
  shellUnregister: () => invoke<void>("shell_unregister"),
  openDefaultApps: () => invoke<void>("open_default_apps"),
  ytOpen: (url?: string, service?: string) => invoke<void>("yt_open", { url: url ?? null, service: service ?? null }),
  ytControl: (cmd: string, arg?: number, service?: string) => invoke<void>("yt_control", { cmd, arg: arg ?? null, service: service ?? null }),
  ytShowAt: (x: number, y: number, w: number, h: number, service?: string) => invoke<void>("yt_show_at", { x, y, w, h, service: service ?? null }),
  streamClose: (service: string) => invoke<void>("stream_close", { service }),
  integrationsGet: () => invoke<IntegrationsConfig>("integrations_get"),
  integrationsSet: (config: IntegrationsConfig) => invoke<void>("integrations_set", { config }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  lfmBegin: (service: "lastfm" | "librefm") => invoke<[string, string]>("lfm_begin", { service }),
  lfmFinish: (service: "lastfm" | "librefm", token: string) => invoke<string>("lfm_finish", { service, token }),
  lbValidate: (token: string) => invoke<string>("lb_validate", { token }),
  malojaTest: () => invoke<string>("maloja_test"),
  scrobbleNowPlaying: (play: ScrobblePlay) => invoke<ServiceResult[]>("scrobble_now_playing", { play }),
  scrobbleSubmit: (play: ScrobblePlay, played: number) => invoke<ServiceResult[]>("scrobble_submit", { play, played: Math.round(played) }),
  scrobbleFlush: () => invoke<number>("scrobble_flush"),
  scrobbleQueueLen: () => invoke<number>("scrobble_queue_len"),
  discordUpdate: (presence: Presence) => invoke<void>("discord_update", { presence }),
  discordClear: () => invoke<void>("discord_clear"),
  discordTest: () => invoke<void>("discord_test"),
  streamLoaded: () => invoke<string[]>("stream_loaded"),
  ytStreamStats: () => invoke<[number, number]>("yt_stream_stats"),
  videoSearch: (query: string, tag?: string, cont?: string) => invoke<void>("video_search", { query, tag: tag ?? null, cont: cont ?? null }),
  artistBio: (artist: string, refresh?: boolean) => invoke<ArtistBio>("artist_bio", { artist, refresh: refresh ?? null }),
  videoWarm: () => invoke<void>("video_warm"),
  videoOpen: (id: string, start: number) => invoke<void>("video_open", { id, start }),
  videoShowAt: (x: number, y: number, w: number, h: number) => invoke<void>("video_show_at", { x, y, w, h }),
  videoHide: () => invoke<void>("video_hide"),
  videoCmd: (cmd: "play" | "pause" | "seek" | "rate", arg?: number) => invoke<void>("video_cmd", { cmd, arg: arg ?? null }),
  videoQuality: (quality: string) => invoke<void>("video_quality", { quality }),
  videoClose: () => invoke<void>("video_close"),
  modsList: () => invoke<ModInfo[]>("mods_list"),
  modsImport: (paths: string[]) => invoke<string[]>("mods_import", { paths }),
  modsRead: (file: string) => invoke<string>("mods_read", { file }),
  modsWrite: (file: string, text: string) => invoke<void>("mods_write", { file, text }),
  modsRemove: (file: string) => invoke<void>("mods_remove", { file }),
  modsOpenFolder: () => invoke<void>("mods_open_folder"),
  saveTextFile: (path: string, text: string) => invoke<void>("save_text_file", { path, text }),
  ytHide: () => invoke<void>("yt_hide"),
  ytRoute: (on: boolean) => invoke<void>("yt_route", { on }),
  adblockStats: () => invoke<{ blocked: number; inspected: number }>("adblock_stats"),
  getFocusConfig: () => invoke<FocusConfig>("get_focus_config"),
  setFocusConfig: (cfg: FocusConfig) => invoke<void>("set_focus_config", { cfg }),
  getFocusState: () => invoke<FocusState>("get_focus_state"),
  showHud: (show: boolean) => invoke<void>("show_hud", { show }),
  setHudScale: (scale: number) => invoke<void>("set_hud_scale", { scale }),
  smtcUpdate: (a: { title: string; artist: string; album: string; cover?: string | null; duration: number; position: number; playing: boolean }) =>
    invoke<void>("smtc_update", { ...a, cover: a.cover ?? null }),
  getLaunchArgs: () => invoke<string[]>("get_launch_args"),
};

// ------------------------------------------------------------------ events
export const on = {
  frame: (cb: (f: Frame) => void) => listen<Frame>("audio-frame", (e) => cb(e.payload)),
  status: (cb: (s: AudioStatus) => void) => listen<AudioStatus>("audio-status", (e) => cb(e.payload)),
  ltas: (cb: (l: Ltas) => void) => listen<Ltas>("audio-ltas", (e) => cb(e.payload)),
  engine: (cb: (e: EngineEvent) => void) => listen<EngineEvent>("engine-event", (e) => cb(e.payload)),
  scan: (cb: (p: ScanProgress) => void) => listen<ScanProgress>("scan-progress", (e) => cb(e.payload)),
  analysis: (cb: (p: AnalysisProgress) => void) => listen<AnalysisProgress>("analysis-progress", (e) => cb(e.payload)),
  libraryChanged: (cb: () => void) => listen("library-changed", () => cb()),
  yt: (cb: (s: YtState) => void) => listen<YtState>("yt-state", (e) => cb(e.payload)),
  adblock: (cb: (s: { blocked: number; inspected: number }) => void) => listen<{ blocked: number; inspected: number }>("adblock-stats", (e) => cb(e.payload)),
  focus: (cb: (s: FocusState) => void) => listen<FocusState>("focus-state", (e) => cb(e.payload)),
  openArgs: (cb: (args: string[]) => void) => listen<string[]>("open-args", (e) => cb(e.payload)),
  mediaKey: (cb: (k: string) => void) => listen<string>("media-key", (e) => cb(e.payload)),
};
export type { UnlistenFn };

// ------------------------------------------------------------------ helpers
export function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function fmtRate(r: number): string {
  if (!r) return "";
  if (r >= 1_000_000) return `DSD${Math.round(r / 44100)}`;
  return r % 1000 === 0 ? `${r / 1000} kHz` : `${(r / 1000).toFixed(1)} kHz`;
}

export function trackToItem(t: Track): QueueItem {
  return { kind: "local", trackId: t.id, path: t.path, title: t.title, artist: t.artist, album: t.album, duration: t.duration };
}

export const defaultDsp = (): DspParams => ({
  eqEnabled: false, preampDb: 0,
  bands: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((f, i) => ({
    freq: f, gainDb: 0, q: i === 0 || i === 9 ? 0.7 : 1.41, kind: i === 0 ? "lowshelf" : i === 9 ? "highshelf" : "peak",
  })),
  crossfeed: 0, replaygain: "off", rgPreampDb: 0, era: "off", eraAmount: 0.6,
  stems: { vocals: 1, drums: 1, bass: 1, other: 1 },
  stageEnabled: false,
  speakers: [{ azimuth: -30, distance: 1.5, source: "L" }, { azimuth: 30, distance: 1.5, source: "R" }],
  room: 0.3, volume: 1,
  mono: false, expVolume: false, speed: 1, preservePitch: true,
});
