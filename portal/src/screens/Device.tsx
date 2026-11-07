import { useEffect, useState } from 'preact/hooks';
import { api, type DeviceDetail, type CatalogApp, type Family as FamilyT, type OtherApp } from '../api';
import { useAppFilter } from '../appfilter';

// One device: child, apps (install or hide), websites, travel mode, release.
export function Device({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<DeviceDetail | null>(null);
  const [fam, setFam] = useState<FamilyT | null>(null);
  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const filter = useAppFilter(catalog);
  const [error, setError] = useState('');
  const [host, setHost] = useState('');
  const [siteName, setSiteName] = useState('');
  const load = () => api.device(id).then(setD).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); api.family().then(setFam).catch(() => {}); api.catalog().then((c) => setCatalog(c.apps)).catch(() => {}); }, [id]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };
  if (!d) return <div class="card">{error ? <div class="error">{error}</div> : 'Loading'}</div>;
  const installed = new Set(d.apps.map((a) => a.id));
  const hidden = new Set(d.hidden);
  const deviceRow = fam?.devices.find((x) => x.id === id);
  return (
    <>
      <p><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>Back to the family</a></p>
      {error && <div class="error" onClick={() => setError('')}>{error}</div>}
      <div class="card">
        <h1>{deviceRow?.name ?? 'Device'}</h1>
        <p>{deviceRow?.platform} · {d.state} · {d.apps.length} apps installed</p>
        <div class="row">
          <label class="field" style={{ margin: 0 }}><span>Child</span>
            <select value={d.child?.id ?? ''} onChange={(e) => act(() => api.renameDevice(id, { childId: (e.target as HTMLSelectElement).value || null }))}>
              <option value="">None</option>
              {fam?.children.map((c) => <option key={c.id} value={c.id}>{c.firstName}</option>)}
            </select>
          </label>
          <button class="btn quiet" onClick={() => { const n = prompt('Device name', deviceRow?.name ?? ''); if (n) act(() => api.renameDevice(id, { name: n })); }}>Rename</button>
        </div>
      </div>

      <div class="card">
        <h2>Apps</h2>
        <p>Installed apps are on the home screen. Hidden apps disappear from this device's Library and home screen until you unhide them. Everything else the child can install from the Library.</p>
        {filter.bar}
        <div class="tiles">
          {filter.apps.map((a) => (
            <span class={`t ${hidden.has(a.id) ? 'off' : ''}`} key={a.id}>
              {a.tileUrl && <img src={a.tileUrl} alt="" />}
              <span>{a.name}{installed.has(a.id) ? ' · installed' : ''}{hidden.has(a.id) ? ' · hidden' : ''} <a href={`#/app/${a.id}`}>About</a></span>
              {!installed.has(a.id) && !hidden.has(a.id) && <button onClick={() => act(() => api.installApp(id, a.id))}>Install</button>}
              <button onClick={() => act(() => api.hideApp(id, a.id, !hidden.has(a.id)))}>{hidden.has(a.id) ? 'Unhide' : 'Hide'}</button>
            </span>
          ))}
        </div>
      </div>

      <div class="card">
        <h2>Websites</h2>
        <p>Sites the child may open from the home screen. A site name like pbskids.org covers its subpages.</p>
        <ul class="list">
          {d.allowlist.map((w) => (
            <li key={w.host}><span class="grow">{w.tile?.name ? <strong>{w.tile.name} </strong> : null}<span class="muted">{w.host}</span></span>
              <button class="btn quiet" onClick={() => act(() => api.settings(id, { allowlist: d.allowlist.filter((x) => x.host !== w.host) }))}>Remove</button></li>
          ))}
        </ul>
        <form class="row" onSubmit={(e) => { e.preventDefault(); act(() => api.settings(id, { allowlist: [...d.allowlist, { host: host.trim().toLowerCase(), tile: { name: siteName.trim() || host.trim(), url: `https://${host.trim().toLowerCase()}` } }] })).then(() => { setHost(''); setSiteName(''); }); }}>
          <input placeholder="pbskids.org" value={host} onInput={(e) => setHost((e.target as HTMLInputElement).value)} style={{ maxWidth: 220 }} />
          <input placeholder="Name on the tile" value={siteName} onInput={(e) => setSiteName((e.target as HTMLInputElement).value)} style={{ maxWidth: 200 }} />
          <button class="btn" disabled={!host.trim()}>Allow site</button>
        </form>
        <div style={{ marginTop: 14 }}>
          <strong>Allow every site for a while</strong>
          <p class="muted" style={{ margin: '4px 0 8px' }}>For a flight, a hotel, a school project. {d.travel.active ? `On until ${new Date(d.travel.until!).toLocaleString()}.` : 'Off.'}</p>
          {d.travel.active
            ? <button class="btn quiet" onClick={() => act(() => api.travel(id, 0))}>End now</button>
            : <TravelPicker onPick={(m) => act(() => api.travel(id, m))} />}
        </div>
      </div>

      <div class="card">
        <h2>Other apps on this tablet</h2>
        <p>Apps installed outside Duckling. Allow one and it appears on the home screen in its own section, for the minutes a day and the hours you set; the websites you list open only while the app has time. While another app is open the lockdown is lifted, and Duckling comes back when the time ends.</p>
        {d.otherApps.length === 0 && <p class="muted">The tablet has not reported its apps yet; it does at its next sync.</p>}
        <ul class="list">
          {d.otherApps.map((a) => <OtherAppRow key={a.package} a={a} onSave={(b) => act(() => api.otherApp(id, a.package, b))} />)}
        </ul>
      </div>

      <div class="card">
        <h2>Remove this tablet</h2>
        <p>Takes the tablet out of the family. The next time it is online (within seconds when it is on), it lifts its lockdown, clears Duckling's apps and data, and offers to uninstall. It can be paired again later with a new code.</p>
        <button class="btn danger" onClick={async () => { if (confirm('Remove this tablet from the family?')) { try { await api.removeDevice(id); onBack(); } catch (e) { setError((e as Error).message); } } }}>Remove this tablet</button>
      </div>
    </>
  );
}


const DURATIONS: [number, string][] = [[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [480, '8 hours'], [1440, '24 hours']];

function TravelPicker({ onPick }: { onPick: (minutes: number) => void }) {
  const [custom, setCustom] = useState('');
  const [unit, setUnit] = useState<'minutes' | 'hours'>('hours');
  const minutes = Math.round(Number(custom) * (unit === 'hours' ? 60 : 1));
  return (
    <div class="row" style={{ alignItems: 'center' }}>
      {DURATIONS.map(([m, label]) => <button key={m} class="btn quiet" onClick={() => onPick(m)}>{label}</button>)}
      <span class="muted">or</span>
      <input type="number" min={1} max={unit === 'hours' ? 48 : 2880} placeholder="3" value={custom} onInput={(e) => setCustom((e.target as HTMLInputElement).value)} style={{ width: 70 }} />
      <select value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value as 'minutes' | 'hours')}><option value="minutes">minutes</option><option value="hours">hours</option></select>
      <button class="btn" disabled={!(minutes >= 1 && minutes <= 2880)} onClick={() => onPick(minutes)}>Allow</button>
    </div>
  );
}

const MINUTES: [number | null, string][] = [[15, '15 min a day'], [30, '30 min a day'], [45, '45 min a day'], [60, '1 hour a day'], [90, '1.5 hours a day'], [120, '2 hours a day'], [null, 'No daily limit']];

function OtherAppRow({ a, onSave }: { a: OtherApp; onSave: (b: { allowed?: boolean; dailyMinutes?: number | null; window?: { start: string; end: string } | null; hosts?: string[] }) => void }) {
  const [start, setStart] = useState(a.window?.start ?? '');
  const [end, setEnd] = useState(a.window?.end ?? '');
  const [hosts, setHosts] = useState(a.hosts.join(', '));
  const used = Math.round(a.usedSecondsToday / 60);
  return (
    <li style={{ alignItems: 'flex-start' }}>
      {a.icon ? <img src={a.icon} alt="" style={{ width: 40, height: 40, borderRadius: 10 }} /> : <span class="swatch" />}
      <span class="grow">
        <strong>{a.label}</strong> <span class="muted">{a.allowed ? (a.dailyMinutes !== null ? `${used} of ${a.dailyMinutes} min used today` : 'allowed, no daily limit') : 'not shown on the tablet'}</span>
        {a.allowed && (
          <div style={{ marginTop: 8 }}>
            <div class="row" style={{ alignItems: 'center' }}>
              <select value={String(a.dailyMinutes)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; onSave({ dailyMinutes: v === 'null' ? null : Number(v) }); }}>
                {MINUTES.map(([m, label]) => <option key={String(m)} value={String(m)}>{label}</option>)}
              </select>
              <span class="muted">between</span>
              <input type="time" value={start} onChange={(e) => setStart((e.target as HTMLInputElement).value)} />
              <span class="muted">and</span>
              <input type="time" value={end} onChange={(e) => setEnd((e.target as HTMLInputElement).value)} />
              <button class="btn quiet" disabled={!!start !== !!end} onClick={() => onSave({ window: start && end ? { start, end } : null })}>{start && end ? 'Set hours' : 'Any time'}</button>
            </div>
            <div class="row" style={{ alignItems: 'center', marginTop: 8 }}>
              <input placeholder="Websites it needs, like youtubekids.com, ytimg.com" value={hosts} onInput={(e) => setHosts((e.target as HTMLInputElement).value)} style={{ flex: 1, minWidth: 260 }} />
              <button class="btn quiet" onClick={() => onSave({ hosts: hosts.split(/[,\s]+/).map((h) => h.trim().toLowerCase()).filter(Boolean) })}>Save sites</button>
            </div>
          </div>
        )}
      </span>
      <button class={`btn ${a.allowed ? 'quiet' : 'primary'}`} onClick={() => onSave({ allowed: !a.allowed, ...(a.allowed ? {} : { dailyMinutes: a.dailyMinutes ?? 30 }) })}>{a.allowed ? 'Remove' : 'Allow'}</button>
    </li>
  );
}
