// Puts tools/backdrops.js (photo backdrops, downloaded the first time a place needs one) into each listed app as
// backdrops.js, loaded right after three.js. Running it again refreshes the copy. Bump each app's manifest version after.
//   node tools/apply-backdrops.mjs story-maker my-avatar read-it-say-it
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
    // After three.js: its own file, or the inline <script> that holds the three.js build.
    const tag = '<script src="three.min.js"></script>', inline = html.indexOf('.THREE={}');
    if (html.includes(tag)) html = html.replace(tag, tag + '\n<script src="backdrops.js"></script>');
    else if (inline > 0) { const end = html.indexOf('</script>', inline) + '</script>'.length; html = html.slice(0, end) + '\n<script src="backdrops.js"></script>' + html.slice(end); }
    else throw new Error(id + ': no three.js to load backdrops.js after');
    fs.writeFileSync(f, html);
  }
  console.log('backdrops', id);
}
