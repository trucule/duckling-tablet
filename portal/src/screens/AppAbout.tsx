import { tr, trn, setLang } from '../i18n';
import { appName, appDescription, appAbout } from '../apps';
import { useEffect, useState } from 'preact/hooks';
import { api, type CatalogApp, type Family as FamilyT } from '../api';

const SUBJECT: Record<string, string> = { reading: 'Reading', math: 'Math', science: 'Science', art: 'Art', music: 'Music', logic: 'Logic' };

// One app: a short recording of it in action, what it trains, how it grows with the child, the life skills it
// serves, and Install or Remove for each tablet in the family.
export function AppAbout({ id, onBack }: { id: string; onBack: () => void }) {
  const [app, setApp] = useState<CatalogApp | null | undefined>(undefined);
  const [fam, setFam] = useState<FamilyT | null>(null);
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState('');
  const load = () => Promise.all([api.catalog(), api.family()]).then(async ([c, f]) => {
    setApp(c.apps.find((a) => a.id === id) ?? null); setFam(f); setLang(f.language);
    const states: Record<string, boolean> = {};
    for (const d of f.devices.filter((x) => x.state === 'active')) { try { states[d.id] = (await api.device(d.id)).apps.some((a) => a.id === id); } catch { /* a device that cannot be read is left out */ } }
    setInstalled(states);
  }).catch((e) => setMsg((e as Error).message));
  useEffect(() => { load(); }, [id]);

  if (app === undefined) return <div class="card">{tr('Loading')}</div>;
  if (app === null) return <div class="card"><p><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>{tr('Back')}</a></p><p>{tr('That app is not in the catalog.')}</p></div>;
  const about = appAbout(app);
  const ages = app.ageMin && app.ageMax ? tr('Ages {min} to {max}', { min: app.ageMin, max: app.ageMax }) : app.ageMin ? tr('Ages {min} and up', { min: app.ageMin }) : '';
  return (
    <>
      <p><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>{tr('Back')}</a></p>
      <div class="card about">
        {app.demoUrl ? <img class="demo" src={app.demoUrl} alt={tr('{app} in use', { app: appName(app) })}  /> : app.tileUrl ? <img class="demo tile" src={app.tileUrl} alt="" /> : null}
        <div class="row" style={{ alignItems: 'center', marginTop: 14 }}>
          {app.tileUrl && <img src={app.tileUrl} alt="" style={{ width: 56, height: 56, borderRadius: 14 }} />}
          <span class="grow"><h1 style={{ margin: 0 }}>{appName(app)}</h1><span class="muted">{[ages, ...app.subjects.map((s) => tr(SUBJECT[s] ?? s))].filter(Boolean).join(' · ')}</span></span>
        </div>
        <p>{appDescription(app)}</p>
        {about && (
          <>
            <h2>{tr('What it trains')}</h2>
            <p>{about.concept}</p>
            <h2>{tr('How it grows with your child')}</h2>
            <p>{about.progression}</p>
            <h2>{tr('Life skills')}</h2>
            <ul class="skills">{about.lifeSkills.map((s) => <li key={s}>{s}</li>)}</ul>
          </>
        )}
      </div>
      <div class="card">
        <h2>{tr('On your tablets')}</h2>
        {fam && fam.devices.filter((d) => d.state === 'active').length === 0 && <p class="muted">{tr('No tablet is paired yet.')}</p>}
        <ul class="list">
          {fam?.devices.filter((d) => d.state === 'active').map((d) => (
            <li key={d.id}>
              <span class="grow"><strong>{d.name}</strong> <span class="muted">{installed[d.id] ? tr('on this tablet') : tr('not on this tablet')}</span></span>
              {installed[d.id]
                ? <button class="btn quiet" onClick={async () => { try { await api.hideApp(d.id, id, true); setMsg(tr('Removed from {device}.', { device: d.name })); await load(); } catch (e) { setMsg((e as Error).message); } }}>{tr('Remove')}</button>
                : <button class="btn primary" onClick={async () => { try { await api.installApp(d.id, id); setMsg(tr('Installing on {device}.', { device: d.name })); await load(); } catch (e) { setMsg((e as Error).message); } }}>{tr('Install')}</button>}
            </li>
          ))}
        </ul>
        {msg && <p class="muted" style={{ marginTop: 10 }}>{msg}</p>}
      </div>
    </>
  );
}
