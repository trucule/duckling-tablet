// Puts the labs' look (tools/lab-look.js) into Kitchen Lab and Chemistry Lab: copies the file into the app as
// look.js, loads it before the game's bundle, and makes the bundle wait for LabLook.apply() between building its
// room and drawing its first frame. The pictures in the app's look/ folder come from tools/build-lab-look.py.
// Both games are one bundle built from the same source, so the bundle's short names are the same in both.
// Running it again refreshes look.js and changes nothing else. Bump each app's manifest version after.
//   node tools/apply-lab-look.mjs kitchen-lab chemistry-lab
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG = '<!-- LAB-LOOK --><script src="look.js"></script>\n';
const BEFORE = '<script id="voicepack">';
// The bundle's start: textures, materials, size, first step, models, the room and its lights, then the first frame.
const OLD = 'await wu(),fu(),SD(),document.body.classList.add("ready")';
// The same, handing the game's three.js pieces to the look once the room is built.
const NEW = 'await wu(),fu(),await(window.LabLook?window.LabLook.apply({scene:XA,renderer:$e,mats:eA,tex:NA,mode:Te,Texture:ii,DataTexture:ws,GLTF:kP,repeat:di,srgb:kA,rgba:lt}):0),SD(),document.body.classList.add("ready")';
const ids = process.argv.slice(2);
if (!ids.length) { console.error('usage: node tools/apply-lab-look.mjs <app-id>...'); process.exit(2); }
for (const id of ids) {
  const dir = path.join(ROOT, 'apps', id), f = path.join(dir, 'index.html');
  if (!fs.existsSync(path.join(dir, 'look', 'env.png'))) throw new Error(id + ': no look/ pictures; run tools/build-lab-look.py first');
  fs.copyFileSync(path.join(ROOT, 'tools', 'lab-look.js'), path.join(dir, 'look.js'));
  let html = fs.readFileSync(f, 'utf8'), changed = false;
  if (!html.includes(TAG)) {
    if (html.split(BEFORE).length !== 2) throw new Error(id + ': the place for look.js was not found once');
    html = html.replace(BEFORE, () => TAG + BEFORE); changed = true;
  }
  if (!html.includes(NEW)) {
    if (html.split(OLD).length !== 2) throw new Error(id + ': the bundle\'s start was not found once; the bundle has changed');
    html = html.replace(OLD, () => NEW); changed = true;
  }
  if (changed) fs.writeFileSync(f, html);
  console.log('lab look', id, changed ? '' : '(page already set; look.js refreshed)');
}
