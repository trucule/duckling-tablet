import { tr, lang, LANGUAGE_NAMES, type Lang } from '../i18n';
import { useEffect, useState } from 'preact/hooks';
import { api, type Stats as StatsT } from '../api';

// The owner's view across every family: counts and sums only. Offered to the parents named in STATS_EMAILS.
export function Stats({ onBack }: { onBack: () => void }) {
  const [s, setS] = useState<StatsT | null>(null);
  const [error, setError] = useState('');
  const load = () => api.stats().then((r) => { setS(r); setError(''); }).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); }, []);

  const back = <p><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>{tr('Back')}</a></p>;
  if (!s) return <>{back}<div class="card">{error ? <div class="error">{error}</div> : tr('Loading')}</div></>;

  const num = (v: number) => v.toLocaleString(lang.value);
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '–');
  const STATUS: Record<string, string> = { trial: tr('Trial'), active: tr('Paying'), grace: tr('Payment retrying'), ended: tr('Ended'), none: tr('No subscription') };
  const SOURCE: Record<string, string> = { trial: '–', google: 'Google Play', apple: 'App Store', stripe: tr('Card') };
  const PLATFORM: Record<string, string> = { android: 'Android', ios: 'iPad', windows: 'Windows', web: tr('Browser') };
  const REQUEST: Record<string, string> = { requested: tr('Received'), planned: tr('Planned'), building: tr('Being built'), declined: tr('Not taken on'), shipped: tr('Finished') };
  const SUBJECT: Record<string, string> = { reading: tr('Reading'), math: tr('Math'), science: tr('Science'), logic: tr('Logic'), art: tr('Art'), music: tr('Music') };
  const grade = (g: number) => (g < 0 ? tr('Pre-K') : g === 0 ? tr('K') : String(g));

  const minutes7 = s.apps.reduce((t, a) => t + a.minutes7, 0);
  const plays = s.voice.clips + s.voice.hits;
  const subjects = [...new Set(s.levels.map((l) => l.subject))];

  return (
    <>
      {back}
      <div class="card">
        <div class="row"><h1 class="grow" style={{ margin: 0 }}>{tr('Stats')}</h1><button class="btn quiet" onClick={load}>{tr('Refresh')}</button></div>
        <p class="muted" style={{ marginTop: 6 }}>{tr('Every family, counted together. As of {time}.', { time: new Date(s.at).toLocaleString(lang.value) })}</p>
        {error && <div class="error">{error}</div>}
        <div class="kpis">
          <Kpi value={num(s.families.total)} label={tr('Families')} note={tr('{n} new this week', { n: num(s.families.new7) })} />
          <Kpi value={num(s.tablets.seen7)} label={tr('Tablets used this week')} note={tr('of {n} paired', { n: num(s.tablets.total) })} />
          <Kpi value={num(s.subscriptions.paying)} label={tr('Paying after the trial')} note={tr('{pct} of {n} families past {days} days', { pct: pct(s.subscriptions.paying, s.subscriptions.trialEnded), n: num(s.subscriptions.trialEnded), days: s.trialDays })} />
          <Kpi value={num(minutes7)} label={tr('Minutes in apps this week')} note={tr('{n} a tablet', { n: num(s.tablets.seen7 ? Math.round(minutes7 / s.tablets.seen7) : 0) })} />
        </div>
      </div>

      <div class="card">
        <h2>{tr('The last 30 days')}</h2>
        <Bars title={tr('Tablets that opened an app')} days={s.days} value={(d) => d.active} />
        <Bars title={tr('Minutes in apps')} days={s.days} value={(d) => d.minutes} />
        <Bars title={tr('New families')} days={s.days} value={(d) => d.families} />
        <Bars title={tr('New tablets')} days={s.days} value={(d) => d.tablets} />
      </div>

      <div class="card">
        <h2>{tr('Apps')}</h2>
        <div class="scroll">
          <table class="stats">
            <thead><tr><th>{tr('App')}</th><th>{tr('Installed')}</th><th>{tr('Tablets, 7 days')}</th><th>{tr('Opens, 7 days')}</th><th>{tr('Minutes, 7 days')}</th><th>{tr('Opens, 30 days')}</th><th>{tr('Minutes, 30 days')}</th><th>{tr('Stars earned')}</th><th>{tr('AI calls, 30 days')}</th></tr></thead>
            <tbody>{[...s.apps].sort((a, b) => b.minutes30 - a.minutes30 || b.installs - a.installs).map((a) => (
              <tr key={a.id}><td>{a.name}</td><td>{num(a.installs)}</td><td>{num(a.tablets7)}</td><td>{num(a.opens7)}</td><td>{num(a.minutes7)}</td><td>{num(a.opens30)}</td><td>{num(a.minutes30)}</td><td>{num(a.stars)}</td><td>{num(a.ai30)}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <p class="muted" style={{ marginTop: 8 }}>{tr('Opens and minutes count from the tablet version that reports them.')}</p>
      </div>

      <div class="card">
        <h2>{tr('Families and children')}</h2>
        <table class="stats narrow"><tbody>
          <tr><td>{tr('Families')}</td><td>{num(s.families.total)}</td></tr>
          <tr><td>{tr('New in the last 30 days')}</td><td>{num(s.families.new30)}</td></tr>
          <tr><td>{tr('With a paired tablet')}</td><td>{num(s.families.withTablet)} ({pct(s.families.withTablet, s.families.total)})</td></tr>
          <tr><td>{tr('Family language {language}', { language: LANGUAGE_NAMES.es })}</td><td>{num(s.families.spanish)}</td></tr>
          <tr><td>{tr('Children')}</td><td>{num(s.children.total)}</td></tr>
          <tr><td>{tr('Children with their own language {language}', { language: LANGUAGE_NAMES.es })}</td><td>{num(s.children.spanish)}</td></tr>
          <tr><td>{tr('Children with an avatar portrait')}</td><td>{num(s.children.portraits)}</td></tr>
        </tbody></table>
        {subjects.length > 0 && (
          <>
            <h3>{tr('Levels set per subject')}</h3>
            <table class="stats narrow"><tbody>{subjects.map((sub) => (
              <tr key={sub}><td>{SUBJECT[sub] ?? sub}</td><td>{s.levels.filter((l) => l.subject === sub).map((l) => `${grade(l.grade)}: ${l.n}`).join(' · ')}</td></tr>
            ))}</tbody></table>
          </>
        )}
      </div>

      <div class="card">
        <h2>{tr('Tablets')}</h2>
        <table class="stats narrow"><tbody>
          <tr><td>{tr('Paired')}</td><td>{num(s.tablets.total)}</td></tr>
          <tr><td>{tr('Seen today')}</td><td>{num(s.tablets.seen1)}</td></tr>
          <tr><td>{tr('Seen in 7 days')}</td><td>{num(s.tablets.seen7)}</td></tr>
          <tr><td>{tr('Seen in 30 days')}</td><td>{num(s.tablets.seen30)}</td></tr>
          <tr><td>{tr('Paired in the last 30 days')}</td><td>{num(s.tablets.new30)}</td></tr>
        </tbody></table>
        <h3>{tr('By platform')}</h3>
        <table class="stats narrow">
          <thead><tr><th>{tr('Platform')}</th><th>{tr('Paired')}</th><th>{tr('Seen in 7 days')}</th></tr></thead>
          <tbody>{s.tablets.platforms.map((p) => <tr key={p.platform}><td>{PLATFORM[p.platform] ?? p.platform}</td><td>{num(p.total)}</td><td>{num(p.seen7)}</td></tr>)}</tbody>
        </table>
        {s.tablets.shells.length > 0 && (
          <>
            <h3>{tr('App versions seen in 30 days')}</h3>
            <table class="stats narrow"><tbody>{s.tablets.shells.map((v) => (
              <tr key={v.platform + v.version}><td>{PLATFORM[v.platform] ?? v.platform} {v.version || '–'}</td><td>{num(v.n)}</td></tr>
            ))}</tbody></table>
          </>
        )}
      </div>

      <div class="card">
        <h2>{tr('Subscriptions')}</h2>
        <table class="stats narrow">
          <thead><tr><th>{tr('Status')}</th><th>{tr('Billed by')}</th><th>{tr('Families')}</th></tr></thead>
          <tbody>{s.subscriptions.byStatus.map((r) => <tr key={r.status + r.source}><td>{STATUS[r.status] ?? r.status}</td><td>{SOURCE[r.source] ?? r.source}</td><td>{num(r.n)}</td></tr>)}</tbody>
        </table>
        <p class="muted" style={{ marginTop: 8 }}>{tr('{n} trials end in the next 7 days.', { n: num(s.subscriptions.trialsEnding7) })}</p>
      </div>

      <div class="card">
        <h2>{tr('Narrator and AI')}</h2>
        <table class="stats narrow"><tbody>
          <tr><td>{tr('Lines saved')}</td><td>{num(s.voice.clips)}</td></tr>
          <tr><td>{tr('Plays from a saved line')}</td><td>{num(s.voice.hits)} ({pct(s.voice.hits, plays)})</td></tr>
          {s.voice.byLanguage.map((v) => <tr key={v.lang}><td>{tr('Lines saved in {language}', { language: LANGUAGE_NAMES[v.lang as Lang] ?? v.lang })}</td><td>{num(v.clips)}</td></tr>)}
          <tr><td>{tr('Characters of speech made, 30 days')}</td><td>{num(s.voice.charsAsked30)}</td></tr>
          <tr><td>{tr('AI calls, 30 days')}</td><td>{num(s.ai.calls30)}</td></tr>
          <tr><td>{tr('AI tokens in and out, 30 days')}</td><td>{num(s.ai.inputTokens30)} / {num(s.ai.outputTokens30)}</td></tr>
        </tbody></table>
      </div>

      <div class="card">
        <h2>{tr('Requests and other apps')}</h2>
        <table class="stats narrow"><tbody>
          {s.requests.byStatus.map((r) => <tr key={r.status}><td>{REQUEST[r.status] ?? r.status}</td><td>{num(r.n)}</td></tr>)}
          <tr><td>{tr('Asked for in the last 30 days')}</td><td>{num(s.requests.new30)}</td></tr>
        </tbody></table>
        {s.otherApps.length > 0 && (
          <>
            <h3>{tr('Other apps parents allowed')}</h3>
            <table class="stats narrow">
              <thead><tr><th>{tr('App')}</th><th>{tr('Families')}</th><th>{tr('Minutes, 30 days')}</th></tr></thead>
              <tbody>{s.otherApps.map((o) => <tr key={o.label}><td>{o.label}</td><td>{num(o.families)}</td><td>{num(o.minutes30)}</td></tr>)}</tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}

function Kpi({ value, label, note }: { value: string; label: string; note: string }) {
  return <div class="kpi"><div class="v">{value}</div><div class="l">{label}</div><div class="muted n">{note}</div></div>;
}

// One small bar per day; the day and its value show on hover, the highest value at the top left.
function Bars({ title, days, value }: { title: string; days: StatsT['days']; value: (d: StatsT['days'][number]) => number }) {
  const vals = days.map(value);
  const max = Math.max(1, ...vals);
  const total = vals.reduce((a, b) => a + b, 0);
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(lang.value, { month: 'short', day: 'numeric' });
  return (
    <div class="bars">
      <div class="row"><strong class="grow">{title}</strong><span class="muted">{tr('{n} in all, highest {max}', { n: total.toLocaleString(lang.value), max: Math.max(0, ...vals).toLocaleString(lang.value) })}</span></div>
      <div class="plot">{days.map((d, i) => <span key={d.day} title={`${label(d.day)}: ${vals[i]}`} style={{ height: `${Math.max(vals[i] ? 4 : 1, (vals[i] / max) * 100)}%` }} class={vals[i] ? '' : 'zero'} />)}</div>
      {days.length > 0 && <div class="row ends muted"><span class="grow">{label(days[0].day)}</span><span>{label(days[days.length - 1].day)}</span></div>}
    </div>
  );
}
