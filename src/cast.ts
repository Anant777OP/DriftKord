// UPnP / DLNA casting. While casting, the network player makes the sound and DriftKord's engine
// keeps playing silently as the clock (progress bar, lyrics, visualizers, gapless queue). Track
// changes, play/pause, seeks and volume follow DriftKord; drift is corrected from the player's own
// position reports.
import { api, Renderer } from "./api";
import { getState, live, livePosition, setState, subscribe, toast } from "./store";

let target: Renderer | null = null;
let sentKey = "";
let lastState = "";
let lastVol = -1;
let poll = 0;
let unsub: (() => void) | null = null;

const NATIVE = ["flac", "wav", "wave", "mp3", "m4a", "alac", "aac", "ogg", "oga", "aif", "aiff", "aifc"];
const isNative = (p: string) => !p.includes("?") && NATIVE.includes(p.split(".").pop()?.toLowerCase() ?? "");

export const casting = () => target;

function current() {
  const s = getState();
  const it = s.queue[s.queueIndex];
  if (!it || it.kind !== "local" || !it.path) return null;
  return it;
}

async function sendCurrent(start?: number) {
  if (!target) return;
  const it = current();
  if (!it) {
    if (getState().ytActive) toast("Streaming services can't be cast — local files only");
    return;
  }
  sentKey = it.path!;
  try {
    await api.dlnaPlay(target, it.path!, it.title, it.artist, it.album ?? "", start ?? Math.max(0, livePosition()));
    if (getState().status?.state === "paused") await api.dlnaControl(target, "pause");
  } catch (e) {
    toast(`Cast: ${e}`);
  }
}

export async function startCast(r: Renderer) {
  if (target) await stopCast(false);
  target = r;
  setState({ cast: { id: r.id, name: r.name } });
  await api.setCastMute(true);
  lastState = getState().status?.state ?? "";
  await sendCurrent();
  api.dlnaControl(r, "volume", getState().dsp.volume).catch(() => {});
  unsub = subscribe(() => {
    if (!target) return;
    const s = getState();
    const it = current();
    if (it && it.path !== sentKey) sendCurrent(0);
    const st = s.status?.state ?? "";
    if (st !== lastState) {
      lastState = st;
      if (st === "paused") api.dlnaControl(target, "pause").catch(() => {});
      else if (st === "playing") api.dlnaControl(target, "play").catch(() => {});
      else if (st === "stopped") api.dlnaControl(target, "stop").catch(() => {});
    }
    if (Math.abs(s.dsp.volume - lastVol) > 0.01) {
      lastVol = s.dsp.volume;
      api.dlnaControl(target, "volume", s.dsp.volume).catch(() => {});
    }
  });
  // keep DriftKord's clock on the network player's position
  poll = window.setInterval(async () => {
    if (!target) return;
    try {
      const st = await api.dlnaStatus(target);
      setState({ castState: st.state });
      if (st.state === "PLAYING" && st.position > 0) {
        const drift = st.position - livePosition();
        if (Math.abs(drift) > 2.5 && Math.abs(drift) < 60) {
          live.position = st.position;
          live.positionAt = performance.now();
          api.seek(st.position).catch(() => {});
        }
      }
    } catch { /* player busy */ }
  }, 3000);
  toast(`Casting to ${r.name}`);
}

export async function stopCast(notify = true) {
  const r = target;
  target = null;
  sentKey = "";
  window.clearInterval(poll);
  unsub?.();
  unsub = null;
  setState({ cast: null, castState: "" });
  await api.setCastMute(false);
  if (r) await api.dlnaControl(r, "stop").catch(() => {});
  if (notify) toast("Playing on this PC again");
}

/** Seeks while casting: the player jumps too (decoded streams restart at the new spot). */
export function castSeek(secs: number) {
  if (!target) return;
  const it = current();
  if (!it) return;
  if (isNative(it.path!)) api.dlnaControl(target, "seek", secs).catch(() => {});
  else sendCurrent(secs);
}
