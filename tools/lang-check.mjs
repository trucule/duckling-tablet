// English and Spanish stay paired: checks what a Spanish family would otherwise see in English, without a browser,
// so it runs everywhere in seconds. The deploy runs it before it builds anything and stops on a failure;
// backend/test/i18n.test.ts runs the same checks with the rest of the tests.
//   node tools/lang-check.mjs
// What it checks (the web app and the portal are checked by backend/test/i18n.test.ts, which reads their TypeScript):
//   - every app's manifest has i18n.es with a name, a description and each About section the English one has;
//   - every line an app passes to T() or tr() as written text has a Spanish entry in that app, and the app has the
//     window.DucklingLang hook that tools/ladder-check.mjs uses to find lines built at run time;
//   - the iPad's Spanish InfoPlist.strings has every permission prompt project.yml has in English;
//   - every shell (Android, iPad, Windows) takes the family's language from the web app (setLanguage).
// Lines built at run time are not visible here; tools/ladder-check.mjs loads each app in Spanish and catches those.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const readIn = (root, ...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
// Shared blocks copied into apps (three.js, the photo backdrops, the hands in the mixture) have no words of their own.
const SHARED = /^(three(\.min)?\.js|backdrops\.js|goo\.js|vosk.*\.js)$/;

function quoted(k, q) { return q + k.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), '\\' + q) + q; }

export function checkApp(id, root = ROOT) {
  const errors = [], dir = path.join(root, 'apps', id);
  const m = JSON.parse(readIn(root, 'apps', id, 'manifest.json')), es = m.i18n && m.i18n.es;
  if (!es) errors.push('manifest has no i18n.es');
  else {
    for (const k of ['name', 'description']) if (!es[k] || !String(es[k]).trim()) errors.push(`manifest i18n.es.${k} is empty`);
    for (const k of Object.keys(m.about || {})) if (!es.about || !es.about[k] || (Array.isArray(m.about[k]) && es.about[k].length !== m.about[k].length)) errors.push(`manifest i18n.es.about.${k} is missing or a different length`);
    for (const k of ['name', 'description']) if (es[k] && m[k] && es[k] === m[k] && k !== 'name') errors.push(`manifest i18n.es.${k} is the English text`);
  }
  const src = fs.readdirSync(dir).filter((f) => /\.(html|js)$/.test(f) && !SHARED.test(f)).map((f) => readIn(root, 'apps', id, f)).join('\n');
  // The lines passed as written text to T() or tr(); a line is translated when it appears as a key somewhere in the app.
  const used = new Set();
  for (const x of src.matchAll(/\b(?:T|tr)\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*[,)]/g)) used.add(x[2].replace(/\\(.)/g, '$1'));
  for (const k of used) {
    if (!/[A-Za-z]{2}/.test(k)) continue;           // symbols and single letters
    const keyed = [quoted(k, "'"), quoted(k, '"')].some((q) => src.includes(q + ':') || src.includes(q + ' :'))
      || (/^[A-Za-z_$][\w$]*$/.test(k) && new RegExp(`[{,\\s]${k}\\s*:`).test(src));
    if (!keyed) errors.push(`no Spanish for "${k.length > 60 ? k.slice(0, 60) + '...' : k}"`);
  }
  if (!/window\.DucklingLang\s*=/.test(src)) errors.push('no window.DucklingLang hook');
  return { id, lines: used.size, errors };
}

export function checkShells() {
  const errors = [];
  // The iPad's permission prompts: project.yml has the English, es.lproj/InfoPlist.strings the Spanish.
  const yml = read('ios', 'project.yml'), strings = read('ios', 'DucklingTablet', 'es.lproj', 'InfoPlist.strings');
  for (const x of yml.matchAll(/^\s+(NS\w+UsageDescription):/gm)) if (!new RegExp(`"${x[1]}"\\s*=`).test(strings)) errors.push(`iPad: no Spanish ${x[1]} in es.lproj/InfoPlist.strings`);
  // Each shell's own words (the Home pill, the app failure page) follow the family's language through setLanguage.
  const has = (file, re, name) => { if (!re.test(read(...file))) errors.push(`${name}: no setLanguage, so its own words stay in English`); };
  has(['android', 'app', 'src', 'main', 'java', 'com', 'ducklingtablet', 'app', 'Shell.kt'], /fun setLanguage\(/, 'Android');
  has(['ios', 'DucklingTablet', 'Shell', 'shell.js'], /setLanguage\s*:/, 'iPad');
  has(['windows', 'src', 'Duckling.Shell', 'ShellBridge.cs'], /public void setLanguage\(/, 'Windows');
  return errors;
}

export function checkAll() {
  const apps = fs.readdirSync(path.join(ROOT, 'apps')).filter((d) => fs.existsSync(path.join(ROOT, 'apps', d, 'manifest.json'))).sort().map((id) => checkApp(id));
  return { apps, shells: checkShells() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { apps, shells } = checkAll();
  let bad = 0;
  for (const a of apps) { if (a.errors.length) { bad++; console.log(`${a.id}:`); for (const e of a.errors) console.log('  ' + e); } }
  for (const e of shells) { bad++; console.log(e); }
  if (bad) { console.log('\nEnglish and Spanish are not paired. Add the Spanish, then run again.'); process.exit(1); }
  console.log(`English and Spanish are paired: ${apps.length} apps (${apps.reduce((n, a) => n + a.lines, 0)} lines), the manifests and the shells.`);
}
