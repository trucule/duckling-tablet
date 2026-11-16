#!/usr/bin/env python3
"""Builds Paint Studio's font library in fonts/ from Fontsource's packages of Google Fonts on npm.

    python3 tools/font-library.py            pick, download, write fonts/files, fonts/LICENSES.txt, fonts/picked.json
    node tools/font-sheets.mjs               then: preview sheets and fonts/library.json (needs Chromium/Playwright)

The pick: every family with Latin letters and a regular (400, upright) style, except icon, barcode, placeholder and
script-specific fonts and the nine fonts built into Paint Studio. All handwriting and display families, then the most
downloaded serif, sans-serif and monospace families (npm monthly downloads from npm search). Each font is the
package's latin-400-normal.woff2, and its LICENSE file is checked: SIL Open Font License, Apache 2.0 or the Ubuntu
Font Licence, all of which allow bundling and serving the fonts.
"""
import concurrent.futures as cf
import io
import json
import os
import re
import sys
import tarfile
import urllib.parse
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'fonts')
BUILTIN = {'fredoka', 'comic-neue', 'patrick-hand', 'pacifico', 'bungee', 'press-start-2p', 'special-elite',
           'creepster', 'permanent-marker'}
SKIP = re.compile(r'barcode|redacted|blokk|flow |wavefont|linefont|material|emoji|\bicons?\b|symbols|adobe blank|'
                  r'noto (sans|serif|rashi|music|znamenny)|\b(jp|kr|sc|tc|hk)$|playwrite|libertinus math', re.I)
TAKE = {'handwriting': 10**6, 'display': 10**6, 'monospace': 25, 'serif': 150, 'sans-serif': 200}
# Children read these names; the groups are what the picker shows.
GROUPS = {'handwriting': 'Handwriting', 'display': 'Fun', 'serif': 'Book', 'sans-serif': 'Plain', 'monospace': 'Typewriter'}


def get(url, timeout=120):
    return urllib.request.urlopen(url, timeout=timeout).read()


def tarball(name):
    latest = json.loads(get(f'https://registry.npmjs.org/{name}/latest', 60))
    return tarfile.open(fileobj=io.BytesIO(get(latest['dist']['tarball'])), mode='r:gz')


def metadata():
    with tarball('google-font-metadata') as t:
        read = lambda n: json.load(t.extractfile(f'package/data/{n}'))
        return read('google-fonts-v2.json')


def downloads():
    seen = {}
    for q in ('keywords:fontsource', 'fontsource'):
        frm = 0
        while frm < 5000:
            u = 'https://registry.npmjs.org/-/v1/search?' + urllib.parse.urlencode({'text': q, 'size': 250, 'from': frm})
            objs = json.loads(get(u, 60)).get('objects', [])
            if not objs:
                break
            for o in objs:
                n = o['package']['name']
                if n.startswith('@fontsource/'):
                    seen[n] = max(seen.get(n, 0), o.get('downloads', {}).get('monthly', 0))
            frm += len(objs)
    return seen


def license_kind(text):
    if 'Open Font License' in text:
        return 'OFL-1.1'
    if 'Apache License' in text:
        return 'Apache-2.0'
    if 'UBUNTU FONT LICENCE' in text.upper():
        return 'UFL-1.0'
    return None


def fetch(r):
    fid = r['id']
    with tarball('@fontsource/' + fid) as t:
        font = t.extractfile(f'package/files/{fid}-latin-400-normal.woff2').read()
        lic = t.extractfile('package/LICENSE').read().decode('utf-8', 'replace')
    kind = license_kind(lic)
    if not kind:
        raise ValueError(f'{fid}: license not recognized')
    # The copyright lines above the license text name the authors; the license texts are written once at the end.
    head = lic.split('This Font Software is licensed under')[0].strip() if kind == 'OFL-1.1' else lic.strip().splitlines()[0]
    return fid, font, kind, head, lic


def main():
    meta, dl = metadata(), downloads()
    rows = []
    for fid, m in meta.items():
        if fid in BUILTIN or 'latin' not in m['subsets'] or 400 not in m['weights'] or 'normal' not in m['styles']:
            continue
        if SKIP.search(m['family']):
            continue
        rows.append({'id': fid, 'name': m['family'], 'cat': m['category'], 'dl': dl.get('@fontsource/' + fid, 0)})
    by = {}
    for r in sorted(rows, key=lambda r: -r['dl']):
        by.setdefault(r['cat'], []).append(r)
    pick = [r for cat, lst in by.items() for r in lst[:TAKE.get(cat, 0)]]
    os.makedirs(os.path.join(OUT, 'files'), exist_ok=True)
    texts, picked, notes = {}, [], []
    with cf.ThreadPoolExecutor(24) as ex:
        for r, res in zip(pick, ex.map(lambda r: _safe(fetch, r), pick)):
            if isinstance(res, Exception):
                print('skipped', r['id'], res, file=sys.stderr)
                continue
            fid, font, kind, head, lic = res
            with open(os.path.join(OUT, 'files', fid + '.woff2'), 'wb') as f:
                f.write(font)
            texts.setdefault(kind, lic)
            notes.append(f'{r["name"]} ({fid}.woff2), {kind}\n{head}\n')
            picked.append({'id': fid, 'name': r['name'], 'group': GROUPS[r['cat']], 'size': len(font), 'downloads': r['dl']})
    with open(os.path.join(OUT, 'LICENSES.txt'), 'w', encoding='utf-8') as f:
        f.write('Fonts in files/: the latin-400-normal.woff2 file of each family from Fontsource (fontsource.org), which\n'
                'packages Google Fonts. Each is under the license named with it; the license texts follow the list.\n\n')
        f.write('\n'.join(sorted(notes, key=str.lower)))
        for kind, text in sorted(texts.items()):
            f.write(f'\n\n==== {kind} ====\n{text}')
    with open(os.path.join(OUT, 'picked.json'), 'w') as f:
        json.dump(picked, f, indent=0)
    print(len(picked), 'fonts,', sum(p['size'] for p in picked) // 1000, 'KB')


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception as e:  # noqa: BLE001 - a font that fails is reported and left out
        return e


if __name__ == '__main__':
    main()
