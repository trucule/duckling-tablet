// Kitchen Lab and Chemistry Lab draw their surface textures in code (wood, steel, sand, mud and so on, about sixteen
// of them). The bundle drew every one before the first frame, which held the app's opening for seconds on a tablet.
// This changes the bundle's texture maker so a texture is drawn the first time something that uses it is shown; the
// ones not needed for the first frame are drawn one at a time once the app is open, so nothing waits for them later.
// The textures themselves are the same. Both games are one bundle built from the same source, so the bundle's short
// names are the same in both. Running it again changes nothing. Bump each app's manifest version after.
//   node tools/apply-lab-textures.mjs kitchen-lab chemistry-lab
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The bundle's texture maker: st(size, draw, repeat) makes a canvas, draws it and wraps it in a CanvasTexture (ii).
const OLD = 'function st(n,A,e){let t=document.createElement("canvas");t.width=t.height=n,A(t.getContext("2d"),n);let i=new ii(t);return i.wrapS=i.wrapT=di,e&&i.repeat.set(e[0],e[1]),i.encoding=kA,i.anisotropy=4,i}';
// The same, with the drawing put off until three.js first reads the texture's picture (when it uploads it), and a
// queue that draws the rest after the page has loaded: one texture every 200 ms, starting 1.5 s in.
const NEW = 'function st(n,A,e){let t=document.createElement("canvas");t.width=t.height=n;let i=new ii(t),d=0,k=()=>{d||(d=1,A(t.getContext("2d"),n))};' +
  'Object.defineProperty(i.source,"data",{configurable:!0,get(){return k(),t},set(){}});' +
  'st.q===void 0&&(st.q=[],addEventListener("load",()=>{let r=()=>{let f=st.q&&st.q.shift();f?(f(),setTimeout(r,200)):st.q=null};setTimeout(r,1500)}));st.q&&st.q.push(k);' +
  'return i.wrapS=i.wrapT=di,e&&i.repeat.set(e[0],e[1]),i.encoding=kA,i.anisotropy=4,i}';
const ids = process.argv.slice(2);
if (!ids.length) { console.error('usage: node tools/apply-lab-textures.mjs <app-id>...'); process.exit(2); }
for (const id of ids) {
  const f = path.join(ROOT, 'apps', id, 'index.html');
  let html = fs.readFileSync(f, 'utf8');
  if (html.includes(NEW)) { console.log('lab textures', id, '(already in)'); continue; }
  if (html.split(OLD).length !== 2) throw new Error(id + ': the texture maker was not found once; the bundle has changed');
  fs.writeFileSync(f, html.replace(OLD, () => NEW));
  console.log('lab textures', id);
}
