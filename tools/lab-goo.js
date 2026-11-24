/* LAB GOO START */
/* Hands in the mixture, for Kitchen Lab and Chemistry Lab. tools/apply-lab-goo.mjs copies this file into both apps as
   goo.js, loaded after the game. The game shows the child's hands reaching into the pot; this adds what the mixture
   does to them and what they do to the mixture, with simple physics:
     - the part of each hand under the surface gets coated, as many small blobs held on the finger bones. Each blob
       hangs on a spring under gravity, so goo sags, wobbles when the hand moves and drips off when it grows heavy;
     - lifting a finger out of something stretchy pulls a strand that sags, thins as it stretches and snaps;
     - water and oil leave the hand wet and dripping; goo stays until it drips off or is washed off in water;
     - a hand that moves through the surface leaves rings on it; holding the slime coats the hand in slime.
   It reads the game through window.__labView (scene, camera, hands, holds, pot layers, bodies), which the game sets.
   The game's three.js is inside its own bundle, so the classes are taken from objects already in its scene. */
(function () {
  'use strict';
  var V = null, C = null, started = false;
  var S = 0.01, Y3 = function (y) { return (500 - y) * S; }, X3 = function (x) { return (x - 800) * S; };
  var G = 32;                                  // gravity, scene units per second squared
  // What each kind of mixture does to a hand. stick: how fast it coats; max: how thick it gets; k: how stiffly a blob
  // holds on (low sags and wobbles more); drip: drops a second from a fully coated hand, each from its lowest point; stretch: how long
  // a strand gets before it snaps (0: no strands); wash: water, which washes goo off; wet: shiny and see-through;
  // rough: the surface (0 glossy to 1 dull); life: seconds for a coat to wear off; thickens: hard when poked fast.
  var MIX = {
    water:   { stick: 0.9, max: 0.35, k: 500, drip: 3, stretch: 0,    wet: true,  wash: true,  rough: 0.05, life: 6 },
    oil:     { stick: 0.8, max: 0.4,  k: 260, drip: 1.2, stretch: 0.15, wet: true,  rough: 0.08, life: 25 },
    foam:    { stick: 1.2, max: 0.9,  k: 2000, drip: 0,    stretch: 0,    rough: 0.9, life: 14 },
    powder:  { stick: 0.7, max: 0.45, k: 4000, drip: 0.05,    stretch: 0,    rough: 1, life: 40 },
    honey:   { stick: 0.7, max: 1.0,  k: 22,  drip: 0.35,  stretch: 2.4,  rough: 0.06, life: 90 },
    batter:  { stick: 0.8, max: 1.0,  k: 40,  drip: 0.4,  stretch: 0.9,  rough: 0.35, life: 80 },
    mud:     { stick: 0.8, max: 1.0,  k: 70,  drip: 0.35,  stretch: 0.25, rough: 0.75, life: 80 },
    glue:    { stick: 0.7, max: 0.9,  k: 30,  drip: 0.3,  stretch: 1.6,  rough: 0.1,  life: 90 },
    oobleck: { stick: 0.6, max: 0.8,  k: 55,  drip: 0.9,  stretch: 0.12, rough: 0.5,  life: 40, thickens: true },
    slime:   { stick: 1.0, max: 1.1,  k: 18,  drip: 0.08,  stretch: 2.8,  rough: 0.12, life: 120 },
    plastic: { stick: 0.5, max: 0.5,  k: 900, drip: 0,     stretch: 0,    rough: 0.8, life: 40 }
  };
  var LAYER = { aq: 'water', oil: 'oil', foam: 'foam', flourTop: 'powder', sand: 'powder', crys: 'powder', honey: 'honey', batter: 'batter', mud: 'mud', cake: 'batter' };

  // ---- three.js classes, from the game's own objects ----------------------------------------------------------
  var T = {};
  function classes() {
    var found = {};
    V.scene.traverse(function (o) {
      if (o.isInstancedMesh && !found.InstancedMesh) found.InstancedMesh = o.constructor;
      else if (o.isMesh && !o.isSkinnedMesh && !o.isInstancedMesh && !found.Mesh) found.Mesh = o.constructor;
      if (o.geometry && o.geometry.isBufferGeometry && o.geometry.type === 'BufferGeometry' && !found.BufferGeometry) found.BufferGeometry = o.geometry.constructor;
      if (o.geometry && o.geometry.attributes && o.geometry.attributes.position && !found.BufferAttribute) found.BufferAttribute = o.geometry.attributes.position.constructor;
      var m = o.material;
      if (m && !Array.isArray(m) && m.type === 'MeshStandardMaterial' && !found.Std) found.Std = m.constructor;
      if (m && !Array.isArray(m) && m.type === 'MeshPhysicalMaterial' && !found.Phys) found.Phys = m.constructor;
    });
    if (!found.BufferGeometry) V.scene.traverse(function (o) { if (o.geometry && !found.BufferGeometry) found.BufferGeometry = Object.getPrototypeOf(o.geometry.constructor.prototype).constructor; });
    found.Vector3 = V.camera.position.constructor; found.Quaternion = V.camera.quaternion.constructor;
    found.Matrix4 = V.camera.matrixWorld.constructor; found.Color = (V.scene.background && V.scene.background.isColor) ? V.scene.background.constructor : null;
    return found.InstancedMesh && found.Mesh && found.BufferGeometry && found.BufferAttribute && (found.Std || found.Phys) && found.Color ? found : null;
  }

  // A small sphere (icosahedron subdivided once), unit radius.
  function ball() {
    var t = (1 + Math.sqrt(5)) / 2, v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    var f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    var norm = function (p) { var l = Math.hypot(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; };
    v = v.map(norm);
    var cache = {}, mid = function (a, b) { var key = a < b ? a + '_' + b : b + '_' + a; if (cache[key] == null) { v.push(norm([(v[a][0] + v[b][0]) / 2, (v[a][1] + v[b][1]) / 2, (v[a][2] + v[b][2]) / 2])); cache[key] = v.length - 1; } return cache[key]; };
    var f2 = [];
    f.forEach(function (tr) { var a = mid(tr[0], tr[1]), b = mid(tr[1], tr[2]), c = mid(tr[2], tr[0]); f2.push([tr[0], a, c], [tr[1], b, a], [tr[2], c, b], [a, b, c]); });
    var pos = new Float32Array(f2.length * 9), nor = new Float32Array(f2.length * 9);
    f2.forEach(function (tr, i) { for (var j = 0; j < 3; j++) { var p = v[tr[j]]; pos.set(p, i * 9 + j * 3); nor.set(p, i * 9 + j * 3); } });
    var g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('normal', new T.BufferAttribute(nor, 3));
    return g;
  }
  // A flat ring in the x-z plane, inner radius 0.8, outer 1.
  function ring() {
    var n = 40, pos = [], nor = [];
    for (var i = 0; i < n; i++) {
      var a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
      var p = function (a, r) { return [Math.cos(a) * r, 0, Math.sin(a) * r]; };
      [p(a0, 0.8), p(a0, 1), p(a1, 1), p(a0, 0.8), p(a1, 1), p(a1, 0.8)].forEach(function (q) { pos.push(q[0], q[1], q[2]); nor.push(0, 1, 0); });
    }
    var g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3)); g.setAttribute('normal', new T.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }
  function material(o) { var M = T.Phys || T.Std, m = new M(o); if (T.Phys && 'clearcoat' in m) { m.clearcoat = o.clearcoat || 0; m.clearcoatRoughness = 0.1; } return m; }

  // ---- the parts ---------------------------------------------------------------------------------------------
  var MAXB = 180;                         // coat blobs per hand
  var BONES = ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'];
  ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'].forEach(function (f) { BONES.push(f + '-metacarpal', f + '-phalanx-proximal', f + '-phalanx-intermediate', f + '-phalanx-distal', f + '-tip'); });
  var TIPS = ['thumb-tip', 'index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'];
  var gooMesh, wetMesh, dropMesh, wetDropMesh, ringMesh, strands = [], drops = [], rings = [], handState = [];
  var v1, v2, v3, q1, m1, col1, up;

  function setup() {
    T = classes(); if (!T) return false;
    v1 = new T.Vector3(); v2 = new T.Vector3(); v3 = new T.Vector3(); q1 = new T.Quaternion(); m1 = new T.Matrix4(); col1 = new T.Color(); up = new T.Vector3(0, 1, 0);
    var bg = ball();
    var make = function (count, mat) { var m = new T.InstancedMesh(bg, mat, count); m.count = 0; m.frustumCulled = false; m.castShadow = true; m.userData.noInk = true; m.setColorAt(0, new T.Color(1, 1, 1)); V.scene.add(m); return m; };
    gooMesh = make(MAXB * 2, material({ color: 0xffffff, roughness: 0.25, metalness: 0, clearcoat: 0.6 }));
    wetMesh = make(MAXB * 2, material({ color: 0xffffff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.55, clearcoat: 1, depthWrite: false }));
    wetMesh.castShadow = false;
    dropMesh = make(160, material({ color: 0xffffff, roughness: 0.2, metalness: 0, clearcoat: 0.6 }));
    wetDropMesh = make(160, material({ color: 0xffffff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.6, depthWrite: false }));
    wetDropMesh.castShadow = false;
    ringMesh = make(40, material({ color: 0xffffff, roughness: 0.2, transparent: true, opacity: 0.35, depthWrite: false }));
    ringMesh.geometry = ring(); ringMesh.castShadow = false;
    V.hands.forEach(function (h, i) {
      var blobs = [];
      for (var b = 0; b < MAXB; b++) {
        var name = BONES[b % BONES.length], bone = h.bones[name];
        if (!bone) continue;
        // A point on the surface of the finger: a random direction, mostly around the bone, scaled to a finger's width.
        var d = new T.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        var w = name === 'wrist' || name.indexOf('metacarpal') > 0 ? 0.13 : name.indexOf('tip') > 0 ? 0.05 : 0.075;
        blobs.push({ bone: bone, name: name, tip: name.indexOf('tip') > 0, vary: 0.6 + Math.random() * 0.4, off: d.multiplyScalar(w), amt: 0, col: [255, 255, 255], wet: false, p: null, v: new T.Vector3(), mix: null, life: 0 });
      }
      handState[i] = { blobs: blobs, under: {}, lastRing: 0, wasIn: false, sheen: 0 };
    });
    return true;
  }

  // ---- reading the game ----------------------------------------------------------------------------------------
  function potInfo() {
    var lay = V.potLayers(), P = V.POT;
    var r = (P.x1 - P.x0) / 2 * S - P.wall * S;
    return { lay: lay, surfaceY: Y3(lay.surface), bottomY: Y3(P.bottom), cx: X3((P.x0 + P.x1) / 2), r: r, rimY: Y3(P.rim), empty: lay.surface >= P.bottom - 0.5 };
  }
  function inPot(p, pot) { return Math.hypot(p.x - pot.cx, p.z) < pot.r && p.y > pot.bottomY - 0.1 && p.y < pot.rimY + 0.3; }
  function rgb(c, fallback) { if (Array.isArray(c)) return c; if (typeof c === 'string') { col1.set(c); col1.convertLinearToSRGB && col1.convertLinearToSRGB(); return [col1.r * 255, col1.g * 255, col1.b * 255]; } return fallback; }
  // What a hand is in: the layer at its fingers in the pot, or the slime it holds.
  function mixFor(hand, pot) {
    var hold = hand.holdId != null ? V.holds.get(hand.holdId) : null;
    if (!hold) return null;
    if (hold.body && (hold.body.type === 'slime' || hold.body.type === 'curd')) {
      var b = hold.body;
      return { kind: b.type === 'slime' ? 'slime' : 'plastic', col: b.type === 'slime' ? rgb(b.col, [150, 220, 255]) : [246, 242, 228], body: b };
    }
    if (!hold.stir || !hold.stir.inFluid) return null;
    var y = hold.stir.y, layer = pot.lay.L.filter(function (q) { return y >= q.top - 6 && y <= q.bottom; })[0] || pot.lay.L[pot.lay.L.length - 1];
    if (!layer) return null;
    var kind = LAYER[layer.kind] || 'water', pt = V.pot;
    if (layer.kind === 'aq' && pt.oobleck) kind = 'oobleck';
    else if (layer.kind === 'aq' && pt.glue > 4 && pt.glue > (pt.water || 0) * 0.3) kind = 'glue';
    var colr = hold.stir.coat ? rgb(hold.stir.coat, [200, 220, 255]) : [200, 220, 255];
    if (kind === 'water') colr = [Math.min(255, colr[0] * 0.6 + 100), Math.min(255, colr[1] * 0.6 + 100), Math.min(255, colr[2] * 0.6 + 110)];
    return { kind: kind, col: colr, speed: Math.hypot(hold.stir.vx, hold.stir.vy) };
  }

  // ---- the frame ----------------------------------------------------------------------------------------------
  var last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!V) { V = window.__labView || null; if (!V) return; }
    if (!started) { if (!V.hands.length || !V.scene) return; started = setup(); if (!started) return; last = now; }
    var dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (dt <= 0) return;
    var pot = potInfo(), gi = 0, wi = 0;
    V.hands.forEach(function (h, i) {
      var st = handState[i]; if (!st) return;
      var mix = mixFor(h, pot), M = mix ? MIX[mix.kind] : null, shown = h.root.visible;
      h.root.updateMatrixWorld(true);
      // Fast pokes stiffen oobleck: it stops coating and pushes back.
      var stiff = M && M.thickens && mix.speed > 500;
      var holding = mix && mix.body, bodyP = holding ? v3.set(X3(mix.body.x), Y3(mix.body.y), 0.45) : null;
      var anyIn = false, lowest = null, outAmt = 0;
      st.blobs.forEach(function (b) {
        var anchor = b.bone.getWorldPosition(v1);
        b.bone.getWorldQuaternion(q1);
        anchor.add(v2.copy(b.off).applyQuaternion(q1));
        var under = !!mix && (holding ? anchor.distanceTo(bodyP) < mix.body.r * S + 0.25 : (anchor.y < pot.surfaceY && inPot(anchor, pot)));
        if (under) anyIn = true;
        // Coat: what is under gets more of the mixture, up to its thickness; water washes goo away.
        if (under && M) {
          if (M.wash && b.amt > 0 && !b.wet) b.amt = Math.max(0, b.amt - dt * 1.5);
          else if (!stiff) {
            if (b.mix && b.mix !== mix.kind && b.amt > 0.05) b.amt *= Math.max(0, 1 - dt * 2);   // a new mixture slowly replaces the old one
            var room = M.max * b.vary - b.amt;
            if (room > 0) { b.amt += Math.min(room, M.stick * dt * 1.6); b.mix = mix.kind; b.wet = !!M.wet; b.col = mix.col; b.life = M.life; }
          }
        } else if (b.amt > 0 && b.mix) {
          // Out of the mixture: wet hands dry, goo slowly wears off.
          var MM = MIX[b.mix];
          b.amt = Math.max(0, b.amt - dt * MM.max / MM.life);
        }
        if (b.amt <= 0.005) { b.amt = 0; b.p = null; return; }
        if (!under) outAmt += b.amt;
        // Each blob hangs on a spring from its spot on the finger: its weight pulls it down, the spring holds it, and a
        // moving hand leaves it behind for a moment. Out of the mixture, drops fall from the fullest blobs, most often
        // from the fingertips; a hand shaken hard flings goo off.
        var MM2 = MIX[b.mix];
        if (!b.p) { b.p = anchor.clone(); b.v.set(0, 0, 0); b.a = anchor.clone(); }
        // Damping acts on the blob's motion relative to the finger, so a hand moving steadily carries its goo along and
        // only a sudden jerk leaves it behind.
        var k = MM2.k, c = Math.sqrt(k) * 1.2, ax = (anchor.x - b.a.x) / dt, ay = (anchor.y - b.a.y) / dt, az = (anchor.z - b.a.z) / dt;
        b.a.copy(anchor);
        b.v.x += (k * (anchor.x - b.p.x) - c * (b.v.x - ax)) * dt;
        b.v.y += (k * (anchor.y - b.p.y) - c * (b.v.y - ay) - 2 * b.amt) * dt;
        b.v.z += (k * (anchor.z - b.p.z) - c * (b.v.z - az)) * dt;
        b.p.addScaledVector(b.v, dt);
        // A hand going back to rest moves faster than any finger would: its goo just comes along.
        if (h.holdId == null) { var lag = b.p.distanceTo(anchor), most = 0.06 + 2 * b.amt / k; if (lag > most) { b.p.sub(anchor).multiplyScalar(most / lag).add(anchor); b.v.set(ax, ay, az); } }
        var hang = b.p.distanceTo(anchor), size = 0.014 + 0.038 * Math.sqrt(b.amt);
        if (!under && h.holdId != null && b.amt > 0.06 && hang - 2 * b.amt / k > 0.3) { drip(b, size, MM2); b.p = null; }
        else if (!under && b.amt > 0.1 && (!lowest || b.p.y < lowest.p.y)) lowest = b;
        if (!shown || !b.p) return;
        // Drawn as a drop that stretches from its spot toward where it hangs.
        var target = b.wet ? wetMesh : gooMesh, idx = b.wet ? wi++ : gi++;
        if (idx >= target.instanceMatrix.count) return;
        var dir = v2.copy(b.p).sub(anchor), len = dir.length();
        if (len > 1e-4) q1.setFromUnitVectors(up, dir.multiplyScalar(1 / len)); else q1.identity();
        var mid = v3.copy(anchor).lerp(b.p, 0.5);
        m1.compose(mid, q1, new T.Vector3(size, size + len * 0.5, size));
        target.setMatrixAt(idx, m1);
        col1.setRGB(b.col[0] / 255, b.col[1] / 255, b.col[2] / 255); col1.convertSRGBToLinear && col1.convertSRGBToLinear();
        target.setColorAt(idx, col1);
      });
      // Drops fall from the lowest coated point, more often the more of the hand is coated.
      if (lowest) {
        st.dripAcc = (st.dripAcc || 0) + dt * MIX[lowest.mix].drip * Math.min(1, outAmt / (MAXB * 0.4));
        if (st.dripAcc > 1) { st.dripAcc = 0; drip(lowest, 0.018 + 0.05 * Math.sqrt(lowest.amt), MIX[lowest.mix]); lowest.p = null; }
      }
      // Strands: a fingertip that comes out of something stretchy pulls a string of it.
      TIPS.forEach(function (name) {
        var bone = h.bones[name]; if (!bone) return;
        var p = bone.getWorldPosition(new T.Vector3());
        var under = !!mix && !holding && p.y < pot.surfaceY && inPot(p, pot);
        // The hand stops being "in" the mixture the moment it comes out, so the strand uses what it was last in.
        var LM = mix ? M : st.lastMix ? MIX[st.lastMix.kind] : null, lcol = mix ? mix.col : st.lastMix && st.lastMix.col;
        if (st.under[name] && !under && LM && LM.stretch > 0 && !stiff && strands.length < 10)
          strands.push(newStrand(bone, new T.Vector3(p.x, pot.surfaceY, p.z), LM, lcol));
        // Letting go of the slime pulls strings from the fingers to it.
        if (!holding && st.lastBody && M === null && strands.length < 8 && Math.random() < 0.7)
          strands.push(newStrand(bone, new T.Vector3(X3(st.lastBody.x), Y3(st.lastBody.y), 0.45), MIX.slime, st.lastCol, st.lastBody));
        st.under[name] = under;
      });
      // Rings on the surface where a hand goes in or sweeps through.
      if (mix && !holding && !pot.empty) {
        var tip = h.bones['middle-finger-tip'].getWorldPosition(new T.Vector3());
        var visc = M ? 1 / Math.max(0.2, Math.sqrt(M.k / 100)) : 1;
        if (rings.length < 40 && ((!st.wasIn && st.lastRing > 0.3) || (mix.speed > 250 && st.lastRing > (0.12 + 0.2 * visc)))) { rings.push({ x: tip.x, z: tip.z, y: pot.surfaceY + 0.012, t: 0, life: M && M.wet ? 1.2 : 2.2, grow: M && M.wet ? 1.6 : 0.5, col: mix.col }); st.lastRing = 0; }
        st.lastRing += dt;
      }
      st.wasIn = !!mix && anyIn;
      if (mix && !holding) st.lastMix = mix; else if (!mix && !anyIn) { st.lastMixT = (st.lastMixT || 0) + dt; if (st.lastMixT > 0.5) { st.lastMix = null; st.lastMixT = 0; } }
      st.lastBody = holding ? mix.body : null; st.lastCol = holding ? mix.col : st.lastCol;
    });
    gooMesh.count = gi; wetMesh.count = wi;
    gooMesh.instanceMatrix.needsUpdate = wetMesh.instanceMatrix.needsUpdate = true;
    if (gooMesh.instanceColor) gooMesh.instanceColor.needsUpdate = true;
    if (wetMesh.instanceColor) wetMesh.instanceColor.needsUpdate = true;
    stepStrands(dt, pot); stepDrops(dt, pot); stepRings(dt);
  }

  // ---- drops ------------------------------------------------------------------------------------------------------
  function drip(b, size, M) {
    var share = Math.min(b.amt, 0.08 + b.amt * 0.25);
    if (drops.length < 150) drops.push({ p: b.p.clone(), v: b.v.clone().multiplyScalar(0.5), r: size * (b.wet ? 0.7 : 0.9), col: b.col, wet: b.wet, t: 0, landed: false, k: M });
    b.amt -= share;
  }
  function stepDrops(dt, pot) {
    var gi = 0, wi = 0;
    for (var i = drops.length - 1; i >= 0; i--) {
      var d = drops[i]; d.t += dt;
      if (!d.landed) {
        d.v.y -= G * dt; d.p.addScaledVector(d.v, dt);
        var inside = Math.hypot(d.p.x - pot.cx, d.p.z) < pot.r;
        if (inside && !pot.empty && d.p.y < pot.surfaceY) { if (rings.length < 40) rings.push({ x: d.p.x, z: d.p.z, y: pot.surfaceY + 0.012, t: 0, life: 0.9, grow: d.wet ? 0.9 : 0.35, col: d.col }); drops.splice(i, 1); continue; }
        var floor = inside ? pot.bottomY : -3.4;
        if (d.p.y < floor) { d.p.y = floor + 0.005; d.landed = true; d.t = 0; }
      } else if (d.t > 5) { drops.splice(i, 1); continue; }
      var mesh = d.wet ? wetDropMesh : dropMesh, idx = d.wet ? wi++ : gi++;
      if (idx >= mesh.instanceMatrix.count) continue;
      // Falling, a drop is a little longer than wide; landed, it spreads into a flat splat that fades.
      var sx = d.landed ? d.r * (1.8 + Math.min(1, d.t * 4)) * Math.max(0, 1 - d.t / 5) : d.r;
      var sy = d.landed ? d.r * 0.25 * Math.max(0, 1 - d.t / 5) : d.r * (1 + Math.min(1.2, Math.abs(d.v.y) * 0.05));
      q1.identity(); m1.compose(d.p, q1, new T.Vector3(sx, Math.max(1e-4, sy), sx));
      mesh.setMatrixAt(idx, m1);
      col1.setRGB(d.col[0] / 255, d.col[1] / 255, d.col[2] / 255); col1.convertSRGBToLinear && col1.convertSRGBToLinear();
      mesh.setColorAt(idx, col1);
    }
    dropMesh.count = gi; wetDropMesh.count = wi;
    [dropMesh, wetDropMesh].forEach(function (m) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
  }

  // ---- strands ----------------------------------------------------------------------------------------------------
  // A strand is a chain of points held to the fingertip at the top and the mixture (or the slime) at the bottom. Each
  // link resists stretching but slowly flows longer (the goo yields), gravity sags it, and its thickness keeps its
  // volume: it thins as it stretches and snaps when it is too thin or too long.
  var N = 14;
  function newStrand(bone, base, M, colr, body) {
    var top = bone.getWorldPosition(new T.Vector3()), pts = [], prev = [];
    for (var i = 0; i < N; i++) { var p = top.clone().lerp(base, i / (N - 1)); pts.push(p); prev.push(p.clone()); }
    var len = Math.max(0.02, top.distanceTo(base));
    var geo = new T.BufferGeometry(), segs = 6;
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array(N * segs * 3), 3));
    geo.setAttribute('normal', new T.BufferAttribute(new Float32Array(N * segs * 3), 3));
    var idx = []; for (var a = 0; a < N - 1; a++) for (var s = 0; s < segs; s++) { var i0 = a * segs + s, i1 = a * segs + (s + 1) % segs, j0 = i0 + segs, j1 = i1 + segs; idx.push(i0, j0, i1, i1, j0, j1); }
    geo.setIndex(idx);
    var mat = material({ color: 0xffffff, roughness: M.rough, metalness: 0, clearcoat: 0.6 });
    col1.setRGB(colr[0] / 255, colr[1] / 255, colr[2] / 255); col1.convertSRGBToLinear && col1.convertSRGBToLinear(); mat.color.copy(col1);
    var mesh = new T.Mesh(geo, mat); mesh.frustumCulled = false; mesh.userData.noInk = true; mesh.castShadow = true; V.scene.add(mesh);
    return { col: colr, bone: bone, base: base, body: body, pts: pts, prev: prev, rest: len / (N - 1), vol: 0.0006 * (0.5 + M.stretch * 0.4), max: M.stretch, M: M, mesh: mesh, segs: segs, t: 0, broken: false };
  }
  function stepStrands(dt, pot) {
    for (var s = strands.length - 1; s >= 0; s--) {
      var st = strands[s], pts = st.pts, prev = st.prev;
      st.t += dt;
      var top = st.broken === 'bottom' ? null : st.bone.getWorldPosition(v1).clone();
      if (st.body) st.base.set(X3(st.body.x), Y3(st.body.y), 0.45);
      // Verlet: each loose point keeps its speed, with gravity and a little drag.
      for (var i = 0; i < N; i++) {
        var p = pts[i], q = prev[i], vx = (p.x - q.x) * 0.96, vy = (p.y - q.y) * 0.96, vz = (p.z - q.z) * 0.96;
        q.copy(p); p.x += vx; p.y += vy - G * dt * dt; p.z += vz;
      }
      // The goo flows: links lengthen toward the length they are pulled to.
      var cur = 0; for (i = 1; i < N; i++) cur += pts[i].distanceTo(pts[i - 1]);
      st.rest += (cur / (N - 1) - st.rest) * Math.min(1, dt * 1.5);
      for (var it = 0; it < 6; it++) {
        if (top) pts[0].copy(top);
        if (!st.broken) pts[N - 1].copy(st.base);
        for (i = 1; i < N; i++) {
          var a = pts[i - 1], b = pts[i], d = v2.copy(b).sub(a), l = d.length() || 1e-6, diff = (l - st.rest) / l;
          var wa = (i - 1 === 0 && top) ? 0 : 0.5, wb = (i === N - 1 && !st.broken) ? 0 : 0.5;
          if (wa + wb === 0) continue; var f = 1 / (wa + wb);
          a.addScaledVector(d, diff * wa * f); b.addScaledVector(d, -diff * wb * f);
        }
      }
      var length = st.rest * (N - 1), radius = Math.sqrt(st.vol / (Math.PI * Math.max(0.05, length)));
      if (!st.broken && (length > st.max || radius < 0.006)) {
        st.broken = 'middle'; st.t = 0;
        // Snapped: the upper half pulls back up to the finger and the rest falls back in.
        drops.push({ p: pts[N >> 1].clone(), v: new T.Vector3(0, -1, 0), r: Math.max(0.02, radius * 2), col: st.col, wet: false, t: 0, landed: false });
      }
      if (st.broken) { st.rest *= Math.max(0, 1 - dt * 4); if (st.t > 0.6) { V.scene.remove(st.mesh); st.mesh.geometry.dispose(); st.mesh.material.dispose(); strands.splice(s, 1); continue; } }
      // The tube.
      var posA = st.mesh.geometry.attributes.position, norA = st.mesh.geometry.attributes.normal, segs = st.segs;
      for (i = 0; i < N; i++) {
        var t2 = v2.copy(pts[Math.min(N - 1, i + 1)]).sub(pts[Math.max(0, i - 1)]).normalize();
        var side = v3.set(0, 1, 0); if (Math.abs(t2.y) > 0.9) side.set(1, 0, 0);
        var n1 = side.clone().cross(t2).normalize(), n2 = t2.clone().cross(n1).normalize();
        // Thicker at the ends, where it pulls out of the goo and off the finger.
        var r = radius * (1 + 0.8 * Math.pow(Math.abs(i / (N - 1) - 0.5) * 2, 3)) * (st.broken ? Math.max(0, 1 - st.t * 1.6) : 1);
        for (var k2 = 0; k2 < segs; k2++) {
          var ang = k2 / segs * Math.PI * 2, cx = Math.cos(ang), sy = Math.sin(ang);
          var nx = n1.x * cx + n2.x * sy, ny = n1.y * cx + n2.y * sy, nz = n1.z * cx + n2.z * sy, o = (i * segs + k2) * 3;
          posA.array[o] = pts[i].x + nx * r; posA.array[o + 1] = pts[i].y + ny * r; posA.array[o + 2] = pts[i].z + nz * r;
          norA.array[o] = nx; norA.array[o + 1] = ny; norA.array[o + 2] = nz;
        }
      }
      posA.needsUpdate = norA.needsUpdate = true;
      st.mesh.geometry.computeBoundingSphere();
    }
  }

  // ---- rings -------------------------------------------------------------------------------------------------------
  function stepRings(dt) {
    var n = 0;
    for (var i = rings.length - 1; i >= 0; i--) {
      var r = rings[i]; r.t += dt;
      if (r.t > r.life) { rings.splice(i, 1); continue; }
      if (n >= ringMesh.instanceMatrix.count) continue;
      var k = r.t / r.life, s = 0.05 + r.grow * Math.sqrt(k) * 0.6;
      q1.identity(); m1.compose(v1.set(r.x, r.y, r.z), q1, v2.set(s, 1, s));
      ringMesh.setMatrixAt(n, m1);
      var f = 1 - k;
      col1.setRGB(0.9 * f + 0.1, 0.95 * f + 0.05, 1 * f); ringMesh.setColorAt(n, col1);
      n++;
    }
    ringMesh.count = n; ringMesh.instanceMatrix.needsUpdate = true; if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true;
  }

  requestAnimationFrame(frame);
  window.__labGoo = { get drops() { return drops.length; }, get strands() { return strands.length; }, get rings() { return rings.length; },
    state: function () { return handState; },
    coat: function () { return handState.map(function (s) { return s ? s.blobs.reduce(function (a, b) { return a + b.amt; }, 0) : 0; }); } };
})();
/* LAB GOO END */
