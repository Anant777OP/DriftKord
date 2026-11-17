/* DriftKord — YouTube Music companion script.
 * Injected at document start into the YouTube Music window only.
 *  1. Scriptlets: prune ad payloads from player/next/browse JSON (fetch, XHR, JSON.parse, ytInitialPlayerResponse)
 *  2. Cosmetic filters: hide promo banners / ad slots / upsell dialogs
 *  3. Ad-skipper fallback: if an ad still renders, mute + fast-forward + click "Skip"
 *  4. Now-playing bridge: posts state to the host app via window.chrome.webview.postMessage("WAYT:...")
 *  5. Remote control API (window.__WA) driven by the host app (play/pause/next/prev/seek/volume/fade)
 * Network-level blocking of ad/tracker domains is done natively in Rust (WebResourceRequested).
 */
(function () {
  'use strict';
  if (window.__WA) return;
  const host = location.hostname;
  if (!/(^|\.)youtube\.com$/.test(host)) return;

  // ---------------------------------------------------------------- 0. capture media-session actions
  // YouTube registers next/previous with the browser's media controls; keeping a handle on them lets
  // DriftKord skip tracks even when YouTube's own player bar is hidden or its markup changes.
  const mediaActions = {};
  try {
    const ms = navigator.mediaSession;
    const orig = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (action, handler) => { mediaActions[action] = handler; return orig(action, handler); };
  } catch (_) {}

  // ---------------------------------------------------------------- 1. JSON pruning scriptlets
  const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams', 'adSignalsInfo', 'adParams'];
  function prune(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 6) return obj;
    for (const k of AD_KEYS) if (k in obj) { try { delete obj[k]; } catch (_) {} }
    if (obj.playerResponse) prune(obj.playerResponse, depth + 1);
    if (Array.isArray(obj)) for (const v of obj) prune(v, depth + 1);
    else for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === 'object' && (k === 'response' || k === 'playerResponse' || k === 'contents' || depth < 2)) prune(v, depth + 1);
    }
    return obj;
  }
  const origParse = JSON.parse;
  JSON.parse = function () {
    const r = origParse.apply(this, arguments);
    try { if (r && typeof r === 'object' && (r.playerAds || r.adPlacements || r.playerResponse || r.adSlots)) prune(r, 0); } catch (_) {}
    return r;
  };
  for (const name of ['ytInitialPlayerResponse', 'ytInitialData']) {
    let value;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get() { return value; },
        set(v) { value = prune(v, 0); },
      });
    } catch (_) {}
  }
  const AD_ENDPOINTS = /\/youtubei\/v1\/(player|next|browse|reel)/;
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const res = await origFetch.apply(this, arguments);
    if (!AD_ENDPOINTS.test(url)) return res;
    try {
      const txt = await res.clone().text();
      const json = origParse(txt);
      prune(json, 0);
      return new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (_) { return res; }
  };
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  XHR.open = function (m, u) { this.__waUrl = u; return origOpen.apply(this, arguments); };
  const desc = Object.getOwnPropertyDescriptor(XHR, 'responseText');
  if (desc && desc.get) {
    Object.defineProperty(XHR, 'responseText', {
      configurable: true,
      get() {
        const t = desc.get.call(this);
        if (this.__waUrl && AD_ENDPOINTS.test(this.__waUrl)) {
          try { return JSON.stringify(prune(origParse(t), 0)); } catch (_) {}
        }
        return t;
      },
    });
  }

  // ---------------------------------------------------------------- 2. Cosmetic filters
  const css = `
    ytmusic-mealbar-promo-renderer, ytmusic-statement-banner-renderer, ytmusic-popup-container tp-yt-paper-dialog:has(ytmusic-mealbar-promo-renderer),
    .ytp-ad-module, .ytp-ad-overlay-container, .ytp-ad-image-overlay, .ytp-ad-text-overlay, .video-ads, #player-ads,
    ytd-ad-slot-renderer, ytd-promoted-sparkles-web-renderer, ytd-display-ad-renderer, ytd-banner-promo-renderer,
    ytmusic-premium-upsell-renderer, ytmusic-upsell-dialog-renderer, .ytmusic-upsell-dialog-renderer,
    ytd-companion-slot-renderer, ytd-action-companion-ad-renderer, ytd-in-feed-ad-layout-renderer,
    tp-yt-paper-dialog:has(ytmusic-upsell-dialog-renderer), #masthead-ad, ytd-rich-item-renderer:has(ytd-ad-slot-renderer)
    { display: none !important; }
    /* integrated mode: DriftKord's player bar replaces YouTube's */
    html.wa-integrated ytmusic-player-bar, html.wa-integrated #player-bar-background { display: none !important; }
    html.wa-integrated ytmusic-app-layout { --ytmusic-player-bar-height: 0px !important; }
    html.wa-integrated #content, html.wa-integrated ytmusic-app-layout #content { padding-bottom: 0 !important; }
  `;
  document.documentElement.classList.add('wa-integrated');
  function injectCss() {
    if (document.getElementById('__wa_css')) return;
    const s = document.createElement('style');
    s.id = '__wa_css';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }
  injectCss();
  document.addEventListener('DOMContentLoaded', injectCss);

  // ---------------------------------------------------------------- 3. Ad skipper fallback
  let adsSkipped = 0;
  function video() { return document.querySelector('video'); }
  function skipAds() {
    const player = document.querySelector('#movie_player, .html5-video-player');
    const v = video();
    const adShowing = player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'));
    if (adShowing && v) {
      v.muted = true;
      try { v.playbackRate = 16; } catch (_) {}
      if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration;
      adsSkipped++;
    } else if (v && v.playbackRate === 16) {
      v.playbackRate = 1;
      v.muted = false;
    }
    const btn = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, button.ytp-ad-skip-button-container');
    if (btn) btn.click();
    // dismiss "Are you still there?" / premium upsell dialogs
    const dismiss = document.querySelector('ytmusic-you-there-renderer button, tp-yt-paper-dialog ytmusic-upsell-dialog-renderer #dismiss-button');
    if (dismiss) dismiss.click();
  }
  setInterval(skipAds, 250);

  // ---------------------------------------------------------------- 4. Now-playing bridge
  function post(msg) {
    try { window.chrome.webview.postMessage('WAYT:' + JSON.stringify(msg)); } catch (_) {}
  }
  function videoId() {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get('v')) return u.searchParams.get('v');
    } catch (_) {}
    const a = document.querySelector('ytmusic-player-bar a.yt-simple-endpoint[href*="watch?v="]');
    if (a) { const m = /v=([\w-]{6,})/.exec(a.getAttribute('href')); if (m) return m[1]; }
    return null;
  }
  let lastEnded = false;
  function report(kind) {
    const v = video();
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : null;
    post({
      kind: kind || 'state',
      videoId: videoId(),
      title: md ? md.title : document.title.replace(/ - YouTube Music$/, ''),
      artist: md ? md.artist : '',
      album: md ? md.album : '',
      artUrl: art,
      position: v ? v.currentTime : 0,
      duration: v && isFinite(v.duration) ? v.duration : 0,
      paused: v ? v.paused : true,
      volume: v ? v.volume : 1,
      adsSkipped,
      routed: typeof routed !== 'undefined' ? routed : false,
      capture: typeof workletState !== 'undefined' ? (worklet ? 'worklet' : workletState) : 'none',
      url: location.href,
    });
  }
  setInterval(() => report('state'), 1000);
  document.addEventListener('ended', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') { lastEnded = true; report('ended'); }
  }, true);
  document.addEventListener('play', (e) => { if (e.target && e.target.tagName === 'VIDEO') { lastEnded = false; report('play'); } }, true);
  document.addEventListener('pause', (e) => { if (e.target && e.target.tagName === 'VIDEO') report('pause'); }, true);

  // ---------------------------------------------------------------- 4b. Route audio into DriftKord's engine
  // The <video> element's sound is taken into Web Audio (which also silences the page's own output),
  // converted to 16-bit PCM at 48 kHz and posted to the host, where the Rust engine plays it through
  // DriftKord's DSP chain and output device. Turning routing off sends audio straight to the speakers.
  let actx = null, srcNode = null, proc = null, sink = null, hooked = null, routed = false;
  let worklet = null, workletState = 'idle'; // idle | loading | ready | failed
  function toB64(i16) {
    const u8 = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function sendPcm(i16) {
    if (!routed || !hooked || hooked.paused) return;
    try { window.chrome.webview.postMessage('WAPCM:' + toB64(i16)); } catch (_) {}
  }
  function loadWorklet() {
    if (workletState !== 'idle' || !actx || !actx.audioWorklet) return;
    workletState = 'loading';
    actx.audioWorklet.addModule('/__driftkord__/capture.js').then(() => {
      worklet = new AudioWorkletNode(actx, 'dk-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      worklet.port.onmessage = (e) => sendPcm(e.data);
      workletState = 'ready';
      wire(); // switch from the fallback to the glitch-free capture
    }).catch(() => { workletState = 'failed'; });
  }
  function ensureSink() {
    if (!sink) {
      sink = actx.createGain();
      sink.gain.value = 0; // the page itself stays silent; DriftKord plays the audio
      sink.connect(actx.destination);
    }
  }
  function wire() {
    if (!srcNode) return;
    try { srcNode.disconnect(); } catch (_) {}
    if (proc) { try { proc.disconnect(); } catch (_) {} }
    if (worklet) { try { worklet.disconnect(); } catch (_) {} }
    if (!routed) { srcNode.connect(actx.destination); return; }
    ensureSink();
    if (worklet) {
      // preferred: capture on the real-time audio thread
      srcNode.connect(worklet);
      worklet.connect(sink);
      return;
    }
    // fallback while the worklet loads (or if it can't): main-thread capture
    if (!proc) {
      proc = actx.createScriptProcessor(4096, 2, 2);
      proc.onaudioprocess = (e) => {
        if (worklet) return;
        const ib = e.inputBuffer;
        const L = ib.getChannelData(0), R = ib.numberOfChannels > 1 ? ib.getChannelData(1) : L;
        const out = new Int16Array(L.length * 2);
        for (let i = 0; i < L.length; i++) {
          const l = Math.max(-1, Math.min(1, L[i])), r = Math.max(-1, Math.min(1, R[i]));
          out[i * 2] = l < 0 ? l * 32768 : l * 32767;
          out[i * 2 + 1] = r < 0 ? r * 32768 : r * 32767;
        }
        sendPcm(out);
      };
    }
    srcNode.connect(proc);
    proc.connect(sink);
  }  function hookVideo() {
    const v = video();
    if (!v) return false;
    if (!actx) actx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
    loadWorklet();
    if (hooked !== v) {
      try { srcNode = actx.createMediaElementSource(v); } catch (_) { return false; }
      hooked = v;
      ['seeking', 'emptied', 'loadstart'].forEach((ev) => v.addEventListener(ev, () => { if (routed) { try { window.chrome.webview.postMessage('WAPCMFLUSH'); } catch (_) {} } }));
      wire();
    }
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return true;
  }
  function setRoute(on) {
    routed = !!on;
    if (routed) {
      const v = video();
      if (v) v.volume = 1; // DriftKord's volume control takes over
      if (!hookVideo()) {
        // the player isn't on the page yet: retry until it is
        const iv = setInterval(() => { if (!routed || hookVideo()) clearInterval(iv); }, 500);
        return;
      }
    }
    wire();
  }
  // keep the hook when YouTube swaps its <video> element
  setInterval(() => { if (routed && video() && video() !== hooked) { hooked = null; srcNode = null; hookVideo(); } }, 1000);

  // ---------------------------------------------------------------- 5. Remote control API
  let fadeTimer = null;
  function click(sel) { const b = document.querySelector(sel); if (b) b.click(); return !!b; }
  window.__WA = {
    play() { const v = video(); if (v) v.play(); },
    pause() { const v = video(); if (v) v.pause(); },
    toggle() { const v = video(); if (v) (v.paused ? v.play() : v.pause()); },
    next() {
      if (mediaActions.nexttrack) { try { mediaActions.nexttrack({ action: 'nexttrack' }); return; } catch (_) {} }
      click('ytmusic-player-bar .next-button, .ytp-next-button, button[aria-label="Next"], [aria-label="Next song"]');
    },
    prev() {
      if (mediaActions.previoustrack) { try { mediaActions.previoustrack({ action: 'previoustrack' }); return; } catch (_) {} }
      click('ytmusic-player-bar .previous-button, .ytp-prev-button, button[aria-label="Previous"], [aria-label="Previous song"]');
    },
    seek(t) { const v = video(); if (v) v.currentTime = t; },
    volume(x) { const v = video(); if (v) v.volume = Math.max(0, Math.min(1, x)); },
    fade(to, ms) {
      const v = video(); if (!v) return;
      clearInterval(fadeTimer);
      const from = v.volume, start = performance.now();
      fadeTimer = setInterval(() => {
        const t = Math.min(1, (performance.now() - start) / Math.max(1, ms));
        v.volume = from + (to - from) * t;
        if (t >= 1) { clearInterval(fadeTimer); if (to === 0) v.pause(); }
      }, 30);
    },
    startSilent() {
      // used by the Auto-DJ: start the track at volume 0 so the host can fade it in
      const iv = setInterval(() => { const v = video(); if (v) { v.volume = 0; clearInterval(iv); } }, 50);
      setTimeout(() => clearInterval(iv), 5000);
    },
    report,
    route: setRoute,
  };
})();
