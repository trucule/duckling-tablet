import { useEffect, useState } from 'preact/hooks';
import { api, type Family as FamilyT, type Child } from '../api';
import { Requests } from './Requests';
import { InstallCard } from '../install';

const GRADES = ['pre-k', 'k', '1', '2', '3', '4', '5', '6'];
const COLORS = ['#ffb3c6', '#ffd36b', '#b3e5ff', '#c8f7c5', '#e0c3fc', '#ffcf99'];

export function Family({ onOpenDevice }: { onOpenDevice: (id: string) => void }) {
  const [fam, setFam] = useState<FamilyT | null>(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState<{ code: string; until: number } | null>(null);
  const [codeChild, setCodeChild] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [newGrade, setNewGrade] = useState('1');
  const [newColor, setNewColor] = useState(COLORS[0]);
  const [, tick] = useState(0);
  const [pin, setPin] = useState(''); const [pinAgain, setPinAgain] = useState(''); const [pinMsg, setPinMsg] = useState('');
  const [invite, setInvite] = useState(''); const [inviteMsg, setInviteMsg] = useState('');
  const load = () => api.family().then(setFam).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  const addChild = async (e: Event) => {
    e.preventDefault();
    try { await api.addChild({ firstName: newName.trim(), grade: newGrade, theme: { colors: [newColor, '#b3e5ff'] } }); setNewName(''); await load(); }
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
        {fam.children.length === 0 && <p>Add your child first: the name shows on the tablet's home screen, and the grade sets where apps start.</p>}
        <ul class="list">
          {fam.children.map((c: Child) => (
            <li key={c.id}>
              <span class="swatch" style={{ background: c.theme?.colors?.[0] ?? '#eee' }} />
              <span class="grow"><strong>{c.firstName}</strong> <span class="muted">{c.grade ? `grade ${c.grade}` : ''}</span></span>
              <button class="btn quiet" onClick={async () => { if (confirm(`Remove ${c.firstName}'s profile?`)) { await api.deleteChild(c.id); load(); } }}>Remove</button>
            </li>
          ))}
        </ul>
        <form class="row" onSubmit={addChild} style={{ marginTop: 12 }}>
          <input placeholder="First name" required maxLength={30} value={newName} onInput={(e) => setNewName((e.target as HTMLInputElement).value)} style={{ maxWidth: 200 }} />
          <select value={newGrade} onChange={(e) => setNewGrade((e.target as HTMLSelectElement).value)} style={{ maxWidth: 120 }}>{GRADES.map((g) => <option key={g} value={g}>{g === 'pre-k' ? 'Pre-K' : g === 'k' ? 'K' : `Grade ${g}`}</option>)}</select>
          <select value={newColor} onChange={(e) => setNewColor((e.target as HTMLSelectElement).value)} style={{ maxWidth: 140 }}>{COLORS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <button class="btn" disabled={!newName.trim()}>Add child</button>
        </form>
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

      <InstallCard />

      <Requests grades={fam.children.map((c) => c.grade).filter((g): g is string => !!g)} onError={setError} />

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
