import { tr } from '../i18n';
import { catalog, config, installed, installing, installFromStore, removeApp, go, openApp } from '../state';

// Every app that is not hidden on this device. Install is free for the child; a parent can hide an app remotely.
export function Store() {
  const hidden = new Set(config.value?.hidden ?? []);
  const apps = catalog.value.filter((a) => !hidden.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div class="screen">
      <div class="topbar">
        <h1>{tr('Library')}</h1>
        <button class="pill" onClick={() => go('home')}>{tr('Home')}</button>
      </div>
      {apps.length === 0 && <div class="card"><p>{tr('No apps yet. Check back soon.')}</p></div>}
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
                {a.ageMin && a.ageMax ? tr('Ages {min} to {max}', { min: a.ageMin, max: a.ageMax }) : ''}{a.subjects?.length ? ` · ${a.subjects.map((s) => tr(s)).join(', ')}` : ''} · {(a.latest.size / 1048576).toFixed(1)} MB
                {a.latest.permissions?.length ? ` · ${tr(a.latest.permissions.length > 1 ? 'uses the microphone and camera' : `uses the ${a.latest.permissions[0]}`)}` : ''}
              </div>
            </div>
            <div class="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              {busy ? <button class="pill" disabled>{tr(busy)}</button>
                : have && !update ? <button class="pill primary" onClick={() => openApp(a.id)}>{tr('Open')}</button>
                : <button class="pill primary" onClick={() => installFromStore(a)}>{update ? tr('Update') : tr('Install')}</button>}
              {have && !busy && <button class="pill quiet" onClick={() => { if (confirm(tr('Remove {app} from this tablet? Progress is kept.', { app: a.name }))) removeApp(a.id); }}>{tr('Remove')}</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
