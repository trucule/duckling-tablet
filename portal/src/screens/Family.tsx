import { tr, trn, lang, setLang, LANGUAGE_NAMES, type Lang } from '../i18n';
import { useEffect, useState } from 'preact/hooks';
import { api, type Family as FamilyT, type Child, type Device, type CatalogApp, type DeviceDetail, type OtherApp, type SiteHost } from '../api';
import { Requests, NoMatch } from './Requests';
import { InstallCard } from '../install';
import { useAppFilter, ageText, SUBJECTS } from '../appfilter';
import { appName, appDescription } from '../apps';
import { siteFromInput, sitesFromList } from '../site';

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
  const [pin, setPin] = useState(''); const [pinAgain, setPinAgain] = useState(''); const [pinMsg, setPinMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [invite, setInvite] = useState(''); const [inviteMsg, setInviteMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const [seed, setSeed] = useState<{ title: string; n: number } | undefined>();
  const [billingBusy, setBillingBusy] = useState(false);
  // Back from Stripe Checkout: the webhook usually lands before the page does; the family reloads to show it.
  const [subscribedNote] = useState(() => new URLSearchParams(location.search).get('subscribed') ? tr('Thank you. The subscription is starting; the tablets pick it up within a minute.') : '');
  const subscribed = !!fam && (fam.subscription.status === 'active' || fam.subscription.status === 'grace');
  const goStripe = async (make: () => Promise<{ url: string }>) => {
    setBillingBusy(true); setError('');
    try { location.href = (await make()).url; } catch (e) { setError((e as Error).message); setBillingBusy(false); }
  };
  const load = async () => {
    try {
      const f = await api.family(); setFam(f); setLang(f.language);
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
  const childName = (id: string | null) => fam?.children.find((c) => c.id === id)?.firstName ?? tr('No child yet');

  const savePin = async (e: Event) => {
    e.preventDefault(); setPinMsg(null);
    if (pin !== pinAgain) { setPinMsg({ ok: false, text: tr('The two PINs were different.') }); return; }
    try { await api.setPin(pin); setPin(''); setPinAgain(''); setPinMsg({ ok: true, text: tr('Saved. Each tablet picks it up at its next check-in, within three hours, or when it is opened.') }); await load(); }
    catch (err) { setPinMsg({ ok: false, text: (err as Error).message }); }
  };
  const sendInvite = async (e: Event) => {
    e.preventDefault(); setInviteMsg(null);
    try { await api.inviteParent(invite.trim()); setInviteMsg({ ok: true, text: tr('Invitation sent to {email}. The link works for 7 days.', { email: invite.trim() }) }); setInvite(''); }
    catch (err) { setInviteMsg({ ok: false, text: (err as Error).message }); }
  };

  if (!fam) return <div class="card">{error ? <div class="error">{error}</div> : tr('Loading')}</div>;
  const active = fam.devices.filter((d) => d.state === 'active' && details[d.id]);
  return (
    <>
      {error && <div class="error" onClick={() => setError('')}>{error}</div>}

      <nav class="sections" aria-label={tr('Sections')}>
        {SECTIONS.map(([id, label]) => <button key={id} class="chip" onClick={() => document.getElementById(id)?.scrollIntoView({ block: 'start' })}>{tr(label)}</button>)}
      </nav>
      <BackToTop />

      <InstallCard />

      <div class="card" id="children">
        <h2>{tr('Children')}</h2>
        {fam.children.length === 0 && <p>{tr('Add your child first: the name shows on the tablet\'s home screen, and the starting level sets where every app begins.')}</p>}
        <ul class="list">
          {fam.children.map((c: Child) => <ChildRow key={c.id} c={c} onChange={load} onError={setError} />)}
        </ul>
        <form class="row" onSubmit={addChild} style={{ marginTop: 12, alignItems: 'center' }}>
          <input placeholder={tr('First name')} required maxLength={30} value={newName} onInput={(e) => setNewName((e.target as HTMLInputElement).value)} style={{ maxWidth: 160 }} />
          <input type="number" min={1} max={16} placeholder={tr('Age')} value={newAge} onInput={(e) => { setNewAge((e.target as HTMLInputElement).value); setNewStart(''); }} style={{ width: 84 }} />
          <label class="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{tr('starts at')}
            <select value={newStart !== '' ? newStart : String(gradeForAge(Number(newAge) || 7))} onChange={(e) => setNewStart((e.target as HTMLSelectElement).value)} style={{ maxWidth: 150 }}>
              {GRADE_SCALE.map(([g, name]) => <option key={g} value={String(g)}>{gradeLevel(name)}</option>)}
            </select>
          </label>
          <select value={newColor} onChange={(e) => setNewColor((e.target as HTMLSelectElement).value)} style={{ maxWidth: 140 }}>{COLORS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <button class="btn" disabled={!newName.trim()}>{tr('Add child')}</button>
        </form>
        <p class="muted" style={{ marginTop: 8 }}>{tr('Every app starts two years below the child\'s age (a 7-year-old starts at kindergarten level) and moves up with each right answer. Change the start here, or one subject at a time on her row.')}</p>
      </div>

      <div class="card" id="devices">
        <h2>{tr('Devices')}</h2>
        <p>{tr('Install Duckling Tablet on the device, open it, and type this code. The code works once and expires in 15 minutes.')}</p>
        <div class="row">
          <select value={codeChild} onChange={(e) => setCodeChild((e.target as HTMLSelectElement).value)} style={{ maxWidth: 220 }}>
            <option value="">{tr('Choose the child later')}</option>
            {fam.children.map((c) => <option key={c.id} value={c.id}>{c.firstName}</option>)}
          </select>
          <button class="btn primary" onClick={makeCode}>{tr('Make a pairing code')}</button>
        </div>
        {code && remaining > 0 && <><div class="code">{code.code}</div><p class="muted" style={{ textAlign: 'center' }}>{tr('Expires in {time}. Refresh to see the new device.', { time: `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` })}</p></>}
        {code && remaining === 0 && <p class="muted">{tr('That code expired. Make a new one.')}</p>}
        {fam.devices.length === 0 && <p style={{ marginTop: 14 }}>{tr('No devices yet.')}</p>}
        <ul class="list" style={{ marginTop: 14 }}>
          {fam.devices.map((d) => (
            <li key={d.id}>
              <span class="grow"><strong>{d.name}</strong> <span class="muted">{d.platform} · {childName(d.childId)} · {tr(d.state)}{details[d.id] ? ' · ' + trn(details[d.id].apps.length, '{n} app', '{n} apps') : ''}{d.lastSeenAt ? ' · ' + tr('seen {when}', { when: new Date(d.lastSeenAt).toLocaleString(lang.value) }) : ''}{d.battery != null ? ` · ${d.battery}%` : ''}</span></span>
              <select value={d.childId ?? ''} onChange={(e) => act(() => api.renameDevice(d.id, { childId: (e.target as HTMLSelectElement).value || null }))} style={{ maxWidth: 160 }} aria-label={tr('Child using {device}', { device: d.name })}>
                <option value="">{tr('No child')}</option>
                {fam.children.map((c) => <option key={c.id} value={c.id}>{c.firstName}</option>)}
              </select>
              <button class="btn quiet" onClick={() => { const n = prompt(tr('Device name'), d.name); if (n) act(() => api.renameDevice(d.id, { name: n })); }}>{tr('Rename')}</button>
              <button class="btn quiet" onClick={() => { if (confirm(tr('Remove {device} from the family? Changes from here stop reaching it and its narrator voice turns off; its apps, PIN and lockdown stay. Its parent area then asks for a new pairing code, so it can join a family again.', { device: d.name }))) act(() => api.removeDevice(d.id)); }}>{tr('Remove')}</button>
            </li>
          ))}
        </ul>
        <p class="muted" style={{ marginTop: 10 }}><button class="btn quiet" onClick={load}>{tr('Refresh')}</button></p>
      </div>

      <AppsCard catalog={catalog} devices={active} details={details} onAct={act} onAsk={(title) => setSeed((s) => ({ title, n: (s?.n ?? 0) + 1 }))} />
      <SitesCard devices={active} details={details} onAct={act} />
      <OtherAppsCard devices={active} details={details} onAct={act} />

      <div id="requests">
        <Requests grades={fam.children.map((c) => c.grade).filter((g): g is string => !!g)} onError={setError} seed={seed} />
      </div>

      <div class="card" id="subscription">
        <h2>{tr('Subscription')}</h2>
        {fam.subscription.status === 'trial' && <p>{tr('Free trial:')} <strong>{trn(fam.subscription.daysLeft ?? 0, '{n} day left', '{n} days left')}</strong>{fam.subscription.periodEnd ? ' ' + tr('(until {date})', { date: new Date(fam.subscription.periodEnd).toLocaleDateString(lang.value) }) : ''}. {tr('After that, $5 a month covers every tablet in the family, on any platform. No card is needed during the trial.')}</p>}
        {fam.subscription.status === 'active' && <p>{fam.subscription.source === 'complimentary' ? tr('Complimentary license: every tablet in the family is covered, with nothing to pay.') : tr('Subscribed. $5 a month covers every tablet in the family.')}</p>}
        {fam.subscription.status === 'grace' && <p class="error">{fam.subscription.source === 'stripe' ? tr('The last payment did not go through. Everything keeps working while Stripe tries the card again; update it under Manage subscription.') : tr('The last payment did not go through. Everything keeps working while the store retries; update the card where you subscribed.')}</p>}
        {(fam.subscription.status === 'ended' || fam.subscription.status === 'none') && <p class="error">{fam.cardPayments ? tr('The free trial has ended, so the tablets are locked. Subscribe here with a card, or in the parent area of an iPad or Android tablet (the Parent button on its home screen); one subscription covers every tablet in the family.') : tr('The free trial has ended, so the tablets are locked. Subscribe in the parent area of an iPad or Android tablet (the Parent button on its home screen); one subscription covers every tablet in the family.')}</p>}
        {fam.cardPayments && (subscribed ? fam.subscription.source === 'stripe' : true) && (
          <>
            <div class="row">
              {!subscribed && <button class="btn primary" disabled={billingBusy} onClick={() => goStripe(api.stripeCheckout)}>{tr('Subscribe with a card, $5 a month')}</button>}
              {fam.cardCustomer && <button class="btn quiet" disabled={billingBusy} onClick={() => goStripe(api.stripePortal)}>{tr('Manage subscription')}</button>}
            </div>
            {!subscribed && <p class="muted">{fam.subscription.status === 'trial' ? tr('Billed by card through Stripe, starting when the free trial ends. It renews each month until you cancel under Manage subscription.') : tr('Billed by card through Stripe. It renews each month until you cancel under Manage subscription.')} <a href="https://ducklingtablet.com/terms">{tr('Terms')}</a> · <a href="https://ducklingtablet.com/privacy">{tr('Privacy')}</a></p>}
          </>
        )}
        {subscribed && fam.subscription.source && fam.subscription.source !== 'stripe' && <p class="muted">{fam.subscription.source === 'apple' ? tr('Billed through the App Store. Manage or cancel it in the Settings app on the iPad, under your name, then Subscriptions.') : tr('Billed through Google Play. Manage or cancel it in the Play Store app, under Payments and subscriptions.')}</p>}
        {subscribedNote && <p>{subscribedNote}</p>}
        <p class="muted">{tr('Included: every learning app and every new one, the narrator voice, the avatar and stars across tablets, this portal, and app requests at no extra cost (above).')}</p>
      </div>

      <div class="card" id="pin">
        <h2>{tr('Parent PIN')}</h2>
        <p>{fam.pinSet ? tr('A PIN is set. It opens the parent area on every tablet in the family. Choose a new one here if it needs changing.') : tr('No PIN yet. The first tablet asks for one during setup, or set it here and every tablet uses it.')}</p>
        <form class="row" onSubmit={savePin}>
          <input type="password" inputMode="numeric" pattern="[0-9]{4,6}" placeholder={fam.pinSet ? tr('New PIN') : tr('PIN (4 to 6 digits)')} required value={pin} onInput={(e) => setPin((e.target as HTMLInputElement).value)} style={{ maxWidth: 170 }} autoComplete="off" />
          <input type="password" inputMode="numeric" pattern="[0-9]{4,6}" placeholder={tr('Again')} required value={pinAgain} onInput={(e) => setPinAgain((e.target as HTMLInputElement).value)} style={{ maxWidth: 120 }} autoComplete="off" />
          <button class="btn" disabled={pin.length < 4}>{fam.pinSet ? tr('Change PIN') : tr('Set PIN')}</button>
        </form>
        {pinMsg && <p class={pinMsg.ok ? 'ok' : 'error'} style={{ marginTop: 10 }}>{pinMsg.text}</p>}
      </div>

      <div class="card" id="parents">
        <h2>{tr('Parents')}</h2>
        <ul class="list">
          {fam.parents.map((p) => (
            <li key={p.id}>
              <span class="grow"><strong>{p.email}</strong> <span class="muted">{p.email === fam.you ? tr('you') : tr(p.role)}</span></span>
              {p.email !== fam.you && <button class="btn quiet" onClick={() => { if (confirm(tr('Remove {email} from the family?', { email: p.email }))) act(() => api.removeParent(p.id)); }}>{tr('Remove')}</button>}
            </li>
          ))}
        </ul>
        {fam.parents.length < 4 && (
          <form class="row" onSubmit={sendInvite} style={{ marginTop: 12 }}>
            <input type="email" placeholder={tr('Another parent\'s email')} required value={invite} onInput={(e) => setInvite((e.target as HTMLInputElement).value)} style={{ maxWidth: 280 }} />
            <button class="btn" disabled={!invite.includes('@')}>{tr('Invite')}</button>
          </form>
        )}
        {inviteMsg && <p class={inviteMsg.ok ? 'ok' : 'error'} style={{ marginTop: 10 }}>{inviteMsg.text}</p>}
      </div>

      <div class="card" id="account">
        <h2>{tr('Account')}</h2>
        <LanguageChoice value={fam.language ?? 'en'} onChange={(l) => act(() => api.setLanguage(l))} />
        <p>{tr('Signed in as {email}. Deleting the account releases every device first, then removes every record.', { email: fam.you })}</p>
        <div class="row">
          {fam.stats && <a class="btn" href="#/stats">{tr('Stats')}</a>}
          <button class="btn quiet" onClick={async () => { await api.logout().catch(() => {}); location.reload(); }}>{tr('Sign out')}</button>
          <button class="btn danger" onClick={async () => { if (prompt(tr('Type DELETE to remove the family account and all its data.')) === tr('DELETE')) { await api.deleteFamily(); location.reload(); } }}>{tr('Delete account and all data')}</button>
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
  return <button class="btn totop" onClick={() => window.scrollTo({ top: 0 })}>{tr('Back to top')}</button>;
}

// Choose the tablet(s) a change applies to. Hidden when the family has one tablet. 'all' is every listed tablet.
function DevicePicker({ devices, value, onChange }: { devices: Device[]; value: string; onChange: (v: string) => void }) {
  if (devices.length < 2) return null;
  return (
    <div class="chips" role="group" aria-label={tr('Which tablet')}>
      <button class={`chip ${value === 'all' ? 'on' : ''}`} onClick={() => onChange('all')}>{tr('Every tablet')}</button>
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
      {devices.length > 1 && <button class="chip" onClick={() => onPick(devices.map((d) => d.id))}>{tr('Every tablet')}</button>}
      {devices.map((d) => <button key={d.id} class="chip" onClick={() => onPick([d.id])}>{d.name}</button>)}
      <button class="chip" onClick={onClose}>{tr('Cancel')}</button>
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
      <h2>{tr('Apps')}</h2>
      <p>{tr("Every app, with what it trains and how it grows with your child. Install puts an app on a tablet's home screen; Remove takes it off that tablet and out of its Library until you install it again.")} {devices.length === 0 ? tr('Pair a tablet to install apps.') : ''}</p>
      {filter.bar}
      <ul class="list apps">
        {filter.apps.map((a) => {
          const where = on(a.id), hidden = hiddenOn(a.id);
          const status = where.length === devices.length && devices.length > 0 ? (devices.length === 1 ? tr('On {devices}', { devices: where[0].name }) : tr('On every tablet')) : where.length ? tr('On {devices}', { devices: where.map((d) => d.name).join(', ') }) : hidden.length ? tr('Removed from {devices}', { devices: hidden.map((d) => d.name).join(', ') }) : devices.length ? tr('Not on any tablet') : '';
          return (
            <li key={a.id}>
              <a href={`#/app/${a.id}`} class="row" style={{ alignItems: 'center', textDecoration: 'none', color: 'inherit', flex: 1, minWidth: 240 }}>
                {a.tileUrl && <img src={a.tileUrl} alt="" style={{ width: 48, height: 48, borderRadius: 12 }} />}
                <span class="grow"><strong>{appName(a)}</strong> <span class="muted">{[ageText(a), ...a.subjects.map((id) => tr(SUBJECTS.find((x) => x[0] === id)?.[1] ?? id))].filter(Boolean).join(' · ')}</span><br /><span class="muted">{appDescription(a)}</span>{status && <><br /><span class={`muted ${where.length ? 'ok' : ''}`}>{status}</span></>}</span>
              </a>
              {picker?.app === a.id
                ? <TargetPicker devices={picker.action === 'install' ? devices.filter((d) => !where.some((x) => x.id === d.id)) : where} label={picker.action === 'install' ? tr('Install on') : tr('Remove from')} onPick={(ids) => run(a.id, picker.action, ids)} onClose={() => setPicker(null)} />
                : <span class="row" style={{ flex: 'none' }}>
                  <button class="btn" disabled={devices.length === 0 || where.length === devices.length} onClick={() => start(a.id, 'install')}>{tr('Install')}</button>
                  <button class="btn quiet" disabled={where.length === 0} onClick={() => start(a.id, 'remove')}>{tr('Remove')}</button>
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
  const [tile, setTile] = useState(true);
  const [custom, setCustom] = useState('');
  const [unit, setUnit] = useState<'minutes' | 'hours'>('hours');
  const chosen = scope === 'all' ? devices : devices.filter((d) => d.id === scope);
  // Each host once, with the chosen tablets that allow it.
  const sites = new Map<string, { host: string; tile?: { name: string; url: string }; on: Device[] }>();
  for (const d of chosen) for (const w of details[d.id].allowlist) { const s = sites.get(w.host) ?? { ...w, on: [] }; s.on.push(d); sites.set(w.host, s); }
  const remove = (h: string) => onAct(() => Promise.all(chosen.filter((d) => details[d.id].allowlist.some((w) => w.host === h)).map((d) => api.settings(d.id, { allowlist: details[d.id].allowlist.filter((w) => w.host !== h) }))));
  const [bad, setBad] = useState('');
  // A site name or a pasted address: the tile opens the page that was pasted, the allowlist names the site.
  const add = (e: Event) => {
    e.preventDefault();
    const site = siteFromInput(host);
    if (!site) { setBad(tr('"{text}" is not a website. Type a site name like kleki.com or paste the address from the browser.', { text: host.trim() })); return; }
    setBad('');
    const h = site.host, entry = tile ? { host: h, tile: { name: (siteName.trim() || h).slice(0, 40), url: site.url } } : { host: h };
    onAct(() => Promise.all(chosen.filter((d) => !details[d.id].allowlist.some((w) => w.host === h)).map((d) => api.settings(d.id, { allowlist: [...details[d.id].allowlist, entry] })))).then(() => { setHost(''); setSiteName(''); setTile(true); });
  };
  const travel = (minutes: number) => onAct(() => Promise.all(chosen.map((d) => api.travel(d.id, minutes))));
  const travelling = chosen.filter((d) => details[d.id].travel.active);
  const minutes = Math.round(Number(custom) * (unit === 'hours' ? 60 : 1));
  return (
    <div class="card" id="websites">
      <h2>{tr('Websites')}</h2>
      <p>{tr('Sites the child may open from the home screen. A site name like pbskids.org covers its subpages and subdomains. A site that loads its videos or pictures from another address needs that address allowed too, without a tile.')}{devices.length === 0 ? ' ' + tr('Pair a tablet to allow sites.') : ''}</p>
      <DevicePicker devices={devices} value={scope} onChange={setScope} />
      <ul class="list">
        {[...sites.values()].map((w) => (
          <li key={w.host}><span class="grow">{w.tile?.name ? <strong>{w.tile.name} </strong> : null}<span class="muted">{w.host}{w.tile ? '' : ' · ' + tr('no tile, used by other sites')}{chosen.length > 1 ? ' · ' + (w.on.length === chosen.length ? tr('every tablet') : w.on.map((d) => d.name).join(', ')) : ''}</span></span>
            <button class="btn quiet" onClick={() => remove(w.host)}>{tr('Remove')}</button></li>
        ))}
      </ul>
      <form class="row" onSubmit={add} style={{ marginTop: sites.size ? 10 : 0 }}>
        <input placeholder="pbskids.org" aria-label={tr('Website')} value={host} onInput={(e) => { setHost((e.target as HTMLInputElement).value); setBad(''); }} style={{ maxWidth: 220 }} />
        {tile && <input placeholder={tr('Name on the tile')} aria-label={tr('Name on the tile')} maxLength={40} value={siteName} onInput={(e) => setSiteName((e.target as HTMLInputElement).value)} style={{ maxWidth: 200 }} />}
        <label class="row" style={{ alignItems: 'center', gap: 6 }}><input type="checkbox" checked={tile} onChange={(e) => setTile((e.target as HTMLInputElement).checked)} style={{ width: 'auto' }} />{tr('Tile on the home screen')}</label>
        <button class="btn" disabled={!host.trim() || chosen.length === 0}>{tr('Allow site')}</button>
      </form>
      {bad && <p class="error" role="alert">{bad}</p>}
      <BlockedAddresses devices={chosen} />
      <div style={{ marginTop: 14 }}>
        <strong>{tr('Allow every site for a while')}</strong>
        <p class="muted" style={{ margin: '4px 0 8px' }}>{tr('For a flight, a hotel, a school project.')} {travelling.length ? travelling.map((d) => chosen.length > 1 ? tr('On until {when} on {device}.', { when: new Date(details[d.id].travel.until!).toLocaleString(lang.value), device: d.name }) : tr('On until {when}.', { when: new Date(details[d.id].travel.until!).toLocaleString(lang.value) })).join(' ') : tr('Off.')}</p>
        {travelling.length > 0 && <p><button class="btn quiet" onClick={() => travel(0)}>{tr('End now')}</button></p>}
        {travelling.length < chosen.length && (
          <div class="row" style={{ alignItems: 'center' }}>
            {DURATIONS.map(([m, label]) => <button key={m} class="btn quiet" onClick={() => travel(m)}>{label}</button>)}
            <span class="muted">{tr('or')}</span>
            <input type="number" min={1} max={unit === 'hours' ? 48 : 2880} placeholder="3" value={custom} onInput={(e) => setCustom((e.target as HTMLInputElement).value)} style={{ width: 70 }} />
            <select value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value as 'minutes' | 'hours')} style={{ width: 'auto' }}><option value="minutes">{tr('minutes')}</option><option value="hours">{tr('hours')}</option></select>
            <button class="btn" disabled={!(minutes >= 1 && minutes <= 2880)} onClick={() => travel(minutes)}>{tr('Allow')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

// Addresses an allowed website asked for and a tablet blocked (a video's playlist on another domain, a picture server),
// reported by the tablets. Allowing one lets it through on that tablet while its website is allowed, with no tile.
// Advertising and analytics addresses are folded away.
function BlockedAddresses({ devices }: { devices: Device[] }) {
  const [lists, setLists] = useState<Record<string, SiteHost[]>>({});
  const [showTrackers, setShowTrackers] = useState(false);
  const [error, setError] = useState('');
  const ids = devices.map((d) => d.id).join(',');
  useEffect(() => {
    let live = true;
    Promise.all(devices.map(async (d) => [d.id, (await api.siteHosts(d.id)).siteHosts] as const))
      .then((all) => { if (live) setLists(Object.fromEntries(all)); })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [ids]);
  const decide = async (d: Device, h: SiteHost, decision: SiteHost['decision']) => {
    setError('');
    try { const r = await api.decideSiteHost(d.id, h.site, h.host, decision); setLists({ ...lists, [d.id]: r.siteHosts }); }
    catch (e) { setError((e as Error).message); }
  };
  const rows = devices.flatMap((d) => (lists[d.id] ?? []).map((h) => ({ d, h })));
  const shown = rows.filter(({ h }) => !h.tracker || showTrackers || h.decision === 'allowed');
  const trackers = rows.filter(({ h }) => h.tracker && h.decision !== 'allowed').length;
  if (!rows.length && !error) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <strong>{tr('Blocked addresses')}</strong>
      <p class="muted" style={{ margin: '4px 0 8px' }}>{tr('Addresses the allowed sites asked for and the tablet blocked. A video that does not play often needs one of them. Allow one only if it belongs to the site or a service you trust.')}</p>
      <ul class="list">
        {shown.map(({ d, h }) => (
          <li key={`${d.id} ${h.site} ${h.host}`}>
            <span class="grow"><strong>{h.host}</strong> <span class="muted">{[tr('for {site}', { site: h.site }), h.media ? tr('video') : '', h.tracker ? tr('advertising or analytics') : '', devices.length > 1 ? d.name : '', h.decision === 'allowed' ? tr('allowed') : h.decision === 'blocked' ? tr('kept blocked') : ''].filter(Boolean).join(' · ')}</span></span>
            {h.decision !== 'allowed' && <button class="btn" onClick={() => decide(d, h, 'allowed')}>{tr('Allow')}</button>}
            {h.decision !== 'blocked' && <button class="btn quiet" onClick={() => decide(d, h, 'blocked')}>{h.decision === 'allowed' ? tr('Block') : tr('Keep blocked')}</button>}
          </li>
        ))}
      </ul>
      {trackers > 0 && <p><button class="btn quiet" onClick={() => setShowTrackers(!showTrackers)}>{showTrackers ? tr('Hide advertising and analytics') : trn(trackers, 'Show {n} advertising or analytics address', 'Show {n} advertising and analytics addresses')}</button></p>}
      {error && <p class="error" role="alert">{error}</p>}
    </div>
  );
}

// The family's language: this portal, the emails, and every tablet whose child has no language of her own (set per child
// under Children). Each choice is written in its own language.
function LanguageChoice({ value, onChange }: { value: Lang; onChange: (l: Lang) => void }) {
  return (
    <div class="row" style={{ alignItems: 'center', marginBottom: 12 }} role="group" aria-label={tr('Language')}>
      <span class="muted">{tr('Language')}</span>
      {(Object.keys(LANGUAGE_NAMES) as Lang[]).map((l) => <button key={l} lang={l} class={`chip ${value === l ? 'on' : ''}`} aria-pressed={value === l} onClick={() => value !== l && onChange(l)}>{LANGUAGE_NAMES[l]}</button>)}
      <span class="muted">{tr('For this portal, the emails and the tablets. A child can have her own under Children.')}</span>
    </div>
  );
}

const MINUTES: [number | null, string][] = [[15, '15 min a day'], [30, '30 min a day'], [45, '45 min a day'], [60, '1 hour a day'], [90, '1.5 hours a day'], [120, '2 hours a day'], [null, 'No daily limit']];

// Apps installed outside Duckling, as each tablet reports them: a tab per tablet, since tablets have different apps.
// Allow puts an app on that tablet's home screen; its minutes, hours and sites are set under it.
function OtherAppsCard({ devices, details, onAct }: { devices: Device[]; details: Record<string, DeviceDetail>; onAct: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [chosen, setChosen] = useState<string>('');
  const device = devices.find((d) => d.id === chosen) ?? devices[0];
  const apps = device ? details[device.id].otherApps : [];
  return (
    <div class="card" id="other-apps">
      <h2>{tr('Other apps')}</h2>
      <p>{tr("Apps installed outside Duckling, as each tablet reports them. Allow one and it appears on that tablet's home screen in its own section, for the minutes a day and the hours you set; the websites you list open only while the app has time. While another app is open the lockdown is lifted, and Duckling comes back when the time ends.")}</p>
      {devices.length > 1 && (
        <div class="chips" role="tablist" aria-label={tr('Which tablet')}>
          {devices.map((d) => <button key={d.id} role="tab" aria-selected={device?.id === d.id} class={`chip ${device?.id === d.id ? 'on' : ''}`} onClick={() => setChosen(d.id)}>{d.name}</button>)}
        </div>
      )}
      {!device && <p class="muted">{tr('Pair a tablet to see its apps.')}</p>}
      {device?.platform === 'ios' && <IpadOtherApps device={device} apps={apps} />}
      {device && device.platform !== 'ios' && apps.length === 0 && <p class="muted">{tr('{device} has not reported its apps yet; it does at its next sync.', { device: device.name })}</p>}
      {device && device.platform !== 'ios' && (
        <ul class="list">
          {apps.map((a) => (
            <li key={a.package} style={{ alignItems: 'flex-start' }}>
              {a.icon ? <img src={a.icon} alt="" style={{ width: 40, height: 40, borderRadius: 10 }} /> : <span class="swatch" />}
              <span class="grow">
                <strong>{a.label}</strong> <span class="muted">{a.allowed ? tr('on the home screen') : tr('not shown on the tablet')}</span>
                {a.allowed && <OtherAppSettings name="" a={a} onSave={(b) => onAct(() => api.otherApp(device.id, a.package, b))} />}
              </span>
              {!a.allowed && <button class="btn primary" onClick={() => onAct(() => api.otherApp(device.id, a.package, { allowed: true, dailyMinutes: a.dailyMinutes ?? 30 }))}>{tr('Allow')}</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The iPad does not tell apps apart to anyone but itself (Screen Time hands Duckling opaque tokens, no names), so the
// parent picks and times them on the iPad and the portal shows the count and the minutes.
function IpadOtherApps({ device, apps }: { device: Device; apps: OtherApp[] }) {
  const allowed = apps.filter((a) => a.allowed);
  return (
    <>
      <p class="muted">{tr('On an iPad the apps are chosen on the iPad itself: open the parent area there, then Other apps, then Choose apps. The iPad names its apps only to itself, so this list shows the allowance of each one and not its name. Screen Time applies the minutes and the child opens the apps from the iPad home screen.')}</p>
      {allowed.length === 0 && <p class="muted">{tr('{device} has no other apps allowed.', { device: device.name })}</p>}
      {allowed.length > 0 && (
        <ul class="list">
          {allowed.map((a) => (
            <li key={a.package}>
              <span class="swatch" />
              <span class="grow"><strong>{tr('App chosen on the iPad')}</strong> <span class="muted">{a.dailyMinutes !== null ? tr('{n} min a day', { n: a.dailyMinutes }) : tr('no daily limit')}</span></span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function OtherAppSettings({ name, a, onSave }: { name: string; a: OtherApp; onSave: (b: { allowed?: boolean; dailyMinutes?: number | null; window?: { start: string; end: string } | null; hosts?: string[] }) => void }) {
  const [start, setStart] = useState(a.window?.start ?? '');
  const [end, setEnd] = useState(a.window?.end ?? '');
  const [hosts, setHosts] = useState(a.hosts.join(', '));
  const [badHosts, setBadHosts] = useState<string[]>([]);
  const used = Math.round(a.usedSecondsToday / 60);
  return (
    <div class="other" style={{ marginTop: 8 }}>
      <div class="row" style={{ alignItems: 'center' }}>
        {name && <strong style={{ fontSize: 15 }}>{name}</strong>}
        <span class="muted">{a.dailyMinutes !== null ? tr('{used} of {limit} min used today', { used, limit: a.dailyMinutes }) : tr('no daily limit')}</span>
        <button class="btn quiet" onClick={() => onSave({ allowed: false })}>{tr('Remove')}</button>
      </div>
      <div class="row" style={{ alignItems: 'center', marginTop: 6 }}>
        <select value={String(a.dailyMinutes)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; onSave({ dailyMinutes: v === 'null' ? null : Number(v) }); }} style={{ width: 'auto' }}>
          {MINUTES.map(([m, label]) => <option key={String(m)} value={String(m)}>{tr(label)}</option>)}
        </select>
        <span class="muted">{tr('between')}</span>
        <input type="time" value={start} onChange={(e) => setStart((e.target as HTMLInputElement).value)} style={{ width: 'auto' }} />
        <span class="muted">{tr('and')}</span>
        <input type="time" value={end} onChange={(e) => setEnd((e.target as HTMLInputElement).value)} style={{ width: 'auto' }} />
        <button class="btn quiet" disabled={!!start !== !!end} onClick={() => onSave({ window: start && end ? { start, end } : null })}>{start && end ? tr('Set hours') : tr('Any time')}</button>
      </div>
      <div class="row" style={{ alignItems: 'center', marginTop: 8 }}>
        <input placeholder={tr('Websites it needs, like youtubekids.com, ytimg.com')} value={hosts} onInput={(e) => setHosts((e.target as HTMLInputElement).value)} style={{ flex: 1, minWidth: 260 }} />
        <button class="btn quiet" onClick={() => { const r = sitesFromList(hosts); setBadHosts(r.bad); if (!r.bad.length) { setHosts(r.hosts.join(', ')); onSave({ hosts: r.hosts }); } }}>{tr('Save sites')}</button>
      </div>
      {badHosts.length > 0 && <p class="error" role="alert">{tr('Not websites: {names}. Use site names like youtubekids.com.', { names: badHosts.join(', ') })}</p>}
    </div>
  );
}


// Difficulty is one grade scale for every subject: pre-K to 8th. A child starts two years below her age.
// Short names, looked up with tr() when shown; a level is "{grade} level".
export const GRADE_SCALE: [number, string][] = [[-1, 'Pre-K'], [0, 'Kindergarten'], [1, '1st grade'], [2, '2nd grade'], [3, '3rd grade'], [4, '4th grade'], [5, '5th grade'], [6, '6th grade'], [7, '7th grade'], [8, '8th grade']];
export const gradeLevel = (name: string) => tr('{grade} level', { grade: tr(name) });
export const gradeForAge = (age: number) => Math.max(-1, Math.min(8, Math.round(age) - 7));
const SUBJECT_NAMES: [string, string][] = [['reading', 'Reading'], ['math', 'Math'], ['science', 'Science'], ['logic', 'Logic'], ['art', 'Art'], ['music', 'Music']];
const gradeName = (g: number) => GRADE_SCALE.find((x) => x[0] === g)?.[1] ?? '';

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
        <strong>{c.firstName}</strong> <span class="muted">{[c.age ? tr('age {n}', { n: c.age }) : '', same ? gradeLevel(gradeName(values[0])) : values.length ? tr('mixed levels') : '', c.stars ? tr('{earned} stars earned, {balance} to spend', { earned: c.stars.earned, balance: c.stars.balance }) : '', c.language ? tr('speaks {language}', { language: LANGUAGE_NAMES[c.language] }) : ''].filter(Boolean).join(' · ')}</span>
        {open && (
          <div style={{ marginTop: 8 }}>
            <div class="row" style={{ alignItems: 'center' }}>
              <span class="muted">{tr('Age')}</span>
              <input type="number" min={1} max={16} value={c.age ?? ''} onChange={(e) => { const v = Number((e.target as HTMLInputElement).value); if (v) save({ age: v }); }} style={{ width: 70 }} />
              <span class="muted">{tr('Every subject')}</span>
              <select value={same ? String(values[0]) : ''} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v !== '') save({ startGrade: Number(v) }); }}>
                {!same && <option value="">{tr('mixed')}</option>}
                {GRADE_SCALE.map(([g, name]) => <option key={g} value={String(g)}>{gradeLevel(name)}</option>)}
              </select>
            </div>
            <div class="row" style={{ alignItems: 'center', marginTop: 6 }}>
              <span class="muted">{tr('Language')}</span>
              <select style={{ width: 'auto' }} aria-label={tr('Language')} value={c.language ?? ''} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; save({ language: v === '' ? null : v as Lang }); }}>
                <option value="">{tr("The family's")}</option>
                {(Object.keys(LANGUAGE_NAMES) as Lang[]).map((l) => <option key={l} value={l} lang={l}>{LANGUAGE_NAMES[l]}</option>)}
              </select>
            </div>
            <div class="row" style={{ alignItems: 'center', marginTop: 6 }}>
              {SUBJECT_NAMES.map(([id, name]) => (
                <label key={id} class="muted" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{tr(name)}
                  <select value={String(levels[id] ?? 0)} onChange={(e) => save({ levels: { [id]: Number((e.target as HTMLSelectElement).value) } })}>
                    {GRADE_SCALE.map(([g, gn]) => <option key={g} value={String(g)}>{tr(gn)}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <p class="muted" style={{ marginTop: 6 }}>{tr('Apps already in progress keep their place; the level sets where a new app starts.')}</p>
          </div>
        )}
      </span>
      <button class="btn quiet" onClick={() => setOpen(!open)}>{open ? tr('Done') : tr('Levels')}</button>
      <button class="btn quiet" onClick={async () => { if (confirm(tr("Remove {name}'s profile?", { name: c.firstName }))) { await api.deleteChild(c.id); onChange(); } }}>{tr('Remove')}</button>
    </li>
  );
}
