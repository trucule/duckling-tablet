import { signal, type Signal } from '@preact/signals';

// The child's portrait and home background, kept on the tablet. The config names each picture by a link whose `v`
// changes only when the picture does; the tablet keeps the picture itself in IndexedDB and shows that copy at once,
// on every return home, after a restart and offline. A new picture is downloaded once and replaces the old copy only
// after it has loaded, so the screen never shows an empty space while it does.
export type Slot = 'portrait' | 'background';
const SLOTS: Slot[] = ['portrait', 'background'];
interface Saved { slot: Slot; v: string; blob: Blob }

const shown: Record<Slot, Signal<string | null>> = { portrait: signal(null), background: signal(null) };
const shownV: Record<Slot, string | null> = { portrait: null, background: null };
const pending: Record<Slot, string | null> = { portrait: null, background: null };
// A failed download of a version is tried again after RETRY_MS, not on every render.
const lastTry: Record<Slot, { v: string; at: number } | null> = { portrait: null, background: null };
const RETRY_MS = 60_000;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('duckling-pictures', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('pictures', { keyPath: 'slot' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
const db = openDb();
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const d = await db;
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const r = fn(d.transaction('pictures', mode).objectStore('pictures'));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

const show = (slot: Slot, src: string | null, v: string | null) => {
  const old = shown[slot].value;
  shownV[slot] = v;
  shown[slot].value = src;
  if (old && old !== src && old.startsWith('blob:')) URL.revokeObjectURL(old);
};
const decoded = (src: string) => new Promise<void>((resolve) => {
  const img = new Image();
  img.onload = () => { (img.decode ? img.decode() : Promise.resolve()).then(() => resolve(), () => resolve()); };
  img.onerror = () => resolve();
  img.src = src;
});

// The copies saved on this tablet, shown before the first check-in answers.
const loaded = (async () => {
  for (const slot of SLOTS) {
    const s = await tx<Saved | undefined>('readonly', (st) => st.get(slot) as IDBRequest<Saved | undefined>);
    if (s?.blob && !shown[slot].value) { const src = URL.createObjectURL(s.blob); await decoded(src); show(slot, src, s.v); }
  }
})();

// The picture's version from its link; a link without one (an older server) is its own version.
export const versionOf = (url: string) => { try { return new URL(url).searchParams.get('v') || url; } catch { return url; } };

async function sync(slot: Slot, url: string | null) {
  await loaded;
  if (!url) {
    lastTry[slot] = null;
    if (shown[slot].value || shownV[slot]) { show(slot, null, null); void tx('readwrite', (st) => st.delete(slot)); }
    return;
  }
  const v = versionOf(url);
  if (v === shownV[slot] || v === pending[slot]) return;
  const t = lastTry[slot];
  if (t && t.v === v && Date.now() - t.at < RETRY_MS) return;
  pending[slot] = v; lastTry[slot] = { v, at: Date.now() };
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!r.ok) throw new Error(String(r.status));
    const blob = await r.blob();
    const src = URL.createObjectURL(blob);
    await decoded(src);
    if (pending[slot] !== v) { URL.revokeObjectURL(src); return; }
    show(slot, src, v); lastTry[slot] = null;
    void tx('readwrite', (st) => st.put({ slot, v, blob } satisfies Saved));
  } catch {
    // No copy could be made (offline, or the link no longer works): with nothing on screen, let the browser load the
    // link itself; a copy is tried again after a minute.
    if (!shown[slot].value) show(slot, url, null);
  } finally {
    if (pending[slot] === v) pending[slot] = null;
  }
}

// The picture to show for a slot: the tablet's copy (an object URL), kept in step with the config's link.
export function usePicture(slot: Slot, url: string | null | undefined): string | null {
  void sync(slot, url ?? null);
  return shown[slot].value;
}

// ---- This tablet's own background --------------------------------------------------------------------------------
// A photo from Camera Fun is the background of this tablet only and never leaves it: the app hands it to the shell,
// the shell hands it to this page (takeLocalBackground), and it is kept here under the key 'tablet'. It shows in place
// of her profile background until a painting is chosen on this tablet (the shell then hands over 'none') or a parent
// removes it here. Paintings chosen on her other tablets change her profile background, which shows on any tablet
// without a photo of its own.
interface TabletSaved { slot: 'tablet'; blob: Blob }
export const tabletBackground = signal<string | null>(null);
const tabletLoaded = (async () => {
  const s = await tx<TabletSaved | undefined>('readonly', (st) => st.get('tablet') as IDBRequest<TabletSaved | undefined>);
  if (s?.blob && !tabletBackground.value) { const src = URL.createObjectURL(s.blob); await decoded(src); tabletBackground.value = src; }
})();
const showTablet = (src: string | null) => {
  const old = tabletBackground.value;
  tabletBackground.value = src;
  if (old && old !== src) URL.revokeObjectURL(old);
};

// Only a JPEG from the app (duckling-compat.js makes it) of a sensible size is taken.
const LOCAL_MAX = 4_000_000;
export async function adoptTabletBackground(dataUrl: string) {
  if (!dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length > LOCAL_MAX) return;
  await tabletLoaded;
  let blob: Blob;
  try {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: 'image/jpeg' });
  } catch { return; }
  const src = URL.createObjectURL(blob);
  await decoded(src);
  showTablet(src);
  await tx('readwrite', (st) => st.put({ slot: 'tablet', blob } satisfies TabletSaved));
}

export async function forgetTabletBackground() {
  await tabletLoaded;
  showTablet(null);
  await tx('readwrite', (st) => st.delete('tablet'));
}

// The home background to show: this tablet's own photo when it has one, otherwise her profile background.
export function useHomeBackground(profileUrl: string | null | undefined): string | null {
  const profile = usePicture('background', profileUrl);
  return tabletBackground.value ?? profile;
}

// Released from this tablet: its copies of her pictures go with the rest of its data.
export async function forgetPictures() {
  for (const slot of SLOTS) { pending[slot] = null; lastTry[slot] = null; show(slot, null, null); }
  showTablet(null);
  await tx('readwrite', (st) => st.clear());
}
