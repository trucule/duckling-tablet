// Puts tools/backdrops.js (photo backdrops, downloaded the first time a place needs one) into each listed app as
// backdrops.js, loaded right after three.js. Running it again refreshes the copy. Bump each app's manifest version after.
//   node tools/apply-backdrops.mjs story-maker my-avatar
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'tools', 'backdrops.js'), 'utf8');
const ids = process.argv.slice(2);
if (!ids.length) { console.error('usage: node tools/apply-backdrops.mjs <app-id>...'); process.exit(2); }
for (const id of ids) {
  const dir = path.join(ROOT, 'apps', id), f = path.join(dir, 'index.html');
  let html = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(path.join(dir, 'backdrops.js'), src);
  if (!html.includes('<script src="backdrops.js"></script>')) {
    const tag = '<script src="three.min.js"></script>';
    if (!html.includes(tag)) throw new Error(id + ': no <script src="three.min.js"> to load backdrops.js after');
    html = html.replace(tag, tag + '\n<script src="backdrops.js"></script>');
    fs.writeFileSync(f, html);
  }
  console.log('backdrops', id);
}
