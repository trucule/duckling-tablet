/* BACKDROPS START */
/* Photo backdrops for an app's 3D places: window.DucklingBackdrops. tools/apply-backdrops.mjs copies this file into
   each app that uses it, between the BACKDROPS markers, right after three.js; edit it here and run that tool again.
   An app keeps its drawn backdrops and asks for a photo when a child goes to a place that has one. The first time,
   the photo and its lighting come from the Duckling API (/backdrops, backend/src/routes/backdrops.ts) and are kept in
   this tablet's IndexedDB; after that they load from there with no request to the API, offline too. A place whose
   photo cannot be had keeps its drawn backdrop.
     DucklingBackdrops.kept(id) -> true when this app has shown the photo before, so it is on the tablet and comes up
       in well under a second. The app then holds its drawn backdrop back and shows the photo first; load() answering
       null means the copy is gone, and the app shows the drawn one after all.
     DucklingBackdrops.warm(ids) -> downloads the photos of those places that the tablet does not have yet, one at a
       time, starting a few seconds after the app opened, so a first visit to a place also shows its photo at once.
       Nothing is decoded. Skipped when the device asks apps to save data.
     DucklingBackdrops.load(id, { linear, sunAt, face }) -> Promise of { id, meta, map, light, turn } or null
       linear: no sRGB decode of the photo, for apps that draw without colour management
       sunAt: the scene's azimuth (radians, atan2(z, x)) to turn the photo's sun to; default 0.88, front right, so
         the camera sees the sunlit side of the cast
       face: in place of sunAt, the column of the photo (0 at its left edge to 1 at its right) to turn toward -z,
         straight ahead of a camera on +z; for a place whose best view matters more than where its sun falls
       map: the 360-degree photo as a texture; light: its lighting as a half-float equirect texture, already turned,
         for PMREMGenerator.fromEquirectangular; turn: how far the photo is turned
       meta: sunAz, sunEl (radians), sunColor, sunStrength, skyColor, groundColor (0 to 1); room, for a photo taken
         indoors: how far its walls are, in camera heights
     DucklingBackdrops.ground(set, { height, radius }) -> a mesh that shows the photo all round with its lower half laid
       on the ground, so things standing at y = 0 stand on the photo's ground (height: the camera height of the photo
       in scene units). Put it in the scene in place of the drawn sky and ground. To fade it, set material.transparent and
       material.uniforms.opacity (only while the camera is inside it: a see-through dome would cover the cast).
       An indoor photo (meta.room) is laid on a room-sized dome instead, so its walls stand at about their real
       distance; the camera may be outside it, and then sees the far side of the room.
     DucklingBackdrops.sunDirection(set) -> a unit vector toward the turned photo's sun.
   Only the three places used last stay in memory (a photo is 32 MB once decoded); an older one is read from the
   tablet's copy again when the child goes back to it. */
(function () {
  'use strict';
  var T = window.THREE;
  if (!T || window.DucklingBackdrops) return;
  function api() { return ((window.KidTablet && window.KidTablet.apiUrl) || 'https://api.ducklingtablet.com').replace(/\/$/, ''); }
  var DB = null;
  function db() {
    if (DB) return DB;
    DB = new Promise(function (res) {
      try {
        var r = indexedDB.open('duckling-backdrops', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('files'); };
        r.onsuccess = function () { res(r.result); }; r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
    return DB;
  }
  function get(k) { return db().then(function (d) { return new Promise(function (res) { if (!d) return res(null); try { var q = d.transaction('files').objectStore('files').get(k); q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { res(null); }; } catch (e) { res(null); } }); }); }
  function put(k, v) { return db().then(function (d) { if (!d) return; try { d.transaction('files', 'readwrite').objectStore('files').put(v, k); } catch (e) {} }); }
  // A file from the tablet's copy, or the first time from the API (then kept). One request per file at a time.
  var asked = {};
  function file(name) {
    if (asked[name]) return asked[name];
    var p = asked[name] = get(name).then(function (b) {
      if (b) return b;
      return fetch(api() + '/backdrops/' + name, { mode: 'cors', credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error('backdrop ' + name + ' ' + r.status);
        return r.blob();
      }).then(function (b2) { put(name, b2); return b2; });
    });
    var done = function () { delete asked[name]; }; p.then(done, done);
    return p;
  }
  // The list of photos. The tablet's copy answers at once, so a kept photo never waits for the network; the list is
  // also asked for again each time the app opens, so places added later reach the tablet, and that fresh copy answers
  // for a place the kept list does not have. The photos themselves never change under a name.
  var fresh = null, keptList = null;
  var parse = function (b) { if (!b) throw new Error('no backdrops.json'); return b.text().then(JSON.parse); };
  function freshList() {
    if (!fresh) fresh = fetch(api() + '/backdrops/backdrops.json', { mode: 'cors', credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('backdrops.json ' + r.status);
      return r.blob();
    }).then(function (b) { put('backdrops.json', b); return parse(b); });
    fresh.catch(function () { fresh = null; });
    return fresh;
  }
  function meta(id) {
    if (!keptList) keptList = get('backdrops.json').then(parse).catch(function () { return null; });
    var net = freshList(); net.catch(function () {});
    return keptList.then(function (j) {
      if (j && j.backdrops[id]) return j.backdrops[id];
      return net.then(function (n) { return n.backdrops[id] || null; });
    });
  }
  // Which photos this app has shown before (the app's own storage, read without waiting).
  var FLAG = 'duckling-backdrop:';
  function kept(id) { try { return localStorage.getItem(FLAG + id) === '1'; } catch (e) { return false; } }
  function mark(id, on) { try { if (on) localStorage.setItem(FLAG + id, '1'); else localStorage.removeItem(FLAG + id); } catch (e) {} }
  // The two pictures of a place, decoded (off the main thread). Asked for once; load() takes them.
  var pics = {};
  function pictures(id) {
    if (!pics[id]) {
      pics[id] = Promise.all([file(id + '.jpg'), file(id + '-light.png')]).then(function (bs) {
        return Promise.all([createImageBitmap(bs[0], { imageOrientation: 'flipY' }), createImageBitmap(bs[1], { premultiplyAlpha: 'none' })]);
      });
      pics[id].catch(function () { delete pics[id]; });
    }
    return pics[id];
  }
  // The place this app showed first the last time it was open is read and decoded as soon as this file runs, while the
  // rest of the app is still starting, so its photo is ready by the time the app asks for it.
  var FIRST = 'duckling-backdrop-first', firstSeen = false;
  try {
    var early = localStorage.getItem(FIRST);
    if (early && kept(early)) {
      meta(early).catch(function () {}); pictures(early).catch(function () {});
      // Not asked for this time (the child went somewhere else, or nowhere yet): the decoded pictures are let go.
      setTimeout(function () {
        var p = pics[early]; if (!p) return;
        delete pics[early]; p.then(function (ims) { ims.forEach(function (im) { if (im.close) im.close(); }); }, function () {});
      }, 20000);
    }
  } catch (e) {}
  var warming = Promise.resolve();
  function warm(ids) {
    var c = navigator.connection;
    if (c && c.saveData) return;
    ids = (ids || []).filter(function (id, i, a) { return id && a.indexOf(id) === i; });
    warming = warming.then(function () { return new Promise(function (res) { setTimeout(res, 4000); }); }).then(function () {
      return ids.reduce(function (p, id) {
        return p.then(function () {
          if (kept(id)) return;
          return meta(id).then(function (m) { if (m) return file(id + '.jpg').then(function () { return file(id + '-light.png'); }).then(function () { mark(id, true); }); });
        }).catch(function () {});
      }, Promise.resolve());
    });
  }
  function lightTexture(bitmap, turn) {
    var w = bitmap.width, h = bitmap.height / 2, c = document.createElement('canvas'); c.width = w; c.height = h * 2;
    var x = c.getContext('2d'); x.drawImage(bitmap, 0, 0);
    var px = x.getImageData(0, 0, w, h * 2).data, out = new Uint16Array(w * h * 4), toHalf = T.DataUtils.toHalfFloat;
    var shift = Math.round(turn / (2 * Math.PI) * w);
    for (var y = 0; y < h; y++) for (var i = 0; i < w; i++) {
      var j = ((i + shift) % w + w) % w;   // column i of the turned map is column j of the photo
      var a = (y * w + j) * 4, b = ((y + h) * w + j) * 4, o = ((h - 1 - y) * w + i) * 4;   // rows bottom-up for WebGL
      for (var k = 0; k < 3; k++) {
        var v = px[a + k] / 255, lo = px[b + k] / 255;
        out[o + k] = toHalf(v > 0.97 ? lo * lo * 16 : v * v);
      }
      out[o + 3] = toHalf(1);
    }
    var t = new T.DataTexture(out, w, h, T.RGBAFormat, T.HalfFloatType);
    t.mapping = T.EquirectangularReflectionMapping; t.magFilter = t.minFilter = T.LinearFilter; t.needsUpdate = true;
    return t;
  }
  var loaded = {}, sets = {}, recent = [], KEEP = 3;
  function used(key) {
    var i = recent.indexOf(key); if (i >= 0) recent.splice(i, 1);
    recent.push(key);
    while (recent.length > KEEP) {
      var old = recent.shift(), set = sets[old];
      delete loaded[old]; delete sets[old];
      if (set) { set.map.dispose(); set.light.dispose(); }   // an app still showing it gets it back from the picture it holds
    }
  }
  function load(id, o) {
    o = o || {};
    var at = o.sunAt === undefined ? 0.88 : o.sunAt, key = id + '|' + !!o.linear + '|' + (o.face === undefined ? at : 'f' + o.face);
    if (!firstSeen) { firstSeen = true; try { localStorage.setItem(FIRST, id); } catch (e) {} }
    if (loaded[key]) { used(key); return loaded[key]; }
    loaded[key] = meta(id).then(function (m) {
      if (!m) return null;
      return pictures(id).then(function (ims) {
        delete pics[id];
        // A photo column u is at azimuth u * 2pi - pi; -z is azimuth -pi/2.
        var turn = o.face === undefined ? m.sunAz - at : (o.face * 2 * Math.PI - Math.PI) + Math.PI / 2, map = new T.Texture(ims[0]); map.mapping = T.EquirectangularReflectionMapping; map.wrapS = T.RepeatWrapping;
        map.encoding = o.linear ? T.LinearEncoding : T.sRGBEncoding; map.generateMipmaps = true; map.minFilter = T.LinearMipmapLinearFilter;
        map.anisotropy = 4; map.needsUpdate = true;
        var set = { id: id, meta: m, map: map, light: lightTexture(ims[1], turn), turn: turn };
        if (ims[1].close) ims[1].close();
        mark(id, true);
        if (loaded[key]) { sets[key] = set; used(key); }
        return set;
      });
    }).catch(function () { delete loaded[key]; mark(id, false); return null; });
    return loaded[key];
  }
  // The photo all round, its lower half projected onto a ground disc (after three.js's GroundProjectedEnv, MIT).
  function ground(set, o) {
    o = o || {};
    var mat = new T.ShaderMaterial({
      uniforms: { opacity: { value: 1 }, map: { value: set.map }, turn: { value: set.turn / (2 * Math.PI) }, height: { value: o.height || 1.7 }, radius: { value: set.meta.room ? set.meta.room * (o.height || 1.7) : o.radius || 60 } },
      side: T.DoubleSide, depthWrite: false, fog: false,
      vertexShader: 'varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: 'varying vec3 vW; uniform float opacity; uniform float radius; uniform float height; uniform float turn; uniform sampler2D map;\n' +
        'float disk(vec3 ro, vec3 rd, vec3 c, vec3 n, float r) { float d = dot(rd, n); if (d > 0.0) return 1e6; vec3 o = ro - c; float t = -dot(n, o) / d; vec3 q = o + rd * t; return dot(q, q) < r * r ? t : 1e6; }\n' +
        'float sphere(vec3 ro, vec3 rd, float ra) { float b = dot(ro, rd); float c = dot(ro, ro) - ra * ra; float h = b * b - c; if (h < 0.0) return -1.0; return -b + sqrt(h); }\n' +
        '#include <common>\n' +
        'void main() { vec3 p = normalize(vW - cameraPosition); vec3 cp = cameraPosition; cp.y -= height;\n' +
        '  float s = sphere(cp, p, radius); vec3 dir = vec3(0.0, 1.0, 0.0);\n' +
        '  if (s > 0.0) { float g = disk(cp, p, vec3(0.0, -height, 0.0), vec3(0.0, 1.0, 0.0), radius); dir = normalize(cp + min(s, g) * p); }\n' +
        '  vec2 uv = equirectUv(dir); uv.x += turn;\n' +
        '  gl_FragColor = vec4(texture2D(map, uv).rgb, opacity);\n' +
        '  #include <encodings_fragment>\n}'
    });
    var m = new T.Mesh(new T.IcosahedronGeometry(1, 16), mat);
    m.scale.setScalar(mat.uniforms.radius.value); m.position.y = mat.uniforms.height.value;   // on the photo's camera
    m.renderOrder = -10; m.frustumCulled = false; m.userData.noInk = true; m.raycast = function () {};
    return m;
  }
  function sunDirection(set) {
    // equirectUv: u = atan(z, x) / 2pi + 0.5, so a column's angle az is the direction x = cos(az), z = sin(az).
    var az = set.meta.sunAz - set.turn, ce = Math.cos(set.meta.sunEl);
    return new T.Vector3(Math.cos(az) * ce, Math.sin(set.meta.sunEl), Math.sin(az) * ce).normalize();
  }
  window.DucklingBackdrops = { load: load, ground: ground, sunDirection: sunDirection, kept: kept, warm: warm };
})();
/* BACKDROPS END */
