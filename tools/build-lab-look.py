#!/usr/bin/env python3
"""Builds the pictures Kitchen Lab and Chemistry Lab use for their look (tools/lab-look.js) from three Poly Haven
CC0 downloads (polyhaven.com), and writes them into each app's look/ folder:

    studio_small_08_4k.exr          the room the glass, steel and liquids reflect      -> env.png
    oak_veneer_01_4k.blend.zip      the kitchen's worktop and shelves                  -> oak.jpg, oak-n.jpg, oak-r.jpg
    tiled_floor_001_4k.blend.zip    the relief and gloss of the wall tiles             -> tile-n.jpg, tile-r.jpg
    chemistry_set_4k.blend.zip      the glassware on the chemistry lab's bench         -> set.glb   (when the file is there)

    python tools/build-lab-look.py <folder with the files>     (needs opencv-python-headless, numpy, OpenEXR; set.glb
                                                                 also needs bpy, Blender as a Python module: pip install bpy)

env.png is the 360-degree room at 512x256, as two square-root images stacked: the top at full brightness and the
bottom at 1/64, so the lamps keep their strength (the same idea as the backdrops' -light.png). The oak is the scan's
colour, normals and roughness at 1024, 1024 and 512. The wall tiles keep the colour the game draws; from the scan come
the normals (the uneven glaze and the edges of each tile) and a roughness picture made for glazed tiles: the scan's own
variation around a glossy value, with matt grout where the scan's surface is lowest. The scan has five tiles a side;
four are cut out, starting on a grout line, to match the four tiles a side the game draws.
set.glb holds the pieces of the chemistry set that tools/lab-look.js stands on the bench (SET below), without normal
maps and with the model's pictures at 512 and 256, since each piece is small on screen.
Kitchen Lab gets the six pictures, Chemistry Lab the room, the tiles and the set (its bench is plain and its shelves
are steel).
"""
import os, sys, zipfile, tempfile
import numpy as np, cv2, OpenEXR

src = sys.argv[1]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPS = {'kitchen-lab': ['env.png', 'oak.jpg', 'oak-n.jpg', 'oak-r.jpg', 'tile-n.jpg', 'tile-r.jpg'], 'chemistry-lab': ['env.png', 'tile-n.jpg', 'tile-r.jpg', 'set.glb']}
# The pieces of the chemistry set that go into set.glb (each is chemistry_set_<name> in the model).
SET = ['clamp_stand', 'clamp', 'test_tube_stand_a', 'test_tube_a', 'test_tube_content_a', 'test_tube_content_d', 'bottle_clear_a', 'bottle_clear_lid', 'bottle_clear_b', 'bottle_clear_b_cork',
       'bottle_clear_c', 'bottle_clear_c_lid', 'bottle_clear_d', 'bottle_clear_d_cork', 'bottle_clear_e', 'bottle_clear_e_dropper', 'bottle_content_a', 'bottle_content_d',
       'bottle_dark_b', 'bottle_dark_b_cork', 'bottle_dark_c', 'bottle_dark_c_lid', 'bottle_dark_e', 'bottle_dark_e_dropper', 'bunsen_burner', 'beaker_small', 'beaker_med', 'beaker_large']

def chemistry_set(zip_path):
    import bpy
    tmp = tempfile.mkdtemp()
    with zipfile.ZipFile(zip_path) as z:
        for i in z.infolist():
            if i.is_dir() or '..' in i.filename or i.filename.startswith('/'): continue
            p = os.path.join(tmp, i.filename); os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'wb') as f: f.write(z.read(i))
    blend = [f for f in os.listdir(tmp) if f.endswith('.blend')][0]
    bpy.ops.wm.open_mainfile(filepath=os.path.join(tmp, blend), use_scripts=False)
    keep = set('chemistry_set_' + k for k in SET)
    for o in list(bpy.data.objects):
        if o.name not in keep: bpy.data.objects.remove(o, do_unlink=True)
    missing = keep - set(o.name for o in bpy.data.objects)
    if missing: raise SystemExit('not in the chemistry set: ' + ', '.join(sorted(missing)))
    for m in bpy.data.materials:
        if not m.node_tree: continue
        for l in list(m.node_tree.links):
            if l.to_socket.name == 'Normal' and l.to_node.type == 'BSDF_PRINCIPLED': m.node_tree.links.remove(l)
    for im in bpy.data.images:
        n = 512 if ('diff' in im.name or 'alpha' in im.name) else 256
        if im.size[0] > n: im.scale(n, n)
    out = os.path.join(tmp, 'set.glb')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_image_format='AUTO', export_jpeg_quality=82, export_apply=True, export_yup=True, export_cameras=False, export_lights=False)
    with open(out, 'rb') as f: return f.read()

def exr(path):
    with OpenEXR.File(path) as f:
        ch = f.channels()
        for k in ('RGB', 'RGBA'):
            if k in ch: return np.asarray(ch[k].pixels, dtype=np.float32)[..., :3]
        if all(k in ch for k in 'RGB'): return np.stack([np.asarray(ch[k].pixels, dtype=np.float32) for k in 'RGB'], -1)
        return np.asarray(ch[list(ch.keys())[0]].pixels, dtype=np.float32)

def textures(name):
    """The pictures inside a Poly Haven .blend.zip, by their last name part (diff, nor_gl, rough, ...)."""
    out, tmp = {}, tempfile.mkdtemp()
    with zipfile.ZipFile(os.path.join(src, name)) as z:
        for i in z.infolist():
            b = os.path.basename(i.filename)
            if not i.filename.startswith('textures/') or not b or i.is_dir(): continue
            p = os.path.join(tmp, b)
            with open(p, 'wb') as f: f.write(z.read(i))
            out[b] = p
    return out

def find(files, part):
    for b, p in files.items():
        if part in b: return p
    raise SystemExit('no ' + part + ' picture in the download')

def read(p, grey=False):
    if p.endswith('.exr'):
        a = exr(p)
        return a[..., 0] if grey and a.ndim == 3 else a
    a = cv2.imread(p, cv2.IMREAD_UNCHANGED).astype(np.float32)
    a /= 65535.0 if a.max() > 255 else 255.0
    if a.ndim == 3: a = a[..., ::-1]
    return a[..., 0] if grey and a.ndim == 3 else a

small = lambda a, n: cv2.resize(a, (n, n), interpolation=cv2.INTER_AREA)
def jpg(a, q): return cv2.imencode('.jpg', (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)[..., ::-1] if a.ndim == 3 else (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, q])[1].tobytes()

made = {}

# The room.
e = cv2.resize(exr(os.path.join(src, 'studio_small_08_4k.exr')), (512, 256), interpolation=cv2.INTER_AREA)
top, bottom = np.sqrt(np.clip(e, 0, 1)), np.sqrt(np.clip(e / 64.0, 0, 1))
made['env.png'] = cv2.imencode('.png', (np.vstack([top, bottom]) * 255 + 0.5).astype(np.uint8)[..., ::-1], [cv2.IMWRITE_PNG_COMPRESSION, 9])[1].tobytes()

# The oak.
oak = textures('oak_veneer_01_4k.blend.zip')
made['oak.jpg'] = jpg(small(read(find(oak, '_diff_')), 1024), 86)
made['oak-n.jpg'] = jpg(small(read(find(oak, '_nor_gl_')), 1024), 90)
made['oak-r.jpg'] = jpg(small(read(find(oak, '_rough_'), True), 512), 88)

# The wall tiles: four of the scan's five tiles a side, from one grout line to another.
tile = textures('tiled_floor_001_4k.blend.zip')
disp = read(find(tile, '_disp'), True)
def grout(axis):
    p = disp.mean(axis=axis); n = len(p); period = n / 5.0
    # The offset whose five evenly spaced lines lie lowest.
    best = min(range(int(period)), key=lambda o: sum(p[int(o + k * period) % n] for k in range(5)))
    return best, period
(x0, px), (y0, py) = grout(0), grout(1)
def cut(a):
    n = a.shape[0]; xs = (np.arange(int(round(4 * px))) + x0) % n; ys = (np.arange(int(round(4 * py))) + y0) % n
    return a[np.ix_(ys, xs)]
made['tile-n.jpg'] = jpg(small(cut(read(find(tile, '_nor_gl_'))), 1024), 90)
r, d = small(cut(read(find(tile, '_rough_'), True)), 512), small(cut(disp), 512)
lines = np.clip((np.percentile(d, 12) - d) / (np.percentile(d, 12) - np.percentile(d, 1) + 1e-6), 0, 1)   # 1 in the grout
glaze = 0.2 + (r - np.median(r)) * 0.35                                                                      # glossy, with the scan's variation
made['tile-r.jpg'] = jpg(np.clip(glaze, 0.08, 0.45) * (1 - lines) + 0.85 * lines, 88)

# The chemistry set, when its download is in the folder; without it the set.glb already in the app stays.
cs = os.path.join(src, 'chemistry_set_4k.blend.zip')
if os.path.exists(cs): made['set.glb'] = chemistry_set(cs)

for app, names in APPS.items():
    out = os.path.join(root, 'apps', app, 'look'); os.makedirs(out, exist_ok=True)
    for n in names:
        if n not in made: continue
        with open(os.path.join(out, n), 'wb') as f: f.write(made[n])
        print(app, n, len(made[n]) // 1024, 'KB')
print('tile grid: starts at', x0, y0, 'period', round(px, 1), round(py, 1))
