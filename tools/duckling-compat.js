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
  var VOICE = read('voice', 'en-US-AnaNeural');

  // ---- 1. Per-app localStorage ------------------------------------------------------------------------------------
  try {
    var real = window.localStorage, prefix = 'duckling:' + APP_ID + ':';
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

  // ---- 3. The small bridge for apps that look for it -----------------------------------------------------------------
  window.KidTablet = {
    platform: bridge ? 'duckling' : 'browser', appId: APP_ID, childName: CHILD, narratorVoice: VOICE,
    say: function (text, opts) { var u = new SpeechSynthesisUtterance(String(text)); if (opts && opts.rate) u.rate = opts.rate; window.speechSynthesis.speak(u); return u; }
  };

  // ---- 2. The narrator --------------------------------------------------------------------------------------------
  if (!bridge || !TOKEN || !window.speechSynthesis || typeof window.SpeechSynthesisUtterance === 'undefined') return;
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
        var r = indexedDB.open('duckling-voice', 1);
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
