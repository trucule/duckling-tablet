/* The look of Kitchen Lab and Chemistry Lab: a photographed room for the glass, steel and liquids to reflect,
   photographed oak for the kitchen's worktop and shelves, and the relief and gloss of real tiles on the wall.
   tools/apply-lab-look.mjs copies this file into each lab as look.js and adds the one call the game's bundle makes to
   it; edit it here and run that tool again. The pictures are in the app's look/ folder, built by
   tools/build-lab-look.py from Poly Haven's CC0 files (look/LICENSES.txt).

   The pictures start loading as soon as this file runs, while the game is still setting itself up. The game waits for
   LabLook.apply() before its first frame, so the room never shows one way and then changes. A picture that cannot be
   had (or all of them, after two and a half seconds) is left out, and that part of the room stays as the game draws it.

   The game hands apply() its own three.js pieces, because its three.js is inside its bundle:
     scene, renderer, mats (the game's materials by name), tex (its drawn textures by name), mode ('chem' or kitchen),
     Texture (a texture made from a picture), DataTexture, repeat (RepeatWrapping), srgb (sRGBEncoding), rgba (RGBAFormat). */
(function () {
  'use strict';
  var DIR = 'look/', WAIT = 2500;
  var chem = /chemistry/i.test(document.title) || !!document.querySelector('canvas[aria-label^="Chemistry"]');   // only to choose what to load; apply() goes by the game's own mode

  function picture(name) {
    return new Promise(function (res) {
      var im = new Image();
      im.onload = function () { (im.decode ? im.decode() : Promise.resolve()).then(function () { res(im); }, function () { res(im); }); };
      im.onerror = function () { res(null); };
      im.src = DIR + name;
    });
  }
  // The room's pixels: the top half of env.png at full brightness, the bottom half at 1/64 for the lamps.
  function roomPixels() {
    return picture('env.png').then(function (im) {
      if (!im) return null;
      var w = im.naturalWidth, h = im.naturalHeight / 2, c = document.createElement('canvas'); c.width = w; c.height = h * 2;
      var x = c.getContext('2d'); x.drawImage(im, 0, 0);
      try { return { w: w, h: h, px: x.getImageData(0, 0, w, h * 2).data }; } catch (e) { return null; }
    });
  }
  // The chemistry lab's glassware: one model file, read here and opened by the game's own model loader.
  var set = null;
  var setFile = !chem || !window.fetch ? Promise.resolve() : fetch(DIR + 'set.glb').then(function (r) { return r.ok ? r.arrayBuffer() : null; }).then(function (b) { set = b; }, function () {});
  var names = chem ? ['tile-n.jpg', 'tile-r.jpg'] : ['tile-n.jpg', 'tile-r.jpg', 'oak.jpg', 'oak-n.jpg', 'oak-r.jpg'];
  var got = {}, room = null;
  var all = Promise.all(names.map(function (n) { return picture(n).then(function (im) { got[n] = im; }); }).concat(roomPixels().then(function (r) { room = r; }), setFile));
  var times = { start: Math.round(performance.now()) };   // when the pictures were in and when the look was on, for tools/load-time.mjs
  all.then(function () { times.loaded = Math.round(performance.now()); });
  var ready = Promise.race([all, new Promise(function (res) { setTimeout(res, WAIT); })]);

  // A 32-bit float as a 16-bit one, for the room's light.
  var f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  function toHalf(v) {
    if (v > 65000) v = 65000;
    f32[0] = v; var x = u32[0], e = (x >> 23) & 0xff, m = x & 0x7fffff;
    if (e < 103) return 0;
    if (e < 113) return (m | 0x800000) >> (126 - e);
    return ((e - 112) << 10) | (m >> 13);
  }
  function roomTexture(c) {
    var w = room.w, h = room.h, px = room.px, out = new Uint16Array(w * h * 4), one = toHalf(1);
    for (var y = 0; y < h; y++) for (var i = 0; i < w; i++) {
      var a = (y * w + i) * 4, b = ((y + h) * w + i) * 4, o = ((h - 1 - y) * w + i) * 4;   // rows bottom-up for WebGL
      for (var k = 0; k < 3; k++) { var v = px[a + k] / 255, lo = px[b + k] / 255; out[o + k] = toHalf(v > 0.97 ? Math.max(1, lo * lo * 64) : v * v); }
      out[o + 3] = one;
    }
    var t = new c.DataTexture(out, w, h, c.rgba, 1016 /* HalfFloatType */);
    t.mapping = 303 /* EquirectangularReflectionMapping */; t.magFilter = t.minFilter = 1006 /* LinearFilter */; t.generateMipmaps = false; t.needsUpdate = true;
    return t;
  }
  function tex(c, name, like, colour) {
    var im = got[name]; if (!im) return null;
    var t = new c.Texture(im);
    t.wrapS = t.wrapT = c.repeat; t.anisotropy = 4; if (colour) t.encoding = c.srgb;
    if (like) { t.repeat.copy(like.repeat); t.offset.copy(like.offset); }
    t.needsUpdate = true;
    return t;
  }
  // Every material in the scene and in the game's own list, once each.
  function materials(c) {
    var seen = [], add = function (m) { if (m && m.isMaterial && seen.indexOf(m) < 0) seen.push(m); };
    for (var k in c.mats) add(c.mats[k]);
    c.scene.traverse(function (o) { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(add); });
    return seen;
  }

  function apply(c) {
    return ready.then(function () {
      if (!set || c.mode !== 'chem' || !c.GLTF) return null;
      return new Promise(function (res) { try { new c.GLTF().parse(set, '', res, function () { res(null); }); } catch (e) { res(null); } });
    }).then(function (model) {
      times.asked = Math.round(performance.now());
      try { look(c); if (model) dress(c, model); } catch (e) { if (window.console) console.warn('lab look', e); }
      times.applied = Math.round(performance.now());
    });
  }

  // The chemistry lab's bench gets real glassware along the wall: a rack of test tubes, a clamp stand, a burner and
  // bottles, from Poly Haven's chemistry set, with liquids in strong colours. They stand behind everything the child
  // works with and are not part of the experiments.
  function dress(c, model) {
    var M = c.mats, bench = null;
    c.scene.traverse(function (o) {
      var p = o.isMesh && o.material === M.counter && o.geometry && o.geometry.parameters;
      if (p && p.width && (!bench || p.width > bench.geometry.parameters.width)) bench = o;
    });
    if (!bench || !M.water) return;
    var K = S.setScale, top = bench.position.y + bench.geometry.parameters.height / 2;
    var group = new bench.parent.constructor(); group.position.set(0, top, 0); group.scale.set(K, K, K); bench.parent.add(group);
    model.scene.traverse(function (o) {
      if (!o.isMesh) return;
      var m = o.material, glass = /glass/.test(m.name);
      if (glass) { m.transparent = true; m.depthWrite = false; m.opacity = S.setGlass; m.envMapIntensity = S.envGlass; m.roughness = Math.min(m.roughness, 0.2); m.metalness = 0; }
      else m.envMapIntensity = S.envMetal;
      o.castShadow = !glass; o.receiveShadow = !glass;
    });
    var liquids = {};
    function liquid(colour) {
      // Solid colour, drawn before the glass round it, so the colour stays strong through the glass.
      if (!liquids[colour]) { var m = M.water.clone(); m.color.set(colour); m.transparent = false; m.opacity = 1; m.depthWrite = true; m.roughness = 0.12; m.envMapIntensity = 1; liquids[colour] = m; }
      return liquids[colour];
    }
    // A piece of the set by its name, placed at x (along the bench) and z (toward the child), in the game's units.
    function put(name, x, z, o) {
      var src = model.scene.getObjectByName('chemistry_set_' + name); if (!src) return null;
      var p = src.clone(true); o = o || {};
      p.position.set(x / K, (o.y || 0) / K, z / K); if (o.turn) p.rotation.y = o.turn;
      if (o.tall) p.scale.y = o.tall;
      if (o.liquid) p.traverse(function (q) { if (q.isMesh) { q.material = liquid(o.liquid); q.castShadow = false; } });
      group.add(p); return p;
    }
    S.set.forEach(function (it) {
      var kind = it[0], x = it[1], z = it[2], colour = it[3];
      if (kind === 'rack') {
        put('test_tube_stand_a', x, z);
        S.tubes.forEach(function (col, i) {
          var dx = (i - (S.tubes.length - 1) / 2) * 2 * 0.0277 * K;
          put('test_tube_a', x + dx, z, { y: 0.012 * K }); put('test_tube_content_d', x + dx, z, { y: 0.014 * K, liquid: col });
        });
      } else if (kind === 'stand') {
        put('clamp_stand', x, z); put('clamp', x + 0.06 * K, z + 0.007 * K, { y: 0.358 * K });
      } else if (kind === 'burner') put('bunsen_burner', x, z);
      else if (kind === 'beaker') put('beaker_' + it[4], x, z);
      else {
        // A bottle with its stopper and a little of something in it.
        var parts = { c: ['bottle_clear_c', 'bottle_clear_c_lid'], b: ['bottle_clear_b', 'bottle_clear_b_cork'], d: ['bottle_clear_d', 'bottle_clear_d_cork'], a: ['bottle_clear_a', 'bottle_clear_lid'],
          e: ['bottle_clear_e', 'bottle_clear_e_dropper'], C: ['bottle_dark_c', 'bottle_dark_c_lid'], B: ['bottle_dark_b', 'bottle_dark_b_cork'], E: ['bottle_dark_e', 'bottle_dark_e_dropper'] }[it[4]];
        if (!parts) return;
        if (colour) put('bottle_content_d', x, z, { liquid: colour, tall: 1.8 });
        parts.forEach(function (n) { put(n, x, z); });
      }
    });
    window.LabLook.applied.set = true;
  }

  function look(c) {
    var kitchen = c.mode !== 'chem', mats = materials(c), M = c.mats, done = { room: false, oak: false, tiles: false };

    // 1. The room: everything shiny reflects it, and it adds soft light from all round. The game's own sky light is
    //    turned down by what the room adds, so the scene is as bright as before and the colours are not washed out.
    if (room) {
      c.scene.environment = roomTexture(c);
      c.scene.traverse(function (o) { if (o.isHemisphereLight) o.intensity *= S.sky; });
      mats.forEach(function (m) { if ('envMapIntensity' in m) m.envMapIntensity = S.env; });
      [M.glass, M.ice, M.water, M.oil, M.honey, M.eggWhite, M.frozen].forEach(function (m) { if (m) m.envMapIntensity = S.envGlass; });
      [M.steel, M.steelDark, M.gold].forEach(function (m) { if (m) m.envMapIntensity = S.envMetal; });
      if (M.glass) { M.glass.opacity = S.glassOpacity; M.glass.roughness = 0.03; }
      done.room = true;
    }

    // 2. The kitchen's oak: wherever the game put its drawn wood, on the worktop, the shelves and the pantry's back.
    if (kitchen && got['oak.jpg']) {
      var woods = [c.tex.counter, c.tex.shelf];
      mats.forEach(function (m) {
        var i = woods.indexOf(m.map); if (i < 0) return;
        // The scan's grain runs up the picture; turned a quarter, it runs along the worktop and the shelves. A panel
        // that is neither (the pantry's back) keeps the grain upright and its own colour.
        var like = m.map, board = m === M.counter || m === M.shelf, grain = !board ? S.oakPanel : like === c.tex.counter ? S.oakCounter : S.oakShelf;
        m.map = tex(c, 'oak.jpg', like, true); m.map.repeat.set(grain[0], grain[1]); m.map.rotation = board ? Math.PI / 2 : 0;
        if (board) m.color.multiply(new m.color.constructor(S.oakTint));
        m.bumpMap = null;
        var n = tex(c, 'oak-n.jpg', m.map), r = tex(c, 'oak-r.jpg', m.map);
        [n, r].forEach(function (x) { if (x) x.rotation = m.map.rotation; });
        if (n) { m.normalMap = n; m.normalScale.set(0.6, 0.6); }
        if (r) { m.roughnessMap = r; m.roughness = S.oakRough; }
        m.needsUpdate = true;
      });
      done.oak = true;
    }

    // 3. The wall tiles keep the game's colours and get a real tile's uneven glaze and matt grout.
    if (M.tile && got['tile-n.jpg']) {
      var t = M.tile, n2 = tex(c, 'tile-n.jpg', t.map), r2 = tex(c, 'tile-r.jpg', t.map);
      t.normalMap = n2; t.normalScale.set(S.tileRelief, S.tileRelief);
      if (r2) { t.roughnessMap = r2; t.roughness = 1; }
      t.envMapIntensity = S.envTile;
      t.needsUpdate = true;
      done.tiles = true;
    }

    // 4. Colour: a warmer, stronger main light, and in the chemistry lab a wall with some colour in it.
    c.scene.traverse(function (o) {
      if (o.isDirectionalLight && o.castShadow) { o.intensity *= S.key; o.color.set(S.keyColour); }
    });
    if (!kitchen && M.tile) M.tile.color.set(S.chemWall);
    if (!kitchen && M.counter) { M.counter.roughness = 0.22; M.counter.color.set(S.chemBench); }
    c.renderer.toneMappingExposure *= S.exposure;
    if (S.saturate !== 1) c.renderer.domElement.style.filter = 'saturate(' + S.saturate + ')';
    window.LabLook.applied = done;
  }

  // The settings, in one place.
  var S = {
    sky: 0.45,            // the game's sky light, once the room lights the scene too
    env: 0.55,            // how strongly ordinary surfaces take the room's light
    envGlass: 1.5, envMetal: 1.15, envTile: 0.3,
    glassOpacity: 0.26,
    oakCounter: [0.7, 5.5], oakShelf: [0.25, 2], oakPanel: [5, 3.6], oakRough: 0.85, oakTint: '#FFE2B8',
    tileRelief: 0.7,
    key: 1.1, keyColour: '#FFE9C8',
    chemWall: '#BFE6F4', chemBench: '#27324A',
    exposure: 1.0,
    // The chemistry set: how many of the game's units a metre of it is, and what stands where on the bench
    // (kind, x, z, colour, which piece). The pot is in the middle, from about x = -2.5 to 2.5.
    setScale: 12, setGlass: 0.6,
    tubes: ['#FF3D71', '#FFC21A', '#22C55E', '#2F9BFF', '#A855F7'],
    set: [['rack', -4.4, -1.8], ['bottle', -5.7, -0.9, '#2F9BFF', 'c'], ['bottle', -3.1, -0.9, '#FF7A1A', 'b'],
      ['stand', 4.05, -1.9], ['burner', 3.15, -1.1], ['bottle', 4.95, -0.95, '#22C55E', 'd'], ['bottle', 2.95, -2.1, '', 'E']],
    saturate: 1.18        // the tone mapping the game uses greys colours a little; this gives them back
  };

  window.LabLook = { ready: ready, apply: apply, settings: S, applied: null, times: times };
})();
