/* DriftKord music-video view (runs inside a muted youtube.com page).
 *  - on a search results page: reports the video results so DriftKord can pick the official video
 *  - on a watch page: shows only the video, full-window, skips ads, and reports its time 4×/s
 *  - window.__DKV: play / pause / seek / rate, driven by DriftKord to stay in sync with your music
 */
(function () {
  'use strict';
  if (window.__DKV || window.top !== window) return;
  const post = (o) => { try { window.chrome.webview.postMessage('DKV:' + JSON.stringify(o)); } catch (_) {} };

  const CSS = `
    html.dkv, html.dkv body { background: #000 !important; overflow: hidden !important; }
    html.dkv #masthead-container, html.dkv #secondary, html.dkv #below, html.dkv ytd-miniplayer, html.dkv tp-yt-app-drawer,
    html.dkv .ytp-chrome-bottom, html.dkv .ytp-chrome-top, html.dkv .ytp-gradient-top, html.dkv .ytp-gradient-bottom,
    html.dkv .ytp-pause-overlay, html.dkv .ytp-ce-element, html.dkv .ytp-cards-teaser, html.dkv .ytp-endscreen-content,
    html.dkv .ytp-watermark, html.dkv .iv-branding, html.dkv .ytp-paid-content-overlay, html.dkv .ytp-spinner,
    html.dkv .ytp-contextmenu, html.dkv .ytp-tooltip, html.dkv .caption-window, html.dkv .ytp-autonav-endscreen-countdown-overlay,
    html.dkv ytd-popup-container, html.dkv tp-yt-paper-dialog, html.dkv .ytp-ad-overlay-container { display: none !important; }
    html.dkv #movie_player, html.dkv .html5-video-player { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483646 !important; background: #000 !important; }
    html.dkv .html5-video-container { position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important; }
    html.dkv video { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; height: 100% !important; object-fit: contain !important; }
  `;
  function style() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.add('dkv');
    if (!document.getElementById('dkv-style')) {
      const s = document.createElement('style');
      s.id = 'dkv-style';
      s.textContent = CSS;
      (document.head || root).appendChild(s);
    }
  }
  style();
  document.addEventListener('DOMContentLoaded', style);

  // ---------------------------------------------------------------- search results
  const secs = (txt) => {
    if (!txt) return 0;
    const p = String(txt).split(':').map(Number);
    return p.reduce((a, b) => a * 60 + b, 0) || 0;
  };
  // Every video result in a search response (first page or a "more results" page), in order,
  // plus the token that asks YouTube for the next page.
  function collect(data) {
    const d = data || window.ytInitialData;
    if (!d) return null;
    const items = [];
    let next = '';
    const seen = new Set();
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 40) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
      const v = o.videoRenderer;
      if (v && v.videoId && !seen.has(v.videoId)) {
        seen.add(v.videoId);
        items.push({
          id: v.videoId,
          title: (v.title && v.title.runs && v.title.runs.map((r) => r.text).join('')) || '',
          channel: (v.ownerText && v.ownerText.runs && v.ownerText.runs[0] && v.ownerText.runs[0].text) || '',
          duration: secs(v.lengthText && v.lengthText.simpleText),
          verified: !!(v.ownerBadges && JSON.stringify(v.ownerBadges).match(/VERIFIED|OFFICIAL_ARTIST/)),
        });
        return;
      }
      const c = o.continuationItemRenderer;
      if (c) {
        const t = c.continuationEndpoint && c.continuationEndpoint.continuationCommand && c.continuationEndpoint.continuationCommand.token;
        if (t) next = t;
        return;
      }
      for (const k in o) if (k !== 'videoRenderer') walk(o[k], depth + 1);
    };
    walk(d.contents || d.onResponseReceivedCommands || d, 0);
    if (!items.length && !next && !(d.contents || d.onResponseReceivedCommands)) return null;
    items.next = next;
    return items;
  }
  if (location.pathname === '/results') {
    let tries = 0;
    const tick = () => {
      const items = collect();
      if (items) post({ kind: 'results', query: new URLSearchParams(location.search).get('search_query') || '', items });
      else if (tries++ < 50) setTimeout(tick, 200);
      else post({ kind: 'results', query: '', items: [] });
    };
    tick();
  }

  // ---------------------------------------------------------------- watch page
  const video = () => document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video') || document.querySelector('video');
  // YouTube's blocking dialogs: cookie consent (we pick "Reject all"), "ad blockers are not allowed",
  // "video paused. Continue watching?". Returns a short reason when something blocks playback.
  function unblock() {
    if (/(^|\.)consent\.(youtube|google)\.com$/.test(location.hostname)) {
      const b = [...document.querySelectorAll('button, input[type=submit]')].find((x) => /reject all|alle ablehnen|tout refuser|rechazar todo/i.test(x.textContent || x.value || ''));
      if (b) b.click();
      return 'YouTube cookie consent page';
    }
    const wall = document.querySelector('ytd-enforcement-message-view-model, tp-yt-paper-dialog ytd-enforcement-message-view-model');
    if (wall) {
      const close = wall.querySelector('#dismiss-button button, button[aria-label*="lose" i], #dismiss-button, yt-button-shape button');
      if (close) close.click();
      return 'YouTube ad-blocker warning';
    }
    const still = [...document.querySelectorAll('yt-confirm-dialog-renderer, ytd-popup-container tp-yt-paper-dialog')].find((d) => /continue watching|still watching/i.test(d.textContent || ''));
    if (still) { const b = still.querySelector('#confirm-button button, #confirm-button, button'); if (b) b.click(); }
    const p = document.getElementById('movie_player');
    const pr = p && typeof p.getPlayerResponse === 'function' ? p.getPlayerResponse() : null;
    const ps = pr && pr.playabilityStatus;
    if (ps && ps.status && ps.status !== 'OK') return (ps.reason || ps.status).toString().slice(0, 120);
    const err = document.querySelector('.ytp-error-content-wrap-reason, .ytp-error .ytp-error-content');
    if (err && err.offsetParent && err.textContent.trim()) return err.textContent.trim().slice(0, 120);
    return '';
  }
  let lastReason = '';

  // ---- video quality. YouTube's "auto" picks from the player's size, which is small while the view
  // waits off-screen, so a fixed choice is held instead (remembered for this page across reloads).
  const QUALITY_ORDER = ['tiny', 'small', 'medium', 'large', 'hd720', 'hd1080', 'hd1440', 'hd2160', 'highres'];
  let wantQ = 'hd1080';
  try { wantQ = localStorage.getItem('dkvQuality') || 'hd1080'; } catch (_) {}
  let lastQApply = 0;
  function pickQuality(levels) {
    const avail = (levels || []).filter((l) => QUALITY_ORDER.includes(l));
    if (!avail.length) return '';
    if (wantQ === 'max') return avail.slice().sort((a, b) => QUALITY_ORDER.indexOf(b) - QUALITY_ORDER.indexOf(a))[0];
    const cap = QUALITY_ORDER.indexOf(wantQ);
    const ok = avail.filter((l) => QUALITY_ORDER.indexOf(l) <= cap).sort((a, b) => QUALITY_ORDER.indexOf(b) - QUALITY_ORDER.indexOf(a));
    return ok[0] || avail.sort((a, b) => QUALITY_ORDER.indexOf(a) - QUALITY_ORDER.indexOf(b))[0];
  }
  function applyQuality(force) {
    const p = document.getElementById('movie_player');
    if (!p || typeof p.getAvailableQualityLevels !== 'function') return;
    if (!force && Date.now() - lastQApply < 1500) return;
    lastQApply = Date.now();
    try {
      if (wantQ === 'auto') {
        if (force && p.setPlaybackQualityRange) p.setPlaybackQualityRange('auto', 'auto');
        return;
      }
      const q = pickQuality(p.getAvailableQualityLevels());
      if (!q) return;
      if (p.getPlaybackQuality && p.getPlaybackQuality() === q && !force) return;
      if (p.setPlaybackQualityRange) p.setPlaybackQualityRange(q, q);
      if (p.setPlaybackQuality) p.setPlaybackQuality(q);
    } catch (_) {}
  }

  let wantPlaying = false;
  let stuck = { id: '', since: 0, tries: 0 };
  let wasAd = false;
  setInterval(() => {
    const reason = unblock();
    if (reason !== lastReason) { lastReason = reason; post({ kind: 'diag', reason }); }
    if (location.pathname !== '/watch') return;
    style();
    const el = video();
    if (!el) return;
    el.muted = true;
    const player = document.getElementById('movie_player');
    const ad = !!(player && player.classList.contains('ad-showing'));
    if (ad) {
      // an ad: let it run muted (out of sight), fast-forward it to the end and press Skip when offered
      try {
        if (el.paused) el.play().catch(() => {});
        el.playbackRate = 16;
        if (isFinite(el.duration) && el.duration > 0 && el.currentTime < el.duration - 0.1) el.currentTime = el.duration - 0.05;
      } catch (_) {}
      const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, button[id^="skip-button"], .ytp-ad-skip-button-container button');
      if (skip) skip.click();
      wasAd = true;
    } else if (wasAd) {
      wasAd = false;
      el.playbackRate = 1; // back to normal for the real video (DriftKord's sync adjusts it from here)
    } else if (wantPlaying && el.paused && !el.ended) {
      el.play().catch(() => {});
    } else if (!wantPlaying && !el.paused) {
      el.pause();
    }
    const vd = player && typeof player.getVideoData === 'function' ? player.getVideoData() : null;
    // a video that won't start (player stuck before the first frame): nudge it, then reload the page
    const vid = (vd && vd.video_id) || '';
    if (vid !== stuck.id) stuck = { id: vid, since: Date.now(), tries: 0 };
    if (el.readyState >= 2 || ad) stuck.since = Date.now();
    else if (vid && Date.now() - stuck.since > 4500) {
      stuck.since = Date.now();
      stuck.tries++;
      if (stuck.tries === 1) { try { player.loadVideoById({ videoId: vid, startSeconds: el.currentTime || 0 }); } catch (_) {} }
      else if (stuck.tries === 2) { location.assign('/watch?v=' + encodeURIComponent(vid)); }
    }
    if (!ad) applyQuality(false);
    let q = '', lv = [];
    try { q = player.getPlaybackQuality ? player.getPlaybackQuality() : ''; lv = player.getAvailableQualityLevels ? player.getAvailableQualityLevels() : []; } catch (_) {}
    post({ kind: 'state', id: (vd && vd.video_id) || new URLSearchParams(location.search).get('v'), t: el.currentTime, d: isFinite(el.duration) ? el.duration : 0, paused: el.paused, ended: el.ended, ready: el.readyState >= 2 && !ad, ad, w: el.videoWidth, h: el.videoHeight, q, lv });
  }, 250);

  // Search through YouTube's own data endpoint from inside this page: a small JSON request instead
  // of loading a whole results page (much faster).
  async function search(q, tag, cont) {
    // only a loaded YouTube page can search; elsewhere (blank page while loading) stay quiet so the
    // pending search is retried once YouTube has loaded
    if (!/(^|\.)youtube\.com$/.test(location.hostname)) return false;
    try {
      for (let i = 0; i < 40 && !(window.ytcfg && window.ytcfg.get && window.ytcfg.get('INNERTUBE_API_KEY')); i++) await new Promise((r) => setTimeout(r, 200));
      const cfg = window.ytcfg && window.ytcfg.get ? window.ytcfg : null;
      const key = cfg && cfg.get('INNERTUBE_API_KEY');
      const ctx = cfg && cfg.get('INNERTUBE_CONTEXT');
      if (!key || !ctx) throw new Error(unblock() || 'YouTube page did not load');
      const r = await fetch('/youtubei/v1/search?prettyPrint=false&key=' + encodeURIComponent(key), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cont ? { context: ctx, continuation: cont } : { context: ctx, query: q, params: 'EgIQAQ==' }),
      });
      const j = await r.json();
      const items = collect(j) || [];
      post({ kind: 'results', query: q, tag: tag || '', items, next: items.next || '' });
      return true;
    } catch (e) {
      post({ kind: 'results', query: q, tag: tag || '', items: null, error: String(e) });
      return false;
    }
  }
  // Switch to another video inside the existing player (no page reload).
  function load(id, start) {
    const p = document.getElementById('movie_player');
    if (location.pathname !== '/watch' || !p || typeof p.loadVideoById !== 'function') return false;
    try {
      // already on this video (a repeated request): just move to the right spot
      const cur = p.getVideoData && p.getVideoData();
      const el = video();
      if (cur && cur.video_id === id && el && el.readyState >= 2) { el.currentTime = Math.max(0, start || 0); return true; }
      p.loadVideoById({ videoId: id, startSeconds: Math.max(0, start || 0), suggestedQuality: wantQ === 'max' ? 'highres' : wantQ });
      setTimeout(() => applyQuality(true), 600);
      setTimeout(() => applyQuality(true), 2500);
      history.replaceState(history.state, '', '/watch?v=' + encodeURIComponent(id));
      return true;
    } catch (_) { return false; }
  }

  window.__DKV = {
    search,
    load,
    play() { wantPlaying = true; const el = video(); if (el) el.play().catch(() => {}); },
    pause() { wantPlaying = false; const el = video(); if (el) el.pause(); },
    seek(t) { const el = video(); if (el && isFinite(t)) el.currentTime = Math.max(0, t); },
    rate(r) { const el = video(); if (el) el.playbackRate = Math.max(0.5, Math.min(2, r)); },
    quality(q) {
      wantQ = q === 'max' || q === 'auto' || QUALITY_ORDER.includes(q) ? q : 'hd1080';
      try { localStorage.setItem('dkvQuality', wantQ); } catch (_) {}
      applyQuality(true);
    },
  };
})();
