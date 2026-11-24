#!/usr/bin/env python3
"""Builds the photo backdrops in backdrops/ from Poly Haven's CC0 HDRIs (the 4K .hdr files, polyhaven.com).

    python tools/build-backdrops.py <folder with the *_4k.hdr files>     (needs opencv-python-headless and numpy)

For each HDRI it writes <id>.jpg (the 360-degree photo, 4096x2048, tone-mapped), <id>-light.png (its lighting at
512x256: two square-root images stacked, the top at full brightness and the bottom at 1/16) and an entry in
backdrops.json with the sun's direction, colour and strength and the average sky and ground colours. The apps keep
their drawn backdrops and download these on first use (backend/src/routes/backdrops.ts).
"""
import cv2, numpy as np, sys, os, json
src = sys.argv[1]; out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'backdrops'); os.makedirs(out, exist_ok=True)
def aces(x):
    a,b,c,d,e = 2.51,0.03,2.43,0.59,0.14
    return np.clip((x*(a*x+b))/(x*(c*x+d)+e),0,1)
meta = {}
KEEP = {'meadow_2','epping_forest_01','fish_hoek_beach','blouberg_sunrise_1','fouriesburg_mountain_midday','bloem_train_track_clear','air_museum_playground','ballawley_park','lythwood_room','monkstown_castle','farm_field'}
for f in sorted(os.listdir(src)):
    if not f.endswith('_4k.hdr'): continue
    pid = f[:-7]
    if pid not in KEEP: continue
    hdr = cv2.imread(os.path.join(src, f), cv2.IMREAD_UNCHANGED)[:, :, ::-1].astype(np.float32)  # RGB
    h, w = hdr.shape[:2]
    lum = hdr @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    # exposure: put the median of the lower 60% (scene, not sky) around 0.18
    med = np.median(lum[int(h*0.4):, :]); expo = 0.22 / max(med, 1e-4)
    ldr = aces(hdr * expo) ** (1/2.2)
    img = (ldr * 255 + 0.5).astype(np.uint8)
    cv2.imwrite(f'{out}/{pid}.jpg', cv2.resize(img, (4096, 2048), interpolation=cv2.INTER_AREA)[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 84, cv2.IMWRITE_JPEG_PROGRESSIVE, 1])
    pass  # cv2.imwrite(f'{out}/{pid}-preview.jpg', cv2.resize(img, (1600, 800), interpolation=cv2.INTER_AREA)[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 80])
    # the sun: centroid of the brightest 0.02% of pixels
    t = np.quantile(lum, 0.9998); ys, xs = np.nonzero(lum >= t)
    wts = lum[ys, xs]; sx, sy = (xs*wts).sum()/wts.sum(), (ys*wts).sum()/wts.sum()
    az = (sx / w) * 2*np.pi - np.pi; el = np.pi/2 - (sy / h) * np.pi
    sun_ratio = float(lum[ys, xs].mean() / max(np.mean(lum), 1e-4))
    col = (hdr[ys, xs] * wts[:, None]).sum(0) / wts.sum(); col = col / max(col.max(), 1e-6)
    # Lighting: 512x256 at the photo's exposure, as two 8-bit square-root images stacked (no alpha, so browsers keep the
    # values): the top at full brightness, the bottom at 1/16 for the sun and bright sky that the top clips.
    small = cv2.resize(hdr * expo, (512, 256), interpolation=cv2.INTER_AREA)
    top = np.sqrt(np.clip(small, 0, 1)); bot = np.sqrt(np.clip(small / 16, 0, 1))
    both = (np.concatenate([top, bot], axis=0) * 255 + 0.5).astype(np.uint8)
    cv2.imwrite(f'{out}/{pid}-light.png', both[:, :, ::-1])
    sky = small[:96].reshape(-1, 3).mean(0); gnd = small[160:].reshape(-1, 3).mean(0)
    tm = lambda c: [round(float(x), 3) for x in (aces(c) ** (1/2.2))]
    meta[pid] = {'skyColor': tm(sky), 'groundColor': tm(gnd), 'sunAz': round(float(az), 4), 'sunEl': round(float(el), 4), 'sunColor': [round(float(c), 3) for c in col], 'sunStrength': round(min(sun_ratio, 200), 1), 'exposure': round(float(expo), 5)}
    print(pid, meta[pid], os.path.getsize(f'{out}/{pid}.jpg') // 1024, 'KB', os.path.getsize(f'{out}/{pid}-light.png') // 1024, 'KB')
json.dump({'source': 'Poly Haven (polyhaven.com), CC0', 'backdrops': meta}, open(f'{out}/backdrops.json', 'w'), indent=1)
