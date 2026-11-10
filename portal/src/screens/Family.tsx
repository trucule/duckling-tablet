import { useEffect, useState } from 'preact/hooks';
import { api, type Family as FamilyT, type Child, type CatalogApp } from '../api';
import { Requests, NoMatch } from './Requests';
import { InstallCard } from '../install';
import { useAppFilter, ageText } from '../appfilter';

const COLORS = ['#ffb3c6', '#ffd36b', '#b3e5ff', '#c8f7c5', '#e0c3fc', '#ffcf99'];

export function Family({ onOpenDevice }: { onOpenDevice: (id: string) => void }) {
  const [fam, setFam] = useState<FamilyT | null>(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState<{ code: string; until: number } | null>(null);
  const [codeChild, setCodeChild] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [newAge, setNewAge] = useState(''); const [newStart, setNewStart] = useState<string>('');
  const [newColor, setNewColor] = useState(COLORS[0]);
  const [, tick] = useState(0);
  const [pin, setPin] = useState(''); const [pinAgain, setPinAgain] = useState(''); const [pinMsg, setPinMsg] = useState('');
  const [invite, setInvite] = useState(''); const [inviteMsg, setInviteMsg] = useState('');
  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const filter = useAppFilter(catalog);
  const [seed, setSeed] = useState<{ title: string; n: number } | undefined>();
  const load = () => api.family().then(setFam).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); api.catalog().then((c) => setCatalog(c.apps)).catch(() => {}); const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  const addChild = async (e: Event) => {
    e.preventDefault();
    const age = Number(newAge);
    try { await api.addChild({ firstName: newName.trim(), ...(age ? { age } : {}), ...(newStart !== '' ? { startGrade: Number(newStart) } : {}), theme: { colors: [newColor, '#b3e5ff'] } }); setNewName(''); setNewAge(''); setNewStart(''); await load(); }
    catch (err) { setError((err as Error).message); }
  };
  const makeCode = async () => {
    try { const r = await api.pairingCode(codeChild || null); setCode({ code: r.code, until: Date.now() + r.expiresInMinutes * 60_000 }); }
    catch (err) { setError((err as Error).message); }
  };
  const remaining = code ? Math.max(0, Math.round((code.until - Date.now()) / 1000)) : 0;
  const childName = (id: string | null) => fam?.children.find((c) => c.id === id)?.firstName ?? 'No child yet';

  const savePin = async (e: Event) => {
    e.preventDefault(); setPinMsg('');
    if (pin !== pinAgain) { setPinMsg('The two PINs were different.'); return; }
    try { await api.setPin(pin); setPin(''); setPinAgain(''); setPinMsg('Saved. Each tablet picks it up at its next check-in, within three hours, or when it is opened.'); await load(); }
    catch (err) { setPinMsg((err as Error).message); }
  };
  const sendInvite = async (e: Event) => {
    e.preventDefault(); setInviteMsg('');
    try { await api.inviteParent(invite.trim()); setInviteMsg(`Invitation sent to ${invite.trim()}. The link works for 7 days.`); setInvite(''); }
    catch (err) { setInviteMsg((err as Error).message); }
  };

  if (!fam) return <div class="card">{error ? <div class="error">{error}</div> : 'Loading'}</div>;
  return (
    <>
      {error && <div class="error" onClick={() => setError('')}>{error}</div>}

      <div class="card">
        <h2>Children</h2>
        {fam.children.length === 0 && <p>Add your child first: the name shows on the tablet's home screen, and the starting level sets where every app begins.</p>}
        <ul class="list">
          {fam.children.map((c: Child) => <ChildRow key={c.id} c={c} onChange={load} onError={setError} />)}
        </ul>
        <form class="row" onSubmit={addChild} style={{ marginTop: 12, alignItems: 'center' }}>
          <input placeholder="First name" required maxLength={30} value={newName} onInput={(e) => setNewName((e.target as HTMLInputElement).value)} style={{ maxWidth: 160 }} />
          <input type="number" min={1} max={16} placeholder="Age" value={newAge} onInput={(e) => { setNewAge((e.target as HTMLInputElement).value); setNewStart(''); }} style={{ width: 70 }} />
          <label class="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>starts at
            <select value={newStart !== '' ? newStart : String(gradeForAge(Number(newAge) || 7))} onChange={(e) => setNewStart((e.target as HTMLSelectElement).value)} style={{ maxWidth: 150 }}>
              {GRADE_SCALE.map(([g, name]) => <option key={g} value={String(g)}>{name}</option>)}
            </select>
          </label>
          <select value={newColor} onChange={(e) => setNewColor((e.target as HTMLSelectElement).value)} style={{ maxWidth: 140 }}>{COLORS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <button class="btn" disabled={!newName.trim()}>Add child</button>
        </form>
        <p class="muted" style={{ marginTop: 8 }}>Every app starts two years below the child's age (a 7-year-old starts at kindergarten level) and moves up as she gets things right. Change the start here, or one subject at a time on her row.</p>
      </div>

      <div class="card">
        <h2>Add a device</h2>
        <p>Install Duckling Tablet on the device, open it, and type this code. The code works once and expires in 15 minutes.</p>
        <div class="row">
          <select value={codeChild} onChange={(e) => setCodeChild((e.target as HTMLSelectElement).value)} style={{ maxWidth: 220 }}>
            <option value="">Choose the child later</option>
            {fam.children.map((c) => <option key={c.id} value={c.id}>{c.firstName}</option>)}
          </select>
          <button class="btn primary" onClick={makeCode}>Make a pairing code</button>
        </div>
        {code && remaining > 0 && <><div class="code">{code.code}</div><p class="muted" style={{ textAlign: 'center' }}>Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}. Open this page again to see the new device.</p></>}
        {code && remaining === 0 && <p class="muted">That code expired. Make a new one.</p>}
      </div>

      <div class="card">
        <h2>Devices</h2>
        {fam.devices.length === 0 && <p>No devices yet.</p>}
        <ul class="list">
          {fam.devices.map((d) => (
            <li key={d.id}>
              <span class="grow"><strong>{d.name}</strong> <span class="muted">{d.platform} · {childName(d.childId)} · {d.state}{d.lastSeenAt ? ` · seen ${new Date(d.lastSeenAt).toLocaleString()}` : ''}{d.battery != null ? ` · ${d.battery}%` : ''}</span></span>
              <button class="btn" onClick={() => onOpenDevice(d.id)}>Open</button>
              <button class="btn quiet" onClick={async () => { if (confirm(`Remove ${d.name} from the family? It lifts its lockdown and returns to the pairing screen the next time it is online.`)) { try { await api.removeDevice(d.id); await load(); } catch (err) { setError((err as Error).message); } } }}>Remove</button>
            </li>
          ))}
        </ul>
        <p class="muted" style={{ marginTop: 10 }}><button class="btn quiet" onClick={load}>Refresh</button></p>
      </div>

      <div class="card">
        <h2>Subscription</h2>
        {fam.subscription.status === 'trial' && <p>Free trial: <strong>{fam.subscription.daysLeft} day{fam.subscription.daysLeft === 1 ? '' : 's'} left</strong>{fam.subscription.periodEnd ? ` (until ${new Date(fam.subscription.periodEnd).toLocaleDateString()})` : ''}. After that, $5 a month covers every tablet in the family, on any platform. No card is needed during the trial.</p>}
        {fam.subscription.status === 'active' && <p>Subscribed. $5 a month covers every tablet in the family.</p>}
        {fam.subscription.status === 'grace' && <p class="error">The last payment did not go through. Everything keeps working while the store retries; update the card where you subscribed.</p>}
        {(fam.subscription.status === 'ended' || fam.subscription.status === 'none') && <p class="error">The free trial has ended. Subscribe in the parent area of an iPad or Android tablet (the Parent button on its home screen); one subscription covers every tablet in the family.</p>}
        <p class="muted">Included: 24 learning apps and every new one, the narrator voice, the avatar and stars across tablets, this portal, and app requests at no extra cost (below).</p>
      </div>

      <div class="card">
        <h2>Parent PIN</h2>
        <p>{fam.pinSet ? 'A PIN is set. It opens the parent area on every tablet in the family. Choose a new one here if it needs changing.' : 'No PIN yet. The first tablet asks for one during setup, or set it here and every tablet uses it.'}</p>
        <form class="row" onSubmit={savePin}>
          <input type="password" inputMode="numeric" pattern="[0-9]{4,6}" placeholder={fam.pinSet ? 'New PIN' : 'PIN (4 to 6 digits)'} required value={pin} onInput={(e) => setPin((e.target as HTMLInputElement).value)} style={{ maxWidth: 170 }} autoComplete="off" />
          <input type="password" inputMode="numeric" pattern="[0-9]{4,6}" placeholder="Again" required value={pinAgain} onInput={(e) => setPinAgain((e.target as HTMLInputElement).value)} style={{ maxWidth: 120 }} autoComplete="off" />
          <button class="btn" disabled={pin.length < 4}>{fam.pinSet ? 'Change PIN' : 'Set PIN'}</button>
        </form>
        {pinMsg && <p class={pinMsg.startsWith('Saved') ? 'ok' : 'error'} style={{ marginTop: 10 }}>{pinMsg}</p>}
      </div>

      <div class="card">
        <h2>Parents</h2>
        <ul class="list">
          {fam.parents.map((p) => (
            <li key={p.id}>
              <span class="grow"><strong>{p.email}</strong> <span class="muted">{p.email === fam.you ? 'you' : p.role}</span></span>
              {p.email !== fam.you && <button class="btn quiet" onClick={async () => { if (confirm(`Remove ${p.email} from the family?`)) { try { await api.removeParent(p.id); await load(); } catch (err) { setError((err as Error).message); } } }}>Remove</button>}
            </li>
          ))}
        </ul>
        {fam.parents.length < 4 && (
          <form class="row" onSubmit={sendInvite} style={{ marginTop: 12 }}>
            <input type="email" placeholder="Another parent's email" required value={invite} onInput={(e) => setInvite((e.target as HTMLInputElement).value)} style={{ maxWidth: 280 }} />
            <button class="btn" disabled={!invite.includes('@')}>Invite</button>
          </form>
        )}
        {inviteMsg && <p class={inviteMsg.startsWith('Invitation sent') ? 'ok' : 'error'} style={{ marginTop: 10 }}>{inviteMsg}</p>}
      </div>

      <div class="card">
        <h2>Apps</h2>
        <p>Every app, with what it trains and how it grows with your child. Open one to read about it and put it on a tablet.</p>
        {filter.bar}
        <ul class="list apps">
          {filter.apps.map((a) => (
            <li key={a.id}>
              <a href={`#/app/${a.id}`} class="row" style={{ alignItems: 'center', textDecoration: 'none', color: 'inherit', flex: 1 }}>
                {a.tileUrl && <img src={a.tileUrl} alt="" style={{ width: 48, height: 48, borderRadius: 12 }} />}
                <span class="grow"><strong>{a.name}</strong> <span class="muted">{[ageText(a) && `ages ${ageText(a)}`, ...a.subjects].filter(Boolean).join(' · ')}</span><br /><span class="muted">{a.description}</span></span>
              </a>
            </li>
          ))}
        </ul>
        {catalog.length > 0 && filter.apps.length === 0 && <NoMatch q={filter.q} onAsk={(title) => setSeed((s) => ({ title, n: (s?.n ?? 0) + 1 }))} />}
      </div>

      <InstallCard />

      <Requests grades={fam.children.map((c) => c.grade).filter((g): g is string => !!g)} onError={setError} seed={seed} />

      <div class="card">
        <h2>Account</h2>
        <p>Signed in as {fam.you}. Deleting the account releases every device first, then removes every record.</p>
        <div class="row">
          <button class="btn quiet" onClick={async () => { await api.logout().catch(() => {}); location.reload(); }}>Sign out</button>
          <button class="btn danger" onClick={async () => { if (prompt('Type DELETE to remove the family account and all its data.') === 'DELETE') { await api.deleteFamily(); location.reload(); } }}>Delete account and all data</button>
        </div>
      </div>
    </>
  );
}


// Difficulty is one grade scale for every subject: pre-K to 8th. A child starts two years below her age.
export const GRADE_SCALE: [number, string][] = [[-1, 'Pre-K level'], [0, 'Kindergarten level'], [1, '1st grade level'], [2, '2nd grade level'], [3, '3rd grade level'], [4, '4th grade level'], [5, '5th grade level'], [6, '6th grade level'], [7, '7th grade level'], [8, '8th grade level']];
export const gradeForAge = (age: number) => Math.max(-1, Math.min(8, Math.round(age) - 7));
const SUBJECT_NAMES: [string, string][] = [['reading', 'Reading'], ['math', 'Math'], ['science', 'Science'], ['logic', 'Logic'], ['art', 'Art'], ['music', 'Music']];
const gradeName = (g: number) => GRADE_SCALE.find((x) => x[0] === g)?.[1].replace(' level', '') ?? '';

function ChildRow({ c, onChange, onError }: { c: Child; onChange: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const levels = c.levels ?? {};
  const values = SUBJECT_NAMES.map(([id]) => levels[id]).filter((v) => typeof v === 'number');
  const same = values.length > 0 && values.every((v) => v === values[0]);
  const save = async (b: Parameters<typeof api.updateChild>[1]) => { try { await api.updateChild(c.id, b); onChange(); } catch (e) { onError((e as Error).message); } };
  return (
    <li style={{ alignItems: 'flex-start' }}>
      {c.portraitUrl ? <img class="portrait" src={c.portraitUrl} alt="" /> : <span class="swatch" style={{ background: c.theme?.colors?.[0] ?? '#eee' }} />}
      <span class="grow">
        <strong>{c.firstName}</strong> <span class="muted">{[c.age ? `age ${c.age}` : '', same ? `${gradeName(values[0])} level` : values.length ? 'mixed levels' : '', c.stars ? `${c.stars.earned} stars earned, ${c.stars.balance} to spend` : ''].filter(Boolean).join(' · ')}</span>
        {open && (
          <div style={{ marginTop: 8 }}>
            <div class="row" style={{ alignItems: 'center' }}>
              <span class="muted">Age</span>
              <input type="number" min={1} max={16} value={c.age ?? ''} onChange={(e) => { const v = Number((e.target as HTMLInputElement).value); if (v) save({ age: v }); }} style={{ width: 70 }} />
              <span class="muted">Every subject</span>
              <select value={same ? String(values[0]) : ''} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v !== '') save({ startGrade: Number(v) }); }}>
                {!same && <option value="">mixed</option>}
                {GRADE_SCALE.map(([g, name]) => <option key={g} value={String(g)}>{name}</option>)}
              </select>
            </div>
            <div class="row" style={{ alignItems: 'center', marginTop: 6 }}>
              {SUBJECT_NAMES.map(([id, name]) => (
                <label key={id} class="muted" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{name}
                  <select value={String(levels[id] ?? 0)} onChange={(e) => save({ levels: { [id]: Number((e.target as HTMLSelectElement).value) } })}>
                    {GRADE_SCALE.map(([g, gn]) => <option key={g} value={String(g)}>{gn.replace(' level', '')}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <p class="muted" style={{ marginTop: 6 }}>Apps already in progress keep their place; the level sets where a new app starts.</p>
          </div>
        )}
      </span>
      <button class="btn quiet" onClick={() => setOpen(!open)}>{open ? 'Done' : 'Levels'}</button>
      <button class="btn quiet" onClick={async () => { if (confirm(`Remove ${c.firstName}'s profile?`)) { await api.deleteChild(c.id); onChange(); } }}>Remove</button>
    </li>
  );
}
