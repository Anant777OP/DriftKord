// Streaming services shown in the Streaming tab. YouTube Music is open (not DRM-protected), so it can
// be routed through DriftKord's engine; the others protect their audio with DRM and play through
// their own web player (DriftKord controls them, shows now-playing, lyrics and visualizers).
import type { QueueItem } from "./api";

export interface StreamService {
  id: string;
  name: string;
  short: string;
  color: string;
  home: string;
  /** audio is DRM-protected: can't go through DriftKord's DSP engine */
  drm: boolean;
  note: string;
}

export const SERVICES: StreamService[] = [
  { id: "youtube", name: "YouTube Music", short: "YouTube", color: "#ff0033", home: "https://music.youtube.com/", drm: false, note: "Full DriftKord engine: EQ, DSP, ad shield" },
  { id: "spotify", name: "Spotify", short: "Spotify", color: "#1ed760", home: "https://open.spotify.com/", drm: true, note: "Free or Premium account" },
  { id: "apple", name: "Apple Music", short: "Apple", color: "#fa2d48", home: "https://music.apple.com/", drm: true, note: "Apple Music subscription" },
  { id: "tidal", name: "TIDAL", short: "TIDAL", color: "#33ffee", home: "https://listen.tidal.com/", drm: true, note: "TIDAL subscription" },
  { id: "amazon", name: "Amazon Music", short: "Amazon", color: "#25d1da", home: "https://music.amazon.com/", drm: true, note: "Amazon Music / Prime" },
];

export const serviceById = (id: string | undefined | null) => SERVICES.find((s) => s.id === id) ?? SERVICES[0];

/** Which streaming service a queue item belongs to (non-YouTube items carry a `svc:<id>:` key). */
export function itemService(it?: QueueItem | null): string {
  const v = it?.videoId;
  if (v && v.startsWith("svc:")) return v.slice(4).split(":")[0];
  return "youtube";
}
