// Every line the tablet web app and the parent portal pass to tr() or trn() has a Spanish entry, and each Spanish line
// keeps the {names} of its English line, so nothing shows in English to a Spanish family and no value is lost in
// translation. Lines the code builds at run time or keeps in label tables (subject names, statuses, the minutes a day)
// are checked from LISTED. A scan of the source then fails on text a person reads that does not go through tr() at all.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { es as webEs } from '../../web/src/i18n/es';
import { es as portalEs } from '../../portal/src/i18n/es';
import { untranslated } from './untranslated';

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? (n === 'i18n' ? [] : files(p)) : /\.tsx?$/.test(n) && !/\.d\.ts$/.test(n) ? [p] : [];
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

const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// Messages the Android, iPad and Windows shells send in English; web/src/shell.ts (nativeText) shows them in Spanish.
const NATIVE = [
  "Bad app id.",
  "Bad file name in package.",
  "Could not finish the install.",
  "Download failed.",
  "Package has no index.html.",
  "Package has too many files.",
  "Package is too large.",
  "Packages come only over HTTPS.",
  "The download did not match. Try again.",
  "The package could not be opened.",
  "This package is not signed by Duckling.",
  "Connect this iPad to the internet and try again.",
  "Connect this tablet to the internet and try again.",
  "The subscription is not available right now.",
  "The purchase is waiting for approval.",
  "The purchase is waiting for payment.",
  "The purchase could not be confirmed. Try Restore purchases in a minute.",
  "No subscription was found for this Apple ID.",
  "No subscription was found for the Google account on this tablet.",
  "Choose the child's Windows account first.",
  "Could not connect to that network.",
  "Enter the parent PIN first.",
  "Give the account a name.",
  "That is the account in use right now. Choose or create the child's own account.",
  "That network is out of range.",
  "The Duckling service closed the connection.",
  "The Duckling service is not running.",
  "The PIN is 4 to 12 digits.",
  "This device has no Wi-Fi.",
  "This network needs a company sign-in, which Duckling cannot do. Join it from a parent's Windows account.",
  "This network needs its password.",
];

const TREES = [
  {
    name: 'tablet', src: join(import.meta.dirname, '..', '..', 'web', 'src'), es: webEs, min: 200,
    listed: ['Waiting', 'Downloading', 'this iPad', 'this device', 'this tablet', "{name}'s tablet", "{name}'s iPad", "{name}'s device", "{name}'s browser",
      'uses the camera', 'uses the microphone', 'uses the microphone and camera', 'reading', 'math', 'science', 'logic', 'art', 'music',
      'Received', 'Planned', 'Being built', 'Not taken on', 'In the Library', 'Withdrawn', 'Finished', ...NATIVE],
    // Not words to translate: units, ids, the portal's address, the device header.
    quiet: ['MB', '· id', '· shell', 'parents.ducklingtablet.com'],
  },
  {
    name: 'portal', src: join(import.meta.dirname, '..', '..', 'portal', 'src'), es: portalEs, min: 200,
    listed: [
      // Section buttons, the minutes a day, the grade scale and the subjects, kept in tables and looked up when shown.
      'Children', 'Devices', 'Apps', 'Websites', 'Other apps', 'Ask for an app', 'Subscription', 'Parent PIN', 'Parents', 'Account',
      '15 min a day', '30 min a day', '45 min a day', '1 hour a day', '1.5 hours a day', '2 hours a day', 'No daily limit',
      'Pre-K', 'Kindergarten', '1st grade', '2nd grade', '3rd grade', '4th grade', '5th grade', '6th grade', '7th grade', '8th grade',
      'Reading', 'Math', 'Science', 'Art', 'Music', 'Logic', 'Ages 4 to 5', 'Ages 6 to 7', 'Ages 8 and up',
      // Request statuses, device states and parent roles as the API sends them.
      'Received', 'Planned', 'Being built', 'Not taken on', 'In the Store', 'Withdrawn', 'Finished', 'active', 'release', 'released', 'owner', 'parent'],
    quiet: ['Duckling Tablet', 'Google Play', 'App Store'],
  },
];

for (const tree of TREES) {
  describe(`${tree.name} translations`, () => {
    const sources = files(tree.src);
    const all = [...new Set([...sources.flatMap((f) => linesIn(readFileSync(f, 'utf8'))), ...tree.listed])];

    it('finds the lines', () => { expect(all.length).toBeGreaterThan(tree.min); });

    it('has Spanish for every line', () => {
      expect(all.filter((l) => !(l in tree.es))).toEqual([]);
    });

    it('keeps the {names} of every line', () => {
      expect(Object.entries(tree.es).filter(([en, t]) => names(en).join() !== names(t).join()).map(([en]) => en)).toEqual([]);
    });

    it('has no Spanish line left in English', () => {
      const same = Object.entries(tree.es).filter(([en, t]) => en === t && !/^(Wi-Fi|Google Play|Stripe|PIN|(\{n\} )?[Aa]pps?)$/.test(en));
      expect(same).toEqual([]);
    });

    it('sends every text a person reads through tr()', () => {
      const allowed = new Set([...tree.listed, ...tree.quiet]);
      expect(sources.flatMap((f) => untranslated(f, tree.src, allowed))).toEqual([]);
    });
  });
}

// The apps, their manifests and the shells: tools/lang-check.mjs, the same check the deploy runs before it builds.
describe('apps and shells translations', async () => {
  // @ts-expect-error a plain .mjs tool without types
  const lc = await import('../../tools/lang-check.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  it('pairs every app, manifest and shell', () => {
    const { apps, shells } = lc.checkAll();
    expect(apps.length).toBeGreaterThan(20);
    expect(apps.filter((a: { errors: string[] }) => a.errors.length).map((a: { id: string; errors: string[] }) => `${a.id}: ${a.errors.join('; ')}`)).toEqual([]);
    expect(shells).toEqual([]);
  });

  it('catches a line with no Spanish, a missing manifest translation and a missing hook', () => {
    const root = mkdtempSync(join(tmpdir(), 'langcheck-')), dir = join(root, 'apps', 'x');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: 'x', name: 'X', description: 'Plays.', about: { concept: 'A' }, i18n: { es: { name: 'X', description: 'Juega.' } } }));
    writeFileSync(join(dir, 'index.html'), `<script>const ES = { 'Well done!': '¡Muy bien!' }; T('Well done!'); T('Try again');</script>`);
    const r = lc.checkApp('x', root);
    expect(r.errors).toEqual(['manifest i18n.es.about.concept is missing or a different length', 'no Spanish for "Try again"', 'no window.DucklingLang hook']);
  });
});

// The emails: each one has its own Spanish subject and body.
describe('email translations', async () => {
  const emails = await import('../src/emails');
  for (const [name, fn] of Object.entries(emails)) {
    if (typeof fn !== 'function') continue;
    it(`${name} has Spanish`, () => {
      for (const source of ['portal', 'tablet']) {
        const args = (l: string) => [l, ...Array.from({ length: fn.length - 1 }, (_, i) => (i === 0 && name === 'signInLinkEmail' ? source : '123456'))];
        const en = (fn as (...a: string[]) => { subject: string; body: string })(...args('en'));
        const es = (fn as (...a: string[]) => { subject: string; body: string })(...args('es'));
        expect(es.subject && es.body).toBeTruthy();
        expect(es.subject).not.toBe(en.subject);
        expect(es.body).not.toBe(en.body);
      }
    });
  }
});
