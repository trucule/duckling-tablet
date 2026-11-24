/* BACKDROPS START */
/* Photo backdrops for an app's 3D places: window.DucklingBackdrops. tools/apply-backdrops.mjs copies this file into
   each app that uses it, between the BACKDROPS markers, right after three.js; edit it here and run that tool again.
   An app keeps its drawn backdrops and asks for a photo when a child goes to a place that has one. The first time,
   the photo and its lighting come from the Duckling API (/backdrops, backend/src/routes/backdrops.ts) and are kept in
   this tablet's IndexedDB; after that they load from there, offline too. A place whose photo cannot be had keeps its
   drawn backdrop.
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
     DucklingBackdrops.sunDirection(set) -> a unit vector toward the turned photo's sun. */
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
  // A file from the tablet's copy, or the first time from the API (then kept).
  function file(name) {
    return get(name).then(function (b) {
      if (b) return b;
      return fetch(api() + '/backdrops/' + name, { mode: 'cors', credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error('backdrop ' + name + ' ' + r.status);
        return r.blob();
      }).then(function (b2) { put(name, b2); return b2; });
    });
  }
  // The list of photos is asked for again each time the app opens, so places added later reach the tablet; the kept
  // copy is used when the API cannot be reached. The photos themselves never change under a name.
  var list = null;
  function meta(id) {
    if (!list) list = fetch(api() + '/backdrops/backdrops.json', { mode: 'cors', credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('backdrops.json ' + r.status);
      return r.blob();
    }).then(function (b) { put('backdrops.json', b); return b; }, function () { return get('backdrops.json'); }).then(function (b) {
      if (!b) throw new Error('no backdrops.json');
      return b.text();
    }).then(JSON.parse).catch(function (e) { list = null; throw e; });
    return list.then(function (j) { return j.backdrops[id] || null; });
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
  var loaded = {};
  function load(id, o) {
    o = o || {};
    var at = o.sunAt === undefined ? 0.88 : o.sunAt, key = id + '|' + !!o.linear + '|' + (o.face === undefined ? at : 'f' + o.face);
    if (loaded[key]) return loaded[key];
    loaded[key] = meta(id).then(function (m) {
      if (!m) return null;
      return Promise.all([file(id + '.jpg'), file(id + '-light.png')]).then(function (bs) {
        return Promise.all([createImageBitmap(bs[0], { imageOrientation: 'flipY' }), createImageBitmap(bs[1], { premultiplyAlpha: 'none' })]);
      }).then(function (ims) {
        // A photo column u is at azimuth u * 2pi - pi; -z is azimuth -pi/2.
        var turn = o.face === undefined ? m.sunAz - at : (o.face * 2 * Math.PI - Math.PI) + Math.PI / 2, map = new T.Texture(ims[0]); map.mapping = T.EquirectangularReflectionMapping; map.wrapS = T.RepeatWrapping;
        map.encoding = o.linear ? T.LinearEncoding : T.sRGBEncoding; map.generateMipmaps = true; map.minFilter = T.LinearMipmapLinearFilter;
        map.anisotropy = 4; map.needsUpdate = true;
        return { id: id, meta: m, map: map, light: lightTexture(ims[1], turn), turn: turn };
      });
    }).catch(function () { delete loaded[key]; return null; });
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
  window.DucklingBackdrops = { load: load, ground: ground, sunDirection: sunDirection };
})();
/* BACKDROPS END */
