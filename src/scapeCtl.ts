// Keeps the soundscape engine in step with the store, so soundscapes keep playing whichever page is
// open, honour the sleep timer, and (optionally) pause together with the music.
import * as engine from "./soundscapes";
import type { LayerId } from "./soundscapes";
import { getState, live, setState, subscribe, toast } from "./store";

let started = false;

export function initSoundscapes() {
  if (started) return;
  started = true;
  let applied: Partial<Record<LayerId, number>> = {};
  let lastPlaying = false, lastMaster = -1, lastBeat = "";
  let musicHeld = false;

  const sync = () => {
    const sc = getState().soundscape;
    if (sc.beat !== lastBeat) { lastBeat = sc.beat; engine.setBeatMode(sc.beat); }
    if (sc.master !== lastMaster) { lastMaster = sc.master; engine.setMaster(sc.master); }
    if (sc.layers !== applied) {
      const ids = new Set([...Object.keys(applied), ...Object.keys(sc.layers)] as LayerId[]);
      for (const id of ids) if ((applied[id] ?? 0) !== (sc.layers[id] ?? 0)) engine.setLayer(id, sc.layers[id] ?? 0);
      applied = sc.layers;
    }
    const want = sc.playing && !musicHeld;
    if (want !== lastPlaying) {
      lastPlaying = want;
      if (want) engine.start().catch((e) => toast(`Soundscapes: ${e}`));
      else engine.stop();
    }
  };
  subscribe(sync);
  sync();

  window.setInterval(() => {
    const s = getState();
    const sc = s.soundscape;
    // sleep timer
    if (sc.playing && sc.timerEndsAt && Date.now() >= sc.timerEndsAt) {
      setState({ soundscape: { ...sc, playing: false, timerEndsAt: null } });
      toast("Soundscape timer finished");
      return;
    }
    // follow the music's play/pause
    const musicPlaying = s.ytActive ? !(s.yt?.paused ?? true) : live.playing;
    const held = sc.pauseWithMusic && !musicPlaying;
    if (held !== musicHeld) { musicHeld = held; sync(); }
  }, 500);
}
