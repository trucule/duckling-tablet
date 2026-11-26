// Realistic avatar: MakeHuman models (built by tools/build-avatar-models.py into models/*.js) put together in three.js.
//
// The body, each piece of hair, clothing and the skin and eye textures are separate files, loaded when first needed.
// Each file is a plain script that stores a base64 glTF (or WebP) in window.AVATAR_MODELS, because the tablet's browser
// cannot fetch files or open data: or blob: URLs; images are decoded with createImageBitmap straight from the bytes.
//
// window.REAL_AVATAR.compose(group, P) puts the avatar for design P into group and returns the anchors avatar.js uses
// for its own hats, glasses, wings and the camera, or null while files are still loading (onReady is called after).
(function () {
  'use strict';
  const T = window.THREE, CAT = window.AVATAR_CATALOG;
  const R = window.REAL_AVATAR = { ok: !!(T && CAT && T.GLTFLoader), ready: false, failed: null, onReady: null, errors: [] };
  if (!R.ok) return;
  const MODELS = () => (window.AVATAR_MODELS = window.AVATAR_MODELS || {});
  const HEIGHT = 1.6;                        // the avatar's height in scene units (the procedural avatar's size)

  // ------------------------------------------------------------------------------------------------------------
  // Choices: design values to model files
  // ------------------------------------------------------------------------------------------------------------
  const A = CAT.assets;
  // Models kept in the package but never offered: too short or too revealing for a child's game. The jean shorts stay
  // because other clothes and the base layer borrow their list of covered skin. A saved design that wore one gets the
  // default instead (avatar.js migrate()). Look at every new clothing model at full length before offering it.
  const NOT_OFFERED = ['bottom-jean-shorts', 'bottom-plaid-skirt'];
  const ids = kind => Object.keys(A).filter(k => k.startsWith(kind + '-') && !NOT_OFFERED.includes(k));
  const list = kind => ids(kind).map(k => [k, A[k].label]);
  const SHADES = ['glasses-3d', 'glasses-goggles'];
  R.SHADES = SHADES;
  R.LOOK = {
    hair: list('hair'), brows: list('brows'), top: list('top').concat(list('dress')), bottom: list('bottom'), shoes: list('shoes'),
    socks: [['none', 'None']].concat(list('socks')), glasses: [['none', 'None']].concat(list('glasses').filter(([k]) => !SHADES.includes(k))),
    earrings: [['none', 'None']].concat(list('jewel').filter(([k]) => k !== 'jewel-pearls')),
    pose: [['stand', 'Stand'], ['wave', 'Salute'], ['hips', 'Hands on hips'], ['hero', 'Hero'], ['shy', 'Shy'], ['peace', 'Peace'], ['pose', 'Strike a pose'], ['fly', 'Fly']]
      .filter(([k]) => CAT.body.poses.includes(k)),
  };
  // The face sliders (each -1 to 1). Keys pair with the body's "name-" and "name+" shape keys.
  R.TUNE = [['faceWidth', 'Face width'], ['cheeks', 'Cheeks'], ['jaw', 'Jaw'], ['chin', 'Chin'], ['eyeSize', 'Eye size'], ['eyeSpacing', 'Eyes apart'],
    ['browHeight', 'Eyebrow height'], ['noseSize', 'Nose size'], ['noseWidth', 'Nose width'], ['noseTip', 'Nose tip'], ['lips', 'Lips'],
    ['mouthWidth', 'Mouth width'], ['ears', 'Ears']].filter(([k]) => CAT.body.keys.includes(k + '+'));
  R.isDress = id => /^dress-/.test(id || '');
  R.tints = id => !!(A[id] && A[id].tint);
  R.has = id => !!A[id];

  // Old (drawn) avatar choices to the real ones, so a saved design carries over.
  R.MIGRATE = {
    hair: { short: 'hair-short', bob: 'hair-bob', long: 'hair-long', ponytail: 'hair-ponytail', pigtails: 'hair-double-braid', braids: 'hair-double-braid',
            bun: 'hair-bun', curly: 'hair-curls', afro: 'hair-afro', pixie: 'hair-short-side' },
    brows: { natural: 'brows-natural', thin: 'brows-soft', thick: 'brows-thick', arched: 'brows-arched' },
    top: { tee: 'top-tee', long: 'top-sweater', hoodie: 'top-sweater', stripes: 'top-tucked-tee', tank: 'top-tank', dress: 'dress-sundress' },
    bottom: { jeans: 'bottom-pants', leggings: 'bottom-pants', shorts: 'bottom-cargo', skirt: 'bottom-ruffle-skirt' },
    shoes: { sneakers: 'shoes-sneakers', boots: 'shoes-rain-boots', sandals: 'shoes-mary-janes', flats: 'shoes-flats-bows' },
    glasses: { round: 'glasses-round', square: 'glasses-black', cateye: 'glasses-leopard' },
    pose: { cheer: 'peace' },
  };

  // Shop outfits made of real clothes: [top, top colour, bottom, bottom colour, shoes, shoe colour, socks].
  R.OUTFITS = {
    soccer: ['top-tee', '#FF2D55', 'bottom-cargo', null, 'shoes-sneakers', '#2B2140', 'socks-high'],
    chef: ['top-sweater', '#FFFFFF', 'bottom-pants', '#2B2140', 'shoes-leather', null, 'socks-low'],
    doctor: ['top-polo', '#7FD1E8', 'bottom-pants', '#7FD1E8', 'shoes-sneakers', '#FFFFFF', 'socks-low'],
    ballerina: ['top-tank', null, 'bottom-tiered-skirt', null, 'shoes-flats-bows', null, 'socks-frill'],
    superhero: ['top-sweater', '#3A86FF', 'bottom-pants', '#3A86FF', 'shoes-rain-boots', '#FF2D55', null],
    princess: ['dress-party', null, null, null, 'shoes-flats-flowers', null, null],
    astronaut: ['dress-overalls', null, null, null, 'shoes-rain-boots', '#C0C8D8', null],
  };

  // ------------------------------------------------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------------------------------------------------
  const scripts = {};
  function loadScript(id) {
    if (scripts[id]) return scripts[id];
    return (scripts[id] = new Promise((res, rej) => {
      if (MODELS()[id]) return res();
      const s = document.createElement('script'); s.src = 'models/' + id + '.js';
      s.onload = () => (MODELS()[id] ? res() : rej(new Error('empty ' + id))); s.onerror = () => rej(new Error('missing ' + id));
      document.head.appendChild(s);
    }));
  }
  function takeBytes(id) {
    const b = atob(MODELS()[id]); delete MODELS()[id];
    const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  function bitmapTexture(u8, type) {
    return createImageBitmap(new Blob([u8], { type }), { premultiplyAlpha: 'none' }).then(bm => { const t = new T.Texture(bm); t.needsUpdate = true; return t; });
  }
  // glTF from bytes, with images decoded without URLs.
  function parseGlb(u8) {
    const loader = new T.GLTFLoader();
    loader.pluginCallbacks = loader.pluginCallbacks.map(cb => parser => {
      const p = cb(parser);
      if (p && p.name === 'EXT_texture_webp') p.isSupported = Promise.resolve(true);
      return p;
    });
    loader.register(parser => {
      parser.loadImageSource = function (index) {
        if (this.sourceCache[index] !== undefined) return this.sourceCache[index].then(t => t.clone());
        const def = this.json.images[index];
        const p = this.getDependency('bufferView', def.bufferView).then(bv => bitmapTexture(bv, def.mimeType)).then(t => { t.userData.mimeType = def.mimeType; return t; });
        this.sourceCache[index] = p; return p;
      };
      return { name: 'kid_bitmap_images' };
    });
    return new Promise((res, rej) => loader.parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), '', res, rej));
  }

  const cache = {};            // id: { meshes } once loaded
  const loading = {};
  let body = null;             // { root, rig, mesh, parts, bones, mixer, clips, index, vid, scale, eyeY, ... }
  const tex = { skin: {}, eye: {} };
  // Bones by their MakeHuman name (three.js drops the dots from node names: wrist.L is wristL).
  const bone = n => body && (body.bones[n] || body.bones[T.PropertyBinding.sanitizeNodeName(n)]);

  // A piece is read and decoded while the body is, and joins the body's skeleton once both are in.
  function load(id) {
    if (cache[id] || loading[id]) return loading[id] || Promise.resolve();
    const done = () => { delete loading[id]; };
    const p = loading[id] = Promise.all([loadScript(id).then(() => parseGlb(takeBytes(id))), loadBody()]).then(([g]) => { cache[id] = adopt(id, g); });
    p.then(done, done);
    return p;
  }
  const texReady = { skin: {}, eye: {} };   // the textures that are in, by name
  function loadTex(kind, name) {
    const id = kind + '-' + name, box = tex[kind];
    if (box[name]) return box[name];
    return (box[name] = loadScript(id).then(() => bitmapTexture(takeBytes(id), 'image/webp')).then(t => { t.flipY = false; t.encoding = T.sRGBEncoding; texReady[kind][name] = t; return t; }));
  }

  // ------------------------------------------------------------------------------------------------------------
  // Surface detail drawn in code: small tiling normal maps for skin pores and fabric weaves, so surfaces catch light
  // the way skin and cloth do. Nothing is downloaded; each pattern is made once.
  // ------------------------------------------------------------------------------------------------------------
  const DETAIL = {};
  function hash(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function smoothNoise(x, y, n) {   // value noise that tiles every n cells
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const v = (a, b) => hash(((a % n) + n) % n, ((b % n) + n) % n);
    return (v(xi, yi) * (1 - sx) + v(xi + 1, yi) * sx) * (1 - sy) + (v(xi, yi + 1) * (1 - sx) + v(xi + 1, yi + 1) * sx) * sy;
  }
  const PATTERNS = {
    // Fine bumps and scattered pores.
    pores: (u, v) => 0.55 * smoothNoise(u * 48, v * 48, 48) + 0.3 * smoothNoise(u * 96, v * 96, 96) - (hash(Math.floor(u * 160), Math.floor(v * 160)) > 0.93 ? 0.6 : 0),
    // Plain weave: threads over and under.
    cotton: (u, v) => { const a = Math.sin(u * Math.PI * 16), b = Math.sin(v * Math.PI * 16); return 0.5 + 0.5 * (Math.sign(a * b) * Math.min(Math.abs(a), Math.abs(b))) + 0.15 * smoothNoise(u * 16, v * 16, 16); },
    // Twill: diagonal ribs.
    denim: (u, v) => 0.5 + 0.3 * Math.sin((u * 8 + v * 8) * Math.PI * 2) + 0.35 * smoothNoise(u * 16, v * 32, 16),
    // Knit: columns of V stitches.
    knit: (u, v) => { const cx = (u * 24) % 1, cy = (v * 32) % 1, side = cx < 0.5 ? cx * 2 : (1 - cx) * 2; const vv = (cy + side * 0.5) % 1; return Math.pow(Math.sin(vv * Math.PI), 0.6) * Math.pow(Math.sin(cx * Math.PI * 2 % Math.PI || 0.0001), 0.3); },
    // Leather: soft cells.
    leather: (u, v) => { let d = 9; const gx = u * 24, gy = v * 24, ix = Math.floor(gx), iy = Math.floor(gy);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const cx = ix + a + hash(((ix + a) % 24 + 24) % 24, ((iy + b) % 24 + 24) % 24), cy = iy + b + hash(((iy + b) % 24 + 24) % 24 + 99, ((ix + a) % 24 + 24) % 24); d = Math.min(d, Math.hypot(gx - cx, gy - cy)); }
      return Math.min(1, d * 1.6); },
  };
  function detailMap(name) {
    if (DETAIL[name]) return DETAIL[name];
    const N = 256, h = new Float32Array(N * N), f = PATTERNS[name];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) h[y * N + x] = f(x / N, y / N);
    const d = new Uint8Array(N * N * 4), at = (x, y) => h[((y + N) % N) * N + ((x + N) % N)];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2, dy = (at(x, y + 1) - at(x, y - 1)) * 2, l = Math.hypot(dx, dy, 1), i = (y * N + x) * 4;
      d[i] = (-dx / l * 0.5 + 0.5) * 255; d[i + 1] = (-dy / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
    const t = new T.DataTexture(d, N, N, T.RGBAFormat); t.wrapS = t.wrapT = T.RepeatWrapping;
    t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
    return (DETAIL[name] = t);
  }
  // Colour detail for cloth, around 0.5 (no change): the uneven yarn that makes fabric read as fabric from a distance.
  const CLOTH_SHADE = {
    // Jersey and plain cotton: heathered yarn, faint lengthwise slubs.
    heather: (u, v) => 0.5 + 0.22 * (smoothNoise(u * 64, v * 64, 64) - 0.5) + 0.16 * (smoothNoise(u * 8, v * 96, 8) - 0.5) + 0.1 * (smoothNoise(u * 16, v * 16, 16) - 0.5),
    // Denim: dark diagonal twill ridges with pale weft between them, lengthwise slubs and soft fading.
    denim: (u, v) => { const tw = Math.sin((u * 24 + v * 24) * Math.PI * 2); return 0.5 + 0.16 * tw + 0.22 * (smoothNoise(u * 6, v * 80, 6) - 0.5) + 0.2 * (smoothNoise(u * 4, v * 4, 4) - 0.5) + (hash(Math.floor(u * 192), Math.floor(v * 192)) > 0.9 ? 0.1 : 0); },
    // Wool and felt: fuzzy mottling at two sizes.
    wool: (u, v) => 0.5 + 0.2 * (smoothNoise(u * 32, v * 32, 32) - 0.5) + 0.2 * (smoothNoise(u * 96, v * 96, 96) - 0.5) + 0.12 * (smoothNoise(u * 6, v * 6, 6) - 0.5),
    // Knit: the shadow between stitch columns.
    knit: (u, v) => 0.38 + 0.24 * PATTERNS.knit(u, v) + 0.12 * (smoothNoise(u * 24, v * 24, 24) - 0.5),
    // Leather: darker creases between the cells.
    leather: (u, v) => 0.36 + 0.22 * PATTERNS.leather(u, v) + 0.1 * (smoothNoise(u * 12, v * 12, 12) - 0.5),
  };
  function shadeMap(name) {
    const key = 'shade-' + name; if (DETAIL[key]) return DETAIL[key];
    const N = 256, d = new Uint8Array(N * N * 4), f = CLOTH_SHADE[name];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const i = (y * N + x) * 4, g = Math.max(0, Math.min(255, f(x / N, y / N) * 255)); d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255; }
    const t = new T.DataTexture(d, N, N, T.RGBAFormat); t.wrapS = t.wrapT = T.RepeatWrapping;
    t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
    return (DETAIL[key] = t);
  }
  // Which detail each piece of clothing gets: { n: weave, rep: weave tiles across the texture, k: weave depth, a: shade,
  // ak: shade strength, sheen }. Most of the models' own textures are a plain white cut-out to be tinted, so this is
  // all the cloth detail they have.
  function fabricOf(id) {
    if (/sweater|warmers/.test(id)) return { n: 'knit', rep: 30, k: 0.5, a: 'knit', ak: 0.5, sheen: 0.5 };
    if (/jean|cargo|overalls/.test(id)) return { n: 'denim', rep: 14, k: 0.6, a: 'denim', ak: 0.9, sheen: 0.12 };
    if (/pants|harem|newsboy|beret|beanie/.test(id)) return { n: 'cotton', rep: 20, k: 0.45, a: 'wool', ak: 0.8, sheen: 0.25 };
    if (/leather|mary-janes|ankle-boots/.test(id)) return { n: 'leather', rep: 12, k: 0.4, a: 'leather', ak: 0.5, sheen: 0 };
    if (/^(top|dress|bottom|socks)-|sneakers|flats/.test(id)) return { n: 'cotton', rep: 22, k: 0.45, a: 'heather', ak: 0.85, sheen: 0.25 };
    return null;
  }
  // three.js r149 moves every texture of a material by the colour texture's repeat, so a detail texture cannot tile on its
  // own through normalMap. This adds the detail in the shader instead, tiled by its own count: a weave that tilts the
  // surface (and for skin, pores) and a colour shade, on top of the model's own textures. Skin also gets scatter().
  function detail(p, o) {
    if (!p.map) return;
    p.extensions = Object.assign({}, p.extensions, { derivatives: true });
    const u = { dN: { value: detailMap(o.n) }, dRep: { value: o.rep }, dK: { value: o.k }, dA: { value: o.a ? shadeMap(o.a) : detailMap(o.n) }, dAK: { value: o.a ? o.ak : 0 } };
    p.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, u);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' +
          'uniform sampler2D dN; uniform float dRep; uniform float dK; uniform sampler2D dA; uniform float dAK;\n' +
          'vec3 dTilt(vec3 pos, vec3 n, vec3 t, vec2 uv) {\n' +
          '  vec3 q0 = dFdx(pos), q1 = dFdy(pos); vec2 s0 = dFdx(uv), s1 = dFdy(uv);\n' +
          '  vec3 q1p = cross(q1, n), q0p = cross(n, q0); vec3 T = q1p * s0.x + q0p * s1.x, B = q1p * s0.y + q0p * s1.y;\n' +
          '  float det = max(dot(T, T), dot(B, B)); float sc = det == 0.0 ? 0.0 : inversesqrt(det);\n' +
          '  return normalize(T * (t.x * sc) + B * (t.y * sc) + n * t.z); }')
        .replace('#include <map_fragment>', '#include <map_fragment>\n' +
          'diffuseColor.rgb *= clamp(1.0 + (texture2D(dA, vUv * dRep).r - 0.5) * 2.0 * dAK, 0.0, 2.0);')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' +
          '{ vec3 t = texture2D(dN, vUv * dRep).xyz * 2.0 - 1.0; t.xy *= dK; normal = dTilt(-vViewPosition, normal, t, vUv * dRep); }');
      if (o.sss) sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' +
        'reflectedLight.directDiffuse *= vec3(1.0, 0.94, 0.9);\n' +
        'reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.14, 0.045, 0.025) * ' + o.sss.toFixed(3) + ';');
    };
    p.customProgramCacheKey = () => 'detail|' + o.n + '|' + (o.a || '') + '|' + (o.sss || 0);
  }
  // Physical materials, so skin, hair and cloth can have sheen.
  function physical(m) {
    if (m.isMeshPhysicalMaterial) return m;
    const p = new T.MeshPhysicalMaterial(); T.MeshStandardMaterial.prototype.copy.call(p, m); p.userData = m.userData; return p;   // Physical's own copy() expects physical fields
  }
  // Skin: light that enters it comes back out warmer and softer (detail()'s sss: a little red is added to the light the
  // skin receives, and the shadowed side keeps a warm glow instead of going grey).
  function finish(mesh, kind, id) {
    const one = m => {
      const p = physical(m);
      if (kind === 'body') {
        const o = Object.assign({ pores: 0.035, rep: 140, sheen: 0.12, sss: 1, env: 0.6, rough: 0.55 }, window.SKIN_TEST || {});
        detail(p, { n: 'pores', rep: o.rep, k: o.pores, sss: o.sss });
        p.roughness = o.rough; p.sheen = o.sheen; p.sheenRoughness = 0.5; p.sheenColor = new T.Color('#ffb4a0');
        p.clearcoat = 0.04; p.clearcoatRoughness = 0.45; p.envMapIntensity = o.env;
      } else if (kind === 'eyes') {
        // The iris and pupil glow a little from their own texture and the cornea is wet, so the eyes read from across the room.
        p.emissive = new T.Color('#ffffff'); p.emissiveMap = p.map; p.emissiveIntensity = 0.15; p.roughness = 0.1; p.clearcoat = 0.5; p.clearcoatRoughness = 0.05;
      } else if (kind === 'hair') {
        p.roughness = 0.55; p.sheen = 0.1; p.sheenRoughness = 0.3; p.sheenColor = p.color.clone().lerp(new T.Color('#ffffff'), 0.4); p.clearcoat = 0;
      } else if (kind === 'clothes' && id) {
        const f = fabricOf(id);
        p.clearcoat = 0;
        // A piece with its own normal map (the knit sweater, the cargo pants) keeps it and gets only the colour shade.
        if (f) { detail(p, p.normalMap ? Object.assign({}, f, { k: 0 }) : f); p.sheen = f.sheen; p.sheenRoughness = 0.6; p.sheenColor = new T.Color('#ffffff'); p.roughness = Math.max(p.roughness, 0.78); }
        if (/glasses|jewel/.test(id)) { p.roughness = 0.2; p.clearcoat = 0.6; }
      }
      p.needsUpdate = true; return p;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
  }

  function setupMaterial(m, kind) {
    if (m.map) m.map.encoding = T.sRGBEncoding;
    m.transparent = false; m.depthWrite = true;
    if (kind === 'hair') { m.alphaTest = 0.2; m.alphaToCoverage = true; m.side = T.DoubleSide; m.roughness = 0.55; m.metalness = 0; }   // soft edges without sorting
    else if (kind === 'eyebrows' || kind === 'lashes') { m.transparent = true; m.depthWrite = false; m.alphaTest = 0.05; m.side = T.DoubleSide; }
    else { m.alphaTest = 0.5; m.side = T.DoubleSide; if (m.metalness > 0.5) m.metalness = 0.2; }
    m.userData.base = m.color.clone();
  }

  // The body: its skeleton is the one every other piece is bound to.
  function loadBody() {
    if (R.bodyPromise) return R.bodyPromise;
    R.bodyPromise = loadScript('body').then(() => parseGlb(takeBytes('body'))).then(g => {
      const root = g.scene, meshes = [];
      root.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
      const mesh = meshes.find(m => m.geometry.attributes._vid) || meshes[0];
      const bones = {}; mesh.skeleton.bones.forEach(b => { bones[b.name] = b; });
      const parts = {};
      for (const m of meshes) {
        m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true;
        const n = (m.material.name || m.name).toLowerCase();
        const kind = m === mesh ? 'body' : /lash/.test(n) ? 'lashes' : /teeth/.test(n) ? 'teeth' : /eye|high-poly/.test(n) ? 'eyes' : 'other';
        parts[kind] = m; setupMaterial(m.material, kind);
        if (kind === 'eyes') { m.material.roughness = 0.3; m.material.side = T.FrontSide; m.material.metalness = 0; }
        if (kind === 'body') { m.material.roughness = 0.62; m.material.metalness = 0; }
        if (kind === 'teeth' || kind === 'lashes' || kind === 'eyes') m.castShadow = false;
        finish(m, kind);
      }
      const mixer = new T.AnimationMixer(root), clips = {};
      for (const c of g.animations) clips[c.name] = c;
      body = { root, mesh, meshes, parts, bones, mixer, clips, index: mesh.geometry.index.array.slice(), vid: mesh.geometry.attributes._vid, pose: null };
      // Size: feet on the floor, HEIGHT tall. Measured in the rest pose, in the model's own units.
      root.updateMatrixWorld(true);
      const box = new T.Box3().setFromObject(mesh);
      body.scale = HEIGHT / Math.max(0.1, box.max.y - box.min.y); body.floor = box.min.y;
      const eyes = parts.eyes ? new T.Box3().setFromObject(parts.eyes) : null;
      const top = box.max.y, eyeY = eyes ? (eyes.min.y + eyes.max.y) / 2 : top - (top - box.min.y) * 0.1;
      const headR = (top - eyeY) / 1.12, front = eyes ? eyes.max.z : headR * 0.9;
      // Anchors for the drawn extras, kept relative to a bone so they follow every pose: a head frame (the drawn
      // head's units, radius 0.19, centred where the drawn head's centre would be) and a torso frame (the drawn
      // body's units, so its neck at height 1.13 lands on her neck and its shoulders on hers).
      const wp = n => (bone(n) ? bone(n).getWorldPosition(new T.Vector3()) : null);
      // The drawn body's shoulders are 0.175 from its middle; hers are about 1.3 head radii (this keeps the drawn
      // necklaces, wings and capes at the sizes they were fitted at).
      const neck = wp('neck01') || new T.Vector3(0, eyeY - headR * 1.5, 0);
      const kTorso = headR * 1.3 / 0.175;
      const anchor = (boneName, pos, sc) => {
        const b = bone(boneName); if (!b) return null;
        const w = new T.Matrix4().compose(pos, new T.Quaternion(), new T.Vector3(sc, sc, sc));
        return { bone: b, local: new T.Matrix4().copy(b.matrixWorld).invert().multiply(w) };
      };
      body.headAnchor = anchor('head', new T.Vector3(0, eyeY + headR * 0.01, front - headR * 0.95), headR / 0.19);
      body.torsoAnchor = anchor('spine02', new T.Vector3(0, neck.y - 1.13 * kTorso, neck.z), kTorso);
      body.restEye = (eyeY - box.min.y) * body.scale; body.headR = headR * body.scale;
      body.scalp = makeScalp(mesh, new T.Vector3(0, eyeY, front - headR * 0.95), headR);
      setPose('stand');
      R.ready = true;
    });
    return R.bodyPromise;
  }

  // Short hair on the scalp itself, under hair styles that leave the front of the head bare (a ponytail pulled back,
  // a bun). It is the body's own surface above a hairline, coloured like her hair, sharing the body's skin and shapes.
  const SCALP = ['hair-ponytail', 'hair-bun', 'hair-braid-bun', 'hair-afro', 'hair-short', 'hair-short-side', 'hair-wavy-short', 'hair-curls'];
  function makeScalp(mesh, centre, r) {
    const g = mesh.geometry, pos = g.attributes.position, idx = g.index.array, mw = mesh.matrixWorld, v = new T.Vector3();
    // Each vertex's cover (0 to 1), fading in just above the hairline so its edge is soft.
    const cover = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mw).sub(centre).divideScalar(r);
      const flat = Math.hypot(v.x, v.z) || 1, c = v.z / flat;
      // Hairline height (in head radii from the head's centre): high at the forehead, lower over the ears, low at the nape.
      const line = -0.12 + 0.62 * Math.pow(Math.max(0, c), 2) - 0.75 * Math.max(0, -c);
      const ear = Math.abs(v.x) > 0.75 && v.y < 0.12 && v.z > -0.5;
      const t = ear || v.y < -1.1 ? 0 : Math.min(1, Math.max(0, (v.y - line + 0.02) / 0.07));
      cover.set([1, 1, 1, t * t * (3 - 2 * t)], i * 4);
    }
    const out = [];
    for (let i = 0; i < idx.length; i += 3) if (cover[idx[i] * 4 + 3] + cover[idx[i + 1] * 4 + 3] + cover[idx[i + 2] * 4 + 3] > 0) out.push(idx[i], idx[i + 1], idx[i + 2]);
    const sg = new T.BufferGeometry();
    for (const k in g.attributes) sg.setAttribute(k, g.attributes[k]);
    sg.setAttribute('color', new T.BufferAttribute(cover, 4));
    sg.morphAttributes = g.morphAttributes; sg.morphTargetsRelative = g.morphTargetsRelative; sg.setIndex(out);
    const m = new T.MeshStandardMaterial({ color: '#3B2416', roughness: 0.85, metalness: 0, vertexColors: true, alphaToCoverage: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    const sm = new T.SkinnedMesh(sg, m); sm.name = 'scalp';
    sm.morphTargetDictionary = mesh.morphTargetDictionary; sm.morphTargetInfluences = mesh.morphTargetInfluences.slice();
    sm.bind(mesh.skeleton, mesh.bindMatrix); sm.frustumCulled = false; sm.castShadow = false;
    return sm;
  }

  // An asset's meshes, re-bound to the body's bones by name.
  function adopt(id, g) {
    const kind = A[id].kind === 'eyebrows' ? 'eyebrows' : A[id].kind === 'hair' ? 'hair' : 'clothes';
    const out = [];
    g.scene.updateMatrixWorld(true);
    g.scene.traverse(o => { if (o.isSkinnedMesh) out.push(o); });
    for (const m of out) {
      const bones = m.skeleton.bones.map(b => body.bones[b.name] || b);
      m.removeFromParent();
      m.bind(new T.Skeleton(bones, m.skeleton.boneInverses), body.mesh.bindMatrix);
      m.frustumCulled = false; m.castShadow = kind !== 'eyebrows'; m.receiveShadow = true;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach(x => setupMaterial(x, kind));
      if (kind !== 'eyebrows') finish(m, kind, id);
      if (kind === 'eyebrows') m.renderOrder = 2;
      // Layers, so a closer layer wins where two nearly touch (a shirt hem over the top of the trousers).
      const layer = { socks: 1, bottom: 2, shoes: 3, top: 4, dress: 4, glasses: 5, hat: 5, jewel: 5 }[id.split('-')[0]] || 0;
      if (layer) (Array.isArray(m.material) ? m.material : [m.material]).forEach(x => { x.polygonOffset = true; x.polygonOffsetFactor = -layer; x.polygonOffsetUnits = -4 * layer; });
    }
    return { meshes: out, kind };
  }

  function setPose(id) {
    if (!body || body.pose === id) return;
    const clip = body.clips[id] || body.clips.stand;
    body.mixer.stopAllAction();
    for (const b of Object.values(body.bones)) { if (b.userData.rest) { b.position.copy(b.userData.rest[0]); b.quaternion.copy(b.userData.rest[1]); b.scale.copy(b.userData.rest[2]); } else b.userData.rest = [b.position.clone(), b.quaternion.clone(), b.scale.clone()]; }
    if (clip) { const a = body.mixer.clipAction(clip); a.reset(); a.play(); body.mixer.update(0); a.paused = true; }
    for (const b of Object.values(body.bones)) b.userData.posed = b.quaternion.clone();
    body.pose = id;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Putting a design together
  // ------------------------------------------------------------------------------------------------------------
  const lin = hex => new T.Color(hex);           // ColorManagement converts sRGB hex to linear
  function worn(P) {
    const o = P.outfit && R.OUTFITS[P.outfit];
    let top = P.top, topC = P.topColor, bottom = P.bottom, botC = P.bottomColor, shoes = P.shoes, shoeC = P.shoesColor, socks = P.socks;
    if (o) [top, topC, bottom, botC, shoes, shoeC, socks] = [o[0], o[1] || topC, o[2], o[3] || botC, o[4], o[5] || shoeC, o[6]];
    if (!A[top]) top = 'top-tee';
    if (R.isDress(top)) bottom = null; else if (!A[bottom]) bottom = 'bottom-pants';
    if (!A[shoes]) shoes = 'shoes-sneakers';
    const items = [[A[P.hair] ? P.hair : 'hair-long', P.hairColor], [A[P.brows] ? P.brows : 'brows-natural', P.hairColor, 0.55],
      [top, topC], [bottom, botC], [shoes, shoeC], [A[socks] ? socks : null, '#FFFFFF']];
    if (A[P.glasses] && !P.shades) items.push([P.glasses]);
    if (SHADES.includes(P.shades)) items.push([P.shades]);
    if (A[P.earrings]) items.push([P.earrings]);
    if (P.neck === 'necklace') items.push(['jewel-pearls']);
    if (A[P.hat]) items.push([P.hat, HAT_COLOR[P.hat] || '#5C4A3A']);
    if (A[P.realHat]) items.push([P.realHat]);
    // Always worn, under everything: the avatar is never shown without clothes, whatever the design or any piece does.
    if (A['base-layer']) items.push(['base-layer']);
    return items.filter(x => x[0]);
  }
  const HAT_COLOR = { 'hat-newsboy': '#6B5444' };
  // The avatar is only ever shown dressed: a top or dress over the chest, a bottom or dress over the hips, and the base
  // layer under them. compose() checks this before it shows anything; R.dressed is also the test hook's check.
  R.dressed = P => {
    const ids = worn(P).map(x => x[0]), has = re => ids.some(id => re.test(id) && A[id]);
    return has(/^(top|dress)-/) && (has(/^dress-/) || has(/^bottom-/)) && (!A['base-layer'] || ids.includes('base-layer'));
  };
  // Everything design P is made of that is not in yet: the body, each piece she wears, and her skin and eye textures.
  // The avatar is shown only once all of it is in, so it never appears with one skin and changes to another.
  const texOf = P => [['skin', skinChoice(P).id], ['eye', eyeName(P.eyeColor)]];
  R.need = P => ['body'].concat(worn(P).map(x => x[0])).filter(id => id === 'body' ? !R.ready : !cache[id])
    .concat(texOf(P).filter(([k, n]) => !texReady[k][n]).map(([k, n]) => k + '-' + n));

  // Each skin texture stands for one colour of the palette (the colour it looks like on screen); her colour picks the
  // nearest texture, and the texture is tinted by her colour over that one, so the palette's own steps stay even.
  const SKIN_REF = { light: '#F6D2B8', medium: '#E2AC82', deep: '#6F4128' };
  function skinChoice(P) {
    const target = new T.Color(P.skin), lum = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    let best = 'light', bd = 9;
    for (const [id, hex] of Object.entries(SKIN_REF)) {
      if (!CAT.body.skins[id]) continue;
      const d = Math.abs(Math.log(lum(new T.Color(hex))) - Math.log(Math.max(1e-4, lum(target)))); if (d < bd) { bd = d; best = id; }
    }
    const ref = new T.Color(SKIN_REF[best]);
    if (P.freckles && best === 'light' && CAT.body.skins.freckles) best = 'freckles';
    const f = (a, b) => Math.min(1.6, Math.max(0.4, a / b));
    return { id: best, tint: new T.Color(f(target.r, ref.r), f(target.g, ref.g), f(target.b, ref.b)) };
  }
  const EYE_TEX = { '#5B3A1E': 'brown', '#3A2412': 'darkbrown', '#7A6A2E': 'green', '#4E8B3A': 'green', '#3F7CC2': 'blue', '#7F8C99': 'grey', '#B07A2A': 'brownlight', '#4F9A94': 'bluegreen', '#8EC5E8': 'lightblue' };
  const eyeName = c => { const n = EYE_TEX[c] || 'brown'; return CAT.body.eyes[n] ? n : Object.keys(CAT.body.eyes)[0]; };

  function morphs(P) {
    const m = {};
    const shape = { round: 'shape-round', oval: 'shape-oval', heart: 'shape-heart', square: 'shape-square' }[P.face];
    if (shape) m[shape] = 0.7;
    const tune = P.tune || {};
    for (const [k] of R.TUNE) { const v = +tune[k] || 0; if (v) m[k + (v < 0 ? '-' : '+')] = Math.min(1, Math.abs(v)); }
    if (P.gender === 'boy') m.boy = 1;
    if (P.build === 'slim') m['build-'] = 0.8; else if (P.build === 'sturdy') m['build+'] = 0.8;
    const mouth = { smile: { mouthSmileLeft: 0.45, mouthSmileRight: 0.45 }, grin: { mouthSmileLeft: 0.85, mouthSmileRight: 0.85, cheekSquintLeft: 0.3, cheekSquintRight: 0.3 },
      small: { mouthSmileLeft: 0.2, mouthSmileRight: 0.2, mouthClose: 0.15 }, open: { mouthSmileLeft: 0.7, mouthSmileRight: 0.7, jawOpen: 0.22 } }[P.mouth] || {};
    Object.assign(m, mouth);
    return m;
  }
  function applyMorphs(meshes, m) {
    for (const x of meshes) {
      const d = x.morphTargetDictionary, inf = x.morphTargetInfluences; if (!d || !inf) continue;
      inf.fill(0); for (const k in m) if (d[k] !== undefined) inf[d[k]] = m[k];
    }
  }
  function hideUnder(ids) {
    const hide = new Set(); for (const id of ids) for (const v of hidesOf(id)) hide.add(v);
    const src = body.index, vid = body.vid.array, out = [];
    for (let i = 0; i < src.length; i += 3) {
      const a = src[i], b = src[i + 1], c = src[i + 2];
      // Only where the whole triangle is covered: hiding every triangle that touches a covered vertex opens gaps at
      // collars and cuffs.
      if (hide.has(Math.round(vid[a])) && hide.has(Math.round(vid[b])) && hide.has(Math.round(vid[c]))) continue;
      out.push(a, b, c);
    }
    const g = body.mesh.geometry; g.setIndex(out); g.index.needsUpdate = true;
  }

  // Layers of clothing: where an outer piece lies over an inner one (a shirt over the waistband, shoes over socks, a dress
  // over shorts), the inner triangles it covers are not drawn, so the inner piece cannot poke through the outer one when
  // the two surfaces come close. A vertex is covered (2) when a short ray along its normal, outward or inward, meets
  // the outer piece within COVER_REACH, and near it (1) within twice that. Results are kept per pair of pieces.
  // The base layer is hidden under tops and dresses; under shorts, skirts and trousers it is only trimmed at their
  // waistband (aboveWaist), so a gap in any of them still shows it.
  const LAYER = { base: 0.5, socks: 1, bottom: 2, shoes: 3, top: 4, dress: 4 };
  const layerOf = id => LAYER[id.split('-')[0]] || 0;
  const COVER_REACH = 0.05;
  const coverCache = new Map();
  function slabs(g) {
    if (g.userData.slabs) return g.userData.slabs;
    const pos = g.attributes.position.array, idx = g.index ? g.index.array : null, n = idx ? idx.length / 3 : pos.length / 9;
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < pos.length; i += 3) { lo = Math.min(lo, pos[i]); hi = Math.max(hi, pos[i]); }
    const S = 64, step = (hi - lo) / S || 1, bins = Array.from({ length: S }, () => []);
    const vi = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k);
    for (let t = 0; t < n; t++) {
      let a = Infinity, b = -Infinity; for (let k = 0; k < 3; k++) { const y = pos[vi(t, k) * 3 + 1]; a = Math.min(a, y); b = Math.max(b, y); }
      for (let s = Math.max(0, Math.floor((a - lo) / step)); s <= Math.min(S - 1, Math.floor((b - lo) / step)); s++) bins[s].push(t);
    }
    return (g.userData.slabs = { lo, step, S, bins, pos, vi });
  }
  // Moller-Trumbore: the distance along the ray to the triangle, or Infinity.
  function hit(o, d, p, a, b, c) {
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2], e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const hx = d[1] * e2z - d[2] * e2y, hy = d[2] * e2x - d[0] * e2z, hz = d[0] * e2y - d[1] * e2x, det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-12) return Infinity;
    const f = 1 / det, sx = o[0] - p[a], sy = o[1] - p[a + 1], sz = o[2] - p[a + 2], u = f * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) return Infinity;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = f * (d[0] * qx + d[1] * qy + d[2] * qz);
    if (v < 0 || u + v > 1) return Infinity;
    const t = f * (e2x * qx + e2y * qy + e2z * qz);
    return t > 0 ? t : Infinity;
  }
  function coveredVerts(inner, outer) {
    const ig = inner.geometry, pos = ig.attributes.position.array, nor = ig.attributes.normal && ig.attributes.normal.array;
    const out = new Uint8Array(pos.length / 3); if (!nor) return out;
    const sl = slabs(outer.geometry), o = [0, 0, 0], d = [0, 0, 0];
    for (let v = 0; v < out.length; v++) {
      const y = pos[v * 3 + 1];
      const s0 = Math.floor((y - 2 * COVER_REACH - sl.lo) / sl.step), s1 = Math.floor((y + 2 * COVER_REACH - sl.lo) / sl.step);
      if (s1 < 0 || s0 >= sl.S) continue;
      d[0] = nor[v * 3]; d[1] = nor[v * 3 + 1]; d[2] = nor[v * 3 + 2];
      // Both ways along the normal: the outer piece usually lies just outside, but where the inner one pokes through it
      // lies just inside.
      const seen = new Set(), back = [-d[0], -d[1], -d[2]], ob = [pos[v * 3] + d[0] * 0.002, y + d[1] * 0.002, pos[v * 3 + 2] + d[2] * 0.002];
      o[0] = pos[v * 3] - d[0] * 0.002; o[1] = y - d[1] * 0.002; o[2] = pos[v * 3 + 2] - d[2] * 0.002;
      outer: for (let s = Math.max(0, s0); s <= Math.min(sl.S - 1, s1); s++) for (const t of sl.bins[s]) {
        if (seen.has(t)) continue; seen.add(t);
        const a = sl.vi(t, 0) * 3, b = sl.vi(t, 1) * 3, c = sl.vi(t, 2) * 3;
        const dist = Math.min(hit(o, d, sl.pos, a, b, c), hit(ob, back, sl.pos, a, b, c));
        if (dist < COVER_REACH) { out[v] = 2; break outer; }
        if (dist < 2 * COVER_REACH) out[v] = 1;
      }
    }
    return out;
  }
  // The hem of a top or dress: the lowest open edge loop that goes around her (a sleeve cuff or a collar does not, or sits
  // higher). Returned as its height at each of HEM_N directions around the body's vertical axis.
  const HEM_N = 72;
  // Points joined across texture seams, and each joined point's neighbours.
  function topology(g) {
    if (g.userData.topo) return g.userData.topo;
    const pos = g.userData.basePos || g.attributes.position.array, idx = g.userData.fullIndex || g.index.array, nv = pos.length / 3;
    const weld = new Int32Array(nv), at = new Map();
    for (let v = 0; v < nv; v++) { const k = Math.round(pos[v * 3] * 1e4) + ',' + Math.round(pos[v * 3 + 1] * 1e4) + ',' + Math.round(pos[v * 3 + 2] * 1e4); if (!at.has(k)) at.set(k, v); weld[v] = at.get(k); }
    const nbs = Array.from({ length: nv }, () => new Set());
    for (let t = 0; t < idx.length; t += 3) for (const [a, b] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) { const A = weld[a], B = weld[b]; if (A !== B) { nbs[A].add(B); nbs[B].add(A); } }
    return (g.userData.topo = { weld, nb: nbs.map(x => [...x]) });
  }
  function hemOf(g, top) {
    const slot = top ? 'waist' : 'hem';
    if (g.userData[slot] !== undefined) return g.userData[slot];
    const pos = g.attributes.position.array, idx = g.index ? (g.userData.fullIndex || g.index.array) : null;
    if (!idx) return (g.userData[slot] = null);
    let cx = 0, cz = 0; const nv = pos.length / 3; for (let v = 0; v < nv; v++) { cx += pos[v * 3]; cz += pos[v * 3 + 2]; } cx /= nv; cz /= nv;
    // Vertices split at texture seams are joined by position first, or every seam would look like an open edge.
    const { weld } = topology(g);
    const count = new Map(), key = (a, b) => (a < b ? a * nv + b : b * nv + a);
    for (let t = 0; t < idx.length; t += 3) for (const [a, b] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) { const k = key(weld[a], weld[b]); if (weld[a] !== weld[b]) count.set(k, (count.get(k) || 0) + 1); }
    const next = new Map();
    for (const [k, c] of count) if (c === 1) { const a = Math.floor(k / nv), b = k % nv; (next.get(a) || next.set(a, []).get(a)).push(b); (next.get(b) || next.set(b, []).get(b)).push(a); }
    const seen = new Set(), ang = v => Math.atan2(pos[v * 3 + 2] - cz, pos[v * 3] - cx);
    let best = null;
    for (const start of next.keys()) {
      if (seen.has(start)) continue;
      const loop = [start]; seen.add(start); let prev = -1, cur = start;
      for (;;) { const nb = (next.get(cur) || []).find(x => x !== prev && !seen.has(x)); if (nb === undefined) break; loop.push(nb); seen.add(nb); prev = cur; cur = nb; }
      if (loop.length < 8) continue;
      let wind = 0; for (let i = 0; i < loop.length; i++) { let d = ang(loop[(i + 1) % loop.length]) - ang(loop[i]); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; wind += d; }
      if (Math.abs(wind) < Math.PI) continue;                      // does not go around her: a cuff
      const y = loop.reduce((a, v) => a + pos[v * 3 + 1], 0) / loop.length;
      if (!best || (top ? y > best.y : y < best.y)) best = { y, loop };
    }
    if (!best) return (g.userData[slot] = null);
    const h = new Float32Array(HEM_N).fill(NaN);
    for (const v of best.loop) { const i = Math.floor((ang(v) + Math.PI) / (2 * Math.PI) * HEM_N) % HEM_N, y = pos[v * 3 + 1]; h[i] = isNaN(h[i]) ? y : top ? Math.min(h[i], y) : Math.max(h[i], y); }
    for (let i = 0; i < HEM_N; i++) if (isNaN(h[i])) { let a = 1; while (a < HEM_N && isNaN(h[(i + a) % HEM_N]) && isNaN(h[(i - a + HEM_N) % HEM_N])) a++; const l = h[(i - a + HEM_N) % HEM_N], r = h[(i + a) % HEM_N]; h[i] = isNaN(l) ? r : isNaN(r) ? l : Math.max(l, r); }
    return (g.userData[slot] = { h, cx, cz, top: Math.max(...Array.from({ length: nv }, (_, v) => pos[v * 3 + 1])) });
  }
  // The base layer never shows above the waistband of the shorts, skirt or trousers over it.
  function aboveWaist(inner, outer) {
    const w = hemOf(outer.geometry, true), pos = inner.geometry.attributes.position.array, out = new Uint8Array(pos.length / 3);
    if (!w) return out;
    for (let v = 0; v < out.length; v++) {
      const i = Math.floor((Math.atan2(pos[v * 3 + 2] - w.cz, pos[v * 3] - w.cx) + Math.PI) / (2 * Math.PI) * HEM_N) % HEM_N;
      if (pos[v * 3 + 1] > w.h[i] - 0.004) out[v] = 2;
    }
    return out;
  }
  // Inner vertices above the hem of a top or dress, all the way round, are inside it.
  function aboveHem(inner, outer) {
    const hem = hemOf(outer.geometry), pos = inner.geometry.attributes.position.array, out = new Uint8Array(pos.length / 3);
    if (!hem) return out;
    for (let v = 0; v < out.length; v++) {
      const y = pos[v * 3 + 1], i = Math.floor((Math.atan2(pos[v * 3 + 2] - hem.cz, pos[v * 3] - hem.cx) + Math.PI) / (2 * Math.PI) * HEM_N) % HEM_N;
      if (y > hem.h[i] + 0.012 && y < hem.top) out[v] = 2;
    }
    return out;
  }
  // A top or dress hangs over the trousers or skirt under it: near its hem, wherever the bottom lies outside it (the seat,
  // a waistband), it is moved out to just past the bottom, the way cloth drapes over cloth.
  const DRAPE_BAND = 0.15, DRAPE_REACH = 0.045, DRAPE_GAP = 0.004;
  const drapeCache = new Map();
  function drape(top, bottom) {
    const g = top.geometry, base = g.userData.basePos, nor = g.attributes.normal && g.attributes.normal.array;
    const out = base.slice(); if (!nor) return out;
    const hem = hemOf(g), lowest = hem ? Math.min(...hem.h) : -Infinity, sl = slabs(bottom.geometry), o = [0, 0, 0], d = [0, 0, 0], push = new Float32Array(base.length / 3);
    for (let v = 0; v < base.length / 3; v++) {
      const y = base[v * 3 + 1]; if (y > lowest + DRAPE_BAND) continue;
      d[0] = nor[v * 3]; d[1] = nor[v * 3 + 1]; d[2] = nor[v * 3 + 2];
      if (Math.abs(d[1]) > 0.5) continue;                     // only sideways rays: a folded hem facing down would reach the legs
      o[0] = base[v * 3] - d[0] * 0.002; o[1] = y - d[1] * 0.002; o[2] = base[v * 3 + 2] - d[2] * 0.002;
      const s0 = Math.max(0, Math.floor((y - DRAPE_REACH - sl.lo) / sl.step)), s1 = Math.min(sl.S - 1, Math.floor((y + DRAPE_REACH - sl.lo) / sl.step));
      let best = Infinity;
      for (let s = s0; s <= s1; s++) for (const t of sl.bins[s]) best = Math.min(best, hit(o, d, sl.pos, sl.vi(t, 0) * 3, sl.vi(t, 1) * 3, sl.vi(t, 2) * 3));
      if (best < DRAPE_REACH) push[v] = best - 0.002 + DRAPE_GAP;
    }
    // Neighbouring points move together: the pushes are spread and evened over the cloth, so the hem lifts as one piece
    // instead of in spikes. Points split at texture seams share one value.
    const { weld, nb } = topology(g), n = base.length / 3;
    for (let v = 0; v < n; v++) if (weld[v] !== v) push[weld[v]] = Math.max(push[weld[v]], push[v]);
    for (let it = 0; it < 6; it++) {
      const next = push.slice();
      for (let v = 0; v < n; v++) { if (weld[v] !== v || !nb[v].length) continue; let sum = 0; for (const u of nb[v]) sum += push[u]; const avg = sum / nb[v].length; next[v] = it < 2 ? Math.max(push[v], avg * 0.9) : push[v] * 0.5 + avg * 0.5; }
      push.set(next);
    }
    for (let v = 0; v < n; v++) { const p = push[weld[v]]; if (!p) continue; const w = weld[v]; out[v * 3] += nor[w * 3] * p; out[v * 3 + 1] += nor[w * 3 + 1] * p; out[v * 3 + 2] += nor[w * 3 + 2] * p; }
    return out;
  }
  function drapeClothes(worn) {
    const bottoms = worn.filter(id => /^bottom-/.test(id));
    for (const id of worn.filter(id => /^(top|dress)-/.test(id))) cache[id].meshes.forEach((m, j) => {
      const g = m.geometry, pa = g.attributes.position;
      if (!g.userData.basePos) g.userData.basePos = pa.array.slice();
      const key = id + '/' + j + '|' + bottoms.join(',');
      if (g.userData.drapeKey === key) return;
      let pos = drapeCache.get(key);
      if (!pos) { pos = g.userData.basePos.slice(); for (const b of bottoms) for (const bm of cache[b].meshes) { const d = drape(m, bm); for (let i = 0; i < pos.length; i++) if (Math.abs(d[i] - g.userData.basePos[i]) > Math.abs(pos[i] - g.userData.basePos[i])) pos[i] = d[i]; } drapeCache.set(key, pos); }
      pa.array.set(pos); pa.needsUpdate = true; g.userData.drapeKey = key; g.userData.slabs = null;
    });
  }
  function layerClothes(items) {
    const worn = items.map(([id]) => id).filter(id => layerOf(id) && cache[id]);
    drapeClothes(worn);
    for (const id of worn) {
      cache[id].meshes.forEach((m, j) => {
        const g = m.geometry; if (!g.index) return;
        if (!g.userData.fullIndex) g.userData.fullIndex = g.index.array.slice();
        const full = g.userData.fullIndex, hidden = new Uint8Array(full.length / 3);
        for (const over of worn) {
          if (layerOf(over) <= layerOf(id) || (id === 'base-layer' && layerOf(over) < 2)) continue;
          cache[over].meshes.forEach((om, k) => {
            const key = id + '/' + j + '|' + over + '/' + k + '|' + (cache[over].meshes[k].geometry.userData.drapeKey || '');
            let cov = coverCache.get(key);
            if (!cov) {
              // Under a bottom the base layer stays whole (a gap in the bottom still shows it) and is only trimmed at the waistband.
              cov = id === 'base-layer' && /^bottom-/.test(over) ? aboveWaist(m, om) : coveredVerts(m, om);
              if (/^(top|dress)-/.test(over) && /^(bottom|base)-/.test(id)) { const up = aboveHem(m, om); for (let v = 0; v < cov.length; v++) cov[v] = Math.max(cov[v], up[v]); }
              coverCache.set(key, cov);
            }
            // A triangle goes when two corners are covered (2) and the third is at least near the outer piece (1). A corner
            // past the outer piece's hem meets nothing at all (0), so the hem keeps its edge with no notches.
            for (let t = 0; t < hidden.length; t++) {
              const a = cov[full[t * 3]], b = cov[full[t * 3 + 1]], c = cov[full[t * 3 + 2]];
              if (a && b && c && (a === 2) + (b === 2) + (c === 2) >= 2) hidden[t] = 1;
            }
          });
        }
        const keep = []; for (let t = 0; t < hidden.length; t++) if (!hidden[t]) keep.push(full[t * 3], full[t * 3 + 1], full[t * 3 + 2]);
        g.setIndex(keep); g.index.needsUpdate = true;
      });
    }
  }
  R.coverCount = () => coverCache.size;

  // Some clothes come without a list of the skin they cover, so her skin can show through them where the boy shape is
  // fuller. They cover at least what a plain T-shirt or shorts cover.
  const HIDE_LIKE = { 'top-tucked-tee': 'top-tee', 'top-polo': 'top-tee', 'top-sweater': 'top-tee',
                      'bottom-cargo': 'bottom-jean-shorts', 'bottom-pants': 'bottom-jean-shorts', 'bottom-plaid-skirt': 'bottom-jean-shorts' };
  const hidesOf = id => ((A[id].hides || []).length ? A[id].hides : (A[HIDE_LIKE[id]] && A[HIDE_LIKE[id]].hides) || []);
  let lastKey = '';
  R.compose = function (group, P) {
    const missing = R.need(P);
    if (missing.length) {
      // Every missing file is asked for at once; the frame that shows her is the first one with all of them.
      const go = () => Promise.all([loadBody()].concat(worn(P).map(x => load(x[0])), texOf(P).map(([k, n]) => loadTex(k, n))));
      go().then(() => { if (R.onReady) R.onReady(); }, e => { R.failed = e.message; R.errors.push(e.stack || e.message); if (R.onReady) R.onReady(); });
      return null;
    }
    if (!R.dressed(P)) { R.errors.push('not dressed: ' + worn(P).map(x => x[0]).join(',')); return null; }
    const sk = skinChoice(P), eye = eyeName(P.eyeColor), st = texReady.skin[sk.id], et = texReady.eye[eye];
    R.texturesReady = true;
    { const bm = body.parts.body.material; if (bm.map !== st) { bm.map = st; bm.needsUpdate = true; } }
    if (body.parts.eyes) { const em = body.parts.eyes.material; if (em.map !== et) { em.map = et; if (em.emissiveMap) em.emissiveMap = et; em.needsUpdate = true; } }
    body.parts.body.material.color.copy(sk.tint);

    const holder = new T.Group(); holder.name = 'real';
    const H = { short: 0.93, medium: 1, tall: 1.06 }[P.height] || 1;
    holder.scale.setScalar(body.scale * H); holder.position.y = -body.floor * body.scale * H;
    holder.add(body.root); group.add(holder);
    setPose(P.pose);

    const items = worn(P), meshes = body.meshes.slice(), hides = [];
    for (const [id, color, k] of items) {
      const c = cache[id];
      for (const m of c.meshes) {
        body.mesh.parent.add(m); meshes.push(m);
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const x of mats) {
          if (A[id].tint && color) { x.color.copy(lin(color)).multiplyScalar(A[id].kind === 'hair' || A[id].kind === 'eyebrows' ? 1.0 : 1.2); if (k) x.color.multiplyScalar(k); } else x.color.copy(x.userData.base);
        }
      }
      if (hidesOf(id).length) hides.push(id);
    }
    const hairId = items[0][0];
    if (body.scalp && SCALP.includes(hairId)) {
      body.mesh.parent.add(body.scalp); meshes.push(body.scalp);
      body.scalp.material.color.copy(lin(P.hairColor)).multiplyScalar(0.8);
    }
    // Pieces left over from the last design come off.
    const keep = new Set(meshes);
    for (const m of body.mesh.parent.children.slice()) if (m.isSkinnedMesh && !keep.has(m)) body.mesh.parent.remove(m);
    if (body.parts.lashes) body.parts.lashes.visible = P.lashes !== false;
    const key = hides.sort().join(',');
    if (key !== lastKey) { hideUnder(hides); lastKey = key; }
    layerClothes(items);
    const m = morphs(P);
    const topId = items[2] && items[2][0];
    if (!R.isDress(topId) && topId !== 'top-tucked-tee') m.under = 1.6;    // the shirt hangs over the waistband
    applyMorphs(meshes, m);
    body.morphs = m; body.all = meshes;

    holder.updateMatrixWorld(true);
    for (const g of body.anchors || []) g.removeFromParent();
    const head = new T.Group(), torso = new T.Group(); body.anchors = [head, torso];
    for (const [g, an] of [[head, body.headAnchor], [torso, body.torsoAnchor]]) {
      if (an) { an.local.decompose(g.position, g.quaternion, g.scale); an.bone.add(g); } else holder.add(g);
    }
    holder.updateMatrixWorld(true);
    // Her left hand, for things she holds: upright in the room (whatever the pose), in the drawn head's units.
    let hand = null;
    const wrist = bone('wrist.L'), knuckle = bone('finger3-1.L');
    if (wrist) {
      hand = new T.Group(); body.anchors.push(hand);
      const p = wrist.getWorldPosition(new T.Vector3());
      if (knuckle) p.lerp(knuckle.getWorldPosition(new T.Vector3()), 0.7);
      const s = body.headR * H / 0.19 * group.getWorldScale(new T.Vector3()).x;
      const w = new T.Matrix4().compose(p, group.getWorldQuaternion(new T.Quaternion()), new T.Vector3(s, s, s));
      new T.Matrix4().copy(wrist.matrixWorld).invert().multiply(w).decompose(hand.position, hand.quaternion, hand.scale);
      wrist.add(hand);
    }
    const eyeAt = group.worldToLocal(head.getWorldPosition(new T.Vector3()));
    return { head, torso, hand, H, eyeY: eyeAt.y, headR: body.headR * H, headBone: body.bones.head };
  };

  // Idle life: blinking and a gentle head sway, called every frame by avatar.js.
  R.tick = function (t, blink) {
    if (!body || !body.all) return;
    const m = body.morphs || {};
    for (const x of body.all) {
      const d = x.morphTargetDictionary, inf = x.morphTargetInfluences; if (!d) continue;
      for (const k of ['eyeBlinkLeft', 'eyeBlinkRight']) if (d[k] !== undefined) inf[d[k]] = Math.max(m[k] || 0, blink);
    }
    const hb = body.bones.head;
    if (hb && hb.userData.posed) { hb.quaternion.copy(hb.userData.posed); hb.rotateZ(Math.sin(t * 0.7) * 0.025); hb.rotateY(Math.sin(t * 0.43) * 0.03); }
  };
  R._body = () => body; R._tex = tex;
  R.preload = () => loadBody().catch(e => { R.failed = e.message; });
})();
