// Library (tracks / albums / artists / folders), Queue and Playlists.
import { open } from "@tauri-apps/plugin-dialog";
import { itemService, serviceById } from "../streaming";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, fmtRate, fmtTime, Playlist, QueueItem, Track, trackToItem } from "../api";
import { Icon, IconButton, Panel, Segmented } from "../controls";
import { enqueue, playIndex, playItems } from "../player";
import { shuffleAll, startRadio } from "../autoplay";
import { setState, toast, useStore } from "../store";

const coverCache = new Map<string, string | null>();
function useCover(path?: string) {
  const [c, setC] = useState<string | null>(path ? coverCache.get(path) ?? null : null);
  useEffect(() => {
    if (!path) return;
    if (coverCache.has(path)) {
      setC(coverCache.get(path) ?? null);
      return;
    }
    let alive = true;
    api.getCover(path).then((x) => {
      coverCache.set(path, x);
      if (alive) setC(x);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  return c;
}

type SortKey = "title" | "artist" | "album" | "duration" | "format" | "bpm" | "camelot" | "dr" | "playCount" | "addedAt";

function matches(t: Track, q: string) {
  if (!q) return true;
  const hay = `${t.title} ${t.artist} ${t.album} ${t.albumArtist} ${t.genre} ${t.codec} ${t.camelot ?? ""} ${t.year ?? ""}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function formatOf(t: Track) {
  if (t.bitDepth === 1) return `${t.codec}`;
  return `${t.codec} ${t.bitDepth ? t.bitDepth + "/" : ""}${fmtRate(t.sampleRate).replace(" kHz", "")}`;
}

export function Library() {
  const tracks = useStore((s) => s.tracks);
  const scan = useStore((s) => s.scan);
  const analysis = useStore((s) => s.analysis);
  const [tab, setTab] = useState<"tracks" | "albums" | "artists" | "folders">("tracks");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "artist", dir: 1 });
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<{ album?: string; artist?: string } | null>(null);

  const list = useMemo(() => {
    let l = tracks.filter((t) => matches(t, q));
    if (filter?.album) l = l.filter((t) => t.album === filter.album);
    if (filter?.artist) l = l.filter((t) => t.artist === filter.artist || t.albumArtist === filter.artist);
    const k = sort.key;
    const val = (t: Track): string | number =>
      k === "format" ? t.sampleRate * 100 + t.bitDepth : k === "artist" ? `${t.albumArtist || t.artist} ${t.album} ${String(t.discNo ?? 0).padStart(2, "0")}${String(t.trackNo ?? 0).padStart(3, "0")}`.toLowerCase()
        : ((t as any)[k] ?? (typeof (t as any)[k] === "string" ? "" : -1));
    return [...l].sort((a, b) => {
      const va = val(a), vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [tracks, q, sort, filter]);

  const selected = list.filter((t) => sel.has(t.id));
  const playSel = (start?: Track) => {
    const items = (selected.length > 1 ? selected : list).map(trackToItem);
    const idx = start ? items.findIndex((i) => i.trackId === start.id) : 0;
    playItems(items, Math.max(0, idx));
  };

  const addFolder = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Add music folder" });
    if (typeof dir === "string") {
      await api.libraryAddFolder(dir);
      toast("Scanning folder…");
    }
  };

  return (
    <div className="library view">
      <div className="toolbar">
        <Segmented value={tab} onChange={(v) => { setTab(v); setFilter(null); }} options={[
          { value: "tracks", label: `Tracks (${tracks.length})` }, { value: "albums", label: "Albums" },
          { value: "artists", label: "Artists" }, { value: "folders", label: "Folders" },
        ]} />
        <div className="search">
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, artist, album, key, format…" />
        </div>
        <button className="btn primary" onClick={shuffleAll} disabled={!tracks.length}><Icon name="shuffle" size={16} /> Shuffle all</button>
        <button className="btn" onClick={addFolder}><Icon name="folder" size={16} /> Add folder</button>
        <button className="btn" onClick={() => api.libraryRescan().then(() => toast("Rescanning…"))}><Icon name="refresh" size={16} /> Rescan</button>
      </div>
      {(scan || analysis) && (
        <div className="progress-line">
          {scan && <span>Scanning {scan.done}/{scan.total} · +{scan.added}</span>}
          {analysis && <span>Analysing BPM / key / DR {analysis.done}/{analysis.total}</span>}
          <div className="bar"><div style={{ width: `${scan ? (scan.done / Math.max(1, scan.total)) * 100 : ((analysis?.done ?? 0) / Math.max(1, analysis?.total ?? 1)) * 100}%` }} /></div>
        </div>
      )}
      {filter && (
        <div className="filter-chip">
          {filter.album ? `Album: ${filter.album}` : `Artist: ${filter.artist}`}
          <button onClick={() => setFilter(null)} aria-label="Clear filter">×</button>
        </div>
      )}
      {tab === "tracks" || filter ? (
        <>
          {selected.length > 0 && <SelectionBar tracks={selected} clear={() => setSel(new Set())} />}
          <TrackTable list={list} sel={sel} setSel={setSel} sort={sort} setSort={setSort} onPlay={playSel} />
        </>
      ) : tab === "albums" ? (
        <AlbumGrid tracks={tracks.filter((t) => matches(t, q))} onOpen={(album) => setFilter({ album })} />
      ) : tab === "artists" ? (
        <ArtistList tracks={tracks.filter((t) => matches(t, q))} onOpen={(artist) => setFilter({ artist })} />
      ) : (
        <Folders />
      )}
      {tracks.length === 0 && tab !== "folders" && (
        <div className="empty-state">
          <Icon name="library" size={48} />
          <h3>Your library is empty</h3>
          <p>Add a music folder, drag files onto the window, or right-click files in Explorer after enabling shell integration in Settings.</p>
          <button className="btn primary" onClick={addFolder}>Add music folder</button>
        </div>
      )}
    </div>
  );
}

function SelectionBar({ tracks, clear }: { tracks: Track[]; clear: () => void }) {
  const [pls, setPls] = useState<Playlist[]>([]);
  useEffect(() => {
    api.playlists().then(setPls).catch(() => {});
  }, []);
  const items = tracks.map(trackToItem);
  const addTo = async (id: number) => {
    const cur = await api.playlistItems(id);
    await api.playlistSetItems(id, [...cur, ...items]);
    toast(`Added ${items.length} to playlist`);
  };
  return (
    <div className="selection-bar">
      <strong>{tracks.length} selected</strong>
      <button className="btn" onClick={() => playItems(items, 0)}><Icon name="play" size={14} /> Play</button>
      <button className="btn" onClick={() => enqueue(items, true)}>Play next</button>
      <button className="btn" onClick={() => enqueue(items)}>Add to queue</button>
      <select className="btn" defaultValue="" onChange={(e) => { if (e.target.value) addTo(+e.target.value); e.target.value = ""; }}>
        <option value="">Add to playlist…</option>
        {pls.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button className="btn" onClick={() => setState({ selection: tracks.map((t) => t.id), view: "metadata" })}><Icon name="edit" size={14} /> Edit tags</button>
      {tracks.length === 1 && <button className="btn" onClick={() => startRadio(tracks[0])}>Start radio</button>}
      {tracks.length === 1 && <button className="btn" onClick={() => api.revealInExplorer(tracks[0].path)}>Show in Explorer</button>}
      <button className="btn" onClick={() => Promise.all(tracks.slice(0, 50).map((t) => api.analyzeTrack(t.id))).then(() => toast("Analysis complete"))}>Re-analyse</button>
      <button className="btn ghost" onClick={clear}>Clear</button>
    </div>
  );
}

const ROW = 34;
function TrackTable({ list, sel, setSel, sort, setSort, onPlay }: {
  list: Track[]; sel: Set<number>; setSel: (s: Set<number>) => void; sort: { key: SortKey; dir: 1 | -1 };
  setSort: (s: { key: SortKey; dir: 1 | -1 }) => void; onPlay: (t: Track) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const lastClick = useRef<number>(-1);
  const playingId = useStore((s) => s.queue[s.queueIndex]?.trackId);
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scroll / ROW) - 5);
  const last = Math.min(list.length, Math.ceil((scroll + height) / ROW) + 5);
  const head = (k: SortKey, label: string, cls = "") => (
    <div className={`th ${cls} ${sort.key === k ? "sorted" : ""}`} onClick={() => setSort({ key: k, dir: sort.key === k ? (sort.dir === 1 ? -1 : 1) : 1 })}>
      {label}{sort.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </div>
  );
  const click = (e: React.MouseEvent, i: number, t: Track) => {
    const n = new Set(e.ctrlKey ? sel : []);
    if (e.shiftKey && lastClick.current >= 0) {
      const [a, b] = [Math.min(lastClick.current, i), Math.max(lastClick.current, i)];
      for (let k = a; k <= b; k++) n.add(list[k].id);
    } else if (e.ctrlKey && sel.has(t.id)) n.delete(t.id);
    else n.add(t.id);
    lastClick.current = i;
    setSel(n);
  };
  return (
    <div className="track-table">
      <div className="tr thead">
        {head("title", "Title", "c-title")}{head("artist", "Artist", "c-artist")}{head("album", "Album", "c-album")}
        {head("format", "Format", "c-fmt")}{head("bpm", "BPM", "c-num")}{head("camelot", "Key", "c-num")}
        {head("dr", "DR", "c-num")}{head("duration", "Time", "c-num")}{head("playCount", "Plays", "c-num")}
      </div>
      <div className="tbody" ref={ref} onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}>
        <div style={{ height: list.length * ROW, position: "relative" }}>
          {list.slice(first, last).map((t, k) => {
            const i = first + k;
            const fake = t.verdict?.startsWith("FAKE") || t.verdict?.startsWith("Suspicious");
            return (
              <div key={t.id} className={`tr ${sel.has(t.id) ? "selected" : ""} ${playingId === t.id ? "playing" : ""}`} style={{ position: "absolute", top: i * ROW, height: ROW, left: 0, right: 0 }}
                onClick={(e) => click(e, i, t)} onDoubleClick={() => onPlay(t)}
                draggable onDragStart={(e) => e.dataTransfer.setData("application/x-wa-items", JSON.stringify([trackToItem(t)]))}>
                <div className="td c-title">{playingId === t.id && <Icon name="play" size={12} />} {t.title}</div>
                <div className="td c-artist">{t.artist}</div>
                <div className="td c-album">{t.album}</div>
                <div className="td c-fmt"><span className={`fmt ${t.bitDepth >= 24 || t.sampleRate > 48000 ? "hires" : ""}`}>{formatOf(t)}</span>{fake && <span className="fmt warn" title={t.verdict ?? ""}>!</span>}</div>
                <div className="td c-num">{t.bpm ? t.bpm.toFixed(0) : ""}</div>
                <div className="td c-num">{t.camelot ?? ""}</div>
                <div className="td c-num">{t.dr ? Math.round(t.dr) : ""}</div>
                <div className="td c-num">{fmtTime(t.duration)}</div>
                <div className="td c-num">{t.playCount || ""}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AlbumCard({ album, tracks, onOpen }: { album: string; tracks: Track[]; onOpen: () => void }) {
  const cover = useCover(tracks[0]?.path);
  const t0 = tracks[0];
  return (
    <div className="album-card" onClick={onOpen} onDoubleClick={() => playItems(tracks.map(trackToItem))}>
      <div className="album-art">{cover ? <img src={cover} alt="" loading="lazy" /> : <Icon name="disc" size={42} />}
        <button className="album-play" onClick={(e) => { e.stopPropagation(); playItems(tracks.map(trackToItem)); }} aria-label={`Play ${album}`}><Icon name="play" size={18} /></button>
      </div>
      <div className="album-name">{album || "Unknown album"}</div>
      <div className="album-artist">{t0?.albumArtist || t0?.artist} {t0?.year ? `· ${t0.year}` : ""}</div>
    </div>
  );
}

function AlbumGrid({ tracks, onOpen }: { tracks: Track[]; onOpen: (album: string) => void }) {
  const albums = useMemo(() => {
    const m = new Map<string, Track[]>();
    for (const t of tracks) {
      const k = `${t.albumArtist}\u0000${t.album}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(t);
    }
    return [...m.entries()].map(([k, ts]) => ({ key: k, album: ts[0].album, tracks: ts.sort((a, b) => (a.discNo ?? 0) - (b.discNo ?? 0) || (a.trackNo ?? 0) - (b.trackNo ?? 0)) }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [tracks]);
  const [limit, setLimit] = useState(120);
  return (
    <div className="album-grid" onScroll={(e) => {
      const el = e.target as HTMLDivElement;
      if (el.scrollTop + el.clientHeight > el.scrollHeight - 400) setLimit((l) => l + 120);
    }}>
      {albums.slice(0, limit).map((a) => <AlbumCard key={a.key} album={a.album} tracks={a.tracks} onOpen={() => onOpen(a.album)} />)}
    </div>
  );
}

function ArtistList({ tracks, onOpen }: { tracks: Track[]; onOpen: (a: string) => void }) {
  const artists = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tracks) {
      const a = t.albumArtist || t.artist || "Unknown artist";
      m.set(a, (m.get(a) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tracks]);
  return (
    <div className="artist-list">
      {artists.map(([a, n]) => (
        <button key={a} className="artist-row" onClick={() => onOpen(a)}>
          <span className="artist-initial">{a.slice(0, 1).toUpperCase()}</span>
          <span className="artist-name">{a}</span>
          <span className="muted">{n} tracks</span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ folder tree
interface Dir { name: string; path: string; dirs: Map<string, Dir>; tracks: Track[]; count: number }
const realPath = (p: string) => p.split("?")[0];
function buildTree(tracks: Track[], roots: string[]): Dir[] {
  const top: Dir[] = [];
  const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "");
  const rootList = roots.map(norm).sort((a, b) => b.length - a.length);
  const byRoot = new Map<string, Dir>();
  const other: Dir = { name: "Other locations", path: "", dirs: new Map(), tracks: [], count: 0 };
  for (const t of tracks) {
    const file = norm(realPath(t.path));
    const dir = file.slice(0, file.lastIndexOf("\\"));
    const root = rootList.find((r) => dir === r || dir.startsWith(r + "\\"));
    let node: Dir;
    let rel: string[];
    if (root) {
      node = byRoot.get(root) ?? { name: root, path: root, dirs: new Map(), tracks: [], count: 0 };
      byRoot.set(root, node);
      rel = dir.slice(root.length).split("\\").filter(Boolean);
    } else {
      node = other;
      rel = dir.split("\\").filter(Boolean);
    }
    node.count++;
    let path = node.path;
    for (const part of rel) {
      path = path ? path + "\\" + part : part;
      let next = node.dirs.get(part);
      if (!next) { next = { name: part, path, dirs: new Map(), tracks: [], count: 0 }; node.dirs.set(part, next); }
      next.count++;
      node = next;
    }
    node.tracks.push(t);
  }
  for (const r of rootList) { const d = byRoot.get(r); if (d) top.push(d); }
  if (other.count) top.push(other);
  return top;
}
function collect(d: Dir): Track[] {
  const sortT = (a: Track, b: Track) => (a.discNo ?? 0) - (b.discNo ?? 0) || (a.trackNo ?? 0) - (b.trackNo ?? 0) || a.path.localeCompare(b.path);
  return [...[...d.tracks].sort(sortT), ...[...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).flatMap(collect)];
}
function TreeNode({ d, depth, open, toggle }: { d: Dir; depth: number; open: Set<string>; toggle: (p: string) => void }) {
  const key = d.path || d.name;
  const isOpen = open.has(key);
  const kids = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...d.tracks].sort((a, b) => (a.trackNo ?? 0) - (b.trackNo ?? 0) || a.path.localeCompare(b.path));
  return (
    <>
      <div className="ftree-row" style={{ paddingLeft: 6 + depth * 16 }} onClick={() => toggle(key)} onDoubleClick={() => playItems(collect(d).map(trackToItem))}>
        <span className="ftree-tw"><Icon name={isOpen ? "down" : "right"} size={12} /></span>
        <Icon name="folder" size={15} />
        <span className="ftree-name" title={d.path}>{d.name}</span>
        <span className="ftree-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn small" onClick={() => playItems(collect(d).map(trackToItem))}>Play</button>
          <button className="btn small" onClick={() => { enqueue(collect(d).map(trackToItem)); toast(`Queued ${d.count} tracks`); }}>Queue</button>
          {d.path && <button className="btn small" onClick={() => api.revealInExplorer(d.path)}>Open</button>}
        </span>
        <span className="ftree-count">{d.count}</span>
      </div>
      {isOpen && kids.map((k) => <TreeNode key={k.path} d={k} depth={depth + 1} open={open} toggle={toggle} />)}
      {isOpen && files.map((t) => (
        <div key={t.id} className="ftree-row ftree-track" style={{ paddingLeft: 26 + (depth + 1) * 16 }} onDoubleClick={() => playItems(files.map(trackToItem), files.indexOf(t))} title={t.path}>
          <Icon name="disc" size={13} />
          <span className="ftree-name">{t.trackNo ? `${String(t.trackNo).padStart(2, "0")}. ` : ""}{t.title}{t.artist ? ` — ${t.artist}` : ""}</span>
          <span className="ftree-count">{fmtTime(t.duration)}</span>
        </div>
      ))}
    </>
  );
}
function FolderTree({ roots }: { roots: string[] }) {
  const tracks = useStore((s) => s.tracks);
  const tree = useMemo(() => buildTree(tracks, roots), [tracks, roots]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(roots));
  const toggle = (p: string) => setOpen((o) => { const n = new Set(o); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  return (
    <Panel title="Browse by folder" actions={<span className="muted small">double-click a folder or song to play</span>}>
      {tree.length === 0 ? <p className="muted">No tracks yet.</p> : <div className="ftree">{tree.map((d) => <TreeNode key={d.path || d.name} d={d} depth={0} open={open} toggle={toggle} />)}</div>}
    </Panel>
  );
}

function Folders() {
  const [folders, setFolders] = useState<string[]>([]);
  const reload = () => api.libraryFolders().then(setFolders);
  useEffect(() => {
    reload();
  }, []);
  return (
    <>
    <Panel title="Watched folders" actions={<button className="btn" onClick={async () => {
      const d = await open({ directory: true, title: "Add music folder" });
      if (typeof d === "string") { await api.libraryAddFolder(d); reload(); }
    }}>Add folder</button>}>
      {folders.length === 0 && <p className="muted">No folders yet.</p>}
      {folders.map((f) => (
        <div key={f} className="folder-row">
          <Icon name="folder" size={16} /> <span>{f}</span>
          <button className="btn small" onClick={() => api.revealInExplorer(f)}>Open</button>
          <button className="btn small danger" onClick={async () => { await api.libraryRemoveFolder(f); reload(); }}>Remove</button>
        </div>
      ))}
    </Panel>
    <FolderTree roots={folders} />
    </>
  );
}

// ------------------------------------------------------------------ Queue
export function Queue() {
  const queue = useStore((s) => s.queue);
  const qi = useStore((s) => s.queueIndex);
  const [drag, setDrag] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    const q = [...queue];
    const [it] = q.splice(from, 1);
    q.splice(to, 0, it);
    let idx = qi;
    if (from === qi) idx = to;
    else if (from < qi && to >= qi) idx--;
    else if (from > qi && to <= qi) idx++;
    setState({ queue: q, queueIndex: idx });
  };
  const remove = (i: number) => {
    const q = queue.filter((_, k) => k !== i);
    setState({ queue: q, queueIndex: i < qi ? qi - 1 : i === qi ? Math.min(qi, q.length - 1) : qi });
  };
  const saveAs = async () => {
    const name = prompt("Playlist name", `Queue ${new Date().toLocaleDateString()}`);
    if (!name) return;
    const id = await api.playlistCreate(name);
    await api.playlistSetItems(id, queue);
    toast(`Saved playlist “${name}”`);
  };
  const total = queue.reduce((s, q) => s + (q.duration ?? 0), 0);
  return (
    <div className="view">
      <div className="toolbar">
        <h2 className="view-title">Queue <span className="muted">· {queue.length} items · {fmtTime(total)}</span></h2>
        <button className="btn" onClick={saveAs} disabled={!queue.length}>Save as playlist</button>
        <button className="btn danger" onClick={() => setState({ queue: [], queueIndex: -1 })}>Clear</button>
      </div>
      <div className="queue-list" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
        const raw = e.dataTransfer.getData("application/x-wa-items");
        if (raw && drag === null) enqueue(JSON.parse(raw));
      }}>
        {queue.map((it, i) => (
          <div key={i} className={`queue-row ${i === qi ? "current" : ""} ${i < qi ? "played" : ""}`} draggable
            onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.stopPropagation(); if (drag !== null && drag !== i) move(drag, i); setDrag(null); }}
            onDoubleClick={() => playIndex(i)}>
            <span className="grip"><Icon name="drag" size={14} /></span>
            <span className="qi-n">{i === qi ? <Icon name="play" size={12} /> : i + 1}</span>
            <span className={`src-badge ${it.kind}`}>{it.kind === "youtube" ? serviceById(itemService(it)).short.toUpperCase() : "LOCAL"}</span>
            <span className="qi-title">{it.title}</span>
            <span className="qi-artist">{it.artist}</span>
            <span className="qi-time">{it.duration ? fmtTime(it.duration) : ""}</span>
            <IconButton icon="close" title="Remove" size={14} onClick={() => remove(i)} />
          </div>
        ))}
        {!queue.length && <p className="muted pad">Queue is empty. Double-click tracks in the library or add songs from the Streaming tab.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Playlists
export function Playlists() {
  const [pls, setPls] = useState<Playlist[]>([]);
  const [open, setOpen] = useState<Playlist | null>(null);
  const [items, setItems] = useState<QueueItem[]>([]);
  const reload = () => api.playlists().then(setPls);
  useEffect(() => {
    reload();
  }, []);
  useEffect(() => {
    if (open) api.playlistItems(open.id).then(setItems);
  }, [open]);
  return (
    <div className="view playlists">
      <div className="pl-side">
        <button className="btn primary" onClick={async () => {
          const name = prompt("New playlist name");
          if (name) { await api.playlistCreate(name); reload(); }
        }}><Icon name="plus" size={14} /> New playlist</button>
        {pls.map((p) => (
          <button key={p.id} className={`pl-row ${open?.id === p.id ? "on" : ""}`} onClick={() => setOpen(p)}>
            <Icon name="playlists" size={16} /> <span>{p.name}</span> <span className="muted">{p.count}</span>
          </button>
        ))}
      </div>
      <div className="pl-main">
        {open ? (
          <Panel title={open.name} actions={<>
            <button className="btn" onClick={() => playItems(items)}><Icon name="play" size={14} /> Play</button>
            <button className="btn" onClick={() => enqueue(items)}>Enqueue</button>
            <button className="btn" onClick={async () => { const n = prompt("Rename playlist", open.name); if (n) { await api.playlistRename(open.id, n); reload(); setOpen({ ...open, name: n }); } }}>Rename</button>
            <button className="btn danger" onClick={async () => { if (confirm(`Delete playlist “${open.name}”?`)) { await api.playlistDelete(open.id); setOpen(null); reload(); } }}>Delete</button>
          </>}>
            {items.map((it, i) => (
              <div key={i} className="queue-row" onDoubleClick={() => playItems(items, i)}>
                <span className="qi-n">{i + 1}</span>
                <span className={`src-badge ${it.kind}`}>{it.kind === "youtube" ? serviceById(itemService(it)).short.toUpperCase() : "LOCAL"}</span>
                <span className="qi-title">{it.title}</span>
                <span className="qi-artist">{it.artist}</span>
                <IconButton icon="close" title="Remove from playlist" size={14} onClick={async () => {
                  const n = items.filter((_, k) => k !== i);
                  await api.playlistSetItems(open.id, n);
                  setItems(n);
                  reload();
                }} />
              </div>
            ))}
            {!items.length && <p className="muted">Empty playlist. Select tracks in the library and choose “Add to playlist”.</p>}
          </Panel>
        ) : (
          <p className="muted pad">Select a playlist. Playlists can mix local files and YouTube Music tracks.</p>
        )}
      </div>
    </div>
  );
}

export { useCover };
