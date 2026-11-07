import { useEffect, useState } from 'preact/hooks';
import { api, type AppRequest, type Attachment } from '../api';

const STATUS: Record<string, string> = { requested: 'Received', planned: 'Planned', building: 'Being built', declined: 'Not taken on', shipped: 'In the Store' };
const OPEN = ['requested', 'planned', 'building'];

// App requests: one in progress at a time, with pictures (a drawing, a photo of a book page) up to 10 MB each.
export function Requests({ grades, onError }: { grades: string[]; onError: (m: string) => void }) {
  const [list, setList] = useState<AppRequest[] | null>(null);
  const [title, setTitle] = useState(''); const [desc, setDesc] = useState(''); const [grade, setGrade] = useState(grades[0] ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState('');
  const load = () => api.requests().then((r) => setList(r.requests)).catch((e) => onError((e as Error).message));
  useEffect(() => { load(); }, []);
  const open = list?.find((r) => OPEN.includes(r.status));

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy('Sending');
    try {
      const r = await api.createRequest({ title: title.trim(), description: desc.trim(), childGrade: grade || null, installWhenReady: true });
      for (const [i, f] of files.entries()) { setBusy(`Sending picture ${i + 1} of ${files.length}`); await api.attach(r.id, f); }
      setTitle(''); setDesc(''); setFiles([]);
      await load();
    } catch (err) { onError((err as Error).message); }
    finally { setBusy(''); }
  };
  const addPictures = async (r: AppRequest, picked: File[]) => {
    setBusy('Sending picture');
    try { for (const f of picked) await api.attach(r.id, f); await load(); }
    catch (err) { onError((err as Error).message); }
    finally { setBusy(''); }
  };

  return (
    <div class="card">
      <h2>Ask for an app <span class="muted" style={{ fontWeight: 400, fontSize: 14 }}>included with your subscription</span></h2>
      {list === null && <p>Loading</p>}
      {list && list.length > 0 && (
        <ul class="list">
          {list.map((r) => (
            <li key={r.id}>
              <span class="grow">
                <strong>{r.title}</strong> <span class="muted">{STATUS[r.status] ?? r.status} · {new Date(r.createdAt).toLocaleDateString()}</span>
                <br /><span class="muted">{r.description}</span>
                {r.attachments.length > 0 && <div class="row" style={{ marginTop: 8 }}>{r.attachments.map((a) => <Picture key={a.id} a={a} />)}</div>}
              </span>
              {OPEN.includes(r.status) && r.attachments.length < 5 && (
                <label class="btn quiet">Add a picture<input type="file" accept="image/*" multiple hidden onChange={(e) => { const f = Array.from((e.target as HTMLInputElement).files ?? []); if (f.length) addPictures(r, f.slice(0, 5 - r.attachments.length)); }} /></label>
              )}
            </li>
          ))}
        </ul>
      )}
      {list && !open && (
        <form onSubmit={submit} style={{ marginTop: 12 }}>
          <p>Describe an app you wish existed and the ET Ducky team builds it, for your family and every other, at no extra cost. One request at a time; you can follow it here, and when it is ready it installs on your tablets.</p>
          <div class="row">
            <input placeholder="A short name, like Dinosaur dig" required minLength={3} maxLength={80} value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} style={{ flex: 1, minWidth: 220 }} />
            <select value={grade} onChange={(e) => setGrade((e.target as HTMLSelectElement).value)} style={{ maxWidth: 140 }}>
              <option value="">Any grade</option>
              {['pre-k', 'k', '1', '2', '3', '4', '5', '6'].map((g) => <option key={g} value={g}>{g === 'pre-k' ? 'Pre-K' : g === 'k' ? 'K' : `Grade ${g}`}</option>)}
            </select>
          </div>
          <textarea placeholder="What should it do, and what does your child like about the idea?" required minLength={10} maxLength={2000} rows={4} value={desc} onInput={(e) => setDesc((e.target as HTMLTextAreaElement).value)} style={{ width: '100%', marginTop: 10, boxSizing: 'border-box' }} />
          <div class="row" style={{ marginTop: 10 }}>
            <label class="btn quiet">{files.length ? `${files.length} picture${files.length > 1 ? 's' : ''} chosen` : 'Add pictures'}<input type="file" accept="image/*" multiple hidden onChange={(e) => setFiles(Array.from((e.target as HTMLInputElement).files ?? []).slice(0, 5))} /></label>
            <button class="btn primary" disabled={!!busy || title.trim().length < 3 || desc.trim().length < 10}>{busy || 'Send the request'}</button>
          </div>
        </form>
      )}
      {list && open && <p class="muted" style={{ marginTop: 10 }}>{busy || 'A new request can be made once this one is finished.'}</p>}
    </div>
  );
}

function Picture({ a }: { a: Attachment }) {
  const [src, setSrc] = useState('');
  useEffect(() => { let url = ''; api.picture(a.url).then((u) => { url = u; setSrc(u); }).catch(() => {}); return () => { if (url) URL.revokeObjectURL(url); }; }, [a.url]);
  return src ? <img src={src} alt="" style={{ height: 72, borderRadius: 8, border: '1px solid var(--line)' }} /> : <span class="muted">loading</span>;
}
