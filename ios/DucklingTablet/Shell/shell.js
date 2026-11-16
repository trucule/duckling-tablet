/* window.DucklingShell for the iPad app. The web app (web/src/shell.ts) calls the shell synchronously, the way
   Android's JavascriptInterface works; WKWebView only offers asynchronous messages. So the native side keeps a
   snapshot of its state here (window.__ducklingState, refreshed whenever it changes), the getters read the
   snapshot, and every action goes to the app as a message (webkit.messageHandlers.duckling). Results that take
   time come back through window.DucklingWeb, exactly as on Android. The PIN is checked here against the hash in
   the snapshot (SHA-256 of "duckling:<pin>", the form every shell keeps), so the parent area opens offline. */
(function () {
  'use strict';
  if (window.DucklingShell) return;
  var S = window.__ducklingState || {};
  // A new snapshot also tells the page, so a screen that shows shell state (the parent area's lockdown steps) re-reads
  // it at once: Guided Access starting, Screen Time approved, the network changing.
  window.__ducklingSetState = function (s) { S = s || {}; window.__ducklingState = S; try { window.dispatchEvent(new Event('duckling:state')); } catch (e) {} };
  function post(cmd, args) { try { window.webkit.messageHandlers.duckling.postMessage({ cmd: cmd, args: args || [] }); } catch (e) {} }

  var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256hex(str) {
    var bytes = new TextEncoder().encode(str), len = bytes.length, total = Math.ceil((len + 9) / 64) * 64;
    var m = new Uint8Array(total); m.set(bytes); m[len] = 0x80;
    var dv = new DataView(m.buffer), bits = len * 8;
    dv.setUint32(total - 4, bits >>> 0); dv.setUint32(total - 8, Math.floor(bits / 4294967296));
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], w = new Uint32Array(64);
    for (var i = 0; i < total; i += 64) {
      for (var t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3), s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
        var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H = [(H[0] + a) >>> 0, (H[1] + b) >>> 0, (H[2] + c) >>> 0, (H[3] + d) >>> 0, (H[4] + e) >>> 0, (H[5] + f) >>> 0, (H[6] + g) >>> 0, (H[7] + h) >>> 0];
    }
    return H.map(function (x) { return ('00000000' + x.toString(16)).slice(-8); }).join('');
  }
  var pinHash = function (pin) { return sha256hex('duckling:' + pin); };

  window.DucklingShell = {
    platform: function () { return 'ios'; },
    shellVersion: function () { return S.shellVersion || ''; },
    getDeviceToken: function () { return S.deviceToken || ''; },
    setDeviceToken: function (t) { S.deviceToken = t; post('setDeviceToken', [t]); },
    pushToken: function () { return S.pushToken || ''; },
    installedApps: function () { return JSON.stringify(S.installed || {}); },
    installApp: function (id, version, url, sha256, signature, permissions) { post('installApp', [id, version, url, sha256, signature, permissions]); },
    uninstallApp: function (id) { if (S.installed) delete S.installed[id]; post('uninstallApp', [id]); },
    openApp: function (id) { post('openApp', [id]); },
    hasPin: function () { return !!S.pinHash; },
    setPin: function (pin) { S.pinHash = pinHash(pin); post('setPinHash', [S.pinHash]); },
    verifyPin: function (pin) { return !!S.pinHash && S.pinHash === pinHash(pin); },
    setPinHash: function (h) { S.pinHash = String(h || '').toLowerCase(); post('setPinHash', [S.pinHash]); },
    // homeRole and pinned keep their Android names so the web app's checks work unchanged: on the iPad they are
    // Screen Time approval and Guided Access.
    lockdownStatus: function () { return JSON.stringify(S.lockdown || { homeRole: false, deviceSecure: false, pinned: false, lockdownOn: false, screenTime: false, guidedAccess: false }); },
    requestHomeRole: function () { post('requestScreenTime'); },
    openSecuritySettings: function () { post('openSettings'); },
    openWifiSettings: function () { post('openSettings'); },
    mediaAccess: function () { return JSON.stringify(S.media || null); },
    requestMediaAccess: function () { post('requestMedia'); },
    openAppSettings: function () { post('openSettings'); },
    // A Camera Fun photo for this tablet's background, once: the snapshot carries it until the page says it took it.
    takeLocalBackground: function () { var d = S.localBackground || ''; if (d) { S.localBackground = ''; post('tookLocalBackground'); } return d; },
    networkStatus: function () { return S.network || (navigator.onLine ? 'other' : 'none'); },
    setLockdown: function (on) { if (S.lockdown) S.lockdown.lockdownOn = !!on; post('setLockdown', [!!on]); },
    setAllowedHosts: function (csv) { post('setAllowedHosts', [String(csv || '')]); },
    setChildInfo: function (name, voice) { post('setChildInfo', [name, voice]); },
    setChildLevels: function (json) { post('setChildLevels', [json]); },
    setChildId: function (id) { post('setChildId', [id]); },
    setAppAccountToken: function (t) { post('setAppAccountToken', [String(t || '')]); },
    release: function () { post('release'); },
    installedPackages: function () { return '[]'; },
    launchPackage: function () {},
    canDrawOverlays: function () { return false; },
    openOverlaySettings: function () {},
    // The subscription, through the App Store. Results arrive at DucklingWeb.onBilling(status, message).
    subscribe: function () { post('subscribe'); },
    subscriptionPrice: function () { return S.price || ''; },
    manageSubscription: function () { post('manageSubscription'); },
    restorePurchases: function () { post('restorePurchases'); },
    reload: function () { post('reload'); },
    __sha256: sha256hex,
  };
})();
