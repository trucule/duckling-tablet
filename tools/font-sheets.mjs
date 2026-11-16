// Preview sheets and the list for Paint Studio's font library (fonts/), after tools/font-library.py. Each font's name
// is drawn in that font in a 320 by 64 cell, 4 cells across and up to 100 to a sheet, a group's fonts on its own
// sheets, so the picker shows every font while downloading only the sheets of the group a child opens. A font that
// fails to load or draws no letters is left out of the list. Writes fonts/sheets/*.webp and fonts/library.json.
//
//   node tools/font-sheets.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '../backend/node_modules/playwright/index.mjs';

const ROOT = join(import.meta.dirname, '..'), OUT = join(ROOT, 'fonts');
const CELL = { w: 320, h: 64, cols: 4, per: 100 };
const ORDER = ['Handwriting', 'Fun', 'Book', 'Plain', 'Typewriter'];
const picked = JSON.parse(readFileSync(join(OUT, 'picked.json'), 'utf8'));
rmSync(join(OUT, 'sheets'), { recursive: true, force: true }); mkdirSync(join(OUT, 'sheets'), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');
const fonts = [], dropped = [];
for (const group of ORDER) {
  const inGroup = picked.filter((f) => f.group === group).sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name));
  for (let s = 0; s * CELL.per < inGroup.length; s++) {
    const batch = inGroup.slice(s * CELL.per, (s + 1) * CELL.per);
    const data = batch.map((f) => ({ id: f.id, name: f.name, b64: readFileSync(join(OUT, 'files', f.id + '.woff2')).toString('base64') }));
    const res = await page.evaluate(async ({ data, CELL }) => {
      const ok = [], bad = [];
      for (const f of data) {
        try {
          const bytes = Uint8Array.from(atob(f.b64), (ch) => ch.charCodeAt(0));
          const face = new FontFace('L' + f.id, bytes.buffer); await face.load(); document.fonts.add(face);
          // A font that draws the same as the fallback for its own name has no letters of its own.
          const g = document.createElement('canvas').getContext('2d');
          g.font = '40px "L' + f.id + '", serif'; const a = g.measureText(f.name + 'Aa').width;
          g.font = '40px serif'; const b = g.measureText(f.name + 'Aa').width;
          g.font = '40px "L' + f.id + '", monospace'; const c2 = g.measureText(f.name + 'Aa').width;
          if (Math.abs(a - c2) > 0.5 && Math.abs(a - b) < 0.5) { bad.push([f.id, 'no letters']); continue; }
          ok.push(f);
        } catch (e) { bad.push([f.id, String(e).slice(0, 60)]); }
      }
      const rows = Math.ceil(ok.length / CELL.cols), c = document.getElementById('c');
      c.width = CELL.w * CELL.cols; c.height = CELL.h * rows;
      const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height); g.fillStyle = '#1e212a'; g.textBaseline = 'middle';
      ok.forEach((f, i) => {
        let px = 34; g.font = px + 'px "L' + f.id + '"';
        while (g.measureText(f.name).width > CELL.w - 20 && px > 12) { px--; g.font = px + 'px "L' + f.id + '"'; }
        g.fillText(f.name, (i % CELL.cols) * CELL.w + 10, Math.floor(i / CELL.cols) * CELL.h + CELL.h / 2);
      });
      return { ok: ok.map((f) => f.id), bad, img: c.toDataURL('image/webp', 0.85) };
    }, { data, CELL });
    const sheet = `${group.toLowerCase()}-${s + 1}.webp`;
    writeFileSync(join(OUT, 'sheets', sheet), Buffer.from(res.img.split(',')[1], 'base64'));
    res.ok.forEach((id, i) => { const f = batch.find((x) => x.id === id); fonts.push({ id, name: f.name, group, size: f.size, sheet, cell: i }); });
    dropped.push(...res.bad);
  }
}
await browser.close();
const library = { version: 1, cell: { w: CELL.w, h: CELL.h, cols: CELL.cols }, groups: ORDER, fonts };
writeFileSync(join(OUT, 'library.json'), JSON.stringify(library));
console.log(`${fonts.length} fonts in ${new Set(fonts.map((f) => f.sheet)).size} sheets; left out:`, dropped);
