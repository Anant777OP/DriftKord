// Navigation entries (shared by the app shell and the Custom-theme editor).
import type { ViewId } from "./store";

export interface NavItem { id: ViewId; icon: string; label: string; group: string }

export const NAV: NavItem[] = [
  { id: "nowplaying", icon: "nowplaying", label: "Now Playing", group: "Listen" },
  { id: "library", icon: "library", label: "Library", group: "Listen" },
  { id: "autoplay", icon: "shuffle", label: "Auto-Play", group: "Listen" },
  { id: "queue", icon: "queue", label: "Queue", group: "Listen" },
  { id: "playlists", icon: "playlists", label: "Playlists", group: "Listen" },
  { id: "youtube", icon: "youtube", label: "Streaming", group: "Listen" },
  { id: "soundscapes", icon: "soundscapes", label: "Soundscapes", group: "Listen" },
  { id: "eq", icon: "eq", label: "EQ & Crossfeed", group: "Sound" },
  { id: "timemachine", icon: "timemachine", label: "Time-Machine", group: "Sound" },
  { id: "stems", icon: "stems", label: "Stem Isolator", group: "Sound" },
  { id: "soundstage", icon: "soundstage", label: "Soundstage", group: "Sound" },
  { id: "moodmap", icon: "moodmap", label: "Mood-Terrain", group: "Explore" },
  { id: "autodj", icon: "autodj", label: "Auto-DJ", group: "Explore" },
  { id: "xray", icon: "xray", label: "Acoustic X-Ray", group: "Explore" },
  { id: "metadata", icon: "metadata", label: "Metadata", group: "Tools" },
  { id: "themes", icon: "themes", label: "Themes", group: "Tools" },
  { id: "settings", icon: "settings", label: "Settings", group: "Tools" },
];
