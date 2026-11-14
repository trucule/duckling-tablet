/* Duckling compatibility layer, written into every app package by tools/publish.mjs in place of voice-config.js.
   Three jobs, all invisible to the app:
   1. localStorage is namespaced per app. Every package runs on the same origin inside the shells, so without this
      two apps that both save "progress" would overwrite each other.
   2. speechSynthesis.speak goes to the Duckling narrator: GET /tts on the API with the device token. Clips are kept
      in IndexedDB, so a line heard once plays again at once and offline. Lines that contain the child's name are
      marked private and never stored on the server. When there is no shell, no connection, or the daily allowance is
      used up, the device voice speaks as before. The utterance events (start, boundary, end, error) still fire, so
      word highlighting and "then do the next thing" keep working. (Ported from the Surface project's kid-voice.js.)
   3. window.KidTablet gives apps that want it the app id, the child's first name and a say() helper.
   4. Calls the apps make to the Anthropic Messages API (Draw With Me lessons, Story Maker scenes) go to the
      Duckling API instead, POST /ai/messages with the device token; the server holds the key and applies the daily
      allowance. The apps read window.DWM_CONFIG.apiKey to decide whether AI is on, so a placeholder is set there.
      Calls to the Surface home screen's local service (KidHome, 127.0.0.1:47821) are answered by the child's profile
      on the server: the avatar, the portrait, the stars. Story Maker's direct Azure calls for its cast of voices
      become narrator requests with the voice and the speaking style.
   5. window.KID_STARS counts this app's stars and reports them; the server adds the other apps' stars.
   The shell provides window.DucklingApp (Android: a JavascriptInterface) with appId(), deviceToken(), apiUrl(),
   childName() and voice(). In a plain browser there is no DucklingApp and only the storage namespace applies. */
(function () {
  'use strict';
  var bridge = window.DucklingApp || null;
  function read(name, fallback) {
    try { var v = bridge && typeof bridge[name] === 'function' ? bridge[name]() : null; return v == null || v === '' ? fallback : String(v); } catch (e) { return fallback; }
  }
  var APP_ID = read('appId', (location.pathname.match(/\/apps\/([a-z0-9-]+)\//) || [])[1] || 'app');
  var TOKEN = read('deviceToken', '');
  var API = read('apiUrl', 'https://api.ducklingtablet.com').replace(/\/$/, '');
  var CHILD = read('childName', '');
  // The paired child's id. With it, everything an app saves (localStorage and IndexedDB) is kept per app and per
  // child: a child paired to this tablet later opens each app at her own grade and never sees an earlier child's
  // progress, stars, photos or recordings. Shells older than the child id keep per-app storage as before.
  var CHILD_ID = read('childId', '').replace(/[^A-Za-z0-9_-]/g, '');
  var VOICE = read('voice', 'en-US-AnaNeural');
  // The child's level per subject on one grade scale: -1 pre-K, 0 kindergarten, 1 to 8. Set by the parent (two years
  // below the child's age by default). Apps map it onto their own ladders with levelFor().
  var LEVELS = {};
  try { LEVELS = JSON.parse(read('levels', '{}')) || {}; } catch (e) {}
  var grade = function (subject) { var g = LEVELS[subject]; return typeof g === 'number' && isFinite(g) ? Math.max(-1, Math.min(8, Math.round(g))) : 2; };
  // Where a ladder of `count` levels starts for this child, given the index that fits a 2nd grader (`start2nd`):
  // pre-K opens at the bottom, 8th grade at the top, 2nd grade at start2nd, the rest in between.
  var levelFor = function (subject, count, start2nd) {
    if (!(count > 1)) return 0;
    var g = grade(subject), s = Math.max(0, Math.min(count - 1, start2nd | 0)), idx;
    if (g <= 2) idx = Math.round(s * (g + 1) / 3); else idx = Math.round(s + (count - 1 - s) * (g - 2) / 6);
    return Math.max(0, Math.min(count - 1, idx));
  };
  // Where a ladder starts when the app says which grade each rung is for: `grades` is one grade per rung, in ladder
  // order (-1 pre-K .. 8), and the child opens on the first rung meant for her grade. With no rung at her grade she
  // opens on the first rung above it, or the top rung when there is none above.
  var rungFor = function (subject, grades) {
    if (!grades || !grades.length) return 0;
    var g = grade(subject), i;
    for (i = 0; i < grades.length; i++) if (grades[i] >= g) return i;
    return grades.length - 1;
  };

  // ---- 1. Per-app localStorage ------------------------------------------------------------------------------------
  try {
    var real = window.localStorage, prefix = 'duckling:' + APP_ID + ':' + (CHILD_ID ? 'child=' + CHILD_ID + ':' : '');
    var ns = {
      getItem: function (k) { return real.getItem(prefix + k); },
      setItem: function (k, v) { real.setItem(prefix + k, v); },
      removeItem: function (k) { real.removeItem(prefix + k); },
      clear: function () { keys().forEach(function (k) { real.removeItem(prefix + k); }); },
      key: function (i) { return keys()[i] == null ? null : keys()[i]; },
      get length() { return keys().length; }
    };
    function keys() { var out = []; for (var i = 0; i < real.length; i++) { var k = real.key(i); if (k && k.indexOf(prefix) === 0) out.push(k.slice(prefix.length)); } return out; }
    Object.defineProperty(window, 'localStorage', { value: ns, configurable: true });
  } catch (e) { /* storage blocked: the app sees whatever the browser gives it */ }

  // ---- 1b. Per-app, per-child IndexedDB -----------------------------------------------------------------------------
  // Camera Fun's photos, Music Box and Voice Band recordings and Draw With Me's drawings live in IndexedDB, which every
  // package shares (one origin). Database names get the same app and child prefix as localStorage. The narrator's clip
  // cache below is shared on purpose (the same line sounds the same for every child) and opens through IDB_OPEN.
  var IDB_OPEN = null;
  try {
    var idb = window.indexedDB;
    if (idb) {
      IDB_OPEN = idb.open.bind(idb);
      if (CHILD_ID) {
        var idbPrefix = 'duckling:' + APP_ID + ':child=' + CHILD_ID + ':', del0 = idb.deleteDatabase.bind(idb), list0 = idb.databases ? idb.databases.bind(idb) : null;
        idb.open = function (name, version) { return version === undefined ? IDB_OPEN(idbPrefix + name) : IDB_OPEN(idbPrefix + name, version); };
        idb.deleteDatabase = function (name) { return del0(idbPrefix + name); };
        if (list0) idb.databases = function () { return list0().then(function (all) { return all.filter(function (d) { return d.name && d.name.indexOf(idbPrefix) === 0; }).map(function (d) { return { name: d.name.slice(idbPrefix.length), version: d.version }; }); }); };
      }
    }
  } catch (e) { /* IndexedDB blocked: apps fall back as they would in any browser */ }

  // ---- 3. The small bridge for apps that look for it -----------------------------------------------------------------
  window.KidTablet = {
    platform: bridge ? 'duckling' : 'browser', appId: APP_ID, childName: CHILD, narratorVoice: VOICE, levels: LEVELS, grade: grade, levelFor: levelFor, rungFor: rungFor,
    say: function (text, opts) { var u = new SpeechSynthesisUtterance(String(text)); if (opts && opts.rate) u.rate = opts.rate; window.speechSynthesis.speak(u); return u; },
    // Replaced below on a paired tablet; in a plain browser there is no home screen to change.
    setHomeBackground: function () { return Promise.reject(new Error('Only on a Duckling tablet.')); },
    clearHomeBackground: function () { return Promise.reject(new Error('Only on a Duckling tablet.')); }
  };

  // ---- 4. Services the Surface apps expected, served by the Duckling API ------------------------------------------
  // Anthropic calls (Draw With Me, Story Maker) go to POST /ai/messages. The Surface home screen's small local
  // service (KidHome at 127.0.0.1:47821: the avatar, the portrait, the star total) is answered by the child's profile
  // on the server, so My Avatar and the stars counter in every app work with no change, and the same avatar and stars
  // follow the child to any tablet.
  var realFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  if (bridge && TOKEN && realFetch) {
    var ANTHROPIC = /^https:\/\/api\.anthropic\.com\/v1\/messages\/?$/, KIDHOME = /^https?:\/\/127\.0\.0\.1:47821(\/[^?#]*)?/;
    var AUTH = { authorization: 'Device ' + TOKEN, 'x-duckling-app': APP_ID };
    var api = function (method, path, body, type) {
      var h = Object.assign({}, AUTH); if (type) h['content-type'] = type;
      return realFetch(API + path, { method: method, headers: h, body: body, mode: 'cors', credentials: 'omit' });
    };
    // Story Maker's cast: it speaks to Azure directly with the key from DWM_CONFIG.tts; here the "key" is a marker and
    // the region "duckling", so its requests land on the Duckling API's narrator endpoint with the voice and style.
    window.DWM_CONFIG = Object.assign({}, window.DWM_CONFIG || {}, { apiKey: 'duckling', tts: { provider: 'azure', key: 'duckling', region: 'duckling' } });
    var AZURE_TTS = /^https:\/\/duckling\.tts\.speech\.microsoft\.com\/cognitiveservices\/(v1|voices\/list)\/?$/;
    var CAST = [['en-US-AnaNeural', 'Female', 'Child'], ['en-US-JennyNeural', 'Female', ''], ['en-US-AriaNeural', 'Female', ''], ['en-US-SaraNeural', 'Female', ''], ['en-US-NancyNeural', 'Female', ''], ['en-US-MichelleNeural', 'Female', ''], ['en-US-AmberNeural', 'Female', ''], ['en-US-AshleyNeural', 'Female', ''], ['en-US-CoraNeural', 'Female', ''], ['en-US-MonicaNeural', 'Female', ''], ['en-US-GuyNeural', 'Male', ''], ['en-US-DavisNeural', 'Male', ''], ['en-US-JasonNeural', 'Male', ''], ['en-US-TonyNeural', 'Male', ''], ['en-US-ChristopherNeural', 'Male', ''], ['en-US-EricNeural', 'Male', ''], ['en-US-BrandonNeural', 'Male', ''], ['en-US-JacobNeural', 'Male', ''], ['en-US-RogerNeural', 'Male', ''], ['en-US-SteffanNeural', 'Male', '']];
    var unesc = function (t) { return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); };
    var ssmlToTts = function (ssml) {
      var voice = (/<voice[^>]*name="([^"]+)"/.exec(ssml) || [])[1] || VOICE;
      var rate = parseInt((/<prosody[^>]*rate="([-+]?\d+)%"/.exec(ssml) || [])[1] || '0', 10) || 0;
      var style = (/express-as[^>]*style="([a-z-]+)"/.exec(ssml) || [])[1];
      var text = unesc(String(ssml).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      var qs = 'text=' + encodeURIComponent(text) + '&rate=' + rate + '&voice=' + encodeURIComponent(voice) + (style ? '&style=' + encodeURIComponent(style) : '') + (CHILD && text.indexOf(CHILD) !== -1 ? '&private=1' : '');
      return api('GET', '/tts?' + qs).then(function (r) {
        if (!r.ok) return new Response(null, { status: r.status });
        return r.arrayBuffer().then(function (buf) { return new Response(buf, { status: 200, headers: { 'content-type': 'audio/mpeg' } }); });
      });
    };
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      init = init || {};
      var az = AZURE_TTS.exec(url);
      if (az) {
        if (az[1] === 'v1') return ssmlToTts(String(init.body || ''));
        var list = CAST.map(function (v) { return { ShortName: v[0], Locale: 'en-US', VoiceType: 'Neural', Gender: v[1], VoiceTag: v[2] ? { VoicePersonalities: [v[2]] } : {} }; });
        return Promise.resolve(new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (ANTHROPIC.test(url)) {
        var headers = Object.assign({ 'content-type': 'application/json' }, AUTH);
        return realFetch(API + '/ai/messages', Object.assign({}, init, { method: 'POST', headers: headers, mode: 'cors', credentials: 'omit' }));
      }
      var home = KIDHOME.exec(url);
      if (home) {
        var path = home[1] || '/', method = String(init.method || 'GET').toUpperCase(), body = init.body;
        if (path === '/avatar' && method === 'GET') return api('GET', '/device/child/avatar');
        if (path === '/avatar') return api('PUT', '/device/child/avatar', body, 'application/json');
        if (path === '/portrait') return api('PUT', '/device/child/portrait', body, 'text/plain');
        if (path === '/stars') { var e = 0; try { e = JSON.parse(body).earned | 0; } catch (err) {} return api('POST', '/device/child/stars', JSON.stringify({ appId: APP_ID, earned: e }), 'application/json'); }
        return api('GET', '/device/child/avatar');
      }
      return realFetch(input, init);
    };
    window.KidTablet.ai = 'duckling';

    // A picture she saved becomes her home screen background, on every tablet of hers. It is resized to fit a screen
    // (at most 1920 pixels on the long side) and sent as JPEG; transparent parts become white.
    var toJpeg = function (src) {
      return new Promise(function (resolve, reject) {
        var draw = function (img, w, h) {
          var k = Math.min(1, 1920 / Math.max(w, h)), c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
          var g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
          var d = c.toDataURL('image/jpeg', 0.86);
          if (d.length > 1900000) d = c.toDataURL('image/jpeg', 0.7);
          resolve(d);
        };
        if (src && src.getContext) return draw(src, src.width, src.height);
        var img = new Image();
        img.onload = function () { draw(img, img.naturalWidth, img.naturalHeight); };
        img.onerror = function () { reject(new Error('That picture could not be read.')); };
        img.src = String(src);
      });
    };
    window.KidTablet.setHomeBackground = function (src) {
      return toJpeg(src).then(function (d) { return api('PUT', '/device/child/background', d, 'text/plain'); }).then(function (r) {
        if (!r.ok) throw new Error(r.status === 409 ? 'This tablet has no child yet.' : 'The background could not be saved. Try again in a moment.');
        return r.json();
      });
    };
    window.KidTablet.clearHomeBackground = function () {
      return api('DELETE', '/device/child/background').then(function (r) { if (!r.ok) throw new Error('The background could not be removed.'); return r.json(); });
    };

    // ---- 5. Stars: this app's earned stars from its own saved progress, the rest from the server --------------------
    // The Surface version read every app's progress from one shared storage; here each app sees only its own, so each
    // app reports its own count and the server keeps the total per child. Defined before the apps' own copy runs, which
    // steps aside when window.KID_STARS exists.
    var starsIn = function (key, raw) {
      var v; try { v = JSON.parse(raw); } catch (e) { return 0; }
      var n = function (x) { return typeof x === 'number' && isFinite(x) && x > 0 ? Math.floor(x) : 0; };
      if (/^lab-done-/.test(key)) return Array.isArray(v) ? v.length : 0;
      if (/-stars$/.test(key)) return n(v);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return 0;
      if (typeof v.stars === 'number') return n(v.stars);
      var sum = 0;
      for (var k in v) if (v[k] && typeof v[k] === 'object' && typeof v[k].stars === 'number') sum += n(v[k].stars);
      return sum;
    };
    var served = { byApp: {} }, lastMine = -1, starsTimer = null;
    var mine = function () {
      var total = 0, per = {}, st = window.localStorage;
      try { for (var i = 0; i < st.length; i++) { var k = st.key(i); if (!k || /^kid-avatar/.test(k)) continue; var n = starsIn(k, st.getItem(k)); if (n) { per[k] = n; total += n; } } } catch (e) {}
      return { total: total, per: per };
    };
    var earnedAll = function () {
      var m = mine().total, total = 0;
      for (var a in served.byApp) if (a !== APP_ID) total += served.byApp[a] | 0;
      return total + Math.max(m, served.byApp[APP_ID] | 0);
    };
    var reportStars = function (force) {
      var m = mine().total;
      if (!force && m === lastMine) return Promise.resolve(earnedAll());
      lastMine = m;
      return api('POST', '/device/child/stars', JSON.stringify({ appId: APP_ID, earned: m }), 'application/json')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j) { served.byApp[APP_ID] = Math.max(m, served.byApp[APP_ID] | 0); } window.dispatchEvent(new Event('kid-stars')); return earnedAll(); }, function () { return earnedAll(); });
    };
    window.KID_STARS = { earned: earnedAll, breakdown: function () { return mine().per; }, report: reportStars, starsIn: starsIn, base: 'http://127.0.0.1:47821' };
    // Saves in this app report a moment later (one report for a burst of saves).
    try {
      var st0 = window.localStorage, setItem0 = st0.setItem;
      st0.setItem = function (k, v) { setItem0.call(st0, k, v); if (!/^kid-avatar/.test(String(k))) { clearTimeout(starsTimer); starsTimer = setTimeout(reportStars, 800); } };
    } catch (e) {}
    // The other apps' stars, from the server, as soon as the page opens.
    api('GET', '/device/child/avatar').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (j && j.earnedByApp) { served.byApp = j.earnedByApp; window.dispatchEvent(new Event('kid-stars')); }
      setTimeout(function () { reportStars(true); }, 1200);
    }, function () {});
  }

  // ---- 2. The narrator --------------------------------------------------------------------------------------------
  if (!bridge || !TOKEN) return;
  // Android's WebView has no speechSynthesis and no SpeechSynthesisUtterance. Without these an app's speech either
  // throws or checks for them and stays silent, so the narrator below had nothing to take over. Both are provided
  // here when missing; the "device voice" behind them is the shell's own text to speech (bridge.speak), and with no
  // shell voice the utterance still starts and ends on a timer so apps that wait for the end keep going.
  if (typeof window.SpeechSynthesisUtterance === 'undefined') {
    window.SpeechSynthesisUtterance = function (text) {
      var t = new EventTarget();
      t.text = text == null ? '' : String(text); t.lang = ''; t.voice = null; t.volume = 1; t.rate = 1; t.pitch = 1;
      t.onstart = t.onend = t.onerror = t.onboundary = t.onpause = t.onresume = t.onmark = null;
      var send = t.dispatchEvent.bind(t);
      t.dispatchEvent = function (ev) { var r = send(ev), h = t['on' + ev.type]; if (typeof h === 'function') { try { h.call(t, ev); } catch (e) { setTimeout(function () { throw e; }); } } return r; };
      return t;
    };
  }
  if (!window.speechSynthesis) window.speechSynthesis = deviceVoice();
  function deviceVoice() {
    var events = new EventTarget(), live = {}, next = 0, waiting = 0, paused = false;
    var native = typeof bridge.speak === 'function';
    var done = function (id, type) {
      var u = live[id]; if (!u) return; delete live[id]; waiting = Math.max(0, waiting - 1);
      fire(u, type || 'end', type === 'error' ? { error: 'interrupted' } : { charIndex: String(u.text).length });
    };
    window.__ducklingVoice = { start: function (id) { if (live[id]) fire(live[id], 'start'); }, end: function (id) { done(id); }, error: function (id) { done(id, 'error'); } };
    return {
      speak: function (u) {
        var id = 'v' + (++next); live[id] = u; waiting++;
        var rate = Math.max(0.5, Math.min(2, Number(u.rate) || 1));
        if (native) { try { bridge.speak(id, clean(u.text), rate); return; } catch (e) {} }
        fire(u, 'start');
        setTimeout(function () { done(id); }, Math.min(15000, 300 + 60 * String(u.text || '').length / rate));
      },
      cancel: function () { if (native) { try { bridge.stopSpeaking(); } catch (e) {} } Object.keys(live).forEach(function (id) { done(id, 'error'); }); },
      pause: function () { paused = true; }, resume: function () { paused = false; },
      getVoices: function () { return []; },
      get speaking() { return waiting > 0; }, get pending() { return waiting > 1; }, get paused() { return paused; },
      onvoiceschanged: null,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events)
    };
  }
  var ss = window.speechSynthesis;
  var orig = { speak: ss.speak.bind(ss), cancel: ss.cancel.bind(ss), pause: ss.pause.bind(ss), resume: ss.resume.bind(ss) };
  var WAIT_MS = 6000;
  var ctx = null, current = null, queue = [], seq = 0, mem = new Map(), dbp = null, down = 0;
  var nameRe = CHILD ? new RegExp('(^|[^a-z])' + CHILD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)', 'i') : null;

  function audio() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; } }
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (t) { window.addEventListener(t, audio, { capture: true, passive: true }); });

  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res) {
      try {
        var r = (IDB_OPEN || indexedDB.open.bind(indexedDB))('duckling-voice', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('clips'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
    return dbp;
  }
  function dbGet(k) { return db().then(function (d) { return new Promise(function (res) { if (!d) return res(null); try { var q = d.transaction('clips').objectStore('clips').get(k); q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { res(null); }; } catch (e) { res(null); } }); }); }
  function dbPut(k, v) { db().then(function (d) { if (!d) return; try { d.transaction('clips', 'readwrite').objectStore('clips').put(v, k); } catch (e) {} }); }

  function clean(t) { return String(t || '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim(); }
  function rateOf(u) { var r = Number(u.rate) || 1; return Math.round((Math.max(0.5, Math.min(2, r)) - 1) * 100); }
  function isPrivate(text) { return !!(nameRe && nameRe.test(text)); }

  // The Duckling narrator: the API answers with the clip (private lines) or sends us to the shared copy on the CDN.
  function fetchClip(text, rate) {
    var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ac) ac.abort(); }, WAIT_MS);
    var url = API + '/tts?text=' + encodeURIComponent(text) + '&rate=' + rate + '&voice=' + encodeURIComponent(VOICE) + (isPrivate(text) ? '&private=1' : '');
    return fetch(url, { headers: { authorization: 'Device ' + TOKEN }, signal: ac ? ac.signal : undefined })
      .then(function (r) { clearTimeout(timer); if (r.status === 429) { down = Date.now() + 10 * 60000; return null; } return r.ok ? r.arrayBuffer() : null; })
      .catch(function () { clearTimeout(timer); return null; });
  }
  function decode(bytes) {
    var c = audio(); if (!c) return Promise.resolve(null);
    return new Promise(function (res) { try { c.decodeAudioData(bytes.slice(0), function (b) { res(b); }, function () { res(null); }); } catch (e) { res(null); } });
  }
  function clip(text, rate) {
    var k = VOICE + '|' + rate + '|' + text;
    if (mem.has(k)) return mem.get(k);
    var p = dbGet(k).then(function (saved) {
      if (saved) return decode(saved);
      if (Date.now() < down) return null;
      return fetchClip(text, rate).then(function (bytes) {
        if (!bytes) { if (Date.now() >= down) down = Date.now() + 30000; return null; }
        dbPut(k, bytes); return decode(bytes);
      });
    }).then(function (b) { if (!b) mem.delete(k); return b; });
    mem.set(k, p);
    return p;
  }

  function fire(u, type, extra) {
    var ev;
    try { ev = new SpeechSynthesisEvent(type, Object.assign({ utterance: u, charIndex: 0, elapsedTime: 0, name: '' }, extra || {})); }
    catch (e) { ev = new Event(type); Object.assign(ev, { utterance: u, charIndex: 0, elapsedTime: 0, name: '' }, extra || {}); }
    if (type === 'error' && !('error' in ev)) { try { Object.defineProperty(ev, 'error', { value: (extra && extra.error) || 'interrupted' }); } catch (e) {} }
    try { u.dispatchEvent(ev); } catch (e) {}
  }

  function playNext() {
    if (current || !queue.length) return;
    var item = queue.shift(), my = ++seq, u = item.u;
    current = item;
    var text = clean(u.text), rate = rateOf(u);
    if (!text) { current = null; fire(u, 'end'); playNext(); return; }
    clip(text, rate).then(function (buf) {
      var c = audio();
      if (!buf || !c || c.state === 'running') return buf;
      return Promise.race([c.resume().catch(function () {}), new Promise(function (r) { setTimeout(r, 300); })]).then(function () { return buf; });
    }).then(function (buf) {
      if (my !== seq) return;
      var c = audio();
      if (!buf || !c || c.state !== 'running') { current = null; item.fallback = true; orig.speak(u); playNext(); return; }
      var src = c.createBufferSource(), gain = c.createGain();
      gain.gain.value = u.volume == null ? 1 : Math.max(0, Math.min(1, Number(u.volume)));
      src.buffer = buf; src.connect(gain); gain.connect(c.destination);
      item.src = src; item.timers = [];
      var full = String(u.text || ''), re = /\S+/g, m, dur = buf.duration;
      while ((m = re.exec(full))) {
        (function (ci, len) {
          item.timers.push(setTimeout(function () { if (my === seq) fire(u, 'boundary', { name: 'word', charIndex: ci, charLength: len, elapsedTime: dur * (ci / Math.max(1, full.length)) }); }, 1000 * dur * (ci / Math.max(1, full.length))));
        })(m.index, m[0].length);
      }
      src.onended = function () {
        if (my !== seq) return;
        item.timers.forEach(clearTimeout); current = null;
        fire(u, 'end', { charIndex: full.length, elapsedTime: dur });
        playNext();
      };
      fire(u, 'start');
      try { src.start(0); } catch (e) { current = null; item.fallback = true; orig.speak(u); playNext(); }
    });
  }

  function stopCurrent(reason) {
    seq++;
    var item = current; current = null;
    if (item) {
      (item.timers || []).forEach(clearTimeout);
      try { if (item.src) { item.src.onended = null; item.src.stop(0); } } catch (e) {}
      fire(item.u, 'error', { error: reason || 'interrupted' });
    }
  }

  var shim = {
    speak: function (u) {
      if (!u || typeof u.text !== 'string') return orig.speak(u);
      queue.push({ u: u }); playNext();
    },
    cancel: function () { queue.forEach(function (it) { fire(it.u, 'error', { error: 'canceled' }); }); queue = []; stopCurrent('canceled'); orig.cancel(); },
    pause: function () { try { if (ctx) ctx.suspend(); } catch (e) {} orig.pause(); },
    resume: function () { try { if (ctx) ctx.resume(); } catch (e) {} orig.resume(); },
    getVoices: function () { return ss.getVoices(); },
    get speaking() { return !!current || ss.speaking; },
    get pending() { return queue.length > 0 || ss.pending; },
    get paused() { return ss.paused; },
    addEventListener: function () { return ss.addEventListener.apply(ss, arguments); },
    removeEventListener: function () { return ss.removeEventListener.apply(ss, arguments); },
    set onvoiceschanged(f) { ss.onvoiceschanged = f; },
    get onvoiceschanged() { return ss.onvoiceschanged; }
  };
  try { Object.defineProperty(window, 'speechSynthesis', { value: shim, configurable: true }); } catch (e) {}
  window.KidTablet.narrator = 'duckling';
})();
