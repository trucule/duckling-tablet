// What a parent types for a website: a site name (kleki.com), a pasted address (https://www.kleki.com/draw?x=1) or
// either with spaces or a trailing dot. The host is the site name in lower case without "www." (a site's own
// subdomains, www included, are allowed with it); a pasted address stays as the tile's link, so the tile opens the
// page the parent copied. Returns null for text that names no site.
export function siteFromInput(input: string): { host: string; url: string } | null {
  const raw = input.trim();
  if (!raw) return null;
  const wild = raw.startsWith('*.');
  let host: string, url: string | null = null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${wild ? raw.slice(2) : raw}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    host = u.hostname;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && (u.pathname !== '/' || u.search)) url = u.href;
  } catch { return null; }
  host = host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) return null;
  return { host: (wild ? '*.' : '') + host, url: url ?? `https://${host}` };
}

// A list of sites separated by commas, spaces or new lines; the names that are not sites are returned apart.
export function sitesFromList(input: string): { hosts: string[]; bad: string[] } {
  const hosts: string[] = [], bad: string[] = [];
  for (const part of input.split(/[\s,]+/).filter(Boolean)) {
    const s = siteFromInput(part);
    if (s) { if (!hosts.includes(s.host)) hosts.push(s.host); } else bad.push(part);
  }
  return { hosts, bad };
}
