/* DriftKord bridge for Spotify, Apple Music, TIDAL and Amazon Music web players.
 * Runs at the start of every document in the embedded service view. `window.__DK_SERVICE` is set
 * by the host just before this script. It only observes and remote-controls the page's own player:
 *  - finds the playing media element (including detached `new Audio()` elements) by watching play()
 *  - reads now-playing info from the Media Session API the service already publishes
 *  - drives play/pause/next/prev/seek through the service's own Media Session handlers or buttons
 * Audio is never captured or modified here: these services' streams are DRM-protected.
 */
(function () {
  'use strict';
  if (window.__WA || window.top !== window) return;
  const SERVICE = window.__DK_SERVICE || 'web';

  // ------------------------------------------------------------ media elements
  const elements = new Set();
  let current = null;
  let ended = false;
  let announced = ''; // song last reported as 'play'
  function track(el) {
    if (!el || elements.has(el)) return;
    elements.add(el);
    el.addEventListener('play', () => { current = el; ended = false; report('play'); });
    el.addEventListener('pause', () => { if (el === current) report('pause'); });
    el.addEventListener('ended', () => { if (el === current) { ended = true; report('ended'); } });
    el.addEventListener('loadedmetadata', () => { if (el === current) report('state'); });
  }
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    track(this);
    current = this;
    return origPlay.apply(this, arguments);
  };
  function scan() { document.querySelectorAll('audio,video').forEach(track); }
  // Services keep short looping helper clips (silence/keep-alive) next to the real stream; those
  // must never be taken for the song, or the song length shows as a few seconds that keep looping.
  function isHelper(el) {
    const d = el.duration;
    return el.loop || (isFinite(d) && d > 0 && d < 20);
  }
  function score(el) {
    let s = 0;
    if (!el.paused) s += 4;
    if (!isHelper(el)) s += 2;
    if (el.readyState > 0) s += 1;
    return s;
  }
  function media() {
    let best = null, bestScore = -1;
    for (const el of elements) {
      const sc = score(el) + (el === current ? 0.5 : 0);
      if (sc > bestScore) { best = el; bestScore = sc; }
    }
    if (best) current = best;
    return best;
  }

  // ------------------------------------------------------------ Media Session (metadata, handlers, position)
  const actions = {};
  let posState = null; // { duration, position, rate, at }
  const ms = navigator.mediaSession;
  if (ms) {
    // patch the prototype as well as the instance, whichever way the page calls them
    const proto = Object.getPrototypeOf(ms);
    try {
      const origSet = proto.setActionHandler;
      proto.setActionHandler = function (action, handler) {
        actions[action] = handler;
        return origSet.call(this, action, handler);
      };
    } catch (_) {}
    try {
      const origPos = proto.setPositionState;
      if (origPos) {
        proto.setPositionState = function (st) {
          if (st && isFinite(st.duration) && st.duration > 0) posState = { duration: st.duration, position: st.position || 0, rate: st.playbackRate || 1, at: performance.now() };
          else posState = null;
          return origPos.call(this, st);
        };
      }
    } catch (_) {}
  }
  /** Is the song playing? The page's own Media Session state is the most reliable signal. */
  function isPlaying(el) {
    const st = ms && ms.playbackState;
    if (st === 'playing') return true;
    if (st === 'paused') return false;
    return !!(el && !el.paused && !isHelper(el));
  }

  // ------------------------------------------------------------ the service's own time display
  const TIME_SELECTORS = {
    spotify: ['[data-testid="playback-position"]', '[data-testid="playback-duration"]'],
    tidal: ['[data-test="current-time"]', '[data-test="duration"]'],
    apple: ['.playback-time .playback-time__current, [data-testid="playback-time-current"]', '.playback-time .playback-time__total, [data-testid="playback-time-total"]'],
    amazon: ['[data-testid="PlaybackPosition"], [data-testid="Transport_ElapsedTime"]', '[data-testid="PlaybackDuration"], [data-testid="Transport_Duration"]'],
  };
  function parseTime(s) {
    if (!s) return NaN;
    const neg = /^\s*[-−]/.test(s);
    const m = s.match(/(\d+):(\d{2})(?::(\d{2}))?/);
    if (!m) return NaN;
    const v = m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
    return neg ? -v : v;
  }
  function domRaw() {
    const sel = TIME_SELECTORS[SERVICE];
    if (!sel) return null;
    const p = parseTime(document.querySelector(sel[0])?.textContent);
    let d = parseTime(document.querySelector(sel[1])?.textContent);
    if (!isFinite(p) || !isFinite(d)) return null;
    if (d < 0) d = p - d; // "remaining time" display
    return d > 0 ? { position: Math.min(p, d), duration: d } : null;
  }
  // The page only shows whole seconds. Sample it 10×/s and remember the moment the number ticks
  // over: that moment is exactly "N.0 s", so the position between ticks is known to ~0.1 s.
  let anchor = null; // { p, d, at }
  setInterval(() => {
    const r = domRaw();
    if (!r) { anchor = null; return; }
    if (!anchor || r.position !== anchor.p || r.duration !== anchor.d) anchor = { p: r.position, d: r.duration, at: performance.now(), fresh: !!anchor && r.position === anchor.p + 1 };
  }, 100);
  function domTime() {
    const r = domRaw();
    if (!r) return null;
    if (!anchor || anchor.p !== r.position) return r;
    // only trust the sub-second phase when we actually saw the tick happen
    const frac = anchor.fresh && isPlaying(media()) ? Math.min(0.999, (performance.now() - anchor.at) / 1000) : 0;
    return { position: Math.min(r.duration, r.position + frac), duration: r.duration };
  }
  function act(name, extra) {
    const h = actions[name];
    if (!h) return false;
    try { h(Object.assign({ action: name }, extra || {})); return true; } catch (_) { return false; }
  }

  // ------------------------------------------------------------ the service's own transport controls
  const BAR_SELECTORS = [
    'aside[data-testid="now-playing-bar"]', // Spotify
    '[data-testid="chrome-player"]', // Apple Music
    '[data-test="footer-player"]', '#footerPlayer', // TIDAL
    '[data-testid="Transport"]', '[data-testid="NowPlayingBar"]', 'music-transport', '#transport', // Amazon Music
  ];
  const CONTROLS = {
    spotify: { next: '[data-testid="control-button-skip-forward"]', prev: '[data-testid="control-button-skip-back"]', toggle: '[data-testid="control-button-playpause"]', progress: '[data-testid="playback-progressbar"]' },
    tidal: { next: '[data-test="next"]', prev: '[data-test="previous"]', toggle: '[data-test="play"], [data-test="pause"]', progress: '[data-test="progress-bar"], [data-test="interaction-layer"]' },
    apple: { progress: '[data-testid="chrome-player"] input[type="range"], amp-lcd input[type="range"], [data-testid="chrome-player"] [role="slider"]' },
    amazon: { progress: '[data-testid*="rogress" i], [data-testid*="Scrubber" i], [data-testid*="Seek" i]' },
  };
  const LABELS = {
    next: /^(next|skip forward|skip to next|next track|next song)\b/i,
    prev: /^(previous|prev|skip back|skip to previous|previous track|previous song)\b/i,
    toggle: /^(play|pause)\b/i,
  };
  const label = (b) => (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim();
  /** The service's player bar (known selector, or the strip that holds previous + play + next). */
  function playerBar() {
    for (const s of BAR_SELECTORS) { const e = document.querySelector(s); if (e) return e; }
    return document.querySelector('[data-dk-bar]');
  }
  function control(kind) {
    const sel = (CONTROLS[SERVICE] || {})[kind];
    if (sel) { const e = document.querySelector(sel); if (e) return e; }
    // by label, inside the player bar only (pages also have "Next" buttons for carousels and history)
    const bar = playerBar();
    if (!bar || !LABELS[kind]) return null;
    return [...bar.querySelectorAll('button,[role="button"],music-button')].find((b) => LABELS[kind].test(label(b))) || null;
  }
  function click(kind) {
    const b = control(kind);
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
    b.click();
    return true;
  }
  const songKey = () => { const md = ms && ms.metadata; return md ? (md.title || '') + '|' + (md.artist || '') : ''; };
  /** Skip with the service's own button; if that isn't there or nothing changes, use its Media
   *  Session handler (each is tried once, never both blindly, so a song is never skipped twice). */
  function skip(kind) {
    const action = kind === 'next' ? 'nexttrack' : 'previoustrack';
    const before = songKey();
    const t0 = timing(media()).position;
    const changed = () => songKey() !== before || timing(media()).position < Math.min(t0, 3) - 0.5 || (kind === 'prev' && t0 > 4 && timing(media()).position < 3);
    if (click(kind)) {
      setTimeout(() => { if (!changed()) act(action); }, 1500);
    } else if (!act(action)) {
      return;
    }
    setTimeout(() => report('state'), 600);
  }

  // ------------------------------------------------------------ seeking
  function fireMouse(target, type, x, y) {
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type.endsWith('up') ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window }));
  }
  /** Seek through the service's own progress bar (a range input, or a slider clicked at a spot). */
  function seekByBar(frac) {
    const sel = (CONTROLS[SERVICE] || {}).progress;
    const root = (sel && document.querySelector(sel)) || null;
    const bar = playerBar();
    const scope = root || bar;
    if (!scope) return false;
    const range = scope.matches('input[type="range"]') ? scope : [...scope.querySelectorAll('input[type="range"]')].find((r) => !/volume/i.test(label(r) + ' ' + (r.closest('[class*="olume"],[data-testid*="olume"]') ? 'volume' : '')));
    if (range && +range.max > 0 && !/volume/i.test(label(range))) {
      const max = +range.max, min = +range.min || 0;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(range, String(min + (max - min) * frac));
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
      // some players commit the seek on pointer release
      const r = range.getBoundingClientRect();
      if (r.width > 0) { const x = r.left + r.width * frac, y = r.top + r.height / 2; fireMouse(range, 'pointerup', x, y); fireMouse(range, 'mouseup', x, y); }
      return true;
    }
    const slider = scope.matches('[role="slider"]') ? scope : root || [...scope.querySelectorAll('[role="slider"],[class*="progress" i],[class*="scrub" i]')].filter((e) => !/volume/i.test(label(e) + ' ' + (e.className || '')) && e.getBoundingClientRect().width > 80).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    if (!slider) return false;
    const r = slider.getBoundingClientRect();
    if (r.width <= 0) return false;
    const x = r.left + r.width * frac, y = r.top + r.height / 2;
    for (const type of ['pointerdown', 'mousedown', 'pointermove', 'mousemove', 'pointerup', 'mouseup', 'click']) fireMouse(slider, type, x, y);
    return true;
  }

  // ------------------------------------------------------------ reporting
  function post(msg) {
    try { window.chrome.webview.postMessage('WAYT:' + JSON.stringify(msg)); } catch (_) {}
  }
  /** Song position and length: Media Session position state → the service's own time display →
   *  the media element (only when it really holds the whole song). */
  function timing(el) {
    if (posState) {
      const p = posState.position + (isPlaying(el) ? ((performance.now() - posState.at) / 1000) * posState.rate : 0);
      return { position: Math.max(0, Math.min(posState.duration, p)), duration: posState.duration };
    }
    const dom = domTime();
    if (dom) return dom;
    if (el && !isHelper(el) && isFinite(el.duration)) return { position: el.currentTime, duration: el.duration };
    return { position: 0, duration: 0 };
  }
  function report(kind) {
    const el = media();
    const t = timing(el);
    const md = ms && ms.metadata;
    const title = md && md.title ? md.title : '';
    const artist = md && md.artist ? md.artist : '';
    if (kind === 'play' && title) announced = title + '|' + artist;
    let art = null;
    if (md && md.artwork && md.artwork.length) {
      let best = md.artwork[0], bestSize = 0;
      for (const a of md.artwork) {
        const n = parseInt(String(a.sizes || '0').split('x')[0], 10) || 0;
        if (n >= bestSize) { best = a; bestSize = n; }
      }
      art = best.src || null;
    }
    post({
      kind: kind || 'state',
      service: SERVICE,
      videoId: title ? 'svc:' + SERVICE + ':' + title + '|' + artist : null,
      title,
      artist,
      album: md && md.album ? md.album : '',
      artUrl: art,
      position: t.position,
      duration: t.duration,
      paused: !isPlaying(el),
      volume: el ? el.volume : 1,
      adsSkipped: 0,
      routed: false,
      url: location.href,
    });
  }
  let lastSig = '';
  setInterval(() => {
    scan();
    const el = media();
    const md = ms && ms.metadata;
    const song = md && md.title ? md.title + '|' + (md.artist || '') : '';
    const playing = isPlaying(el);
    const sig = song + playing;
    ensureStyle();
    if (integrated) hideBars();
    if (playing && song && song !== announced) {
      // a new song is playing (or its details just arrived): announce it like a fresh play
      announced = song;
      report('play');
    } else if (playing || sig !== lastSig) {
      // report every second while playing, and whenever the play state changes
      report('state');
    }
    lastSig = sig;
  }, 1000);

  // ------------------------------------------------------------ hide the service's own player bar
  // When DriftKord's player bar is in charge ("DriftKord controls"), the page's duplicate transport is
  // hidden. It stays in the page (only invisible), so the service keeps working normally.
  let integrated = false;
  function hideBars() {
    // fallback for layouts without a known selector: the slim, wide strip that holds the
    // previous + play/pause + next buttons together
    const nexts = [...document.querySelectorAll('button,[role="button"]')].filter((b) => LABELS.next.test(label(b)) && b.getBoundingClientRect().width > 0);
    for (const nx of nexts) {
      let el = nx.parentElement, bar = null;
      while (el && el !== document.body) {
        const r = el.getBoundingClientRect();
        if (r.height > 140) break;
        const btns = [...el.querySelectorAll('button,[role="button"]')].map(label);
        if (btns.some((l) => LABELS.prev.test(l)) && btns.some((l) => /^(play|pause)/i.test(l)) && r.width >= innerWidth * 0.4) bar = el;
        el = el.parentElement;
      }
      if (bar) bar.setAttribute('data-dk-bar', '');
    }
  }
  let style = null;
  function ensureStyle() {
    const root = document.documentElement;
    if (!root) return;
    if (!style) {
      style = document.createElement('style');
      style.textContent = 'html.dk-integrated [data-dk-bar],' + BAR_SELECTORS.map((s) => 'html.dk-integrated ' + s).join(',') + '{position:fixed!important;left:0!important;right:0!important;bottom:0!important;top:auto!important;opacity:0!important;pointer-events:none!important;z-index:-1!important}';
    }
    if (!style.isConnected) (document.head || root).appendChild(style);
    root.classList.toggle('dk-integrated', integrated);
  }

  // ------------------------------------------------------------ remote control API
  let fadeTimer = null;
  window.__WA = {
    // Prefer the service's own Media Session handlers (they keep its UI and queue in step); if one
    // doesn't take effect, act on the playing element directly.
    play() {
      const el = media();
      if (isPlaying(el)) return;
      const acted = act('play');
      if (!el || isHelper(el)) { if (!acted) click('toggle'); return; }
      setTimeout(() => { if (el.paused) el.play().catch(() => click('toggle')); }, 400);
    },
    pause() {
      const el = media();
      if (!isPlaying(el)) return;
      const acted = act('pause');
      if (!el || isHelper(el)) { if (!acted) click('toggle'); return; }
      setTimeout(() => { if (!el.paused) el.pause(); }, 400);
    },
    toggle() { if (isPlaying(media())) window.__WA.pause(); else window.__WA.play(); },
    next() { skip('next'); },
    prev() { skip('prev'); },
    seek(t) {
      // 1. the service's own seek handler  2. the song's media element (when it holds the whole song)
      // 3. the service's progress bar. Each next step only runs if the previous one didn't land.
      const el = media();
      const dur = timing(el).duration;
      const near = () => Math.abs(timing(media()).position - t) < 3 || (el && !isHelper(el) && Math.abs(el.currentTime - t) < 3);
      const songElement = el && !isHelper(el) && isFinite(el.duration) && el.duration > 20 && (!dur || Math.abs(el.duration - dur) < 3);
      const steps = [];
      if (actions.seekto) steps.push(() => act('seekto', { seekTime: t, fastSeek: false }));
      if (songElement) steps.push(() => { el.currentTime = t; return true; });
      if (dur > 0) steps.push(() => seekByBar(Math.max(0, Math.min(1, t / dur))));
      const run = (k) => {
        while (k < steps.length && !steps[k]()) k++;
        if (k >= steps.length) return;
        setTimeout(() => { if (!near()) run(k + 1); else report('state'); }, 700);
      };
      run(0);
    },    debug() {
      const el = media();
      return JSON.stringify({ actions: Object.keys(actions), posState, dom: domTime(), timing: timing(el), playing: isPlaying(el), song: songKey(),
        els: [...elements].map((e) => ({ paused: e.paused, t: e.currentTime, d: e.duration, loop: e.loop })),
        bar: !!playerBar(), next: !!control('next'), prev: !!control('prev'), progress: !!((CONTROLS[SERVICE] || {}).progress && document.querySelector(CONTROLS[SERVICE].progress)) });
    },
    volume(x) { const v = Math.max(0, Math.min(1, x)); elements.forEach((el) => { el.volume = v; }); },
    fade(to, ms2) {
      const el = media(); if (!el) return;
      clearInterval(fadeTimer);
      const from = el.volume, start = performance.now();
      fadeTimer = setInterval(() => {
        const t = Math.min(1, (performance.now() - start) / Math.max(1, ms2));
        el.volume = from + (to - from) * t;
        if (t >= 1) { clearInterval(fadeTimer); if (to === 0) window.__WA.pause(); }
      }, 30);
    },
    startSilent() { elements.forEach((el) => { el.volume = 0; }); },
    report,
    route() {},
    integrate(on) { integrated = !!on; ensureStyle(); if (integrated) hideBars(); },
  };
})();
