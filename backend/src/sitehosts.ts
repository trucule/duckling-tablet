// Hosts outside an allowed website that it needs for its own videos, checked by hand for each site. A tablet allows
// them only while the site itself is allowed, and opens no tile for them. Nothing else a site loads from elsewhere is
// allowed (ads, analytics, other sites): a site's videos may fail until its hosts are listed here.
//
// To add a site: open it in Chrome, play a video, and list the hosts in DevTools > Network (or
// performance.getEntriesByType('resource')). Keep only the hosts the video needs; leave out ads and analytics, and
// name exact hosts rather than a whole domain whose other parts are not for children. A site's own subdomains are
// already allowed with it.
export const SITE_MEDIA_HOSTS: Record<string, string[]> = {
  // Checked 2026-11-14 in Chrome: episodes (urs.pbs.org finds the video, kids.pbs-video.pbs.org streams it) and
  // PBS KIDS Live (urs-anonymous-detect.pbs.org, and proxy.drm.pbs.org for the stream's license; the stream itself is
  // livestream.pbskids.org). Games stay on pbskids.org subdomains. pbs.org as a whole is not allowed.
  'pbskids.org': ['urs.pbs.org', 'urs-anonymous-detect.pbs.org', 'kids.pbs-video.pbs.org', 'proxy.drm.pbs.org'],
};

const bare = (h: string) => h.trim().toLowerCase().replace(/^\*\./, '').replace(/^www\./, '');

/** The media hosts for a list of allowed website hosts: a host gets a site's list when it is that site or under it. */
export function mediaHostsFor(allowed: string[]): string[] {
  const out = new Set<string>();
  for (const a of allowed.map(bare)) {
    for (const [site, hosts] of Object.entries(SITE_MEDIA_HOSTS)) if (a === site || a.endsWith(`.${site}`)) hosts.forEach((h) => out.add(h));
  }
  return [...out].sort();
}

/**
 * The site name in what a parent typed or pasted: https://www.kleki.com/draw becomes kleki.com, Kleki.com. becomes
 * kleki.com, and *.example.org keeps its wildcard. Text that is not a site comes back unchanged, so the host check
 * that follows refuses it with its own message.
 */
export function siteHost(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const raw = input.trim(), wild = raw.startsWith('*.');
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${wild ? raw.slice(2) : raw}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return input;
    return (wild ? '*.' : '') + u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  } catch { return input; }
}
