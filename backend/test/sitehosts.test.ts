import { describe, expect, it } from 'vitest';
import { SIGN_IN_HOSTS, mediaHostsFor } from '../src/sitehosts.js';

describe('media hosts for allowed websites', () => {
  it('lists a site\'s hosts for the site, its www name and its subdomains only', () => {
    const pbs = ['kids.pbs-video.pbs.org', 'proxy.drm.pbs.org', 'urs-anonymous-detect.pbs.org', 'urs.pbs.org'];
    expect(mediaHostsFor(['pbskids.org'])).toEqual(pbs);
    expect(mediaHostsFor(['www.pbskids.org', '*.pbskids.org', 'Games.PBSKids.org'])).toEqual(pbs);
    expect(mediaHostsFor(['notpbskids.org', 'pbskids.org.evil.com', 'example.org'])).toEqual([]);
    expect(mediaHostsFor([])).toEqual([]);
  });
  it('names sign-in hosts exactly, never a whole service or a site that browses', () => {
    for (const h of SIGN_IN_HOSTS) {
      expect(h).toMatch(/^[a-z0-9.-]+$/);
      expect(['*.', 'www.google.com', 'google.com', 'play.google.com', 'www.youtube.com', 'youtube.com', 'apple.com', 'www.apple.com', 'microsoft.com', 'www.microsoft.com', 'bing.com'].some((bad) => h === bad || h.startsWith('*.'))).toBe(false);
    }
    expect(new Set(SIGN_IN_HOSTS).size).toBe(SIGN_IN_HOSTS.length);
  });
});

describe('linkExpiry', () => {
  it('stays the same for 15 days and is always 30 to 45 days ahead', async () => {
    const { linkExpiry } = await import('../src/util.js');
    const day = 86_400_000, t = Date.UTC(2026, 10, 14, 20);
    for (let h = 0; h < 15 * 24; h += 7) {
      const now = t + h * 3_600_000, e = linkExpiry(now);
      expect(e - now).toBeGreaterThanOrEqual(30 * day);
      expect(e - now).toBeLessThanOrEqual(45 * day);
    }
    expect(linkExpiry(t)).toBe(linkExpiry(t + 1000));
  });
});
