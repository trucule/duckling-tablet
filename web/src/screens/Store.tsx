import { catalog, config, installed, installing, installFromStore, removeApp, go } from '../state';
import { shell } from '../shell';

// Every app that is not hidden on this device. Install is free for the child; a parent can hide an app remotely.
export function Store() {
  const hidden = new Set(config.value?.hidden ?? []);
  const apps = catalog.value.filter((a) => !hidden.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div class="screen">
      <div class="topbar">
        <h1>Library</h1>
        <button class="pill" onClick={() => go('home')}>Home</button>
      </div>
      {apps.length === 0 && <div class="card"><p>No apps yet. Check back soon.</p></div>}
      {apps.map((a) => {
        const have = installed.value[a.id];
        const busy = installing.value[a.id];
        const update = have && have !== a.latest.version;
        return (
          <div class="store-row" key={a.id}>
            <div class="art">{a.tileUrl && <img src={a.tileUrl} alt="" />}</div>
            <div>
              <h3>{a.name}</h3>
              <p>{a.description}</p>
              <div class="meta">
                {a.ageMin && a.ageMax ? `Ages ${a.ageMin} to ${a.ageMax}` : ''}{a.subjects?.length ? ` · ${a.subjects.join(', ')}` : ''} · {(a.latest.size / 1048576).toFixed(1)} MB
                {a.latest.permissions?.length ? ` · uses the ${a.latest.permissions.join(' and ')}` : ''}
              </div>
            </div>
            <div class="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              {busy ? <button class="pill" disabled>{busy}</button>
                : have && !update ? <button class="pill primary" onClick={() => shell.openApp(a.id)}>Open</button>
                : <button class="pill primary" onClick={() => installFromStore(a)}>{update ? 'Update' : 'Install'}</button>}
              {have && !busy && <button class="pill quiet" onClick={() => { if (confirm(`Remove ${a.name} from this tablet? Progress is kept.`)) removeApp(a.id); }}>Remove</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
