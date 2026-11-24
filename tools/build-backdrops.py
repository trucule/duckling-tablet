#!/usr/bin/env python3
"""Builds the photo backdrops in backdrops/ from Poly Haven's CC0 HDRIs (the 4K .hdr files, polyhaven.com) and from
the made-up places, which are 360-degree pictures generated for Duckling (<id>.jpg or <id>.png, listed in MADE).

    python tools/build-backdrops.py <folder with the files>     (needs opencv-python-headless and numpy)

Only the files in the folder are built; the other entries in backdrops.json stay. For each one it writes <id>.jpg (the 360-degree photo, 4096x2048, tone-mapped), <id>-light.png (its lighting at
512x256: two square-root images stacked, the top at full brightness and the bottom at 1/16) and an entry in
backdrops.json with where it came from, the sun's direction, colour and strength and the average sky and ground colours. The apps keep
their drawn backdrops and download these on first use (backend/src/routes/backdrops.ts).
"""
import cv2, numpy as np, sys, os, json
src = sys.argv[1]; out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'backdrops'); os.makedirs(out, exist_ok=True)
def aces(x):
    a,b,c,d,e = 2.51,0.03,2.43,0.59,0.14
    return np.clip((x*(a*x+b))/(x*(c*x+d)+e),0,1)
meta = {}
old = os.path.join(out, 'backdrops.json')
if os.path.exists(old): meta = json.load(open(old))['backdrops']
# A night photo's exposure comes from its sky (median brightness of the top 40%), or the ground rule makes it day.
DARK = {'qwantani_night': 0.06}
POLY = 'Poly Haven (polyhaven.com), CC0'
KEEP = {'meadow_2','epping_forest_01','fish_hoek_beach','blouberg_sunrise_1','fouriesburg_mountain_midday','bloem_train_track_clear','air_museum_playground','ballawley_park','lythwood_room','monkstown_castle','farm_field',
        'qwantani_night','goegap','rainforest_trail','potsdamer_platz','kiara_8_sunset','art_studio','hotel_room','kloofendal_overcast'}
# The made-up places: 360-degree pictures generated for Duckling with Google Gemini from the prompts in
# docs/backdrops.md. They are ordinary 8-bit pictures, so the sun is given here: where it is in the picture (x and y
# as fractions of the width and height; find: look for the brightest spot near there), how strong it is and its colour.
# A sun the picture does not show (overhead, behind the camera, a stage's lights) is placed where the light comes from:
# the stage's lights are over the seats, in front of whoever stands on it.
MADE = {
    'under_the_sea':  dict(x=0.50, y=0.08, find=True,  strength=60,  color=[0.85, 1.0, 1.0]),
    'rainbow_hill':   dict(x=0.27, y=0.40, find=False, strength=120, color=[1.0, 0.95, 0.85]),
    'candy_land':     dict(x=0.15, y=0.22, find=False, strength=90,  color=[1.0, 0.95, 0.9]),
    'cupcake_town':   dict(x=0.82, y=0.17, find=True,  strength=140, color=[1.0, 0.93, 0.8]),
    'cloud_kingdom':  dict(x=0.79, y=0.45, find=True,  strength=150, color=[1.0, 0.82, 0.6]),
    'ice_palace':     dict(x=0.31, y=0.47, find=True,  strength=120, color=[1.0, 0.95, 0.88]),
    'volcano_island': dict(x=0.60, y=0.15, find=False, strength=150, color=[1.0, 0.95, 0.85]),
    'big_stage':      dict(x=0.00, y=0.15, find=False, strength=90,  color=[1.0, 0.82, 0.6]),
    'outer_space':    dict(x=0.78, y=0.29, find=True,  strength=200, color=[1.0, 1.0, 1.0]),
    'moon_surface':   dict(x=0.00, y=0.33, find=True,  strength=200, color=[1.0, 1.0, 1.0]),
    'snowy_meadow':   dict(x=0.50, y=0.25, find=False, strength=8,   color=[1.0, 1.0, 1.0]),
    'snowy_mountain': dict(x=0.01, y=0.03, find=True,  strength=160, color=[1.0, 0.97, 0.9]),
}
MADE_SOURCE = 'Generated for Duckling Tablet with Google Gemini'
def build_made():
    for pid, o in MADE.items():
        f = next((os.path.join(src, pid + e) for e in ('.jpg', '.png') if os.path.exists(os.path.join(src, pid + e))), None)
        if not f: continue
        img = cv2.imread(f, cv2.IMREAD_COLOR)[:, :, ::-1]
        img = cv2.resize(img, (4096, 2048), interpolation=cv2.INTER_CUBIC).astype(np.float32)
        h, w = img.shape[:2]
        # Join the left and right edges: each edge column takes in more of the column across the join.
        b = 64
        for k in range(b):
            a = 0.5 * (1 - k / b) ** 2
            l, r = img[:, k].copy(), img[:, w - 1 - k].copy()
            img[:, k] = (1 - a) * l + a * r; img[:, w - 1 - k] = (1 - a) * r + a * l
        # Straight up and straight down are one point: blend the top and bottom rows into their average colour.
        for y0, y1, step in ((0, int(h * 0.06), 1), (h - 1, h - 1 - int(h * 0.04), -1)):
            n = abs(y1 - y0)
            for i, y in enumerate(range(y0, y1, step)):
                a = (1 - i / n) ** 2
                img[y] = (1 - a) * img[y] + a * img[y].mean(0)
        img = np.clip(img, 0, 255)
        cv2.imwrite(f'{out}/{pid}.jpg', img.astype(np.uint8)[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 84, cv2.IMWRITE_JPEG_PROGRESSIVE, 1])
        lin = (img / 255) ** 2.2
        sx, sy = o['x'] * w, o['y'] * h
        if o['find']:
            lum = lin @ np.array([0.2126, 0.7152, 0.0722], np.float32)
            rx, ry = int(w * 0.06), int(h * 0.08)
            xs_ = np.arange(int(sx) - rx, int(sx) + rx) % w; ys_ = np.clip(np.arange(int(sy) - ry, int(sy) + ry), 0, h - 1)
            win = lum[np.ix_(ys_, xs_)]; t = np.quantile(win, 0.995); yy, xx = np.nonzero(win >= t)
            ang = (xs_[xx] / w) * 2 * np.pi
            sx = (np.arctan2(np.sin(ang).mean(), np.cos(ang).mean()) % (2 * np.pi)) / (2 * np.pi) * w; sy = ys_[yy].mean()
        az = (sx / w) * 2 * np.pi - np.pi; el = np.pi / 2 - (sy / h) * np.pi
        small = cv2.resize(lin, (512, 256), interpolation=cv2.INTER_AREA)
        # The pictures stop at white, so the sun is added to the lighting as a small bright disc.
        gx, gy = np.meshgrid(np.arange(512), np.arange(256))
        dx = np.minimum(np.abs(gx - sx / 8), 512 - np.abs(gx - sx / 8)); d2 = dx ** 2 + (gy - sy / 8) ** 2
        small = small + np.exp(-d2 / (2 * 1.6 ** 2))[:, :, None] * min(16, 0.1 * o['strength']) * np.array(o['color'], np.float32)
        top = np.sqrt(np.clip(small, 0, 1)); bot = np.sqrt(np.clip(small / 16, 0, 1))
        cv2.imwrite(f'{out}/{pid}-light.png', (np.concatenate([top, bot], axis=0) * 255 + 0.5).astype(np.uint8)[:, :, ::-1])
        sky = small[:96].reshape(-1, 3).mean(0); gnd = small[160:].reshape(-1, 3).mean(0)
        c = lambda v: [round(float(x), 3) for x in np.clip(v, 0, 1) ** (1 / 2.2)]
        meta[pid] = {'source': MADE_SOURCE, 'skyColor': c(np.minimum(sky, 1)), 'groundColor': c(gnd), 'sunAz': round(float(az), 4), 'sunEl': round(float(el), 4),
                     'sunColor': o['color'], 'sunStrength': o['strength'], 'exposure': 1}
        print(pid, meta[pid], os.path.getsize(f'{out}/{pid}.jpg') // 1024, 'KB')

for f in sorted(os.listdir(src)):
    if not f.endswith('_4k.hdr'): continue
    pid = f[:-7]
    if pid not in KEEP: continue
    hdr = cv2.imread(os.path.join(src, f), cv2.IMREAD_UNCHANGED)[:, :, ::-1].astype(np.float32)  # RGB
    h, w = hdr.shape[:2]
    lum = hdr @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    # exposure: put the median of the lower 60% (scene, not sky) around 0.18
    med = np.median(lum[int(h*0.4):, :]); expo = 0.22 / max(med, 1e-4)
    if pid in DARK: expo = DARK[pid] / max(np.median(lum[:int(h*0.4), :]), 1e-6)   # a night stays dark: set by its sky
    ldr = aces(hdr * expo) ** (1/2.2)
    img = (ldr * 255 + 0.5).astype(np.uint8)
    cv2.imwrite(f'{out}/{pid}.jpg', cv2.resize(img, (4096, 2048), interpolation=cv2.INTER_AREA)[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 84, cv2.IMWRITE_JPEG_PROGRESSIVE, 1])
    pass  # cv2.imwrite(f'{out}/{pid}-preview.jpg', cv2.resize(img, (1600, 800), interpolation=cv2.INTER_AREA)[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 80])
    # the sun: centroid of the brightest 0.02% of pixels
    t = np.quantile(lum, 0.9998); ys, xs = np.nonzero(lum >= t)
    wts = lum[ys, xs]; sx, sy = (xs*wts).sum()/wts.sum(), (ys*wts).sum()/wts.sum()
    az = (sx / w) * 2*np.pi - np.pi; el = np.pi/2 - (sy / h) * np.pi
    sun_ratio = float(lum[ys, xs].mean() / max(np.mean(lum), 1e-4))
    if pid in DARK: sun_ratio = min(sun_ratio, 6.0)   # town glow on the horizon, not a sun
    col = (hdr[ys, xs] * wts[:, None]).sum(0) / wts.sum(); col = col / max(col.max(), 1e-6)
    # Lighting: 512x256 at the photo's exposure, as two 8-bit square-root images stacked (no alpha, so browsers keep the
    # values): the top at full brightness, the bottom at 1/16 for the sun and bright sky that the top clips.
    small = cv2.resize(hdr * expo, (512, 256), interpolation=cv2.INTER_AREA)
    top = np.sqrt(np.clip(small, 0, 1)); bot = np.sqrt(np.clip(small / 16, 0, 1))
    both = (np.concatenate([top, bot], axis=0) * 255 + 0.5).astype(np.uint8)
    cv2.imwrite(f'{out}/{pid}-light.png', both[:, :, ::-1])
    sky = small[:96].reshape(-1, 3).mean(0); gnd = small[160:].reshape(-1, 3).mean(0)
    tm = lambda c: [round(float(x), 3) for x in (aces(c) ** (1/2.2))]
    meta[pid] = {'source': POLY, 'skyColor': tm(sky), 'groundColor': tm(gnd), 'sunAz': round(float(az), 4), 'sunEl': round(float(el), 4), 'sunColor': [round(float(c), 3) for c in col], 'sunStrength': round(min(sun_ratio, 200), 1), 'exposure': round(float(expo), 5)}
    print(pid, meta[pid], os.path.getsize(f'{out}/{pid}.jpg') // 1024, 'KB', os.path.getsize(f'{out}/{pid}-light.png') // 1024, 'KB')
build_made()
# Photos taken indoors: how far the walls are from the camera, in camera heights (backdrops.js lays the photo on a
# dome that size instead of a wide one).
ROOM = {'hotel_room': 1.6, 'art_studio': 2.2, 'lythwood_room': 1.6, 'big_stage': 4}
for v in meta.values(): v.setdefault('source', POLY)
for k, v in ROOM.items():
    if k in meta: meta[k]['room'] = v
json.dump({'backdrops': dict(sorted(meta.items()))}, open(f'{out}/backdrops.json', 'w'), indent=1)
