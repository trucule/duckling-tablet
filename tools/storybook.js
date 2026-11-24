/* STORYBOOK START */
/* The storybook look for an app's 3D scenes: lit surfaces are shaded in a few flat steps, with soft highlights, and the
   solid things in the scene get a dark ink outline of the same width on screen whatever their size.
   tools/apply-storybook.mjs copies this file into each 3D app between the STORYBOOK markers, right after three.js and
   before the app's own code makes its renderer; edit it here and run that tool again. It changes nothing in the app's own code: the app's materials keep every value the app sets, and the
   outline is a second pass of the same scene. The toy kit apps and Story Maker have the look built in and My Avatar
   stays realistic, so they do not carry this block.
   An object is left out of the outline when its material is unlit, see-through or glowing, when it is very large for
   its distance from the camera (ground, sea, sky, walls of a room), or when it sets userData.noInk. */
(function () {
  'use strict';
  var T = window.THREE;
  if (!T || !T.WebGLRenderer || T.__storybook) return;
  T.__storybook = true;
  var INK_WIDTH = 0.0065;                               // in clip space: about 2.3 pixels at 720 lines, 4 at 1200
  var LIT = { MeshStandardMaterial: 1, MeshPhysicalMaterial: 1, MeshLambertMaterial: 1, MeshPhongMaterial: 1, MeshToonMaterial: 1 };

  // Flat steps: the direct light on a surface is rounded to thirds, and highlights are softened.
  var TOON_GLSL = '#include <lights_fragment_end>\n' +
    '{ float sbBase = max( dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) ), 1e-3 );\n' +
    '  float sbL = dot( reflectedLight.directDiffuse, vec3( 0.299, 0.587, 0.114 ) ) / sbBase;\n' +
    '  float sbS = floor( sbL * 3.0 + 0.2 ) / 3.0;\n' +
    '  reflectedLight.directDiffuse *= sbS / max( sbL, 1e-3 );\n' +
    '  reflectedLight.directSpecular *= 0.3; }\n';
  function toon(m) {
    if (!m || m.userData.sbToon || !LIT[m.type] || m.type === 'MeshToonMaterial') return;
    m.userData.sbToon = true;
    var before = m.onBeforeCompile, beforeKey = m.customProgramCacheKey;
    m.onBeforeCompile = function (sh, r) {
      if (before) before.call(this, sh, r);
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', TOON_GLSL);
    };
    m.customProgramCacheKey = function () { return 'storybook|' + (beforeKey ? beforeKey.call(this) : ''); };
    m.needsUpdate = true;
  }

  // The outline: back faces pushed out along their normals by a fixed width on screen, drawn after the scene.
  var INK = new T.MeshBasicMaterial({ color: 0x2B2140, side: T.BackSide });
  INK.onBeforeCompile = function (sh) {
    sh.vertexShader = 'attribute vec3 sbNormal;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n' +
      'vec4 sbN = projectionMatrix * vec4( normalize( normalMatrix * sbNormal ), 0.0 );\n' +
      'gl_Position.xy += normalize( sbN.xy + vec2( 1e-6 ) ) * ' + INK_WIDTH.toFixed(5) + ' * gl_Position.w;\n');
  };
  INK.customProgramCacheKey = function () { return 'storybook-ink'; };

  // The outline is pushed along normals averaged over every corner at the same place, so boxes and other hard-edged
  // shapes keep a closed outline instead of splitting at their edges. Kept on the geometry as sbNormal.
  function smoothNormals(g) {
    if (g.attributes.sbNormal) return;
    var p = g.attributes.position, n = g.attributes.normal, at = {}, sum = [], k, i;
    for (i = 0; i < p.count; i++) {
      k = Math.round(p.getX(i) * 1e4) + ',' + Math.round(p.getY(i) * 1e4) + ',' + Math.round(p.getZ(i) * 1e4);
      if (at[k] === undefined) { at[k] = sum.length; sum.push([0, 0, 0]); }
      var s = sum[at[k]]; s[0] += n.getX(i); s[1] += n.getY(i); s[2] += n.getZ(i);
    }
    var out = new Float32Array(p.count * 3);
    for (i = 0; i < p.count; i++) {
      k = Math.round(p.getX(i) * 1e4) + ',' + Math.round(p.getY(i) * 1e4) + ',' + Math.round(p.getZ(i) * 1e4);
      var v = sum[at[k]], l = Math.hypot(v[0], v[1], v[2]) || 1;
      out[i * 3] = v[0] / l; out[i * 3 + 1] = v[1] / l; out[i * 3 + 2] = v[2] / l;
    }
    g.setAttribute('sbNormal', new T.BufferAttribute(out, 3));
  }
  var sphere = new T.Sphere(), camPos = new T.Vector3();
  function inkable(o) {
    if (!o.isMesh || o.userData.noInk || !o.visible) return false;
    var m = o.material;
    if (!m || Array.isArray(m) || !LIT[m.type] || m.wireframe) return false;
    if (m.transparent && m.opacity < 0.95) return false;
    if (m.emissive && m.emissiveIntensity * Math.max(m.emissive.r, m.emissive.g, m.emissive.b) > 0.5) return false;
    var g = o.geometry; if (!g || !g.attributes || !g.attributes.normal) return false;
    if (!g.boundingSphere) g.computeBoundingSphere();
    sphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
    if (sphere.radius >= 0.45 * Math.max(1e-3, sphere.center.distanceTo(camPos))) return false;
    if (g.userData.sbCount !== g.attributes.position.count) { g.deleteAttribute('sbNormal'); smoothNormals(g); g.userData.sbCount = g.attributes.position.count; }
    return true;
  }

  // three.js r149 makes render() inside the renderer's constructor, so each new renderer gets its own wrapped copy.
  function wrap(renderer) {
    var render = renderer.render;
    renderer.render = function (scene, camera) {
      if (!scene || !scene.isScene || !camera || this.__sbInk || window.STORYBOOK_OFF) return render.call(this, scene, camera);
      scene.traverse(function (o) { if (o.isMesh && o.material && !Array.isArray(o.material)) toon(o.material); });
      render.call(this, scene, camera);
      // Second pass: only the outlined things, over what is already drawn, without touching shadows or the background.
      scene.updateMatrixWorld(); camera.updateMatrixWorld(); camPos.setFromMatrixPosition(camera.matrixWorld);
      var hidden = [];
      scene.traverse(function (o) {
        if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o.visible && !inkable(o)) { o.visible = false; hidden.push(o); }
      });
      var autoClear = this.autoClear, bg = scene.background, over = scene.overrideMaterial, fog = scene.fog, shadows = this.shadowMap.autoUpdate;
      this.autoClear = false; scene.background = null; scene.overrideMaterial = INK; scene.fog = null; this.shadowMap.autoUpdate = false; this.__sbInk = true;
      try { render.call(this, scene, camera); } finally {
        this.__sbInk = false; this.autoClear = autoClear; scene.background = bg; scene.overrideMaterial = over; scene.fog = fog; this.shadowMap.autoUpdate = shadows;
        for (var i = 0; i < hidden.length; i++) hidden[i].visible = true;
      }
    };
  }
  var Base = T.WebGLRenderer;
  var Storybook = class extends Base { constructor(p) { super(p); wrap(this); } };
  T.WebGLRenderer = Storybook;
})();
/* STORYBOOK END */
