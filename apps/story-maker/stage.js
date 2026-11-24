// The story stage: the cast as toy-like 3D figures on a small set for the story's place, acting out each line while
// it is read. Everything is built from three.js shapes here, so there is nothing to download and it runs offline.
// index.html drives it: STAGE.setScene() when a scene starts, STAGE.line() as each line is read, STAGE.quiet() when
// the line ends, STAGE.cheer() at the end. Without WebGL, STAGE.ok is false and the page shows its emoji strip.
// A line's stage direction is a list of { who, move, do, face, prop } (see MARKS and ACTIONS); a line without one is
// acted from its mood. Story time runs on its own clock (update), so tests can step it and look at frames.
'use strict';
(function () {
  const T = window.THREE;
  const STAGE = window.STAGE = { ok: false, MARKS: ['left', 'center', 'right', 'front', 'back'], ACTIONS: [
    'wave', 'jump', 'dance', 'spin', 'cheer', 'clap', 'laugh', 'nod', 'shake', 'point', 'think', 'look', 'shy', 'hide',
    'sad', 'scared', 'sleep', 'bow', 'hug', 'run', 'sneeze', 'knock', 'talk'] };
  if (!T) return;
  let renderer = null;
  try {
    const probe = document.createElement('canvas');
    if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) return;
    renderer = new T.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  } catch (e) { return; }
  STAGE.ok = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = T.SRGBColorSpace;

  // ---- shapes and materials ----------------------------------------------------------------------------------
  // The storybook look shared with the other 3D apps: flat toon shading in three steps and a dark ink outline round each
  // part (ink() below). The child's own face is her My Avatar portrait and keeps its realistic look.
  const TOON = (() => { const t = new T.DataTexture(new Uint8Array([100, 165, 215]), 3, 1, T.RedFormat); t.minFilter = t.magFilter = T.NearestFilter; t.needsUpdate = true; return t; })();
  const mats = new Map();
  const mat = (c, r = 0.55, extra) => {
    const key = c + '|' + r + '|' + (extra ? JSON.stringify(extra) : '');
    if (!mats.has(key)) { const o = Object.assign({}, extra || {}); delete o.metalness; delete o.roughness; mats.set(key, new T.MeshToonMaterial(Object.assign({ color: c, gradientMap: TOON }, o))); }
    return mats.get(key);
  };
  const glow = (c, k = 1.2) => mat(c, 0.4, { emissive: c, emissiveIntensity: k });
  function add(parent, geo, m, x = 0, y = 0, z = 0, o) {
    const mesh = new T.Mesh(geo, m); mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
    if (o && o.s) mesh.scale.set(o.s[0], o.s[1], o.s[2]);
    if (o && o.r) mesh.rotation.set(o.r[0], o.r[1], o.r[2]);
    if (o && o.noShadow) mesh.castShadow = false;
    parent.add(mesh); return mesh;
  }
  const sph = (r, s = 28) => new T.SphereGeometry(r, s, Math.round(s * 0.75));
  const cap = (r, l) => new T.CapsuleGeometry(r, l, 8, 20);
  const cyl = (a, b, h, s = 24) => new T.CylinderGeometry(a, b, h, s);
  const cone = (r, h, s = 20) => new T.ConeGeometry(r, h, s);
  const torus = (r, t, a = Math.PI * 2) => new T.TorusGeometry(r, t, 10, 28, a);
  function roundBox(w, h, d, r) {
    const s = new T.Shape(), x = -w / 2 + r, y = -h / 2 + r, ww = w - 2 * r, hh = h - 2 * r;
    s.moveTo(x, y - r); s.lineTo(x + ww, y - r); s.quadraticCurveTo(x + ww + r, y - r, x + ww + r, y); s.lineTo(x + ww + r, y + hh);
    s.quadraticCurveTo(x + ww + r, y + hh + r, x + ww, y + hh + r); s.lineTo(x, y + hh + r); s.quadraticCurveTo(x - r, y + hh + r, x - r, y + hh);
    s.lineTo(x - r, y); s.quadraticCurveTo(x - r, y - r, x, y - r);
    const g = new T.ExtrudeGeometry(s, { depth: Math.max(0.001, d - 2 * r), bevelEnabled: true, bevelThickness: r, bevelSize: r * 0.98, bevelSegments: 4, curveSegments: 8 });
    g.translate(0, 0, -(d - 2 * r) / 2); g.computeVertexNormals(); return g;
  }
  // Ink outline: a copy of each solid part drawn inside out and pushed out along its normals by a fixed width in view
  // space, so thin and thick parts get the same line whatever their scale. Glows, sprites, see-through parts, the
  // portrait face and the big ground and sea pieces get none.
  const INK_W = 0.024;
  const INK = new T.MeshBasicMaterial({ color: '#2B2140', side: T.BackSide });
  INK.onBeforeCompile = sh => { sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nmvPosition.xyz += normalize( normalMatrix * normal ) * ' + INK_W.toFixed(4) + ';\ngl_Position = projectionMatrix * mvPosition;'); };
  const ws = new T.Vector3();
  function ink(root) {
    const list = []; root.updateMatrixWorld(true);
    root.traverse(m => { if (m.isMesh && !m.userData.ink && !m.userData.inked) list.push(m); });
    for (const m of list) {
      const mt = m.material; m.userData.inked = true;
      if (!mt || Array.isArray(mt) || !mt.isMeshToonMaterial || mt.transparent || (mt.emissiveIntensity > 0.5 && mt.emissive && mt.emissive.getHex())) continue;
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      m.getWorldScale(ws); const r = m.geometry.boundingSphere.radius * Math.max(ws.x, ws.y, ws.z);
      if (r < 0.03 || r > 4) continue;
      const o = new T.Mesh(m.geometry, INK); o.userData.ink = true; o.raycast = () => {}; o.castShadow = o.receiveShadow = false; m.add(o);
    }
  }
  // An emoji drawn on a canvas, for props, the scene's things and the child's face when there is no portrait.
  const emojiCache = new Map();
  function emojiTexture(ch) {
    if (emojiCache.has(ch)) return emojiCache.get(ch);
    const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c = cv.getContext('2d');
    c.font = '100px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(ch, 64, 72);
    const t = new T.CanvasTexture(cv); if ('colorSpace' in t) t.colorSpace = T.SRGBColorSpace; emojiCache.set(ch, t); return t;
  }
  function emojiSprite(ch, size) {
    const s = new T.Sprite(new T.SpriteMaterial({ map: emojiTexture(ch), transparent: true, depthWrite: false }));
    s.scale.set(size, size, 1); return s;
  }

  const BLACK = mat('#1b1b24', 0.15), GLINT = new T.MeshBasicMaterial({ color: '#ffffff' });
  function eyes(head, y, z, spread, r, ring) {
    const out = [];
    for (const sx of [-1, 1]) {
      const g = new T.Group(); g.position.set(sx * spread, y, z); head.add(g);
      if (ring) add(g, sph(r * 1.45, 20), mat(ring, 0.5), 0, 0, -r * 0.35, { s: [1, 1, 0.5] });
      add(g, sph(r, 18), BLACK, 0, 0, 0, { s: [1, 1.12, 0.7] });
      add(g, sph(r * 0.32, 8), GLINT, r * 0.33, r * 0.38, r * 0.62, { noShadow: true });
      out.push(g);
    }
    return out;
  }
  const mouthOn = (head, y, z, w) => add(head, sph(w, 14), mat('#5a1f2a', 0.4), 0, y, z, { s: [1, 0.35, 0.4] });
  function rig(id) {
    const root = new T.Group(); root.name = id;
    const body = new T.Group(); root.add(body);
    const head = new T.Group(); body.add(head);
    const armL = new T.Group(), armR = new T.Group(); body.add(armL, armR);
    return { id, root, body, head, armL, armR, eyes: [], mouth: null, height: 1.5 };
  }
  function arm(g, m, x, y, len, r) { g.position.set(x, y, 0); add(g, cap(r, len), m, 0, -len / 2, 0); add(g, sph(r * 1.25, 12), m, 0, -len - r * 0.4, 0); }
  function feet(c, m, spread, r, z = 0.08) { for (const sx of [-1, 1]) add(c.body, sph(r, 16), m, sx * spread, r * 0.55, z, { s: [1, 0.55, 1.5] }); }

  // ---- the cast ----------------------------------------------------------------------------------------------
  const MAKE = {
    bun() {
      const c = rig('bun'), fur = mat('#ece6dc', 0.85), pink = mat('#f4a7b9', 0.6), tweed = mat('#8a6f4e', 0.9);
      add(c.body, cap(0.36, 0.34), tweed, 0, 0.62, 0);
      add(c.body, sph(0.27), fur, 0, 0.6, 0.18, { s: [1, 1.15, 0.6] });
      feet(c, fur, 0.17, 0.17);
      add(c.body, sph(0.12, 14), mat('#ffffff', 0.95), 0, 0.5, -0.36);
      const bow = new T.Group(); bow.position.set(0, 0.95, 0.29); c.body.add(bow);
      for (const sx of [-1, 1]) add(bow, cone(0.08, 0.14, 12), mat('#c0392b', 0.5), sx * 0.07, 0, 0, { r: [0, 0, sx * Math.PI / 2] });
      c.head.position.set(0, 1.28, 0.02);
      add(c.head, sph(0.33), fur, 0, 0, 0, { s: [1, 0.95, 0.95] });
      add(c.head, sph(0.16), mat('#fbf8f2', 0.9), 0, -0.1, 0.24, { s: [1.2, 0.8, 0.7] });
      add(c.head, sph(0.05, 10), pink, 0, -0.02, 0.36);
      for (const sx of [-1, 1]) {
        const e = new T.Group(); e.position.set(sx * 0.13, 0.28, -0.02); e.rotation.z = -sx * 0.18; c.head.add(e);
        add(e, cap(0.08, 0.42), fur, 0, 0.26, 0, { s: [1, 1, 0.6] });
        add(e, cap(0.045, 0.36), pink, 0, 0.26, 0.035, { s: [1, 1, 0.4] });
        add(c.head, sph(0.09, 14), mat('#f7f4ee', 0.95), sx * 0.08, -0.13, 0.33, { s: [1.3, 0.55, 0.6] });
      }
      c.eyes = eyes(c.head, 0.05, 0.27, 0.12, 0.055);
      const brass = mat('#c9a227', 0.3, { metalness: 0.6 });
      for (const sx of [-1, 1]) add(c.head, torus(0.085, 0.012), brass, sx * 0.12, 0.05, 0.31);
      c.mouth = mouthOn(c.head, -0.2, 0.3, 0.05);
      arm(c.armL, tweed, -0.38, 0.85, 0.32, 0.075); arm(c.armR, tweed, 0.38, 0.85, 0.32, 0.075);
      const cane = new T.Group(); cane.position.set(0, -0.46, 0.06); c.armR.add(cane);
      add(cane, cyl(0.022, 0.022, 0.72, 8), mat('#5b3a21', 0.6), 0, -0.3, 0);
      add(cane, torus(0.06, 0.022, Math.PI), mat('#5b3a21', 0.6), -0.06, 0.06, 0);
      c.height = 2.0; return c;
    },
    spark() {
      const c = rig('spark'), green = mat('#5cc46b', 0.5), belly = mat('#ffe08a', 0.6), orange = mat('#ff8c42', 0.5), wing = mat('#9b6cd6', 0.6, { side: T.DoubleSide });
      add(c.body, sph(0.42), green, 0, 0.55, 0, { s: [1, 1.05, 0.95] });
      add(c.body, sph(0.32), belly, 0, 0.5, 0.17, { s: [1, 1.1, 0.6] });
      feet(c, green, 0.2, 0.15);
      for (let i = 0; i < 4; i++) add(c.body, cone(0.055, 0.14, 10), orange, 0, 0.95 - i * 0.18, -0.28 - i * 0.05, { r: [-0.6 - i * 0.25, 0, 0] });
      const tail = new T.Group(); tail.position.set(0, 0.32, -0.36); c.body.add(tail); c.tail = tail;
      add(tail, cone(0.14, 0.62, 14), green, 0, 0, -0.26, { r: [-Math.PI / 2 - 0.5, 0, 0] });
      for (const sx of [-1, 1]) {
        const s = new T.Shape(); s.moveTo(0, 0); s.quadraticCurveTo(0.35, 0.25, 0.48, 0.05); s.quadraticCurveTo(0.34, 0.02, 0.38, -0.12); s.quadraticCurveTo(0.2, -0.04, 0, -0.08);
        add(c.body, new T.ShapeGeometry(s, 10), wing, sx * 0.22, 0.82, -0.2, { r: [0.2, sx > 0 ? -0.5 : Math.PI + 0.5, 0] });
      }
      c.head.position.set(0, 1.12, 0.05);
      add(c.head, sph(0.32), green);
      add(c.head, sph(0.2), green, 0, -0.08, 0.24, { s: [1.15, 0.8, 1] });
      for (const sx of [-1, 1]) { add(c.head, sph(0.025, 8), mat('#2c6b35', 0.6), sx * 0.07, -0.02, 0.43); add(c.head, cone(0.06, 0.2, 12), belly, sx * 0.15, 0.3, -0.04, { r: [-0.25, 0, -sx * 0.35] }); }
      c.eyes = eyes(c.head, 0.1, 0.24, 0.13, 0.065, '#ffffff');
      c.mouth = mouthOn(c.head, -0.15, 0.4, 0.07);
      arm(c.armL, green, -0.4, 0.72, 0.2, 0.07); arm(c.armR, green, 0.4, 0.72, 0.2, 0.07);
      c.height = 1.6; c.sparks = true; return c;
    },
    beep() {
      const c = rig('beep'), shell = mat('#c9d6e3', 0.35, { metalness: 0.25 }), dark = mat('#2a3340', 0.3), eye = glow('#4ff0ff', 1.4);
      add(c.body, roundBox(0.7, 0.6, 0.5, 0.12), shell, 0, 0.62, 0);
      for (const [x, col] of [[-0.14, '#ff5d73'], [0, '#ffd23f'], [0.14, '#3ddc84']]) add(c.body, cyl(0.045, 0.045, 0.04, 12), glow(col, 0.5), x, 0.58, 0.26, { r: [Math.PI / 2, 0, 0] });
      for (const sx of [-1, 1]) { add(c.body, cyl(0.06, 0.06, 0.26, 10), dark, sx * 0.18, 0.22, 0); add(c.body, roundBox(0.2, 0.1, 0.28, 0.04), shell, sx * 0.18, 0.06, 0.04); }
      c.head.position.set(0, 1.18, 0);
      add(c.head, roundBox(0.62, 0.46, 0.46, 0.13), shell);
      add(c.head, roundBox(0.5, 0.32, 0.06, 0.06), dark, 0, 0, 0.21);
      for (const sx of [-1, 1]) { const g = new T.Group(); g.position.set(sx * 0.11, 0.03, 0.25); c.head.add(g); add(g, cyl(0.055, 0.055, 0.02, 16), eye, 0, 0, 0, { r: [Math.PI / 2, 0, 0] }); c.eyes.push(g); add(c.head, cyl(0.07, 0.07, 0.05, 14), dark, sx * 0.33, 0, 0, { r: [0, 0, Math.PI / 2] }); }
      c.mouth = add(c.head, roundBox(0.14, 0.035, 0.02, 0.012), eye, 0, -0.08, 0.255);
      add(c.head, cyl(0.015, 0.015, 0.2, 6), dark, 0, 0.32, 0);
      c.bulb = add(c.head, sph(0.05, 12), glow('#ff4d4d', 1.2), 0, 0.44, 0);
      arm(c.armL, dark, -0.42, 0.8, 0.26, 0.05); arm(c.armR, dark, 0.42, 0.8, 0.26, 0.05);
      c.height = 1.75; return c;
    },
    twinkle() {
      const c = rig('twinkle'), white = mat('#fbf7ff', 0.6), hoof = mat('#b9a6e8', 0.4), gold = mat('#ffcc4d', 0.3, { metalness: 0.4 });
      const mane = ['#ff7eb6', '#ffb86b', '#ffe66b', '#7ee0a0', '#7ec8ff', '#b48cff'].map(x => mat(x, 0.6));
      add(c.body, cap(0.34, 0.36), white, 0, 0.66, 0);
      for (const sx of [-1, 1]) { add(c.body, cap(0.1, 0.22), white, sx * 0.16, 0.26, 0); add(c.body, cyl(0.11, 0.12, 0.12, 14), hoof, sx * 0.16, 0.06, 0); }
      for (let i = 0; i < 4; i++) add(c.body, sph(0.1, 12), mane[i + 1], 0.02 * i, 0.55 - i * 0.07, -0.36 - i * 0.07);   // tail
      c.head.position.set(0, 1.3, 0.04);
      add(c.head, sph(0.3), white, 0, 0, 0, { s: [0.95, 1, 1] });
      add(c.head, sph(0.2), white, 0, -0.12, 0.2, { s: [1, 0.85, 1.15] });
      for (const sx of [-1, 1]) { add(c.head, sph(0.022, 8), mat('#c9a0dc', 0.6), sx * 0.07, -0.13, 0.42); add(c.head, cone(0.07, 0.18, 10), white, sx * 0.17, 0.27, -0.04, { r: [0, 0, -sx * 0.3] }); }
      const horn = new T.Group(); horn.position.set(0, 0.3, 0.12); horn.rotation.x = 0.3; c.head.add(horn);
      add(horn, cone(0.07, 0.38, 14), gold, 0, 0.17, 0);
      for (let i = 0; i < 3; i++) add(horn, torus(0.055 - i * 0.012, 0.012), gold, 0, 0.06 + i * 0.09, 0, { r: [Math.PI / 2, 0, 0] });
      for (let i = 0; i < 6; i++) add(c.head, sph(0.11, 12), mane[i], 0, 0.22 - i * 0.1, -0.2 - Math.sin(i * 0.5) * 0.06);
      c.eyes = eyes(c.head, 0.07, 0.27, 0.13, 0.06);
      for (const e of c.eyes) add(e, cyl(0.004, 0.004, 0.06, 4), BLACK, 0.03, 0.08, 0, { r: [0, 0, -0.4] });   // lashes
      c.mouth = mouthOn(c.head, -0.24, 0.3, 0.05);
      arm(c.armL, white, -0.36, 0.9, 0.28, 0.08); arm(c.armR, white, 0.36, 0.9, 0.28, 0.08);
      c.height = 2.0; return c;
    },
    pip() {
      const c = rig('pip'), navy = mat('#253050', 0.5), white = mat('#ffffff', 0.6), orange = mat('#ffa83d', 0.45);
      add(c.body, sph(0.38), navy, 0, 0.55, 0, { s: [1, 1.22, 0.95] });
      add(c.body, sph(0.3), white, 0, 0.5, 0.13, { s: [1, 1.25, 0.75] });
      for (const sx of [-1, 1]) add(c.body, sph(0.12, 14), orange, sx * 0.14, 0.06, 0.16, { s: [1, 0.35, 1.5] });
      c.head.position.set(0, 1.06, 0.02);
      add(c.head, sph(0.29), navy);
      add(c.head, sph(0.21), white, 0, -0.04, 0.12, { s: [1.15, 0.95, 0.85] });
      add(c.head, cone(0.06, 0.15, 12), orange, 0, -0.06, 0.34, { r: [Math.PI / 2, 0, 0] });
      for (const sx of [-1, 1]) add(c.head, sph(0.045, 10), mat('#ffb3c1', 0.8), sx * 0.17, -0.1, 0.22, { s: [1, 0.6, 0.4] });
      c.eyes = eyes(c.head, 0.04, 0.25, 0.1, 0.05);
      c.mouth = mouthOn(c.head, -0.15, 0.27, 0.035);
      c.armL.position.set(-0.36, 0.78, 0); add(c.armL, sph(0.13, 14), navy, 0, -0.18, 0, { s: [0.45, 1.5, 0.8] });
      c.armR.position.set(0.36, 0.78, 0); add(c.armR, sph(0.13, 14), navy, 0, -0.18, 0, { s: [0.45, 1.5, 0.8] });
      c.height = 1.5; return c;
    },
    // The child: her My Avatar portrait is her face; until it loads (or with none), a kid emoji.
    me() {
      const c = rig('me'), shirt = mat('#ffcf3f', 0.7), pants = mat('#3a6fd8', 0.75), shoe = mat('#ff5d8f', 0.5), skin = mat('#e8b996', 0.7);
      add(c.body, cap(0.27, 0.34), shirt, 0, 0.82, 0);
      for (const sx of [-1, 1]) { add(c.body, cap(0.1, 0.3), pants, sx * 0.12, 0.33, 0); add(c.body, sph(0.12, 14), shoe, sx * 0.12, 0.07, 0.05, { s: [1, 0.6, 1.4] }); }
      add(c.body, cyl(0.24, 0.27, 0.16, 18), pants, 0, 0.55, 0);
      c.head.position.set(0, 1.42, 0);
      const back = add(c.head, sph(0.3), mat('#ffffff', 0.9), 0, 0, -0.02, { s: [1, 1, 0.55] });
      const face = new T.Mesh(new T.CircleGeometry(0.31, 40), new T.MeshBasicMaterial({ map: emojiTexture('🧒'), transparent: true }));
      face.position.set(0, 0, 0.15); c.head.add(face); c.face = face; c.faceBack = back;
      add(c.head, torus(0.31, 0.025), mat('#ffcf3f', 0.5), 0, 0, 0.15);
      arm(c.armL, skin, -0.33, 1.06, 0.3, 0.07); arm(c.armR, skin, 0.33, 1.06, 0.3, 0.07);
      for (const a of [c.armL, c.armR]) add(a, cap(0.085, 0.08), shirt, 0, -0.05, 0);
      c.height = 1.9; c.portrait = true; return c;
    },
    hop() {
      const c = rig('hop'), green = mat('#6fcf4f', 0.45), belly = mat('#e6f7b0', 0.6), pink = mat('#ff8fa3', 0.6);
      add(c.body, sph(0.42), green, 0, 0.46, 0, { s: [1.1, 0.9, 0.95] });
      add(c.body, sph(0.32), belly, 0, 0.42, 0.16, { s: [1.1, 0.95, 0.6] });
      for (const sx of [-1, 1]) add(c.body, sph(0.16, 14), green, sx * 0.28, 0.07, 0.15, { s: [1.2, 0.4, 1.7] });
      c.head.position.set(0, 0.92, 0.05);
      add(c.head, sph(0.34), green, 0, 0, 0, { s: [1.15, 0.8, 0.95] });
      for (const sx of [-1, 1]) add(c.head, sph(0.13, 16), green, sx * 0.17, 0.2, 0.08);
      c.eyes = eyes(c.head, 0.22, 0.17, 0.17, 0.075, '#ffffff');
      c.mouth = add(c.head, torus(0.17, 0.018, Math.PI), mat('#2f5f2a', 0.5), 0, -0.07, 0.24, { r: [0, 0, Math.PI] });
      for (const sx of [-1, 1]) add(c.head, sph(0.04, 10), pink, sx * 0.24, -0.05, 0.22, { s: [1, 0.6, 0.4] });
      arm(c.armL, green, -0.42, 0.62, 0.2, 0.06); arm(c.armR, green, 0.42, 0.62, 0.2, 0.06);
      c.height = 1.3; c.mouthArc = true; return c;
    },
    rusty() {
      const c = rig('rusty'), fur = mat('#ff8a3d', 0.6), cream = mat('#fff1df', 0.7), dark = mat('#3b2418', 0.6);
      add(c.body, cap(0.3, 0.36), fur, 0, 0.66, 0);
      add(c.body, sph(0.22), cream, 0, 0.7, 0.16, { s: [1, 1.3, 0.6] });
      for (const sx of [-1, 1]) { add(c.body, cap(0.09, 0.2), dark, sx * 0.14, 0.22, 0); add(c.body, sph(0.11, 12), dark, sx * 0.14, 0.06, 0.05, { s: [1, 0.6, 1.3] }); }
      const tail = new T.Group(); tail.position.set(0, 0.45, -0.3); c.body.add(tail); c.tail = tail;
      add(tail, sph(0.2), fur, 0, 0.12, -0.18, { s: [0.8, 0.8, 1.6] }); add(tail, sph(0.13, 14), cream, 0, 0.22, -0.42, { s: [0.9, 0.9, 1.2] });
      c.head.position.set(0, 1.25, 0.03);
      add(c.head, sph(0.3), fur);
      add(c.head, cone(0.18, 0.34, 18), cream, 0, -0.08, 0.3, { r: [Math.PI / 2, 0, 0] });
      add(c.head, sph(0.045, 10), dark, 0, -0.08, 0.47);
      for (const sx of [-1, 1]) {
        add(c.head, cone(0.11, 0.3, 14), fur, sx * 0.17, 0.3, -0.02, { r: [0, 0, -sx * 0.25] });
        add(c.head, cone(0.05, 0.12, 10), dark, sx * 0.205, 0.42, -0.02, { r: [0, 0, -sx * 0.25] });
        add(c.head, sph(0.13, 14), cream, sx * 0.13, -0.1, 0.15, { s: [1, 0.8, 0.8] });
      }
      c.eyes = eyes(c.head, 0.07, 0.24, 0.12, 0.05);
      c.mouth = mouthOn(c.head, -0.2, 0.32, 0.04);
      arm(c.armL, fur, -0.34, 0.9, 0.28, 0.07); arm(c.armR, fur, 0.34, 0.9, 0.28, 0.07);
      c.height = 1.8; return c;
    },
    luna() {
      const c = rig('luna'), feather = mat('#8a6fb0', 0.7), face = mat('#e9dcf7', 0.7), gold = mat('#ffc94d', 0.4), beak = mat('#f2a33a', 0.5);
      add(c.body, sph(0.42), feather, 0, 0.6, 0, { s: [1, 1.2, 0.95] });
      add(c.body, sph(0.3), face, 0, 0.55, 0.15, { s: [1, 1.2, 0.65] });
      for (let i = 0; i < 6; i++) add(c.body, sph(0.035, 8), feather, ((i % 3) - 1) * 0.1, 0.62 - Math.floor(i / 3) * 0.14, 0.34, { s: [1, 0.6, 0.4] });
      for (const sx of [-1, 1]) add(c.body, sph(0.08, 10), beak, sx * 0.12, 0.06, 0.12, { s: [1, 0.5, 1.4] });
      c.head.position.set(0, 1.18, 0.02);
      add(c.head, sph(0.34), feather, 0, 0, 0, { s: [1.1, 0.95, 0.95] });
      for (const sx of [-1, 1]) { add(c.head, sph(0.15, 18), face, sx * 0.13, 0.02, 0.2, { s: [1, 1, 0.5] }); add(c.head, cone(0.08, 0.22, 10), feather, sx * 0.24, 0.32, 0, { r: [0, 0, -sx * 0.4] }); }
      c.eyes = eyes(c.head, 0.03, 0.29, 0.13, 0.07, '#ffc94d');
      add(c.head, cone(0.045, 0.12, 10), beak, 0, -0.1, 0.32, { r: [Math.PI / 2 + 0.6, 0, 0] });
      c.mouth = mouthOn(c.head, -0.18, 0.29, 0.03);
      c.armL.position.set(-0.4, 0.86, 0); add(c.armL, sph(0.16, 14), feather, 0, -0.22, 0, { s: [0.4, 1.4, 0.8] });
      c.armR.position.set(0.4, 0.86, 0); add(c.armR, sph(0.16, 14), feather, 0, -0.22, 0, { s: [0.4, 1.4, 0.8] });
      void gold; c.height = 1.6; return c;
    },
    mo() {
      const c = rig('mo'), fur = mat('#8b5a3c', 0.85), dark = mat('#5a3826', 0.85), muzzle = mat('#c9a07a', 0.8), antler = mat('#f1dfb8', 0.6);
      add(c.body, cap(0.45, 0.4), fur, 0, 0.82, 0);
      add(c.body, sph(0.32), muzzle, 0, 0.8, 0.22, { s: [1, 1.2, 0.6] });
      for (const sx of [-1, 1]) { add(c.body, cap(0.13, 0.26), dark, sx * 0.2, 0.28, 0); add(c.body, cyl(0.14, 0.15, 0.12, 12), mat('#2f2018', 0.6), sx * 0.2, 0.06, 0); }
      c.head.position.set(0, 1.62, 0.05);
      add(c.head, sph(0.34), fur);
      add(c.head, sph(0.22), muzzle, 0, -0.14, 0.3, { s: [1.05, 0.9, 1.2] });
      for (const sx of [-1, 1]) {
        add(c.head, sph(0.03, 8), dark, sx * 0.08, -0.08, 0.55);
        add(c.head, sph(0.1, 12), fur, sx * 0.32, 0.12, -0.02, { s: [1.4, 0.6, 0.6] });
        const a = new T.Group(); a.position.set(sx * 0.22, 0.28, 0); a.rotation.z = -sx * 0.5; c.head.add(a);
        add(a, cyl(0.04, 0.05, 0.25, 8), antler, 0, 0.1, 0);
        add(a, sph(0.24, 16), antler, sx * 0.1, 0.3, 0, { s: [1, 0.55, 0.18] });
        for (let k = 0; k < 3; k++) add(a, cone(0.04, 0.16, 8), antler, sx * (0.02 + k * 0.1), 0.45, 0, { r: [0, 0, -sx * (0.2 - k * 0.2)] });
      }
      c.eyes = eyes(c.head, 0.08, 0.27, 0.13, 0.05);
      c.mouth = mouthOn(c.head, -0.28, 0.46, 0.05);
      arm(c.armL, fur, -0.5, 1.12, 0.38, 0.1); arm(c.armR, fur, 0.5, 1.12, 0.38, 0.1);
      c.height = 2.5; return c;
    },
    zip() {
      const c = rig('zip'), grey = mat('#b7b9c6', 0.7), pink = mat('#ffb3c6', 0.6), light = mat('#eceef5', 0.7);
      add(c.body, sph(0.27), grey, 0, 0.36, 0, { s: [1, 1.2, 0.95] });
      add(c.body, sph(0.19), light, 0, 0.34, 0.12, { s: [1, 1.2, 0.6] });
      for (const sx of [-1, 1]) add(c.body, sph(0.08, 10), pink, sx * 0.1, 0.04, 0.08, { s: [1, 0.5, 1.6] });
      const curve = new T.CatmullRomCurve3([new T.Vector3(0, 0.2, -0.22), new T.Vector3(0, 0.15, -0.5), new T.Vector3(0.15, 0.3, -0.7), new T.Vector3(0.05, 0.45, -0.78)]);
      c.tail = new T.Group(); c.body.add(c.tail); add(c.tail, new T.TubeGeometry(curve, 20, 0.018, 6), pink);
      c.head.position.set(0, 0.78, 0.03);
      add(c.head, sph(0.24), grey, 0, 0, 0, { s: [1, 0.95, 1] });
      add(c.head, cone(0.13, 0.22, 14), grey, 0, -0.05, 0.22, { r: [Math.PI / 2, 0, 0] });
      add(c.head, sph(0.035, 8), pink, 0, -0.05, 0.34);
      for (const sx of [-1, 1]) {
        add(c.head, cyl(0.22, 0.22, 0.03, 22), grey, sx * 0.2, 0.22, -0.02, { r: [Math.PI / 2, 0, -sx * 0.3] });
        add(c.head, cyl(0.15, 0.15, 0.035, 22), pink, sx * 0.2, 0.22, 0.0, { r: [Math.PI / 2, 0, -sx * 0.3] });
        for (const dy of [-0.02, 0.02]) add(c.head, cyl(0.004, 0.004, 0.22, 4), BLACK, sx * 0.12, -0.06 + dy, 0.27, { r: [0, 0, Math.PI / 2 + sx * dy * 4] });
      }
      c.eyes = eyes(c.head, 0.04, 0.18, 0.09, 0.045);
      c.mouth = mouthOn(c.head, -0.12, 0.25, 0.025);
      arm(c.armL, grey, -0.25, 0.5, 0.14, 0.045); arm(c.armR, grey, 0.25, 0.5, 0.14, 0.045);
      c.height = 1.15; return c;
    },
    captain() {
      const c = rig('captain'), red = mat('#e8483b', 0.45), light = mat('#ff9a8a', 0.6), navy = mat('#1f2f5a', 0.6), gold = mat('#ffc94d', 0.3, { metalness: 0.5 });
      add(c.body, sph(0.45), red, 0, 0.5, 0, { s: [1.3, 0.75, 0.95] });
      add(c.body, sph(0.33), light, 0, 0.45, 0.17, { s: [1.3, 0.7, 0.6] });
      for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) add(c.body, cyl(0.035, 0.03, 0.42, 6), red, sx * (0.48 + k * 0.02), 0.25, -0.15 + k * 0.15, { r: [0, 0, sx * 0.7] });
      c.head.position.set(0, 0.85, 0.12);
      for (const sx of [-1, 1]) {
        add(c.head, cyl(0.03, 0.03, 0.26, 8), red, sx * 0.22, 0.08, 0);
        const e = new T.Group(); e.position.set(sx * 0.22, 0.25, 0); c.head.add(e);
        add(e, sph(0.085, 14), mat('#ffffff', 0.3)); const p = add(e, sph(0.05, 12), BLACK, 0, 0, 0.05); add(e, sph(0.015, 6), GLINT, 0.015, 0.02, 0.095);
        c.eyes.push(e); void p;
      }
      const hat = new T.Group(); hat.position.set(0, 0.88, -0.02); hat.scale.setScalar(0.78); c.body.add(hat);
      add(hat, cyl(0.22, 0.24, 0.15, 22), navy, 0, 0.06, 0); add(hat, cyl(0.3, 0.3, 0.025, 24), navy, 0, -0.02, 0.04, { s: [1, 1, 0.9] });
      add(hat, cyl(0.226, 0.236, 0.04, 22), mat('#ffffff', 0.6), 0, 0.0, 0); add(hat, sph(0.045, 10), gold, 0, 0.06, 0.23, { s: [1, 1, 0.4] });
      add(hat, cyl(0.24, 0.26, 0.02, 24), mat('#141e3c', 0.5), 0, -0.03, 0.12, { s: [1, 1, 0.6] });
      c.mouth = mouthOn(c.body, 0.52, 0.42, 0.06);
      for (const [g, sx] of [[c.armL, -1], [c.armR, 1]]) {
        g.position.set(sx * 0.55, 0.62, 0.1);
        add(g, cap(0.06, 0.2), red, 0, -0.1, 0, { r: [0, 0, sx * 0.3] });
        add(g, sph(0.15, 16), red, sx * 0.08, -0.3, 0.05, { s: [1, 1.2, 0.8] });
        add(g, sph(0.09, 12), light, sx * 0.14, -0.42, 0.05, { s: [0.8, 1.2, 0.7] });
      }
      c.height = 1.6; return c;
    },
  };

  // ---- places ------------------------------------------------------------------------------------------------
  // Every set is a round island of ground with its landmark behind the cast. The marks are the same on every set.
  const MARK = { left: [-2.1, 1.0], center: [0, 1.4], right: [2.1, 1.0], front: [0, 2.9], back: [0.9, -1.3] };   // back is off center, so whoever stands in the middle does not hide it
  const HOME = [[[0, 1.4]], [[-1.0, 1.3], [1.0, 1.3]], [[-1.7, 1.1], [0, 1.6], [1.7, 1.1]]];
  // Drawn ground, water, clouds and far mountains are marked userData.drawnBg: a photo backdrop hides them and keeps everything else.
  function island(g, top, side, r = 7.2) {
    add(g, cyl(r, r - 0.4, 0.6, 56), mat(top, 0.95), 0, -0.3, 0).userData.drawnBg = true;
    add(g, cyl(r - 0.4, r - 1.2, 0.8, 56), mat(side, 0.95), 0, -0.95, 0).userData.drawnBg = true;
  }
  function tree(g, x, z, s, leaf, trunk) {
    const t = new T.Group(); t.position.set(x, 0, z); t.scale.setScalar(s); g.add(t);
    add(t, cyl(0.12, 0.16, 1.0, 10), mat(trunk || '#8a5a33', 0.9), 0, 0.5, 0);
    const L = leaf || ['#3fae5b', '#58c46c', '#2f9a52'];
    add(t, sph(0.75, 20), mat(L[0], 0.8), 0, 1.45, 0); add(t, sph(0.55, 18), mat(L[1], 0.8), 0.35, 1.25, 0.25); add(t, sph(0.5, 18), mat(L[2], 0.8), -0.35, 1.2, -0.2);
    return t;
  }
  function pine(g, x, z, s, col, snow) {
    const t = new T.Group(); t.position.set(x, 0, z); t.scale.setScalar(s); g.add(t);
    add(t, cyl(0.1, 0.14, 0.5, 8), mat('#7a4a2a', 0.9), 0, 0.25, 0);
    for (let i = 0; i < 3; i++) { add(t, cone(0.8 - i * 0.2, 0.9, 16), mat(col || '#2f8f57', 0.8), 0, 0.85 + i * 0.5, 0); if (snow) add(t, cone(0.42 - i * 0.1, 0.36, 16), mat('#ffffff', 0.7), 0, 1.15 + i * 0.5, 0); }
    return t;
  }
  function flowers(g, n, colors, rMin = 3.6) {
    for (let i = 0; i < n; i++) {
      const a = i * 2.399, r = rMin + (i % 7) * 0.45, x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (z < -2.2 && Math.abs(x) < 4.2) continue;
      add(g, cyl(0.012, 0.012, 0.22, 4), mat('#3a8f45'), x, 0.11, z, { noShadow: true });
      add(g, sph(0.07, 8), mat(colors[i % colors.length], 0.6), x, 0.24, z, { noShadow: true });
    }
  }
  function clouds(g, list, col = '#ffffff') {
    for (const [x, y, z, s] of list) {
      const c = new T.Group(); c.position.set(x, y, z); c.scale.setScalar(s); c.userData.drawnBg = true; g.add(c);
      for (const [cx, cy, r] of [[0, 0, 0.9], [0.9, -0.15, 0.7], [-0.9, -0.2, 0.65], [0.3, 0.45, 0.6]]) add(c, sph(r, 16), mat(col, 1), cx, cy, 0, { noShadow: true });
    }
  }
  const PLACE = {
    castle: { sky: ['#7fc4ff', '#cfe9ff', '#fff6e0'], build(g, A) {
      island(g, '#7ccf6b', '#b98b5e');
      for (let i = 0; i < 6; i++) add(g, cyl(0.42, 0.42, 0.06, 16), mat('#cfc6b6', 0.9), Math.sin(i) * 0.2, 0.01, 2.8 - i * 0.62, { s: [1, 1, 0.75] });
      const C = new T.Group(); C.position.set(0, 0, -3.4); g.add(C);
      const stone = mat('#e8e0d0', 0.85);
      add(C, roundBox(5.2, 2.4, 1.1, 0.08), stone, 0, 1.2, 0);
      for (let i = -6; i <= 6; i += 2) add(C, roundBox(0.34, 0.34, 1.1, 0.05), mat('#d4c9b4', 0.85), i * 0.4, 2.55, 0);
      for (const sx of [-1, 1]) {
        const t = new T.Group(); t.position.set(sx * 2.9, 0, 0.1); C.add(t);
        add(t, cyl(0.85, 0.95, 3.6, 28), stone, 0, 1.8, 0);
        add(t, cone(1.1, 1.6, 28), mat(sx < 0 ? '#7d5bd6' : '#ef6f6c', 0.6), 0, 4.4, 0);
        add(t, cyl(0.02, 0.02, 0.7, 6), mat('#5b3a21'), 0, 5.5, 0);
        A.push({ o: add(t, new T.PlaneGeometry(0.5, 0.3), mat(sx < 0 ? '#ffd23f' : '#4fb4ff', 0.6, { side: T.DoubleSide }), 0.25, 5.7, 0), f: (o, t2) => { o.rotation.y = Math.sin(t2 * 3 + sx) * 0.35; } });
        for (const y of [1.6, 2.7]) add(t, roundBox(0.28, 0.42, 0.1, 0.05), mat('#3a3250', 0.4), 0, y, 0.92);
      }
      add(C, roundBox(1.6, 1.9, 0.2, 0.05), mat('#a8693a', 0.75), 0, 0.95, 0.56);
      for (const y of [0.45, 1.45]) add(C, roundBox(1.6, 0.08, 0.24, 0.02), mat('#5b4636', 0.5), 0, y, 0.58);
      [[-5.2, -1.2, 1.1], [5.0, -0.8, 1.2], [-5.8, 1.6, 0.9], [5.7, 1.9, 0.95], [-4.0, 3.6, 0.7], [4.3, 3.7, 0.75]].forEach(([x, z, s]) => tree(g, x, z, s));
      flowers(g, 40, ['#ff6fa5', '#ffd23f', '#ffffff', '#b58cff']);
      clouds(g, [[-7, 7.5, -12, 1.4], [6, 8.5, -14, 1.7], [0.5, 9.5, -18, 1.2]]);
    } },
    moon: { sky: ['#05061a', '#151a3d', '#2b2f5c'], light: ['#cfd8ff', 0.5, 1.1], fog: '#151a3d', build(g, A) {
      island(g, '#c9c9d4', '#8d8d9c');
      for (const [x, z, r] of [[-2.8, 2.6, 0.7], [3.1, 2.2, 0.5], [-4.2, -0.6, 0.9], [4.4, -0.4, 0.8], [1.6, 3.9, 0.4], [-1.2, -2.6, 0.6]]) {
        add(g, torus(r, r * 0.18), mat('#b1b1bf', 0.95), x, 0.02, z, { r: [Math.PI / 2, 0, 0], s: [1, 1, 0.6] });
        add(g, cyl(r * 0.95, r * 0.95, 0.02, 24), mat('#a6a6b5', 0.95), x, 0.005, z);
      }
      const R = new T.Group(); R.position.set(-2.6, 0, -3.2); R.rotation.z = 0.06; g.add(R);
      add(R, cyl(0.55, 0.62, 2.4, 24), mat('#ffffff', 0.4), 0, 1.5, 0); add(R, cone(0.55, 1.0, 24), mat('#ff4f6b', 0.45), 0, 3.2, 0);
      add(R, cyl(0.35, 0.35, 0.06, 24), mat('#6fd3ff', 0.2, { emissive: '#3fa9e0', emissiveIntensity: 0.4 }), 0, 1.9, 0.55, { r: [Math.PI / 2, 0, 0] });
      for (let i = 0; i < 3; i++) { const f = new T.Group(); f.rotation.y = i * 2.09; R.add(f); add(f, roundBox(0.12, 0.9, 0.6, 0.04), mat('#ff4f6b', 0.45), 0, 0.55, 0.65); }
      add(g, cyl(0.03, 0.03, 1.6, 6), mat('#dddddd'), 2.6, 0.8, -2.6);
      A.push({ o: add(g, new T.PlaneGeometry(0.8, 0.5), mat('#ffd23f', 0.6, { side: T.DoubleSide }), 3.0, 1.35, -2.6), f: (o, t) => { o.rotation.y = Math.sin(t * 1.5) * 0.15; } });
      const earth = add(g, sph(1.6, 32), mat('#3f8ee8', 0.6, { emissive: '#1d4f9a', emissiveIntensity: 0.35 }), 7, 9, -18, { noShadow: true });
      for (const [x, y, z, s] of [[0.6, 0.6, 1.2, 0.6], [-0.7, -0.2, 1.3, 0.5], [0.1, -0.9, 1.2, 0.45]]) add(earth, sph(s, 16), mat('#58c46c', 0.8), x, y, z, { s: [1, 0.6, 0.5], noShadow: true });
      A.push({ o: earth, f: (o, t) => { o.rotation.y = t * 0.1; } });
      const pts = []; for (let i = 0; i < 500; i++) { const a = Math.random() * Math.PI * 2, e = Math.random() * 1.2 + 0.05, r = 40; pts.push(Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r); }
      const sg = new T.BufferGeometry(); sg.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
      g.add(new T.Points(sg, new T.PointsMaterial({ color: '#ffffff', size: 0.18, sizeAttenuation: true })));
    } },
    island: { sky: ['#5ec4ff', '#bdeaff', '#fff4d6'], water: '#2fb4d8', build(g, A) {
      island(g, '#f3d89b', '#d9b26b', 6.4);
      const palm = (x, z, s, lean) => {
        const p = new T.Group(); p.position.set(x, 0, z); p.scale.setScalar(s); p.rotation.z = lean; g.add(p);
        for (let i = 0; i < 6; i++) add(p, cyl(0.13 - i * 0.01, 0.15 - i * 0.01, 0.42, 10), mat(i % 2 ? '#a0703f' : '#8a5a33', 0.9), Math.sin(i * 0.25) * 0.2 * i * 0.3, 0.21 + i * 0.4, 0);
        const top = new T.Group(); top.position.set(0.3, 2.45, 0); p.add(top);
        for (let k = 0; k < 6; k++) { const l = add(top, sph(0.6, 14), mat(k % 2 ? '#3fae5b' : '#2f9a52', 0.75), 0, 0, 0, { s: [1.6, 0.12, 0.45] }); l.rotation.y = k * 1.05; l.position.set(Math.cos(k * 1.05) * 0.6, -0.15, -Math.sin(k * 1.05) * 0.6); l.rotation.z = -0.35; }
        for (let k = 0; k < 3; k++) add(top, sph(0.12, 10), mat('#6b4423', 0.8), Math.cos(k * 2.1) * 0.15, -0.2, Math.sin(k * 2.1) * 0.15);
        A.push({ o: top, f: (o, t) => { o.rotation.z = Math.sin(t * 1.3 + x) * 0.06; } });
      };
      palm(-3.6, -2.0, 1.3, 0.12); palm(3.9, -1.4, 1.1, -0.15); palm(-4.6, 2.2, 0.9, 0.18);
      const chest = new T.Group(); chest.position.set(2.2, 0, -2.6); chest.rotation.y = -0.4; g.add(chest);
      add(chest, roundBox(1.0, 0.55, 0.62, 0.05), mat('#9a5b2e', 0.7), 0, 0.28, 0); add(chest, cyl(0.31, 0.31, 1.0, 16, 1, false, 0, Math.PI), mat('#8a4f26', 0.7), 0, 0.56, 0, { r: [0, 0, Math.PI / 2] });
      add(chest, roundBox(0.14, 0.18, 0.06, 0.02), mat('#ffc94d', 0.3, { metalness: 0.6 }), 0, 0.5, 0.33);
      for (const [x, z, s] of [[4.6, 2.6, 0.5], [-1.8, -3.6, 0.4], [5.3, 0.4, 0.35]]) add(g, sph(s, 12), mat('#9a9aa6', 0.9), x, s * 0.4, z, { s: [1.3, 0.7, 1] });
      for (const [x, z] of [[1.2, 3.6], [-2.6, 3.2], [3.4, 3.0]]) add(g, cone(0.12, 0.14, 5), mat('#ffb3a7', 0.6), x, 0.06, z, { r: [0, 0, Math.PI / 2] });
      clouds(g, [[-6, 7, -14, 1.3], [7, 8, -16, 1.5]]);
    } },
    forest: { sky: ['#8fd3b0', '#d6f2df', '#fff8e6'], light: ['#fff3dc', 0.5, 1.05], fog: '#cfe8d6', build(g) {
      island(g, '#5aa84f', '#7a5235');
      for (const [x, z, s] of [[-4.6, -2.2, 1.3], [-2.4, -3.8, 1.5], [0.8, -4.3, 1.6], [3.2, -3.4, 1.4], [5.0, -1.4, 1.2], [-5.6, 1.0, 1.0], [5.8, 1.8, 0.9]]) pine(g, x, z, s, ['#2f8f57', '#3a9e5f', '#237a48'][Math.abs(Math.round(x)) % 3]);
      [[-3.4, 2.8, 0.7], [4.0, 3.2, 0.65]].forEach(([x, z, s]) => tree(g, x, z, s, ['#4cb45a', '#69c46a', '#3a9e50']));
      for (const [x, z, s] of [[-1.8, -1.6, 0.6], [2.6, 2.6, 0.45], [-3.0, 0.4, 0.5], [3.4, -0.6, 0.55]]) {
        add(g, cyl(0.1 * s / 0.5, 0.13 * s / 0.5, 0.3 * s / 0.5, 12), mat('#fff3df', 0.7), x, 0.15 * s / 0.5, z);
        const capm = add(g, sph(0.3 * s / 0.5, 18, 0), mat('#e8483b', 0.5), x, 0.3 * s / 0.5, z, { s: [1, 0.65, 1] });
        for (let k = 0; k < 4; k++) add(capm, sph(0.05, 6), mat('#ffffff', 0.6), Math.cos(k * 1.6) * 0.16, 0.2, Math.sin(k * 1.6) * 0.16, { noShadow: true });
      }
      add(g, cyl(0.28, 0.28, 2.0, 16), mat('#8a5a33', 0.9), 2.2, 0.28, -1.6, { r: [0, 0.6, Math.PI / 2] });
      add(g, cyl(0.45, 0.5, 0.45, 18), mat('#9a6a43', 0.9), -2.6, 0.22, -2.0);
      flowers(g, 26, ['#ffffff', '#ffd23f', '#b58cff']);
    } },
    beach: { sky: ['#4fb8ff', '#b8e6ff', '#fff2cf'], water: '#38b6e0', build(g, A) {
      island(g, '#f6dfa4', '#dcb874', 6.6);
      const U = new T.Group(); U.position.set(-3.2, 0, -1.6); U.rotation.z = 0.12; g.add(U);
      add(U, cyl(0.04, 0.04, 2.2, 8), mat('#ffffff', 0.5), 0, 1.1, 0);
      for (let k = 0; k < 8; k++) add(U, new T.ConeGeometry(1.3, 0.5, 4, 1, true, k * Math.PI / 4, Math.PI / 4), mat(k % 2 ? '#ff5d73' : '#ffffff', 0.6, { side: T.DoubleSide }), 0, 2.2, 0);
      const SC = new T.Group(); SC.position.set(2.6, 0, -1.4); g.add(SC);
      const sand = mat('#e8c47e', 0.95);
      add(SC, roundBox(1.4, 0.5, 1.0, 0.06), sand, 0, 0.25, 0); for (const sx of [-1, 1]) { add(SC, cyl(0.24, 0.28, 0.9, 14), sand, sx * 0.6, 0.45, 0); add(SC, cone(0.28, 0.35, 14), sand, sx * 0.6, 1.07, 0); }
      add(SC, cyl(0.3, 0.34, 0.7, 14), sand, 0, 0.85, 0); add(SC, cyl(0.01, 0.01, 0.4, 4), mat('#ffffff'), 0, 1.4, 0);
      add(SC, new T.PlaneGeometry(0.22, 0.14), mat('#ff5d73', 0.6, { side: T.DoubleSide }), 0.11, 1.55, 0);
      const ball = add(g, sph(0.32, 20), mat('#ffffff', 0.4), 3.6, 0.32, 2.4);
      for (let k = 0; k < 3; k++) add(ball, sph(0.325, 20, 0), mat(['#ff5d73', '#3a86ff', '#ffd23f'][k], 0.4), 0, 0, 0, { s: [0.35, 1, 1], r: [0, k * 1.05, 0], noShadow: true });
      add(g, roundBox(1.1, 0.04, 1.8, 0.02), mat('#3a86ff', 0.8), -1.6, 0.03, 2.8, { r: [0, 0.3, 0] });
      add(g, sph(1.4, 24), new T.MeshBasicMaterial({ color: '#fff3a0' }), -8, 9, -22, { noShadow: true });
      for (const [x, z] of [[1.0, 3.8], [-3.6, 3.0]]) add(g, cone(0.14, 0.16, 5), mat('#ffb3a7', 0.6), x, 0.06, z, { r: [0, 0, Math.PI / 2] });
      clouds(g, [[6, 8, -16, 1.4]]);
      void A;
    } },
    fair: { sky: ['#ffb6d9', '#ffe1ef', '#fff6e0'], build(g, A) {
      island(g, '#8bd46e', '#b98b5e');
      const W = new T.Group(); W.position.set(1.8, 0, -3.6); g.add(W);
      for (const sx of [-1, 1]) add(W, cyl(0.07, 0.09, 3.6, 8), mat('#7d5bd6', 0.5), sx * 0.8, 1.7, 0, { r: [0, 0, sx * 0.22] });
      const wheel = new T.Group(); wheel.position.set(0, 3.4, 0.2); W.add(wheel);
      add(wheel, torus(2.0, 0.07), mat('#ff5d8f', 0.5)); add(wheel, torus(1.2, 0.05), mat('#ffd23f', 0.5));
      for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; add(wheel, cyl(0.03, 0.03, 4, 6), mat('#ffffff', 0.5), 0, 0, 0, { r: [0, 0, a] }); }
      const cabins = []; for (let k = 0; k < 8; k++) { const cb = add(W, roundBox(0.42, 0.4, 0.42, 0.08), mat(['#3a86ff', '#ff5d73', '#3ddc84', '#ffd23f'][k % 4], 0.5), 0, 0, 0.35); cabins.push(cb); }
      A.push({ o: wheel, f: (o, t) => { o.rotation.z = t * 0.25; cabins.forEach((cb, k) => { const a = t * 0.25 + k * Math.PI / 4; cb.position.set(Math.cos(a) * 2.0, 3.4 + Math.sin(a) * 2.0 - 0.25, 0.35); }); } });
      const tent = new T.Group(); tent.position.set(-3.0, 0, -2.4); g.add(tent);
      for (let k = 0; k < 10; k++) add(tent, new T.CylinderGeometry(1.3, 1.3, 1.6, 3, 1, true, k * Math.PI / 5, Math.PI / 5), mat(k % 2 ? '#ff5d73' : '#ffffff', 0.6, { side: T.DoubleSide }), 0, 0.8, 0);
      for (let k = 0; k < 10; k++) add(tent, new T.ConeGeometry(1.45, 1.2, 3, 1, true, k * Math.PI / 5, Math.PI / 5), mat(k % 2 ? '#ffffff' : '#ff5d73', 0.6, { side: T.DoubleSide }), 0, 2.2, 0);
      add(tent, cyl(0.02, 0.02, 0.5, 4), mat('#5b3a21'), 0, 3.0, 0); add(tent, new T.PlaneGeometry(0.4, 0.24), mat('#ffd23f', 0.6, { side: T.DoubleSide }), 0.2, 3.15, 0);
      add(tent, roundBox(0.6, 1.1, 0.05, 0.05), mat('#3a2e28', 0.7), 0, 0.55, 1.29);
      for (const [x, z, col] of [[-4.6, 0.8, '#ff5d73'], [-4.3, 1.3, '#3a86ff'], [-4.9, 1.2, '#ffd23f'], [4.6, 1.4, '#3ddc84'], [4.9, 0.9, '#b58cff']]) {
        add(g, cyl(0.006, 0.006, 1.6, 4), mat('#ffffff'), x, 0.8, z, { noShadow: true });
        const b = add(g, sph(0.24, 16), mat(col, 0.35), x, 1.75, z, { s: [1, 1.15, 1] });
        A.push({ o: b, f: (o, t) => { o.position.y = 1.75 + Math.sin(t * 1.6 + x * 3) * 0.06; } });
      }
      flowers(g, 18, ['#ffffff', '#ffd23f']);
      clouds(g, [[-6, 8, -15, 1.3], [7, 9, -17, 1.4]], '#ffffff');
    } },
    mountain: { sky: ['#8ec5ff', '#dceeff', '#f7fbff'], fog: '#e6f1ff', build(g, A) {
      island(g, '#f4f8ff', '#b9c6d8');
      for (const [x, z, h, r] of [[-3.6, -6, 6.5, 3.6], [1.4, -7.5, 8.5, 4.4], [5.8, -5.6, 5.5, 3.2]]) {
        add(g, cone(r, h, 6), mat('#8796ad', 0.9), x, h / 2 - 0.4, z, { r: [0, x, 0] }).userData.drawnBg = true;
        add(g, cone(r * 0.42, h * 0.42, 6), mat('#ffffff', 0.8), x, h - 0.4 - h * 0.21 + 0.01, z, { r: [0, x, 0] }).userData.drawnBg = true;
      }
      for (const [x, z, s] of [[-4.6, -1.2, 1.1], [4.8, -0.8, 1.2], [-5.4, 2.0, 0.8], [5.4, 2.4, 0.85], [-2.6, -2.8, 0.9]]) pine(g, x, z, s, '#2f7f57', true);
      const S = new T.Group(); S.position.set(2.6, 0, -1.8); g.add(S);
      for (const [y, r] of [[0.4, 0.45], [1.05, 0.33], [1.55, 0.24]]) add(S, sph(r, 18), mat('#ffffff', 0.8), 0, y, 0);
      add(S, cone(0.05, 0.25, 8), mat('#ff8c42', 0.5), 0, 1.55, 0.3, { r: [Math.PI / 2, 0, 0] });
      for (const sx of [-1, 1]) add(S, sph(0.035, 6), BLACK, sx * 0.08, 1.62, 0.21);
      add(S, torus(0.27, 0.06), mat('#e8483b', 0.7), 0, 1.3, 0, { r: [Math.PI / 2, 0, 0] });
      add(S, cyl(0.18, 0.2, 0.25, 14), mat('#2a3340', 0.5), 0, 1.84, 0); add(S, cyl(0.28, 0.28, 0.03, 16), mat('#2a3340', 0.5), 0, 1.72, 0);
      const pts = []; for (let i = 0; i < 400; i++) pts.push((Math.random() - 0.5) * 18, Math.random() * 9, (Math.random() - 0.5) * 12 + 1);
      const sg = new T.BufferGeometry(); sg.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
      const snow = new T.Points(sg, new T.PointsMaterial({ color: '#ffffff', size: 0.09 })); g.add(snow);
      A.push({ o: snow, f: (o, t, dt) => { const p = o.geometry.attributes.position; for (let i = 0; i < p.count; i++) { let y = p.getY(i) - dt * 0.6; if (y < 0) y += 9; p.setY(i, y); p.setX(i, p.getX(i) + Math.sin(t + i) * dt * 0.1); } p.needsUpdate = true; } });
    } },
    cupcake: { sky: ['#ffc4e1', '#ffe6f2', '#fff7ea'], build(g, A) {
      island(g, '#ffb3d1', '#c98ab0');
      const cupcake = (x, z, s, wrap, frost) => {
        const c = new T.Group(); c.position.set(x, 0, z); c.scale.setScalar(s); g.add(c);
        add(c, cyl(0.9, 0.7, 1.1, 16), mat(wrap, 0.6, { flatShading: true }), 0, 0.55, 0);
        for (let k = 0; k < 3; k++) add(c, sph(0.95 - k * 0.25, 22), mat(frost, 0.45), 0, 1.25 + k * 0.42, 0, { s: [1, 0.55, 1] });
        add(c, sph(0.16, 14), mat('#e8233b', 0.3), 0, 2.2, 0);
        add(c, roundBox(0.4, 0.6, 0.06, 0.08), mat('#7a4a2a', 0.6), 0, 0.42, 0.82);
        for (const sx of [-1, 1]) add(c, roundBox(0.26, 0.26, 0.06, 0.05), mat('#9ee7ff', 0.2), sx * 0.45, 0.72, 0.74, { r: [0, sx * 0.5, 0] });
        for (let k = 0; k < 10; k++) add(c, cap(0.02, 0.07), mat(['#ffd23f', '#3a86ff', '#3ddc84', '#ff5d73'][k % 4], 0.5), Math.cos(k * 0.63) * 0.5, 1.55, Math.sin(k * 0.63) * 0.5, { r: [k, k * 2, 0], noShadow: true });
      };
      cupcake(-3.0, -2.8, 1.25, '#7ec8ff', '#fff3f8'); cupcake(1.2, -3.8, 1.5, '#b48cff', '#ffd1e6'); cupcake(4.4, -1.8, 1.1, '#7ee0a0', '#fff6c9');
      const lolly = (x, z, col) => {
        add(g, cyl(0.05, 0.05, 1.6, 8), mat('#ffffff', 0.4), x, 0.8, z);
        const top = add(g, cyl(0.5, 0.5, 0.12, 24), mat(col, 0.35), x, 1.8, z, { r: [Math.PI / 2, 0, 0] });
        add(top, torus(0.3, 0.05), mat('#ffffff', 0.35), 0, 0.07, 0, { r: [Math.PI / 2, 0, 0], noShadow: true });
        A.push({ o: top, f: (o, t) => { o.rotation.z = t * 0.6; } });
      };
      lolly(-4.6, 0.8, '#ff5d73'); lolly(4.9, 1.4, '#3a86ff'); lolly(-5.2, 2.6, '#3ddc84');
      for (const [x, z, c] of [[2.6, 3.2, '#ff5d73'], [-2.4, 3.6, '#ffd23f'], [3.8, 0.4, '#b48cff']]) add(g, sph(0.18, 12), mat(c, 0.3), x, 0.15, z, { s: [1.4, 0.8, 1] });
      clouds(g, [[-6, 8, -15, 1.3], [6, 9, -16, 1.4]], '#fff0f7');
    } },
    train: { sky: ['#9fd4ff', '#d8efff', '#fff3db'], build(g, A) {
      island(g, '#8ccf74', '#b98b5e');
      add(g, roundBox(10.5, 0.3, 2.2, 0.06), mat('#c8b8a0', 0.9), 0, 0.15, -1.8);
      for (let i = -9; i <= 9; i++) add(g, roundBox(0.22, 0.06, 1.5, 0.02), mat('#7a5235', 0.9), i * 0.55, 0.32, -3.2);
      for (const z of [-3.6, -2.8]) add(g, roundBox(10.5, 0.06, 0.08, 0.02), mat('#8796ad', 0.3, { metalness: 0.5 }), 0, 0.37, z);
      const TR = new T.Group(); TR.position.set(-1.0, 0.4, -3.2); g.add(TR);
      const red = mat('#e8483b', 0.45), dark = mat('#2a3340', 0.4), gold = mat('#ffc94d', 0.3, { metalness: 0.5 });
      add(TR, cyl(0.62, 0.62, 2.0, 22), red, 0.2, 0.95, 0, { r: [0, 0, Math.PI / 2] });
      add(TR, roundBox(1.2, 1.6, 1.4, 0.08), red, -1.3, 1.1, 0); add(TR, roundBox(1.4, 0.12, 1.6, 0.04), dark, -1.3, 1.95, 0);
      add(TR, roundBox(0.6, 0.5, 0.06, 0.06), mat('#9ee7ff', 0.2), -1.3, 1.35, 0.71);
      const stack = add(TR, cyl(0.16, 0.24, 0.6, 14), dark, 0.75, 1.75, 0); void stack;
      add(TR, cyl(0.64, 0.64, 0.12, 22), gold, 1.2, 0.95, 0, { r: [0, 0, Math.PI / 2] });
      add(TR, cone(0.55, 0.5, 4), dark, 1.45, 0.25, 0, { r: [0, 0, -Math.PI / 2] });
      for (const x of [-1.5, -0.6, 0.3, 1.0]) for (const z of [-0.6, 0.6]) add(TR, cyl(0.32, 0.32, 0.1, 18), dark, x, 0.3, z, { r: [Math.PI / 2, 0, 0] });
      for (const [cx, col] of [[-3.6, '#3a86ff'], [-6.0, '#ffd23f']]) {
        add(TR, roundBox(2.1, 1.2, 1.3, 0.1), mat(col, 0.5), cx, 0.95, 0);
        for (const wx of [-0.55, 0.05, 0.65]) add(TR, roundBox(0.4, 0.4, 0.06, 0.06), mat('#9ee7ff', 0.2), cx + wx, 1.1, 0.66);
        for (const x of [-0.7, 0.7]) for (const z of [-0.6, 0.6]) add(TR, cyl(0.24, 0.24, 0.1, 16), dark, cx + x, 0.25, z, { r: [Math.PI / 2, 0, 0] });
      }
      const puffs = []; for (let k = 0; k < 5; k++) { const p = add(TR, sph(0.22, 12), mat('#ffffff', 1), 0.75, 2.1, 0, { noShadow: true }); puffs.push(p); }
      A.push({ o: TR, f: (o, t) => { puffs.forEach((p, k) => { const a = ((t * 0.5 + k / 5) % 1); p.position.set(0.75 - a * 1.4, 2.1 + a * 1.8, 0); p.scale.setScalar(0.6 + a * 1.4); }); } });
      const sign = new T.Group(); sign.position.set(4.2, 0.3, -1.4); g.add(sign);
      for (const sx of [-1, 1]) add(sign, cyl(0.04, 0.04, 1.6, 6), dark, sx * 0.6, 0.8, 0);
      add(sign, roundBox(1.5, 0.45, 0.08, 0.05), mat('#ffffff', 0.6), 0, 1.5, 0);
      add(sign, sph(0.2, 16), gold, -0.5, 1.5, 0.05, { s: [1, 1, 0.3] });
      [[-5.4, 1.8, 0.9], [5.6, 2.2, 0.9]].forEach(([x, z, s]) => tree(g, x, z, s));
      flowers(g, 20, ['#ff6fa5', '#ffd23f', '#ffffff']);
      clouds(g, [[-7, 8, -15, 1.3], [6, 9, -17, 1.5]]);
    } },
    sea: { sky: ['#0a3d6b', '#1f78a8', '#56c1d6'], light: ['#bff2ff', 0.55, 0.95], fog: '#1f78a8', build(g, A) {
      island(g, '#e9d6a0', '#c9b27a');
      const coral = (x, z, s, col) => {
        const c = new T.Group(); c.position.set(x, 0, z); c.scale.setScalar(s); g.add(c);
        const m = mat(col, 0.6);
        add(c, cap(0.12, 0.8), m, 0, 0.5, 0);
        for (let k = 0; k < 4; k++) { const b = new T.Group(); b.position.set(0, 0.5 + k * 0.15, 0); b.rotation.set(0, k * 1.6, 0.6); c.add(b); add(b, cap(0.08, 0.5), m, 0, 0.3, 0); add(b, sph(0.1, 10), m, 0, 0.6, 0); }
      };
      coral(-3.4, -2.2, 1.3, '#ff7a8a'); coral(3.6, -2.0, 1.1, '#ffa94d'); coral(-4.8, 1.6, 0.9, '#b48cff'); coral(4.8, 2.0, 0.8, '#ff7ac0');
      for (const [x, z, h] of [[-2.0, -3.4, 2.6], [1.6, -3.8, 3.0], [-5.4, -0.4, 2.0], [5.2, -0.2, 2.2], [0.2, -4.4, 2.4]]) {
        const w = new T.Group(); w.position.set(x, 0, z); g.add(w);
        const parts = []; for (let k = 0; k < 6; k++) { const p = add(w, cap(0.09, h / 7), mat(k % 2 ? '#3fae5b' : '#2f9a52', 0.7), 0, (k + 0.5) * h / 6, 0); parts.push(p); }
        A.push({ o: w, f: (o, t) => { parts.forEach((p, k) => { p.position.x = Math.sin(t * 1.2 + x + k * 0.5) * 0.08 * k; }); } });
      }
      add(g, sph(0.6, 18, 0, Math.PI * 2, 0, Math.PI / 2), mat('#ffb3c6', 0.5), 2.4, 0, 3.0, { s: [1, 0.5, 1] });
      const chest = new T.Group(); chest.position.set(-1.0, 0, -2.6); chest.rotation.y = 0.3; g.add(chest);
      add(chest, roundBox(1.0, 0.55, 0.62, 0.05), mat('#9a5b2e', 0.7), 0, 0.28, 0);
      add(chest, cyl(0.31, 0.31, 1.0, 16, 1, false, 0, Math.PI), mat('#8a4f26', 0.7), 0, 0.56, 0, { r: [0, 0, Math.PI / 2] });
      const fish = [];
      for (const [col, y, r, sp] of [['#ffd23f', 3.4, 5.2, 0.4], ['#ff7a3d', 4.2, 4.0, -0.5], ['#7ec8ff', 2.8, 6.0, 0.3]]) {
        const f = new T.Group(); g.add(f); add(f, sph(0.25, 14), mat(col, 0.5), 0, 0, 0, { s: [1.4, 0.9, 0.5] }); add(f, cone(0.18, 0.3, 4), mat(col, 0.5), -0.42, 0, 0, { r: [0, 0, Math.PI / 2] });
        add(f, sph(0.04, 6), BLACK, 0.2, 0.06, 0.1); fish.push([f, y, r, sp]);
      }
      A.push({ o: g, f: (o, t) => { fish.forEach(([f, y, r, sp]) => { const a = t * sp; f.position.set(Math.cos(a) * r, y + Math.sin(t * 2) * 0.1, Math.sin(a) * r * 0.5 - 2); f.rotation.y = -a + (sp > 0 ? -Math.PI / 2 : Math.PI / 2); }); } });
      const bub = []; for (let k = 0; k < 18; k++) { const b = add(g, sph(0.06 + (k % 3) * 0.03, 8), mat('#dff8ff', 0.1, { transparent: true, opacity: 0.6 }), (k * 1.7 % 10) - 5, k * 0.4, -1 - (k % 4), { noShadow: true }); bub.push(b); }
      A.push({ o: g, f: (o, t, dt) => { bub.forEach(b => { b.position.y += dt * 0.6; if (b.position.y > 8) b.position.y = 0; }); } });
    } },
  };
  // A water plane around the island sets, under the sky.
  function water(g, col, A) {
    const w = add(g, new T.CircleGeometry(40, 48), mat(col, 0.15, { metalness: 0.1 }), 0, -0.35, 0, { r: [-Math.PI / 2, 0, 0], noShadow: true }); w.userData.drawnBg = true;
    A.push({ o: w, f: (o, t) => { o.position.y = -0.36 + Math.sin(t * 0.8) * 0.04; } });
  }

  // ---- scene and camera ---------------------------------------------------------------------------------------
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(34, 2, 0.1, 120);
  const hemi = new T.HemisphereLight('#eaf6ff', '#6f8f4f', 0.55); scene.add(hemi);
  const sun = new T.DirectionalLight('#fff3dc', 1.25); sun.position.set(5, 9, 6); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8 }); sun.shadow.bias = -0.0006; scene.add(sun);
  let setGroup = null, setId = '', anims = [], cast = {}, actors = [], props = [], sparks = [];
  const WIDE = 9.6, CLOSE = 7.8;
  const view = { look: new T.Vector3(0, 1.05, 0.2), dist: WIDE, yaw: 0, pitch: 0.2 }, want = { look: new T.Vector3(0, 1.05, 0.2), dist: WIDE, yaw: 0 };
  function sky(cols) {
    const c = document.createElement('canvas'); c.width = 4; c.height = 256; const x = c.getContext('2d'); const gr = x.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, cols[0]); gr.addColorStop(0.62, cols[1]); gr.addColorStop(1, cols[2]); x.fillStyle = gr; x.fillRect(0, 0, 4, 256);
    const t = new T.CanvasTexture(c); if ('colorSpace' in t) t.colorSpace = T.SRGBColorSpace; return t;
  }
  function buildSet(id) {
    if (setId === id && setGroup) return;
    if (setGroup) scene.remove(setGroup);
    const P = PLACE[id] || PLACE.castle; setId = PLACE[id] ? id : 'castle';
    setGroup = new T.Group(); anims = []; scene.add(setGroup);
    if (P.water) water(setGroup, P.water, anims);
    P.build(setGroup, anims); ink(setGroup);
    scene.background = sky(P.sky);
    scene.fog = new T.Fog(P.fog || P.sky[1], 20, 42);
    const L = P.light || ['#fff3dc', 0.55, 1.25];
    // Toon shading reads brighter than the old smooth shading, so the fill light is lower and the sun a touch stronger.
    sun.color.set(L[0]); hemi.intensity = L[1] * 0.7; sun.intensity = L[2];
    hemi.color.set('#eaf6ff'); hemi.groundColor.set('#6f8f4f'); sun.position.set(5, 9, 6);
    clearPhoto(); if (PHOTO[setId]) wantPhoto(setId);
  }

  // ---- photo backdrops ----------------------------------------------------------------------------------------
  // A set with a photo shows its drawn sky and ground first. The photo (tools/backdrops.js) downloads the first time
  // the set is used and is kept on the tablet, so later it comes up at once. It replaces the drawn sky, ground, water
  // and clouds; the landmark, props and cast stay in front of it, lit like the photo.
  // Each set's photo and where its sun goes (radians round the stage, atan2(z, x); 0.88 is behind the camera on the
  // right, -1.57 straight ahead), chosen so the view behind the cast is the photo's best side.
  const PHOTO = { castle: ['meadow_2', 0.88], forest: ['epping_forest_01', 0.88], beach: ['fish_hoek_beach', -1.2], island: ['blouberg_sunrise_1', 2.35], mountain: ['fouriesburg_mountain_midday', -0.34], train: ['bloem_train_track_clear', 0.88], fair: ['air_museum_playground', 0.88] };
  let photo = null;
  function clearPhoto() { if (photo) { scene.remove(photo); photo = null; } }
  function wantPhoto(id) {
    const B = window.DucklingBackdrops; if (!B) return;
    B.load(PHOTO[id][0], { linear: true, sunAt: PHOTO[id][1] }).then(set => {
      if (!set || setId !== id || !setGroup) return;
      clearPhoto();
      photo = new T.Group();
      photo.add(B.ground(set, { height: 2.2, radius: 50 }));
      const catcher = new T.Mesh(new T.PlaneGeometry(18, 18), new T.ShadowMaterial({ opacity: 0.28 }));
      catcher.rotation.x = -Math.PI / 2; catcher.position.y = 0.002; catcher.receiveShadow = true; catcher.userData.noInk = catcher.userData.inked = true; catcher.raycast = () => {};
      photo.add(catcher); scene.add(photo);
      setGroup.traverse(o => { if (o.userData.drawnBg) o.visible = false; });
      scene.background = null; scene.fog = null;
      // The cast keeps the stage's sun, front right, so faces stay lit; it takes the photo's sun colour and strength
      // and the photo's sky and ground as the fill light.
      const m = set.meta;
      sun.color.setRGB(m.sunColor[0], m.sunColor[1], m.sunColor[2]).lerp(new T.Color('#ffffff'), 0.4);
      sun.intensity = 0.7 + 0.45 * Math.min(1, m.sunStrength / 60);
      hemi.color.setRGB(m.skyColor[0], m.skyColor[1], m.skyColor[2]); hemi.groundColor.setRGB(m.groundColor[0], m.groundColor[1], m.groundColor[2]);
      hemi.intensity = 0.55 - 0.15 * Math.min(1, m.sunStrength / 60);
      if (!running) render();
    });
  }

  // ---- acting ---------------------------------------------------------------------------------------------------
  const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  let simT = 0, events = [], speaking = null;
  const later = (sec, fn) => events.push({ at: simT + sec, fn });
  function at(mark, i) { const m = MARK[mark] || MARK.center; return new T.Vector3(m[0] + (i || 0) * 0.15, 0, m[1]); }
  function walkTo(c, pos, secs) { c.from = c.root.position.clone(); c.to = pos.clone(); c.walkT = 0; c.walkDur = secs || Math.max(0.9, c.from.distanceTo(pos) / 2.2); }
  function act(c, what) { c.act = what; c.actT = 0; c.jumps = 0; }
  function settle(c) { c.act = null; c.body.position.set(0, 0, 0); c.body.rotation.set(0, 0, 0); c.head.rotation.set(0, 0, 0); c.armL.rotation.set(0, 0, 0); c.armR.rotation.set(0, 0, 0); if (!c.grow) c.root.scale.set(1, 1, 1); }
  function puffAt(c, colors, n) {
    const p = c.head.getWorldPosition(new T.Vector3()); const dir = new T.Vector3(Math.sin(c.root.rotation.y), 0, Math.cos(c.root.rotation.y)); p.addScaledVector(dir, 0.45);
    for (let i = 0; i < n; i++) {
      const m = new T.Mesh(sph(0.045, 6), new T.MeshBasicMaterial({ color: colors[i % colors.length], transparent: true }));
      m.position.copy(p); m.v = new T.Vector3((Math.random() - 0.5) * 2 + dir.x * 2, Math.random() * 2 + 0.6, (Math.random() - 0.5) * 2 + dir.z * 2); m.life = 1; scene.add(m); sparks.push(m);
    }
  }
  function showProp(c, ch) {
    for (const p of props.filter(p => p.owner === c)) { scene.remove(p.s); props.splice(props.indexOf(p), 1); }
    if (!ch) return;
    const s = emojiSprite(ch, 0.7); scene.add(s); props.push({ s, owner: c, born: simT });
  }
  // A stage direction for one actor. move: a mark; do: an action; face: a cast id, 'audience' or 'back'; prop: an emoji.
  function direct(c, d) {
    if (!c) return;
    if (d.move || d.do === 'hug') c.directed = true;
    if (c.grow && c.grow < 1) c.grow = 1;   // still waiting to appear: appear now
    let delay = 0;
    if (d.move && MARK[d.move]) { const taken = actors.filter(o => o !== c && o.root.position.distanceTo(at(d.move)) < 0.6).length; walkTo(c, at(d.move, taken ? (taken % 2 ? 4 : -4) : 0)); delay = c.walkDur; }
    if (d.do === 'run' && d.move) { c.walkDur *= 0.55; delay = c.walkDur; }
    c.face = d.face || (d.do === 'hug' || d.do === 'point' ? c.face : 'audience');
    if (d.do === 'hug' && cast[d.face]) { const o = cast[d.face].root.position; walkTo(c, o.clone().add(new T.Vector3(c.root.position.x < o.x ? -0.75 : 0.75, 0, 0.05))); delay = c.walkDur; }
    if (d.do && d.do !== 'run') later(delay, () => act(c, d.do));
    if (d.prop) showProp(c, d.prop);
  }
  const MOOD = { excited: 'jump', cheerful: 'wave', sad: 'sad', whispering: 'hide', shouting: 'cheer', friendly: 'nod', neutral: 'talk' };

  function update(dt) {
    simT += dt; const t = simT;
    for (const e of events.filter(e => e.at <= simT)) { events.splice(events.indexOf(e), 1); e.fn(); }
    for (const c of actors) {
      let walking = false;
      if (c.to) {
        c.walkT = Math.min(1, c.walkT + dt / c.walkDur); const e = ease(c.walkT);
        const p = new T.Vector3().lerpVectors(c.from, c.to, e); c.root.position.x = p.x; c.root.position.z = p.z;
        const dir = Math.atan2(c.to.x - c.from.x, c.to.z - c.from.z);
        let d = dir - c.root.rotation.y; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; c.root.rotation.y += d * Math.min(1, dt * 9);
        walking = c.walkT < 1;
        const f = c.walkDur < 0.8 ? 16 : 11;
        c.body.position.y = walking ? Math.abs(Math.sin(t * f)) * 0.09 : 0; c.body.rotation.z = walking ? Math.sin(t * f) * 0.07 : 0;
        c.armL.rotation.x = walking ? Math.sin(t * f) * 0.6 : 0; c.armR.rotation.x = walking ? -Math.sin(t * f) * 0.6 : 0;
        if (c.walkT >= 1) { c.to = null; c.body.rotation.z = 0; }
      }
      if (!walking) {
        let goal = 0;
        if (c.face === 'back') goal = Math.PI;
        else if (c.face && cast[c.face] && cast[c.face] !== c) { const o = cast[c.face].root.position; goal = Math.atan2(o.x - c.root.position.x, o.z - c.root.position.z); }
        let d = goal - c.root.rotation.y; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; c.root.rotation.y += d * Math.min(1, dt * 5);
      }
      if (c.grow) { const g = c.grow < 1 ? 0.01 : Math.min(1, c.root.scale.x + dt * 3.5); c.root.scale.setScalar(g); if (g >= 1) c.grow = 0; }
      const breathe = 1 + Math.sin(t * 2 + c.id.length) * 0.015; c.body.scale.y += (breathe - c.body.scale.y) * 0.3;
      const blink = (t + c.id.length * 0.7) % 3.6 < 0.12 ? 0.1 : 1; for (const e of c.eyes) e.scale.y = blink;
      const talking = speaking === c;
      if (c.mouth) c.mouth.scale.y = c.mouthArc ? (talking ? 1 + Math.abs(Math.sin(t * 16)) * 1.4 : 1) : (talking ? 0.35 + Math.abs(Math.sin(t * 16)) * 0.9 : 0.35);
      if (!c.act && !walking) c.head.rotation.x = talking ? Math.sin(t * 7) * 0.08 : c.head.rotation.x * 0.9;
      if (c.bulb) c.bulb.material.emissiveIntensity = talking ? 1 + Math.abs(Math.sin(t * 14)) * 2 : 1.2;
      if (c.tail) c.tail.rotation.y = Math.sin(t * 2.4 + c.id.length) * 0.35;
      if (c.act) perform(c, dt, t);
    }
    for (const p of props) { const c = p.owner; const w = c.root.position; const dir = c.root.rotation.y; p.s.position.set(w.x + Math.sin(dir) * 0.5, c.height * 0.55 + Math.sin(t * 2) * 0.05, w.z + Math.cos(dir) * 0.5); const k = Math.min(1, (simT - p.born) * 4); p.s.scale.setScalar(0.7 * k); }
    for (let i = sparks.length - 1; i >= 0; i--) { const m = sparks[i]; m.v.y -= 5 * dt; m.position.addScaledVector(m.v, dt); m.life -= dt * 1.1; m.material.opacity = Math.max(0, m.life); m.scale.setScalar(Math.max(0.01, m.life)); if (m.life <= 0) { scene.remove(m); m.material.dispose(); sparks.splice(i, 1); } }
    for (const a of anims) a.f(a.o, t, dt);
    // The camera leans toward whoever is speaking; on narrator lines it shows the whole set.
    const k = Math.min(1, dt * 1.6);
    view.look.lerp(want.look, k); view.dist += (want.dist - view.dist) * k; view.yaw += (want.yaw - view.yaw) * k;
    camera.position.set(view.look.x + Math.sin(view.yaw) * Math.cos(view.pitch) * view.dist, view.look.y + Math.sin(view.pitch) * view.dist, view.look.z + Math.cos(view.yaw) * Math.cos(view.pitch) * view.dist);
    camera.lookAt(view.look);
  }
  function perform(c, dt, t) {
    const a = (c.actT += dt), done = len => { if (a > len) { const was = c.act; settle(c); return was; } return null; };
    switch (c.act) {
      case 'jump': case 'cheer': { const j = (a % 0.7) / 0.7; c.body.position.y = Math.sin(j * Math.PI) * 0.5; const up = c.act === 'cheer' ? 2.6 : Math.sin(j * Math.PI) * 2.2; c.armL.rotation.z = -up; c.armR.rotation.z = up; done(1.4); break; }
      case 'wave': c.armR.rotation.z = 2.4 + Math.sin(a * 10) * 0.35; done(1.6); break;
      case 'talk': c.armR.rotation.z = Math.min(1, a * 4) * 0.6; c.armR.rotation.x = -0.4 + Math.sin(a * 6) * 0.2; done(1.4); break;
      case 'dance': c.body.rotation.z = Math.sin(a * 8) * 0.18; c.body.position.y = Math.abs(Math.sin(a * 8)) * 0.15; c.armL.rotation.z = -1.4 - Math.sin(a * 8) * 0.6; c.armR.rotation.z = 1.4 - Math.sin(a * 8) * 0.6; c.root.rotation.y += dt * 1.5; done(2.4); break;
      case 'spin': c.root.rotation.y += dt * 9; c.body.position.y = Math.sin(Math.min(1, a / 1.2) * Math.PI) * 0.3; done(1.2); break;
      case 'clap': c.armL.rotation.set(-1.3, 0, -0.5 + Math.abs(Math.sin(a * 10)) * 0.4); c.armR.rotation.set(-1.3, 0, 0.5 - Math.abs(Math.sin(a * 10)) * 0.4); done(1.5); break;
      case 'laugh': c.body.rotation.x = -0.15; c.body.position.y = Math.abs(Math.sin(a * 14)) * 0.05; c.head.rotation.x = -0.25; done(1.5); break;
      case 'nod': c.head.rotation.x = Math.sin(a * 9) * 0.25; done(1.0); break;
      case 'shake': c.head.rotation.y = Math.sin(a * 10) * 0.4; done(1.0); break;
      case 'point': c.armR.rotation.x = -1.5; c.armR.rotation.z = 0.15; done(1.6); break;
      case 'think': c.armR.rotation.set(-2.3, 0, 0.6); c.head.rotation.z = 0.2; c.head.rotation.x = -0.15; done(2.0); break;
      case 'look': c.head.rotation.y = Math.sin(a * 2.6) * 0.7; c.armR.rotation.set(-2.6, 0, 0.3); done(2.4); break;
      case 'shy': c.body.rotation.z = Math.sin(a * 3) * 0.06; c.head.rotation.x = 0.25; c.armL.rotation.set(-0.6, 0, -0.4); c.armR.rotation.set(-0.6, 0, 0.4); done(2.2); break;
      case 'hide': { const k = Math.min(1, a * 4); c.body.scale.y = 1 - k * 0.25; c.armL.rotation.set(-2.2 * k, 0, -0.4); c.armR.rotation.set(-2.2 * k, 0, 0.4); done(1.8); break; }
      case 'sad': c.head.rotation.x = 0.4; c.body.rotation.x = 0.12; c.armL.rotation.z = 0.15; c.armR.rotation.z = -0.15; done(2.2); break;
      case 'scared': c.body.position.x = Math.sin(a * 40) * 0.03; c.armL.rotation.z = -1.6; c.armR.rotation.z = 1.6; c.body.position.y = a < 0.3 ? Math.sin(a / 0.3 * Math.PI) * 0.3 : 0; done(1.6); break;
      case 'sleep': { const k = Math.min(1, a * 2); c.body.rotation.z = 0.35 * k; c.head.rotation.x = 0.3 * k; if (!c.zzz) { c.zzz = true; showProp(c, '💤'); } if (a > 3) { c.zzz = false; showProp(c, ''); settle(c); } break; }
      case 'bow': c.body.rotation.x = Math.sin(Math.min(1, a / 1.2) * Math.PI) * 0.6; done(1.2); break;
      case 'hug': c.armL.rotation.set(-1.4, 0, 0.4); c.armR.rotation.set(-1.4, 0, -0.4); c.body.rotation.x = 0.1; done(1.6); break;
      case 'knock': c.armR.rotation.x = -1.4 + Math.abs(Math.sin(a * 9)) * 0.45; done(1.6); break;
      case 'sneeze':
        if (a < 0.8) { c.head.rotation.x = -a * 0.45; c.body.scale.y = 1 + a * 0.1; }
        else if (a < 0.95) { if (!c.sneezed) { c.sneezed = true; puffAt(c, c.sparks ? ['#ffb000', '#ff5a1f'] : ['#ffffff', '#dfefff'], 18); } c.head.rotation.x = 0.45; c.body.scale.y = 0.9; }
        else if (a < 1.6) { c.head.rotation.x *= 0.85; } else { c.sneezed = false; settle(c); }
        break;
      default: settle(c);
    }
  }

  // ---- driving it from the story ------------------------------------------------------------------------------
  let canvas = null, host = null, running = false, raf = 0, last = 0, lastScene = null;
  STAGE.placeId = label => ({ 'a castle': 'castle', 'the moon': 'moon', 'an island': 'island', 'a forest': 'forest', 'the beach': 'beach', 'a fair': 'fair', 'a snowy mountain': 'mountain', 'cupcake town': 'cupcake', 'a train': 'train', 'under the sea': 'sea' })[label] || 'castle';
  STAGE.PLACES = Object.keys(PLACE);
  STAGE.CAST = Object.keys(MAKE);
  STAGE.mount = function (el) {
    host = el; canvas = renderer.domElement; canvas.className = 'stage3d'; el.appendChild(canvas);
    new ResizeObserver(resize).observe(el); resize();
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (host && host.offsetParent) start(); });
  };
  function resize() { if (!host) return; const w = host.clientWidth || 800, h = host.clientHeight || 300; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); render(); }
  function render() { renderer.render(scene, camera); }
  function loop(now) { if (host && !host.offsetParent) { stop(); return; } const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now; update(dt); render(); if (running) raf = requestAnimationFrame(loop); }
  function start() { if (running || STAGE.still) return; running = true; last = 0; raf = requestAnimationFrame(loop); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  STAGE.start = start; STAGE.stop = stop;
  // A new scene. ids: the cast's ids, in the order they were picked. First scene of a story: they walk on.
  STAGE.setScene = function ({ place, ids, entrance, things, meName }) {
    buildSet(place);
    const keep = actors.map(a => a.id).join() === ids.join();
    if (!keep) {
      for (const a of actors) scene.remove(a.root);
      actors = ids.filter(id => MAKE[id]).slice(0, 3).map(id => cast[id] || (cast[id] = MAKE[id]()));
      for (const a of actors) { scene.add(a.root); ink(a.root); if (a.portrait) loadPortrait(a); }
    }
    events = []; speaking = null;
    for (const p of props.slice()) { scene.remove(p.s); } props = [];
    if (lastScene) for (const s of lastScene) setGroup.remove(s);
    lastScene = (things || []).slice(0, 2).map((ch, i) => { const s = emojiSprite(ch, 0.9); s.position.set(i ? 3.2 : -3.2, 0.75, i ? 2.8 : 2.6); setGroup.add(s); return s; });
    const homes = HOME[actors.length - 1] || HOME[2];
    actors.forEach((a, i) => {
      settle(a); a.face = 'audience'; a.directed = false; const h = new T.Vector3(homes[i][0], 0, homes[i][1]);
      // First scene: each friend pops up near the landmark and walks forward to their spot, in clear view.
      if (entrance || !keep) { a.root.position.set(h.x * 0.5, 0, -1.1); a.root.rotation.y = 0; a.grow = 0.01; a.root.scale.setScalar(0.01); later(i * 0.35, () => { a.grow = 1; if (!a.directed) walkTo(a, h, 1.6); }); }
      else walkTo(a, h, 1.0);
    });
    want.look.set(0, 1.05, 0.2); want.dist = WIDE; want.yaw = 0;
    void meName; start();
  };
  // One line, as it starts to be read. whoId: a cast id or 'narrator'. acts: cleaned stage directions.
  STAGE.line = function ({ whoId, mood, acts }) {
    const c = cast[whoId] && actors.includes(cast[whoId]) ? cast[whoId] : null;
    speaking = c;
    const list = acts && acts.length ? acts : (c ? [{ who: whoId, do: MOOD[mood] || 'talk' }] : []);
    for (const d of list) direct(cast[d.who] && actors.includes(cast[d.who]) ? cast[d.who] : c, d);
    // Toward the speaker, but never off the set: a friend still walking on from the side is not followed out there.
    if (c) { const p = c.to || c.root.position, x = Math.max(-1.6, Math.min(1.6, p.x * 0.6)); want.look.set(x, 1.0, Math.max(0, Math.min(1.4, p.z * 0.5))); want.dist = CLOSE; want.yaw = -x * 0.08; }
    else { want.look.set(0, 1.05, 0.2); want.dist = WIDE; want.yaw = 0; }
    start();
  };
  STAGE.quiet = function () { speaking = null; };
  STAGE.cheer = function () { speaking = null; actors.forEach((a, i) => later(i * 0.15, () => { a.face = 'audience'; act(a, 'cheer'); })); want.look.set(0, 1.05, 0.2); want.dist = WIDE; want.yaw = 0; start(); };
  // Tests and the preview: step story time and draw, without the clock.
  STAGE.step = function (sec) { for (let i = 0; i < Math.round(sec * 30); i++) update(1 / 30); render(); };
  STAGE.debug = () => ({ set: setId, actors: actors.map(a => ({ id: a.id, x: +a.root.position.x.toFixed(2), z: +a.root.position.z.toFixed(2), act: a.act, talking: speaking === a })), props: props.length, running });
  function loadPortrait(c) {
    if (!(window.KidTablet && KidTablet.portrait)) return;
    KidTablet.portrait().then(url => {
      if (!url) return;
      new T.TextureLoader().load(url, tex => { if ('colorSpace' in tex) tex.colorSpace = T.SRGBColorSpace; c.face.material.map = tex; c.face.material.needsUpdate = true; });
    }, () => {});
  }
})();
