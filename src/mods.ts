// Mod loader. Style mods (.css) apply and remove live. Script mods (.js) run once at start-up with
// the `DriftKord` API below; they're off until you switch them on and confirm you trust them.
// Theme presets (.json / .dktheme) are applied to the Custom theme from the Mods list.
import { api, ModInfo } from "./api";
import { getState, live, setState, subscribe, toast } from "./store";

const ENABLED_KEY = "modsEnabled";
let enabled = new Set<string>();
const running = new Set<string>(); // script mods already executed this session
export let lastModError: Record<string, string> = {};

/** The API handed to script mods (also on window.DriftKord). */
export const modApi = {
  version: "1.0",
  getState,
  setState,
  subscribe,
  live,
  toast,
  api,
  /** Add CSS; returns a function that removes it. */
  addStyle(css: string): () => void {
    const el = document.createElement("style");
    el.dataset.modStyle = "script";
    el.textContent = css;
    document.head.appendChild(el);
    return () => el.remove();
  },
  /** Run `cb(title, artist)` whenever the song changes. */
  onSongChange(cb: (title: string, artist: string) => void): () => void {
    let last = "";
    return subscribe(() => {
      const s = getState();
      const it = s.queue[s.queueIndex];
      const title = s.ytActive ? s.yt?.title || it?.title || "" : it?.title || "";
      const artist = s.ytActive ? s.yt?.artist || it?.artist || "" : it?.artist || "";
      const k = title + "|" + artist;
      if (k !== last && title) { last = k; try { cb(title, artist); } catch (e) { console.error(e); } }
    });
  },
};

async function loadEnabled() {
  try { enabled = new Set(JSON.parse((await api.getSetting(ENABLED_KEY)) ?? "[]")); } catch { enabled = new Set(); }
}
async function saveEnabled() {
  await api.setSetting(ENABLED_KEY, JSON.stringify([...enabled])).catch(() => {});
}
export const isEnabled = (file: string) => enabled.has(file);

function styleEl(file: string) {
  return document.querySelector<HTMLStyleElement>(`style[data-mod="${CSS.escape(file)}"]`);
}

async function activate(m: ModInfo) {
  if (m.kind === "css") {
    const css = await api.modsRead(m.file);
    let el = styleEl(m.file);
    if (!el) { el = document.createElement("style"); el.dataset.mod = m.file; document.head.appendChild(el); }
    el.textContent = css;
  } else if (m.kind === "js" && !running.has(m.file)) {
    const code = await api.modsRead(m.file);
    running.add(m.file);
    try {
      // eslint-disable-next-line no-new-func
      new Function("DriftKord", `"use strict";\n${code}\n//# sourceURL=mods/${m.file}`)(modApi);
      delete lastModError[m.file];
    } catch (e) {
      lastModError[m.file] = String(e);
      toast(`Mod "${m.name}" failed: ${e}`);
    }
  }
}

/** Load all switched-on mods (called once at start-up). */
export async function initMods() {
  (window as any).DriftKord = modApi;
  await loadEnabled();
  const list = await api.modsList().catch(() => [] as ModInfo[]);
  for (const m of list) if (enabled.has(m.file) && m.kind !== "theme") await activate(m).catch(() => {});
}

/** Switch a mod on or off. Returns true when a restart is needed (turning off a script mod). */
export async function setModEnabled(m: ModInfo, on: boolean): Promise<boolean> {
  if (on) enabled.add(m.file); else enabled.delete(m.file);
  await saveEnabled();
  if (on) { await activate(m); return false; }
  if (m.kind === "css") { styleEl(m.file)?.remove(); return false; }
  return m.kind === "js" && running.has(m.file);
}

/** Re-read a style mod from disk (after editing it in another program). */
export async function reloadStyleMod(m: ModInfo) {
  if (m.kind === "css" && enabled.has(m.file)) await activate(m);
}

export async function forgetMod(file: string) {
  enabled.delete(file);
  await saveEnabled();
  styleEl(file)?.remove();
}

/** A ready-to-edit example, written into the mods folder on request. */
export const EXAMPLE_CSS = `/*
 * @name Rounded album art
 * @description Example style mod — makes every album cover a circle that slowly spins while playing.
 * @author You
 * @version 1.0
 */
.cover-mini, .fp-art { border-radius: 50% !important; }
.fp-art img { animation: dk-spin 20s linear infinite; }
@keyframes dk-spin { to { transform: rotate(360deg); } }
`;
export const EXAMPLE_JS = `/*
 * @name Song-change toast
 * @description Example script mod — shows a small message whenever a new song starts.
 * @author You
 * @version 1.0
 */
DriftKord.onSongChange((title, artist) => {
  DriftKord.toast("Now playing: " + title + " — " + artist);
});
`;

void setState;
