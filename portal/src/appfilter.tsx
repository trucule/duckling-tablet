import { useMemo, useState } from 'preact/hooks';
import type { CatalogApp } from './api';

export const SUBJECTS: [string, string][] = [['reading', 'Reading'], ['math', 'Math'], ['science', 'Science'], ['art', 'Art'], ['music', 'Music'], ['logic', 'Logic']];
const AGES: [string, string, (a: CatalogApp) => boolean][] = [
  ['4-5', 'Ages 4 to 5', (a) => (a.ageMin ?? 0) <= 5 && (a.ageMax ?? 99) >= 4],
  ['6-7', 'Ages 6 to 7', (a) => (a.ageMin ?? 0) <= 7 && (a.ageMax ?? 99) >= 6],
  ['8+', 'Ages 8 and up', (a) => (a.ageMax ?? 99) >= 8],
];

// Search and filters over the catalog: words match the name, description, About text and life skills; chips narrow
// by subject and age. Shared by the family page (browse) and the device page (install or hide).
export function useAppFilter(catalog: CatalogApp[]) {
  const [q, setQ] = useState('');
  const [subject, setSubject] = useState('');
  const [age, setAge] = useState('');
  const apps = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const ageTest = AGES.find((x) => x[0] === age)?.[2];
    return catalog.filter((a) => {
      if (subject && !a.subjects.includes(subject)) return false;
      if (ageTest && !ageTest(a)) return false;
      if (!words.length) return true;
      const hay = [a.name, a.description, a.about?.concept, a.about?.progression, ...(a.about?.lifeSkills ?? []), ...a.subjects].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [catalog, q, subject, age]);
  const bar = (
    <div class="filter">
      <input type="search" placeholder="Search apps: fractions, handwriting, patience, music" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div class="chips">
        <button class={`chip ${subject === '' ? 'on' : ''}`} onClick={() => setSubject('')}>All subjects</button>
        {SUBJECTS.map(([id, name]) => <button key={id} class={`chip ${subject === id ? 'on' : ''}`} onClick={() => setSubject(subject === id ? '' : id)}>{name}</button>)}
      </div>
      <div class="chips">
        <button class={`chip ${age === '' ? 'on' : ''}`} onClick={() => setAge('')}>All ages</button>
        {AGES.map(([id, name]) => <button key={id} class={`chip ${age === id ? 'on' : ''}`} onClick={() => setAge(age === id ? '' : id)}>{name}</button>)}
      </div>
    </div>
  );
  return { apps, bar, q, active: !!(q || subject || age) };
}

export const ageText = (a: CatalogApp) => a.ageMin && a.ageMax ? `${a.ageMin} to ${a.ageMax}` : a.ageMin ? `${a.ageMin} and up` : '';
