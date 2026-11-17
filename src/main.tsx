import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import { Hud } from "./features/System";
import { applyTheme, themeById } from "./themes";
import { api } from "./api";
import { setState } from "./store";
import "./styles.css";

const label = getCurrentWebviewWindow().label;
const root = ReactDOM.createRoot(document.getElementById("root")!);

if (label === "hud") {
  document.documentElement.classList.add("hud-window");
  // HUD inherits the user's theme colours/fonts
  api.getSetting("prefs").then((p) => {
    const id = p ? JSON.parse(p).themeId : undefined;
    applyTheme(themeById(id ?? "sony-walkman-1989"));
    document.documentElement.classList.add("hud-window");
  }).catch(() => {});
  root.render(<Hud />);
} else {
  // Restore the saved look before the first render so the default theme never flashes.
  const start = () =>
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  api.getSetting("prefs").then((p) => {
    if (p) {
      try {
        const prefs = JSON.parse(p);
        const look: Record<string, unknown> = {};
        for (const k of ["themeId", "visualizer", "adaptive"]) if (prefs[k] !== undefined) look[k] = prefs[k];
        setState(look);
        applyTheme(themeById(prefs.themeId));
      } catch { /* ignore */ }
    }
  }).catch(() => {}).finally(start);
}
