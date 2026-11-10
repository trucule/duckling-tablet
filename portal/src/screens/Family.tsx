import { useEffect, useState } from 'preact/hooks';
import { api, type Family as FamilyT, type Child, type Device, type CatalogApp, type DeviceDetail, type OtherApp } from '../api';
import { Requests, NoMatch } from './Requests';
import { InstallCard } from '../install';
import { useAppFilter, ageText } from '../appfilter';

const COLORS = ['#ffb3c6', '#ffd36b', '#b3e5ff', '#c8f7c5', '#e0c3fc', '#ffcf99'];

// The sections of the page, in order, for the buttons at the top. Each card carries the matching id.
const SECTIONS: [string, string][] = [['children', 'Children'], ['devices', 'Devices'], ['apps', 'Apps'], ['websites', 'Websites'], ['other-apps', 'Other apps'], ['requests', 'Ask for an app'], ['subscription', 'Subscription'], ['pin', 'Parent PIN'], ['parents', 'Parents'], ['account', 'Account']];

// Everything about the family on one page: children, the tablets, and the apps, websites and other apps across all
// of them. A change applies to one tablet or every tablet; the picker appears only when the family has several.
export function Family() {
  const [fam, setFam] = useState<FamilyT | null>(null);
  const [details, setDetails] = useState<Record<string, DeviceDetail>>({});
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
  const [seed, setSeed] = useState<{ title: string; n: number } | undefined>();
  const load = async () => {
    try {
      const f = await api.family(); setFam(f);
      const ds = await Promise.all(f.devices.filter((d) => d.state === 'active').map(async (d) => [d.id, await api.device(d.id).catch(() => null)] as const));
      setDetails(Object.fromEntries(ds.filter(([, v]) => v).map(([k, v]) => [k, v!])));
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { load(); api.catalog().then((c) => setCatalog(c.apps)).catch(() => {}); const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  // Any change: run it, then reload the family and the tablets so every section shows the result.
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };

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
  const active = fam.devices.filter((d) => d.state === 'active' && details[d.id]);
  return (
    <>
      {error && <div class="error" onClick={() => setError('')}>{error}</div>}

      <nav class="sections" aria-label="Sections">
        {SECTIONS.map(([id, label]) => <button key={id} class="chip" onClick={() => document.getElementById(id)?.scrollIntoView({ block: 'start' })}>{label}</button>)}
      </nav>
      <BackToTop />

      <InstallCard />

      <div class="card" id="children">
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

      <div class="card" id="devices">
        <h2>Devices</h2>
        <p>Install Duckling Tablet on the device, open it, and type this code. The code works once and expires in 15 minutes.</p>
        <div class="row">
          <select value={codeChild} onChange={(e) => setCodeChild((e.target as HTMLSelectElement).value)} style={{ maxWidth: 220 }}>
            <option value="">Choose the child later</option>
            {fam.children.map((c) => <option key={c.id} value={c.id}>{c.firstName}</option>)}
          </select>
          <button class="btn primary" onClick={makeCode}>Make a pairing code</button>
        </div>
        {code && remaining > 0 && <><div class="code">{code.code}</div><p class="muted" style={{ textAlign: 'center' }}>Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}. Refresh to see the new device.</p></>}
        {code && remaining === 0 && <p class="muted">That code expired. Make a new one.</p>}
        {fam.devices.length === 0 && <p style={{ marginTop: 14 }}>No devices yet.</p>}
        <ul class="list" style={{ marginTop: 14 }}>
          {fam.devices.map((d) => (
            <li key={d.id}>
              <span class="grow"><strong>{d.name}</strong> <span class="muted">{d.platform} · {childName(d.childId)} · {d.state}{details[d.id] ? ` · ${details[d.id].apps.length} apps` : ''}{d.lastSeenAt ? ` · seen ${new Date(d.lastSeenAt).toLocaleString()}` : ''}{d.battery != null ? ` · ${d.battery}%` : ''}</span></span>
              <select value={d.childId ?? ''} onChange={(e) => act(() => api.renameDevice(d.id, { childId: (e.target as HTMLSelectElement).value || null }))} style={{ maxWidth: 160 }} aria-label={`Child using ${d.name}`}>
                <option value="">No child</option>
                {fam.children.map((c) => <option key={c.id} value={c.id}>{c.firstName}</option>)}
              </select>
              <button class="btn quiet" onClick={() => { const n = prompt('Device name', d.name); if (n) act(() => api.renameDevice(d.id, { name: n })); }}>Rename</button>
              <button class="btn quiet" onClick={() => { if (confirm(`Remove ${d.name} from the family? Changes from here stop reaching it and its narrator voice turns off; its apps, PIN and lockdown stay. Its parent area then asks for a new pairing code, so it can join a family again.`)) act(() => api.removeDevice(d.id)); }}>Remove</button>
            </li>
          ))}
        </ul>
        <p class="muted" style={{ marginTop: 10 }}><button class="btn quiet" onClick={load}>Refresh</button></p>
      </div>

      <AppsCard catalog={catalog} devices={active} details={details} onAct={act} onAsk={(title) => setSeed((s) => ({ title, n: (s?.n ?? 0) + 1 }))} />
      <SitesCard devices={active} details={details} onAct={act} />
      <OtherAppsCard devices={active} details={details} onAct={act} />

      <div id="requests">
        <Requests grades={fam.children.map((c) => c.grade).filter((g): g is string => !!g)} onError={setError} seed={seed} />
      </div>

      <div class="card" id="subscription">
        <h2>Subscription</h2>
        {fam.subscription.status === 'trial' && <p>Free trial: <strong>{fam.subscription.daysLeft} day{fam.subscription.daysLeft === 1 ? '' : 's'} left</strong>{fam.subscription.periodEnd ? ` (until ${new Date(fam.subscription.periodEnd).toLocaleDateString()})` : ''}. After that, $5 a month covers every tablet in the family, on any platform. No card is needed during the trial.</p>}
        {fam.subscription.status === 'active' && <p>Subscribed. $5 a month covers every tablet in the family.</p>}
        {fam.subscription.status === 'grace' && <p class="error">The last payment did not go through. Everything keeps working while the store retries; update the card where you subscribed.</p>}
        {(fam.subscription.status === 'ended' || fam.subscription.status === 'none') && <p class="error">The free trial has ended. Subscribe in the parent area of an iPad or Android tablet (the Parent button on its home screen); one subscription covers every tablet in the family.</p>}
        <p class="muted">Included: 24 learning apps and every new one, the narrator voice, the avatar and stars across tablets, this portal, and app requests at no extra cost (above).</p>
      </div>

      <div class="card" id="pin">
        <h2>Parent PIN</h2>
        <p>{fam.pinSet ? 'A PIN is set. It opens the parent area on every tablet in the family. Choose a new one here if it needs changing.' : 'No PIN yet. The first tablet asks for one during setup, or set it here and every tablet uses it.'}</p>
        <form class="row" onSubmit={savePin}>
          <input type="password" inputMode="numeric" pattern="[0-9]{4,6}" placeholder={fam.pinSet ? 'New PIN' : 'PIN (4 to 6 digits)'} required value={pin} onInput={(e) => setPin((e.target as HTMLInputElement).value)} style={{ maxWidth: 170 }} autoComplete="off" />
          <input type="password" inputMode="numeric" pattern="[0-9]{4,6}" placeholder="Again" required value={pinAgain} onInput={(e) => setPinAgain((e.target as HTMLInputElement).value)} style={{ maxWidth: 120 }} autoComplete="off" />
          <button class="btn" disabled={pin.length < 4}>{fam.pinSet ? 'Change PIN' : 'Set PIN'}</button>
        </form>
        {pinMsg && <p class={pinMsg.startsWith('Saved') ? 'ok' : 'error'} style={{ marginTop: 10 }}>{pinMsg}</p>}
      </div>

      <div class="card" id="parents">
        <h2>Parents</h2>
        <ul class="list">
          {fam.parents.map((p) => (
            <li key={p.id}>
              <span class="grow"><strong>{p.email}</strong> <span class="muted">{p.email === fam.you ? 'you' : p.role}</span></span>
              {p.email !== fam.you && <button class="btn quiet" onClick={() => { if (confirm(`Remove ${p.email} from the family?`)) act(() => api.removeParent(p.id)); }}>Remove</button>}
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

      <div class="card" id="account">
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

// A fixed button at the bottom corner once the page has scrolled.
function BackToTop() {
  const [shown, setShown] = useState(false);
  useEffect(() => { const on = () => setShown(window.scrollY > 300); on(); window.addEventListener('scroll', on, { passive: true }); return () => window.removeEventListener('scroll', on); }, []);
  if (!shown) return null;
  return <button class="btn totop" onClick={() => window.scrollTo({ top: 0 })}>Back to top</button>;
}

// Choose the tablet(s) a change applies to. Hidden when the family has one tablet. 'all' is every listed tablet.
function DevicePicker({ devices, value, onChange }: { devices: Device[]; value: string; onChange: (v: string) => void }) {
  if (devices.length < 2) return null;
  return (
    <div class="chips" role="group" aria-label="Which tablet">
      <button class={`chip ${value === 'all' ? 'on' : ''}`} onClick={() => onChange('all')}>Every tablet</button>
      {devices.map((d) => <button key={d.id} class={`chip ${value === d.id ? 'on' : ''}`} onClick={() => onChange(d.id)}>{d.name}</button>)}
    </div>
  );
}

// One click per tablet when a change could go to several of them: the choices are the tablets it applies to, plus
// all of them at once.
function TargetPicker({ devices, label, onPick, onClose }: { devices: Device[]; label: string; onPick: (ids: string[]) => void; onClose: () => void }) {
  return (
    <span class="chips" style={{ marginTop: 0 }}>
      <span class="muted" style={{ alignSelf: 'center' }}>{label}</span>
      {devices.length > 1 && <button class="chip" onClick={() => onPick(devices.map((d) => d.id))}>Every tablet</button>}
      {devices.map((d) => <button key={d.id} class="chip" onClick={() => onPick([d.id])}>{d.name}</button>)}
      <button class="chip" onClick={onClose}>Cancel</button>
    </span>
  );
}

// Every catalog app with the tablets it is on. Install puts it on the home screen; Remove takes it off the tablet and
// out of that tablet's Library until it is installed again. With several tablets the button asks which.
function AppsCard({ catalog, devices, details, onAct, onAsk }: { catalog: CatalogApp[]; devices: Device[]; details: Record<string, DeviceDetail>; onAct: (fn: () => Promise<unknown>) => Promise<void>; onAsk: (title: string) => void }) {
  const filter = useAppFilter(catalog);
  const [picker, setPicker] = useState<{ app: string; action: 'install' | 'remove' } | null>(null);
  const on = (appId: string) => devices.filter((d) => details[d.id].apps.some((a) => a.id === appId));
  const hiddenOn = (appId: string) => devices.filter((d) => details[d.id].hidden.includes(appId) && !details[d.id].apps.some((a) => a.id === appId));
  const run = (appId: string, action: 'install' | 'remove', ids: string[]) => { setPicker(null); return onAct(() => Promise.all(ids.map((id) => action === 'install' ? api.installApp(id, appId) : api.hideApp(id, appId, true)))); };
  const start = (appId: string, action: 'install' | 'remove') => {
    const targets = action === 'install' ? devices.filter((d) => !on(appId).some((x) => x.id === d.id)) : on(appId);
    if (targets.length === 1) run(appId, action, [targets[0].id]); else setPicker({ app: appId, action });
  };
  return (
    <div class="card" id="apps">
      <h2>Apps</h2>
      <p>Every app, with what it trains and how it grows with your child. Install puts an app on a tablet's home screen; Remove takes it off that tablet and out of its Library until you install it again. {devices.length === 0 ? 'Pair a tablet to install apps.' : ''}</p>
      {filter.bar}
      <ul class="list apps">
        {filter.apps.map((a) => {
          const where = on(a.id), hidden = hiddenOn(a.id);
          const status = where.length === devices.length && devices.length > 0 ? (devices.length === 1 ? `On ${where[0].name}` : 'On every tablet') : where.length ? `On ${where.map((d) => d.name).join(', ')}` : hidden.length ? `Removed from ${hidden.map((d) => d.name).join(', ')}` : devices.length ? 'Not on any tablet' : '';
          return (
            <li key={a.id}>
              <a href={`#/app/${a.id}`} class="row" style={{ alignItems: 'center', textDecoration: 'none', color: 'inherit', flex: 1, minWidth: 240 }}>
                {a.tileUrl && <img src={a.tileUrl} alt="" style={{ width: 48, height: 48, borderRadius: 12 }} />}
                <span class="grow"><strong>{a.name}</strong> <span class="muted">{[ageText(a) && `ages ${ageText(a)}`, ...a.subjects].filter(Boolean).join(' · ')}</span><br /><span class="muted">{a.description}</span>{status && <><br /><span class={`muted ${where.length ? 'ok' : ''}`}>{status}</span></>}</span>
              </a>
              {picker?.app === a.id
                ? <TargetPicker devices={picker.action === 'install' ? devices.filter((d) => !where.some((x) => x.id === d.id)) : where} label={picker.action === 'install' ? 'Install on' : 'Remove from'} onPick={(ids) => run(a.id, picker.action, ids)} onClose={() => setPicker(null)} />
                : <span class="row" style={{ flex: 'none' }}>
                  <button class="btn" disabled={devices.length === 0 || where.length === devices.length} onClick={() => start(a.id, 'install')}>Install</button>
                  <button class="btn quiet" disabled={where.length === 0} onClick={() => start(a.id, 'remove')}>Remove</button>
                </span>}
            </li>
          );
        })}
      </ul>
      {catalog.length > 0 && filter.apps.length === 0 && <NoMatch q={filter.q} onAsk={onAsk} />}
    </div>
  );
}

const DURATIONS: [number, string][] = [[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [480, '8 hours'], [1440, '24 hours']];

// Websites the child may open, for one tablet or every tablet, and "every site for a while" for the same scope.
function SitesCard({ devices, details, onAct }: { devices: Device[]; details: Record<string, DeviceDetail>; onAct: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [scope, setScope] = useState('all');
  const [host, setHost] = useState('');
  const [siteName, setSiteName] = useState('');
  const [custom, setCustom] = useState('');
  const [unit, setUnit] = useState<'minutes' | 'hours'>('hours');
  const chosen = scope === 'all' ? devices : devices.filter((d) => d.id === scope);
  // Each host once, with the chosen tablets that allow it.
  const sites = new Map<string, { host: string; tile?: { name: string; url: string }; on: Device[] }>();
  for (const d of chosen) for (const w of details[d.id].allowlist) { const s = sites.get(w.host) ?? { ...w, on: [] }; s.on.push(d); sites.set(w.host, s); }
  const remove = (h: string) => onAct(() => Promise.all(chosen.filter((d) => details[d.id].allowlist.some((w) => w.host === h)).map((d) => api.settings(d.id, { allowlist: details[d.id].allowlist.filter((w) => w.host !== h) }))));
  const add = (e: Event) => {
    e.preventDefault();
    const h = host.trim().toLowerCase(), entry = { host: h, tile: { name: siteName.trim() || host.trim(), url: `https://${h}` } };
    onAct(() => Promise.all(chosen.filter((d) => !details[d.id].allowlist.some((w) => w.host === h)).map((d) => api.settings(d.id, { allowlist: [...details[d.id].allowlist, entry] })))).then(() => { setHost(''); setSiteName(''); });
  };
  const travel = (minutes: number) => onAct(() => Promise.all(chosen.map((d) => api.travel(d.id, minutes))));
  const travelling = chosen.filter((d) => details[d.id].travel.active);
  const minutes = Math.round(Number(custom) * (unit === 'hours' ? 60 : 1));
  return (
    <div class="card" id="websites">
      <h2>Websites</h2>
      <p>Sites the child may open from the home screen. A site name like pbskids.org covers its subpages.{devices.length === 0 ? ' Pair a tablet to allow sites.' : ''}</p>
      <DevicePicker devices={devices} value={scope} onChange={setScope} />
      <ul class="list">
        {[...sites.values()].map((w) => (
          <li key={w.host}><span class="grow">{w.tile?.name ? <strong>{w.tile.name} </strong> : null}<span class="muted">{w.host}{chosen.length > 1 ? ` · ${w.on.length === chosen.length ? 'every tablet' : w.on.map((d) => d.name).join(', ')}` : ''}</span></span>
            <button class="btn quiet" onClick={() => remove(w.host)}>Remove</button></li>
        ))}
      </ul>
      <form class="row" onSubmit={add} style={{ marginTop: sites.size ? 10 : 0 }}>
        <input placeholder="pbskids.org" value={host} onInput={(e) => setHost((e.target as HTMLInputElement).value)} style={{ maxWidth: 220 }} />
        <input placeholder="Name on the tile" value={siteName} onInput={(e) => setSiteName((e.target as HTMLInputElement).value)} style={{ maxWidth: 200 }} />
        <button class="btn" disabled={!host.trim() || chosen.length === 0}>Allow site</button>
      </form>
      <div style={{ marginTop: 14 }}>
        <strong>Allow every site for a while</strong>
        <p class="muted" style={{ margin: '4px 0 8px' }}>For a flight, a hotel, a school project. {travelling.length ? travelling.map((d) => `On until ${new Date(details[d.id].travel.until!).toLocaleString()}${chosen.length > 1 ? ` on ${d.name}` : ''}.`).join(' ') : 'Off.'}</p>
        {travelling.length > 0 && <p><button class="btn quiet" onClick={() => travel(0)}>End now</button></p>}
        {travelling.length < chosen.length && (
          <div class="row" style={{ alignItems: 'center' }}>
            {DURATIONS.map(([m, label]) => <button key={m} class="btn quiet" onClick={() => travel(m)}>{label}</button>)}
            <span class="muted">or</span>
            <input type="number" min={1} max={unit === 'hours' ? 48 : 2880} placeholder="3" value={custom} onInput={(e) => setCustom((e.target as HTMLInputElement).value)} style={{ width: 70 }} />
            <select value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value as 'minutes' | 'hours')} style={{ width: 'auto' }}><option value="minutes">minutes</option><option value="hours">hours</option></select>
            <button class="btn" disabled={!(minutes >= 1 && minutes <= 2880)} onClick={() => travel(minutes)}>Allow</button>
          </div>
        )}
      </div>
    </div>
  );
}

const MINUTES: [number | null, string][] = [[15, '15 min a day'], [30, '30 min a day'], [45, '45 min a day'], [60, '1 hour a day'], [90, '1.5 hours a day'], [120, '2 hours a day'], [null, 'No daily limit']];

// Apps installed outside Duckling, as the tablets report them, grouped by app with the tablets that have it. Allow
// puts the app on a tablet's home screen; its minutes, hours and sites are set per tablet.
function OtherAppsCard({ devices, details, onAct }: { devices: Device[]; details: Record<string, DeviceDetail>; onAct: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [picker, setPicker] = useState<string | null>(null);
  const groups = new Map<string, { label: string; icon: string | null; on: { device: Device; a: OtherApp }[] }>();
  for (const d of devices) for (const a of details[d.id].otherApps) { const g = groups.get(a.package) ?? { label: a.label, icon: a.icon, on: [] }; g.on.push({ device: d, a }); if (!g.icon && a.icon) g.icon = a.icon; groups.set(a.package, g); }
  const allow = (pkg: string, ids: string[]) => { setPicker(null); const g = groups.get(pkg)!; return onAct(() => Promise.all(ids.map((id) => { const cur = g.on.find((x) => x.device.id === id)!.a; return api.otherApp(id, pkg, { allowed: true, dailyMinutes: cur.dailyMinutes ?? 30 }); }))); };
  return (
    <div class="card" id="other-apps">
      <h2>Other apps</h2>
      <p>Apps installed outside Duckling. Allow one and it appears on the tablet's home screen in its own section, for the minutes a day and the hours you set; the websites you list open only while the app has time. While another app is open the lockdown is lifted, and Duckling comes back when the time ends.</p>
      {groups.size === 0 && <p class="muted">{devices.length ? 'No tablet has reported its apps yet; each does at its next sync.' : 'Pair a tablet to see its apps.'}</p>}
      <ul class="list">
        {[...groups.entries()].map(([pkg, g]) => {
          const allowed = g.on.filter((x) => x.a.allowed), rest = g.on.filter((x) => !x.a.allowed);
          return (
            <li key={pkg} style={{ alignItems: 'flex-start' }}>
              {g.icon ? <img src={g.icon} alt="" style={{ width: 40, height: 40, borderRadius: 10 }} /> : <span class="swatch" />}
              <span class="grow">
                <strong>{g.label}</strong> <span class="muted">{devices.length > 1 ? `on ${g.on.map((x) => x.device.name).join(', ')} · ` : ''}{allowed.length ? `allowed on ${allowed.length === g.on.length && g.on.length > 1 ? 'every tablet' : allowed.map((x) => x.device.name).join(', ')}` : 'not shown on the tablet'}</span>
                {allowed.map((x) => <OtherAppSettings key={x.device.id} name={devices.length > 1 ? x.device.name : ''} a={x.a} onSave={(b) => onAct(() => api.otherApp(x.device.id, pkg, b))} />)}
              </span>
              {picker === pkg
                ? <TargetPicker devices={rest.map((x) => x.device)} label="Allow on" onPick={(ids) => allow(pkg, ids)} onClose={() => setPicker(null)} />
                : <button class={`btn ${allowed.length ? 'quiet' : 'primary'}`} disabled={rest.length === 0} onClick={() => rest.length === 1 ? allow(pkg, [rest[0].device.id]) : setPicker(pkg)}>Allow</button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function OtherAppSettings({ name, a, onSave }: { name: string; a: OtherApp; onSave: (b: { allowed?: boolean; dailyMinutes?: number | null; window?: { start: string; end: string } | null; hosts?: string[] }) => void }) {
  const [start, setStart] = useState(a.window?.start ?? '');
  const [end, setEnd] = useState(a.window?.end ?? '');
  const [hosts, setHosts] = useState(a.hosts.join(', '));
  const used = Math.round(a.usedSecondsToday / 60);
  return (
    <div class="other" style={{ marginTop: 8 }}>
      <div class="row" style={{ alignItems: 'center' }}>
        {name && <strong style={{ fontSize: 15 }}>{name}</strong>}
        <span class="muted">{a.dailyMinutes !== null ? `${used} of ${a.dailyMinutes} min used today` : 'no daily limit'}</span>
        <button class="btn quiet" onClick={() => onSave({ allowed: false })}>Remove</button>
      </div>
      <div class="row" style={{ alignItems: 'center', marginTop: 6 }}>
        <select value={String(a.dailyMinutes)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; onSave({ dailyMinutes: v === 'null' ? null : Number(v) }); }} style={{ width: 'auto' }}>
          {MINUTES.map(([m, label]) => <option key={String(m)} value={String(m)}>{label}</option>)}
        </select>
        <span class="muted">between</span>
        <input type="time" value={start} onChange={(e) => setStart((e.target as HTMLInputElement).value)} style={{ width: 'auto' }} />
        <span class="muted">and</span>
        <input type="time" value={end} onChange={(e) => setEnd((e.target as HTMLInputElement).value)} style={{ width: 'auto' }} />
        <button class="btn quiet" disabled={!!start !== !!end} onClick={() => onSave({ window: start && end ? { start, end } : null })}>{start && end ? 'Set hours' : 'Any time'}</button>
      </div>
      <div class="row" style={{ alignItems: 'center', marginTop: 8 }}>
        <input placeholder="Websites it needs, like youtubekids.com, ytimg.com" value={hosts} onInput={(e) => setHosts((e.target as HTMLInputElement).value)} style={{ flex: 1, minWidth: 260 }} />
        <button class="btn quiet" onClick={() => onSave({ hosts: hosts.split(/[,\s]+/).map((h) => h.trim().toLowerCase()).filter(Boolean) })}>Save sites</button>
      </div>
    </div>
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
