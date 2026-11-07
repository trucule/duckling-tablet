import { useEffect, useState } from 'preact/hooks';
import { api, type DeviceDetail, type CatalogApp, type Family as FamilyT } from '../api';
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
        <p class="muted" style={{ marginTop: 12 }}>Travel mode: {d.travel.active ? `on until ${new Date(d.travel.until!).toLocaleTimeString()}` : 'off'}.
          <button class="btn quiet" style={{ marginLeft: 8 }} onClick={() => act(() => api.travel(id, d.travel.active ? 0 : 6))}>{d.travel.active ? 'End now' : 'Allow every site for 6 hours'}</button></p>
      </div>

      <div class="card">
        <h2>Remove this tablet</h2>
        <p>Takes the tablet out of the family. The next time it is online (within seconds when it is on), it lifts its lockdown, clears Duckling's apps and data, and offers to uninstall. It can be paired again later with a new code.</p>
        <button class="btn danger" onClick={async () => { if (confirm('Remove this tablet from the family?')) { try { await api.removeDevice(id); onBack(); } catch (e) { setError((e as Error).message); } } }}>Remove this tablet</button>
      </div>
    </>
  );
}
