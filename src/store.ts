// Minimal global store (useSyncExternalStore) + a mutable "live" channel for 60fps data
// that must never trigger React re-renders (visualizers read it in requestAnimationFrame).
import { useSyncExternalStore } from "react";
import type {
  AudioStatus, DspParams, FocusState, Frame, Ltas, QueueItem, ScanProgress, AnalysisProgress, Track, YtState,
} from "./api";
import { defaultDsp } from "./api";
import type { BeatMode, LayerId } from "./soundscapes";
import type { LyricsInfo } from "./lyrics";
import type { CustomTheme } from "./customTheme";
import type { VideoInfo } from "./video";

export type ViewId =
  | "nowplaying" | "library" | "queue" | "playlists" | "youtube" | "eq" | "timemachine" | "moodmap"
  | "autodj" | "stems" | "soundstage" | "soundscapes" | "xray" | "metadata" | "settings" | "themes" | "autoplay";

export type VizId = "silk" | "balloon" | "gate" | "glow" | "albumart" | "animal" | "graffiti" | "ink" | "orbit" | "horizon";

export interface LyricLine { time: number; text: string }

export type AutoMode = "random" | "smart" | "mood" | "harmonic" | "discovery";
export interface AutoPlayConfig {
  /** Endless: keep the queue topped up so music never stops. */
  enabled: boolean;
  mode: AutoMode;
  /** Don't replay a track that was played within this many hours (0 = off). */
  noRepeatHours: number;
  /** Minimum number of tracks between two songs by the same artist. */
  artistSpacing: number;
  favoritesBoost: boolean;
  skipLearning: boolean;
  filters: { genres: string[]; hiResOnly: boolean; minRating: number; decades: number[]; losslessOnly: boolean };
  /** What to do when the app starts. */
  autostart: "off" | "resume" | "shuffle";
}
export function defaultAutoPlay(): AutoPlayConfig {
  return {
    enabled: false, mode: "smart", noRepeatHours: 12, artistSpacing: 3, favoritesBoost: true, skipLearning: true,
    filters: { genres: [], hiResOnly: false, minRating: 0, decades: [], losslessOnly: false }, autostart: "off",
  };
}
/** Ambient soundscapes mixed under the music (layer levels 0..1; absent = off). */
export interface SoundscapeState {
  playing: boolean;
  master: number;
  layers: Partial<Record<LayerId, number>>;
  scene: string | null;
  beat: BeatMode;
  /** stop automatically at this time (ms epoch) */
  timerEndsAt: number | null;
  /** pause the soundscape whenever the music is paused */
  pauseWithMusic: boolean;
}
export interface SleepState { endsAt: number | null; endOfTrack: boolean }
export type AdaptiveMode = "off" | "accent" | "full";

export interface AutoDjConfig { enabled: boolean; crossfade: number; harmonic: boolean; beatmatch: boolean; gapless: boolean }

export interface State {
  status: AudioStatus | null;
  tracks: Track[];
  queue: QueueItem[];
  queueIndex: number;
  view: ViewId;
  themeId: string;
  dsp: DspParams;
  ltas: Ltas | null;
  yt: YtState | null;
  ytActive: boolean;
  /** last report from each streaming service (youtube, spotify, apple, tidal, amazon) */
  streams: Record<string, YtState>;
  /** service shown in the Streaming tab */
  streamService: string;
  adblock: { blocked: number; inspected: number };
  focus: FocusState;
  scan: ScanProgress | null;
  analysis: AnalysisProgress | null;
  toast: string | null;
  visualizer: VizId;
  autoDj: AutoDjConfig;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  cover: string | null;
  lyrics: LyricLine[] | null;
  cinema: boolean;
  selection: number[];
  lastTransition: { gapless: boolean; crossfade: boolean; at: number } | null;
  autoPlay: AutoPlayConfig;
  sleep: SleepState;
  adaptive: AdaptiveMode;
  adaptiveSwatches: string[];
  /** Seconds added to the playback position when looking up lyrics (+ = lyrics earlier). */
  lyricOffset: number;
  /** what the lyrics engine is doing / found for the current song */
  lyricsInfo: LyricsInfo;
  hudOpen: boolean;
  /** Focus HUD look: 0.25–1 opacity, 0.75–1.6 size. */
  hudOpacity: number;
  hudScale: number;
  /** Hide YouTube Music's own player bar and drive it from DriftKord's. */
  ytIntegrated: boolean;
  /** Play YouTube Music through DriftKord's audio engine (DSP, output device, ducking). */
  ytRouteEngine: boolean;
  soundscape: SoundscapeState;
  /** full-screen player (opened by clicking the album art) */
  fullPlayer: boolean;
  /** show the song's music video instead of the visualizer / album art */
  videoMode: boolean;
  /** network player being cast to (DLNA) */
  cast: { id: string; name: string } | null;
  castState: string;
  videoInfo: VideoInfo;
  /** the user's Custom theme (null until they first open it) */
  customTheme: CustomTheme | null;
  /** Custom theme wallpaper (data URL, stored separately from prefs) */
  customBg: string | null;
  fullPlayerTab: "lyrics" | "queue" | "artist";
  /** recent scrobbles and what each service answered (newest first) */
  scrobbleLog: { title: string; artist: string; at: number; kind: "scrobble" | "nowplaying"; results: { service: string; ok: boolean; message: string }[] }[];
  /** last Discord Rich Presence problem (null = fine) */
  discordError: string | null;
}

const initial: State = {
  status: null,
  tracks: [],
  queue: [],
  queueIndex: -1,
  view: "nowplaying",
  themeId: "driftkord-black",
  dsp: defaultDsp(),
  ltas: null,
  yt: null,
  ytActive: false,
  streams: {},
  streamService: "youtube",
  adblock: { blocked: 0, inspected: 0 },
  focus: { game: false, fullscreenApp: "", call: false, callApp: "", duck: 1 },
  scan: null,
  analysis: null,
  toast: null,
  visualizer: "silk",
  autoDj: { enabled: false, crossfade: 6, harmonic: true, beatmatch: true, gapless: true },
  shuffle: false,
  repeat: "off",
  cover: null,
  lyrics: null,
  cinema: false,
  selection: [],
  lastTransition: null,
  autoPlay: defaultAutoPlay(),
  sleep: { endsAt: null, endOfTrack: false },
  adaptive: "accent",
  adaptiveSwatches: [],
  lyricOffset: 0,
  lyricsInfo: { status: "idle", source: "", gap: null },
  hudOpen: false,
  hudOpacity: 0.92,
  hudScale: 1,
  ytIntegrated: true,
  ytRouteEngine: true,
  scrobbleLog: [],
  fullPlayer: false,
  videoMode: false,
  cast: null,
  castState: "",
  videoInfo: { status: "off", title: "", channel: "", index: 0, total: 0, offset: 0 },
  customTheme: null,
  customBg: null,
  fullPlayerTab: "lyrics",
  discordError: null,
  soundscape: { playing: false, master: 0.6, layers: { rain: 0.7, fire: 0.25, thunder: 0.2 }, scene: "rainy-window", beat: "alpha", timerEndsAt: null, pauseWithMusic: false },
};

let state: State = initial;
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

let toastTimer: number | undefined;
export function toast(msg: string) {
  setState({ toast: msg });
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setState({ toast: null }), 4200);
}

// ---------------------------------------------------------------- live (non-React) channel
const emptyFrame: Frame = {
  bands: new Array(64).fill(0), bass: 0, mid: 0, treble: 0, rms: [0, 0], peak: [0, 0], correlation: 1,
  gonio: [], beat: false, crestDb: 0, position: 0, playing: false,
};

export const live = {
  frame: emptyFrame as Frame,
  /** seconds of audio buffered between the player and the speakers (lyrics wait for it) */
  lyricLatency: 0,
  /** monotonically increasing beat counter (beats are edge events) */
  beats: 0,
  lastBeatAt: 0,
  position: 0,
  positionAt: performance.now(),
  playing: false,
};

export function livePosition(): number {
  if (!live.playing) return live.position;
  // local playback runs at the chosen playback speed
  const s = state.ytActive ? 1 : Math.max(0.01, state.dsp.speed ?? 1);
  return live.position + ((performance.now() - live.positionAt) / 1000) * s;
}
