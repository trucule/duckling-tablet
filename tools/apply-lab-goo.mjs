// Puts tools/lab-goo.js (hands in the mixture) into Kitchen Lab and Chemistry Lab as goo.js, and gives the game's
// bundle the read-only window.__labView it uses: the scene, camera, hands, held things, pot layers and bodies. Both
// games are one bundle built from the same source, so the bundle's short names are the same in both. Running it again
// refreshes goo.js. Bump each app's manifest version after.
//   node tools/apply-lab-goo.mjs kitchen-lab chemistry-lab
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'tools', 'lab-goo.js'), 'utf8');
// The bundle's names for the scene, camera, hands, held things, pot layers, pot, pot shape, bodies and time.
const HOOK = 'try{window.__labView={scene:XA,camera:We,hands:qt,holds:mt,potLayers:ye,pot:l,POT:X,bodies:LA,get time(){return fe}}}catch{}';
const AFTER = /(try\{\/kldebug\/\.test\(location\.search\)&&\(window\.__kl=\{[^}]*\{return fe\}\}\)\}catch\{\})/;
const ids = process.argv.slice(2);
if (!ids.length) { console.error('usage: node tools/apply-lab-goo.mjs <app-id>...'); process.exit(2); }
for (const id of ids) {
  const dir = path.join(ROOT, 'apps', id), f = path.join(dir, 'index.html');
  let html = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(path.join(dir, 'goo.js'), src);
  if (!html.includes('window.__labView=')) {
    if (!AFTER.test(html)) throw new Error(id + ': the bundle has changed; find where its debug hook is set and update HOOK');
    html = html.replace(AFTER, '$1' + HOOK);
  }
  if (!html.includes('<script src="goo.js"></script>')) {
    const end = html.lastIndexOf('</body>');
    if (end < 0) throw new Error(id + ': no </body>');
    html = html.slice(0, end) + '<script src="goo.js"></script>\n' + html.slice(end);
  }
  fs.writeFileSync(f, html);
  console.log('lab goo', id);
}
