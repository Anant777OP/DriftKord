// Artist biography for the song that's playing: who they are, where they're from, active years,
// genres, photo and the life story (MusicBrainz + Wikipedia, cached for two weeks).
import { useEffect, useMemo, useState } from "react";
import { api, ArtistBio, trackToItem } from "../api";
import { Icon, Panel } from "../controls";
import { playItems } from "../player";
import { useStore } from "../store";

const memo = new Map<string, ArtistBio>();
const inflight = new Map<string, Promise<ArtistBio>>();

function primary(a: string) {
  return a.split(/\s+(?:feat\.?|ft\.?|featuring|x)\s+|\s*[,&;/]\s*|\s+and\s+/i)[0].replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").trim();
}

/** The artist of whatever is playing (local file or streaming service). */
export function useCurrentArtist(): string {
  const queue = useStore((s) => s.queue);
  const qi = useStore((s) => s.queueIndex);
  const yt = useStore((s) => s.yt);
  const ytActive = useStore((s) => s.ytActive);
  const it = queue[qi];
  const raw = (ytActive ? yt?.artist || it?.artist : it?.artist) ?? "";
  return primary(raw);
}

function useBio(artist: string) {
  const [state, setState] = useState<{ artist: string; bio: ArtistBio | null; loading: boolean; error: string }>({ artist: "", bio: null, loading: false, error: "" });
  const [enabled, setEnabled] = useState(true);
  useEffect(() => { api.getSetting("onlineBios").then((v) => setEnabled(v !== "false")).catch(() => {}); }, []);
  const load = (refresh = false) => {
    if (!artist || !enabled) return;
    const key = artist.toLowerCase();
    if (!refresh && memo.has(key)) { setState({ artist, bio: memo.get(key)!, loading: false, error: "" }); return; }
    setState({ artist, bio: null, loading: true, error: "" });
    let p = inflight.get(key);
    if (!p || refresh) { p = api.artistBio(artist, refresh); inflight.set(key, p); }
    p.then((b) => { memo.set(key, b); inflight.delete(key); setState((s) => (s.artist === artist ? { artist, bio: b, loading: false, error: "" } : s)); })
      .catch((e) => { inflight.delete(key); setState((s) => (s.artist === artist ? { artist, bio: null, loading: false, error: String(e) } : s)); });
  };
  useEffect(() => { load(); }, [artist, enabled]);
  return { ...state, enabled, reload: () => load(true) };
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").filter((l) => l.trim()).map((l, i) =>
        l.startsWith("§") ? <h4 key={i} className="ab-sub">{l.slice(1)}</h4> : <p key={i}>{l}</p>)}
    </>
  );
}

/** The biography itself (used in the Now Playing panel and the full-screen player). */
export function ArtistBioView({ compact }: { compact?: boolean }) {
  const artist = useCurrentArtist();
  const { bio, loading, error, enabled, reload } = useBio(artist);
  const [more, setMore] = useState(false);
  const tracks = useStore((s) => s.tracks);
  const mine = useMemo(() => {
    const a = artist.toLowerCase();
    return a ? tracks.filter((t) => primary(t.artist).toLowerCase() === a || primary(t.albumArtist || "").toLowerCase() === a) : [];
  }, [tracks, artist]);
  useEffect(() => setMore(false), [artist]);

  if (!artist) return <p className="muted ab-empty">Play something to see the artist's story.</p>;
  if (!enabled) {
    return (
      <p className="muted ab-empty">
        Artist biographies are off.{" "}
        <button className="btn small" onClick={async () => { await api.setSetting("onlineBios", "true"); location.reload(); }}>Turn on</button>
      </p>
    );
  }
  if (loading) {
    return (
      <div className="ab-loading">
        <div className="ab-skel img" />
        <div className="ab-skel-lines"><div className="ab-skel" /><div className="ab-skel short" /><div className="ab-skel" /><div className="ab-skel" /></div>
      </div>
    );
  }
  if (error || !bio || !bio.found) {
    return (
      <div className="ab-empty">
        <Icon name="disc" size={28} />
        <p>{error ? "Couldn't load the biography right now." : <>No biography found for <b>{artist}</b>.</>}</p>
        <div className="row wrap">
          <button className="btn small" onClick={reload}>Try again</button>
          <button className="btn small ghost" onClick={() => api.openUrl(`https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(artist)}`)}>Search Wikipedia</button>
        </div>
      </div>
    );
  }
  const facts = [bio.kind === "Person" ? "Artist" : bio.kind, bio.origin, bio.active].filter(Boolean);
  const sections = more ? bio.sections : [];
  return (
    <div className={`ab ${compact ? "compact" : ""}`}>
      <div className="ab-head">
        {bio.image ? <img className="ab-photo" src={bio.image} alt={bio.name} loading="lazy" referrerPolicy="no-referrer" /> : <div className="ab-photo empty"><Icon name="disc" size={34} /></div>}
        <div className="ab-who">
          <div className="ab-name">{bio.name}</div>
          {bio.description && <div className="ab-desc">{bio.description}</div>}
          {facts.length > 0 && <div className="ab-facts">{facts.map((f) => <span key={f} className="chip">{f}</span>)}</div>}
          {bio.genres.length > 0 && <div className="ab-genres">{bio.genres.map((g) => <span key={g}>{g}</span>)}</div>}
        </div>
      </div>
      <div className="ab-text">
        <Paragraphs text={bio.summary} />
        {sections.map((s) => (
          <section key={s.title}>
            <h3>{s.title}</h3>
            <Paragraphs text={s.text} />
          </section>
        ))}
        {bio.sections.length > 0 && (
          <button className="btn small ab-more" onClick={() => setMore(!more)}>{more ? "Show less" : `Read full biography (${bio.sections.length} sections)`}</button>
        )}
      </div>
      {mine.length > 0 && (
        <div className="ab-lib">
          <span><Icon name="library" size={14} /> {mine.length} song{mine.length === 1 ? "" : "s"} by {bio.name} in your library</span>
          <button className="btn small" onClick={() => playItems(mine.map(trackToItem))}><Icon name="play" size={12} /> Play all</button>
        </div>
      )}
      <div className="ab-credit">
        {bio.wikipediaUrl && <button className="linkish" onClick={() => api.openUrl(bio.wikipediaUrl!)}>Wikipedia</button>}
        {bio.musicbrainzUrl && <button className="linkish" onClick={() => api.openUrl(bio.musicbrainzUrl!)}>MusicBrainz</button>}
        <span>Text from Wikipedia, CC BY-SA 4.0</span>
        <button className="linkish" onClick={reload} title="Fetch again">Refresh</button>
      </div>
    </div>
  );
}

/** Now Playing panel. */
export function ArtistPanel() {
  const artist = useCurrentArtist();
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("abOpen") !== "0"; } catch { return true; } });
  const toggle = () => { setOpen(!open); try { localStorage.setItem("abOpen", open ? "0" : "1"); } catch { /* ignore */ } };
  return (
    <Panel title={<span className="ab-title">About the artist{artist ? <small> · {artist}</small> : null}</span>} className="artist-panel"
      actions={<button className="btn small ghost" onClick={toggle}>{open ? "Hide" : "Show"}</button>}>
      {open ? <ArtistBioView /> : <p className="muted small">Biography hidden.</p>}
    </Panel>
  );
}
