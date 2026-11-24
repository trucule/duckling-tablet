// Puts tools/storybook.js (the storybook look for 3D scenes) into each listed app, between the STORYBOOK markers, right
// after the script that defines three.js. Running it again replaces the block. Bump each app's manifest version and run tools/phrases.mjs after.
//   node tools/apply-storybook.mjs planet-explorer tangram-city ...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const block = fs.readFileSync(path.join(ROOT, 'tools', 'storybook.js'), 'utf8').trim();
const ids = process.argv.slice(2);
if (!ids.length) { console.error('usage: node tools/apply-storybook.mjs <app-id>...'); process.exit(2); }
for (const id of ids) {
  const f = path.join(ROOT, 'apps', id, 'index.html');
  let html = fs.readFileSync(f, 'utf8');
  const tag = '<script>' + block + '</script>';
  const re = /<script>\/\* STORYBOOK START \*\/[\s\S]*?\/\* STORYBOOK END \*\/<\/script>/;
  if (re.test(html)) html = html.replace(re, () => tag);
  else {
    // Right after the script that defines three.js, so the app's renderer is made with the wrapped class.
    const lib = html.search(/WebGLRenderer\s*=|class \w+\{constructor\(\w+=\{\}\)\{const\{canvas|function WebGLRenderer|\.WebGLRenderer=/);
    if (lib < 0) throw new Error(id + ': three.js not found');
    const end = html.indexOf('</script>', lib); if (end < 0) throw new Error(id + ': no </script> after three.js');
    html = html.slice(0, end + 9) + '\n' + tag + html.slice(end + 9);
  }
  fs.writeFileSync(f, html);
  console.log('storybook', id);
}
