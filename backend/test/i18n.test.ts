// Every line the tablet web app passes to tr() or trn() has a Spanish entry, and each Spanish line keeps the {names}
// of its English line, so nothing shows in English on a Spanish tablet and no value is lost in translation. Lines the
// code builds at run time (subject names, the permission phrases, the request statuses) are checked from LISTED.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { es } from '../../web/src/i18n/es';

const SRC = join(import.meta.dirname, '..', '..', 'web', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? (n === 'i18n' ? [] : files(p)) : /\.tsx?$/.test(n) ? [p] : [];
});

// The quoted lines inside tr(...) and trn(n, ...): the first argument, and both lines of trn.
function linesIn(src: string): string[] {
  const out: string[] = [];
  const quoted = /(['"])((?:\\.|(?!\1)[^\\])*)\1/y;
  for (const m of src.matchAll(/\btr(n?)\(/g)) {
    let i = m.index! + m[0].length;
    const take = () => {
      while (/\s/.test(src[i])) i++;
      quoted.lastIndex = i;
      const q = quoted.exec(src);
      if (!q) return false;
      out.push(q[2].replace(/\\(.)/g, '$1'));
      i = quoted.lastIndex;
      return true;
    };
    if (m[1]) { // trn(count, one, other)
      let depth = 0;
      for (; i < src.length; i++) { const ch = src[i]; if (ch === '(') depth++; else if (ch === ')') depth--; else if (ch === ',' && depth === 0) { i++; break; } }
      if (take()) { while (/[\s,]/.test(src[i])) i++; take(); }
    } else take();
  }
  return out;
}

const LISTED = ['Waiting', 'Downloading', 'this iPad', 'this device', 'this tablet', "{name}'s tablet", "{name}'s iPad", "{name}'s device", "{name}'s browser",
  'uses the camera', 'uses the microphone', 'uses the microphone and camera', 'reading', 'math', 'science', 'logic', 'art', 'music',
  'Received', 'Planned', 'Being built', 'Not taken on', 'In the Library', 'Withdrawn', 'Finished'];
const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('tablet translations', () => {
  const all = [...new Set([...files(SRC).flatMap((f) => linesIn(readFileSync(f, 'utf8'))), ...LISTED])];

  it('finds the lines', () => { expect(all.length).toBeGreaterThan(200); });

  it('has Spanish for every line the tablet shows', () => {
    expect(all.filter((l) => !(l in es))).toEqual([]);
  });

  it('keeps the {names} of every line', () => {
    expect(Object.entries(es).filter(([en, t]) => names(en).join() !== names(t).join()).map(([en]) => en)).toEqual([]);
  });

  it('has no Spanish line left in English', () => {
    const same = Object.entries(es).filter(([en, t]) => en === t && !/^(Wi-Fi|Google Play)$/.test(en));
    expect(same).toEqual([]);
  });
});
