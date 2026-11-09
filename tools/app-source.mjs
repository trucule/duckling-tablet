// The files that make up an app's package, and a hash over them. Shared by tools/publish.mjs and tools/phrases.mjs:
// phrases.json records the hash of the source it was checked against, and the publish tool refuses a new version
// whose source no longer matches it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

// demo.gif is for the portal's About page and goes to storage on its own; recorder scratch folders are skipped.
export function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (dir === base && name === 'demo.gif') continue;
    if (name.startsWith('.demo-')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

// Every packaged file except phrases.json itself. Line endings are normalised so a Windows checkout hashes the same.
export function sourceHash(dir) {
  const h = createHash('sha256');
  for (const rel of listFiles(dir)) {
    if (rel === 'phrases.json') continue;
    let bytes = readFileSync(join(dir, rel));
    if (/\.(html|js|json|css|md|txt|svg)$/i.test(rel)) bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
    h.update(rel).update('\0').update(bytes).update('\0');
  }
  return h.digest('hex');
}
