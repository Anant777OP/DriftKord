// Settings → Integrations: Discord Rich Presence and scrobbling (Last.fm, Libre.fm, ListenBrainz, Maloja).
import { useEffect, useState } from "react";
import { api, IntegrationsConfig } from "../api";
import { Panel, Toggle } from "../controls";
import { reloadIntegrations } from "../integrations";
import { toast, useStore } from "../store";

const NAMES: Record<string, string> = { lastfm: "Last.fm", librefm: "Libre.fm", listenbrainz: "ListenBrainz", maloja: "Maloja" };

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return <button className="link-btn" onClick={() => api.openUrl(href).catch((e) => toast(String(e)))}>{children} ↗</button>;
}

function Status({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={`int-status ${ok ? "ok" : ""}`}><i />{children}</span>;
}

export function IntegrationsPanel() {
  const [cfg, setCfg] = useState<IntegrationsConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tokens, setTokens] = useState<{ lastfm?: string; librefm?: string }>({});
  const [queued, setQueued] = useState(0);
  const log = useStore((s) => s.scrobbleLog);
  const discordError = useStore((s) => s.discordError);

  useEffect(() => {
    api.integrationsGet().then(setCfg).catch((e) => toast(String(e)));
    api.scrobbleQueueLen().then(setQueued).catch(() => {});
  }, []);
  if (!cfg) return null;

  const save = async (next: IntegrationsConfig, note?: string) => {
    setCfg(next);
    try {
      await api.integrationsSet(next);
      await reloadIntegrations();
      if (note) toast(note);
    } catch (e) {
      toast(String(e));
    }
  };
  const run = async (id: string, f: () => Promise<void>) => {
    setBusy(id);
    try { await f(); } catch (e) { toast(String(e)); } finally { setBusy(null); }
  };

  // ---- Last.fm / Libre.fm browser sign-in (two steps)
  const lfmStart = (svc: "lastfm" | "librefm") => run(svc, async () => {
    if (svc === "lastfm") await api.integrationsSet(cfg); // the key/secret must be saved first
    const [token] = await api.lfmBegin(svc);
    setTokens((t) => ({ ...t, [svc]: token }));
    toast(`Approve DriftKord on the ${NAMES[svc]} page that just opened, then press Finish`);
  });
  const lfmFinish = (svc: "lastfm" | "librefm") => run(svc, async () => {
    const user = await api.lfmFinish(svc, tokens[svc]!);
    setTokens((t) => ({ ...t, [svc]: undefined }));
    const fresh = await api.integrationsGet();
    setCfg(fresh);
    await reloadIntegrations();
    toast(`${NAMES[svc]} connected as ${user}`);
  });
  const lfmDisconnect = (svc: "lastfm" | "librefm") =>
    save({ ...cfg, [svc]: { ...cfg[svc], session: "", user: "", enabled: false } }, `${NAMES[svc]} disconnected`);

  const lfmBlock = (svc: "lastfm" | "librefm") => {
    const c = cfg[svc];
    const connected = !!c.session;
    return (
      <section className="int-card" key={svc}>
        <header className="int-head">
          <span className={`int-logo ${svc}`}>{svc === "lastfm" ? "as" : "lf"}</span>
          <div><strong>{NAMES[svc]}</strong><small>{svc === "lastfm" ? "Scrobble to your Last.fm profile" : "Free, open-source Last.fm alternative"}</small></div>
          <Status ok={connected && c.enabled}>{connected ? (c.enabled ? `On · ${c.user}` : `Paused · ${c.user}`) : "Not connected"}</Status>
        </header>
        {svc === "lastfm" && !connected && (
          <>
            <p className="muted small">Last.fm needs your own free API account. <Ext href="https://www.last.fm/api/account/create">Create one</Ext> (any app name, e.g. "DriftKord"), then paste the two values here.</p>
            <div className="int-fields">
              <label className="field"><span>API key</span><input value={c.apiKey} onChange={(e) => setCfg({ ...cfg, lastfm: { ...c, apiKey: e.target.value.trim() } })} placeholder="32 characters" spellCheck={false} /></label>
              <label className="field"><span>Shared secret</span><input type="password" value={c.secret} onChange={(e) => setCfg({ ...cfg, lastfm: { ...c, secret: e.target.value.trim() } })} placeholder="32 characters" spellCheck={false} /></label>
            </div>
          </>
        )}
        <div className="row wrap">
          {connected ? (
            <>
              <Toggle on={c.enabled} onChange={(v) => save({ ...cfg, [svc]: { ...c, enabled: v } })} label="Scrobble" />
              <button className="btn small ghost" onClick={() => lfmDisconnect(svc)}>Disconnect</button>
            </>
          ) : tokens[svc] ? (
            <>
              <button className="btn primary" disabled={busy === svc} onClick={() => lfmFinish(svc)}>Finish — I approved it</button>
              <button className="btn small ghost" onClick={() => lfmStart(svc)}>Open the page again</button>
            </>
          ) : (
            <button className="btn primary" disabled={busy === svc || (svc === "lastfm" && (c.apiKey.length !== 32 || c.secret.length !== 32))} onClick={() => lfmStart(svc)}>
              Connect {NAMES[svc]}
            </button>
          )}
        </div>
      </section>
    );
  };

  const lb = cfg.listenbrainz, mj = cfg.maloja, dc = cfg.discord;
  return (
    <Panel title="Integrations" className="int-panel">
      <div className="int-grid">
        {/* ---------------------------------------------------------------- Discord */}
        <section className="int-card">
          <header className="int-head">
            <span className="int-logo discord">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M19.6 5.6A16.6 16.6 0 0 0 15.5 4.3l-.5 1a15 15 0 0 0-6 0l-.5-1a16.6 16.6 0 0 0-4.1 1.3C1.8 9.5 1.1 13.3 1.4 17a16.7 16.7 0 0 0 5 2.6l1.1-1.7a10.8 10.8 0 0 1-1.7-.8l.4-.3a11.9 11.9 0 0 0 11.6 0l.4.3c-.6.3-1.1.6-1.7.8l1.1 1.7a16.6 16.6 0 0 0 5-2.6c.4-4.3-.7-8-3-11.4zM8.5 14.7c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1zm7 0c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1z" /></svg>
            </span>
            <div><strong>Discord Rich Presence</strong><small>Show “Listening to …” on your Discord profile</small></div>
            <Status ok={dc.enabled && !!dc.appId && !discordError}>{!dc.enabled ? "Off" : !dc.appId ? "Needs Application ID" : discordError ? "Problem" : "On"}</Status>
          </header>
          <ol className="int-steps small muted">
            <li><Ext href="https://discord.com/developers/applications">Open the Discord Developer Portal</Ext> → <em>New Application</em> → name it <strong>DriftKord</strong> (that name appears on your profile).</li>
            <li>Copy the <em>Application ID</em> from its General Information page and paste it below.</li>
          </ol>
          <label className="field"><span>Application ID</span>
            <input value={dc.appId} inputMode="numeric" placeholder="e.g. 1234567890123456789" spellCheck={false}
              onChange={(e) => setCfg({ ...cfg, discord: { ...dc, appId: e.target.value.replace(/\D/g, "") } })}
              onBlur={() => save(cfg)} />
          </label>
          <div className="row wrap">
            <Toggle on={dc.enabled} onChange={(v) => save({ ...cfg, discord: { ...dc, enabled: v } }, v ? "Discord Rich Presence on" : "Discord Rich Presence off")} label="Show on Discord" />
            <button className="btn small" disabled={!dc.appId || busy === "discord"} onClick={() => run("discord", async () => { await api.integrationsSet(cfg); await api.discordTest(); toast("Connected — check your Discord profile"); })}>Test connection</button>
          </div>
          <Toggle on={dc.onlineArt} onChange={(v) => save({ ...cfg, discord: { ...dc, onlineArt: v } })} label="Find album covers online for local files (asks the iTunes Search API)" />
          <Toggle on={dc.showWhenPaused} onChange={(v) => save({ ...cfg, discord: { ...dc, showWhenPaused: v } })} label="Keep showing while paused" />
          {dc.enabled && discordError && <p className="warn small">{discordError}</p>}
          <p className="muted small">Discord must be running on this PC (desktop app). Streaming songs use their own cover art.</p>
        </section>

        {lfmBlock("lastfm")}
        {lfmBlock("librefm")}

        {/* ---------------------------------------------------------------- ListenBrainz */}
        <section className="int-card">
          <header className="int-head">
            <span className="int-logo listenbrainz">LB</span>
            <div><strong>ListenBrainz</strong><small>Open listening history by MetaBrainz</small></div>
            <Status ok={lb.enabled && !!lb.user}>{lb.user ? (lb.enabled ? `On · ${lb.user}` : `Paused · ${lb.user}`) : "Not connected"}</Status>
          </header>
          <p className="muted small">Copy your user token from <Ext href="https://listenbrainz.org/settings/">ListenBrainz settings</Ext>.</p>
          <label className="field"><span>User token</span>
            <input type="password" value={lb.token} placeholder="xxxxxxxx-xxxx-…" spellCheck={false} onChange={(e) => setCfg({ ...cfg, listenbrainz: { ...lb, token: e.target.value.trim(), user: "" } })} />
          </label>
          <details className="small">
            <summary className="muted">Self-hosted server</summary>
            <label className="field"><span>API address</span>
              <input value={lb.url} placeholder="https://api.listenbrainz.org" onChange={(e) => setCfg({ ...cfg, listenbrainz: { ...lb, url: e.target.value.trim() } })} />
            </label>
          </details>
          <div className="row wrap">
            <button className="btn primary" disabled={!lb.token || busy === "lb"} onClick={() => run("lb", async () => {
              await api.integrationsSet(cfg);
              const user = await api.lbValidate(lb.token);
              await save({ ...cfg, listenbrainz: { ...lb, user, enabled: true } }, `ListenBrainz connected as ${user}`);
            })}>Check & connect</button>
            {lb.user && <Toggle on={lb.enabled} onChange={(v) => save({ ...cfg, listenbrainz: { ...lb, enabled: v } })} label="Submit listens" />}
          </div>
        </section>

        {/* ---------------------------------------------------------------- Maloja */}
        <section className="int-card">
          <header className="int-head">
            <span className="int-logo maloja">M</span>
            <div><strong>Maloja</strong><small>Your own self-hosted scrobble server</small></div>
            <Status ok={mj.enabled && !!mj.url}>{mj.enabled && mj.url ? "On" : "Off"}</Status>
          </header>
          <div className="int-fields">
            <label className="field"><span>Server address</span>
              <input value={mj.url} placeholder="http://localhost:42010" spellCheck={false} onChange={(e) => setCfg({ ...cfg, maloja: { ...mj, url: e.target.value.trim() } })} />
            </label>
            <label className="field"><span>API key</span>
              <input type="password" value={mj.key} placeholder="from Maloja → Settings → API keys" spellCheck={false} onChange={(e) => setCfg({ ...cfg, maloja: { ...mj, key: e.target.value.trim() } })} />
            </label>
          </div>
          <div className="row wrap">
            <button className="btn primary" disabled={!mj.url || busy === "mj"} onClick={() => run("mj", async () => {
              await api.integrationsSet(cfg);
              await api.malojaTest();
              await save({ ...cfg, maloja: { ...mj, enabled: true } }, "Maloja connected");
            })}>Test & connect</button>
            {mj.url && <Toggle on={mj.enabled} onChange={(v) => save({ ...cfg, maloja: { ...mj, enabled: v } })} label="Scrobble" />}
          </div>
        </section>

        {/* ---------------------------------------------------------------- activity */}
        <section className="int-card int-activity">
          <header className="int-head">
            <div><strong>Scrobble activity</strong><small>A song counts after half of it (or 4 minutes) has played</small></div>
          </header>
          {queued > 0 && (
            <div className="row wrap">
              <span className="small">{queued} scrobble{queued === 1 ? "" : "s"} saved while offline</span>
              <button className="btn small" onClick={() => run("flush", async () => { const left = await api.scrobbleFlush(); setQueued(left); toast(left ? `${left} still waiting` : "All sent"); })}>Send now</button>
            </div>
          )}
          {log.length === 0 ? (
            <p className="muted small">Nothing yet. Works for local files and every streaming service.</p>
          ) : (
            <ul className="int-log">
              {log.map((l, i) => (
                <li key={i}>
                  <span className="ellipsis"><strong>{l.title}</strong> — {l.artist}</span>
                  <span className="int-log-res">
                    {l.results.map((r) => (
                      <span key={r.service} className={`int-tag ${r.ok ? "ok" : "bad"}`} title={r.message || (l.kind === "scrobble" ? "Scrobbled" : "Now playing sent")}>
                        {NAMES[r.service] ?? r.service} {r.ok ? "✓" : "✕"}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">Keys and tokens are stored only on this PC. Song title, artist, album and play time are sent to the services you turn on.</p>
        </section>
      </div>
    </Panel>
  );
}
