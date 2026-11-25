import { describe, expect, it } from 'vitest';
import { SIGN_IN_HOSTS, SHARED_COUNTRY, SHARED_SERVICE, WHOLE_SITE, mediaHostsFor, refusalFor, sharedHostReason } from '../src/sitehosts.js';
import { ticketBody, ticketTitle } from '../src/etducky.js';

describe('media hosts for allowed websites', () => {
  it('lists a site\'s hosts for the site, its www name and its subdomains only', () => {
    const pbs = ['kids.pbs-video.pbs.org', 'proxy.drm.pbs.org', 'urs-anonymous-detect.pbs.org', 'urs.pbs.org'];
    expect(mediaHostsFor(['pbskids.org'])).toEqual(pbs);
    expect(mediaHostsFor(['www.pbskids.org', '*.pbskids.org', 'Games.PBSKids.org'])).toEqual(pbs);
    expect(mediaHostsFor(['notpbskids.org', 'pbskids.org.evil.com', 'example.org'])).toEqual([]);
    expect(mediaHostsFor([])).toEqual([]);
    expect(mediaHostsFor(['getepic.com'])).toEqual(['getepicapi.com', 'www.getepicapi.com']);
    expect(mediaHostsFor(['www.getepic.com', 'pbskids.org'])).toEqual([...pbs, 'getepicapi.com', 'www.getepicapi.com'].sort());
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

describe('hosts that cannot be allowed on their own', () => {
  it('refuses country and shared-service domains, and allows a name under them', () => {
    for (const h of ['co.uk', 'com.au', 'gob.mx', 'uk', '*.co.uk']) expect(sharedHostReason(h), h).toBe(SHARED_COUNTRY);
    for (const h of ['github.io', 'cloudfront.net', 's3.amazonaws.com', 'storage.googleapis.com', 'blogspot.com', 'vercel.app', '*.github.io']) expect(sharedHostReason(h), h).toBe(SHARED_SERVICE);
    for (const h of ['bbc.co.uk', 'kids.github.io', 'd123.cloudfront.net', 'bucket.s3.amazonaws.com', 'pbskids.org', 'www.getepicapi.com']) expect(sharedHostReason(h), h).toBeNull();
  });
  it('does not offer Allow for a whole website for browsing, but does for its media hosts', () => {
    for (const h of ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'www.google.com', 'wikipedia.org', 'www.reddit.com']) expect(refusalFor(h), h).toBe(WHOLE_SITE);
    for (const h of ['i.ytimg.com', 'player.vimeo.com', 'www.youtube-nocookie.com', 'fonts.googleapis.com']) expect(refusalFor(h), h).toBeNull();
    expect(refusalFor('github.io')).toBe(SHARED_SERVICE);
  });
});

describe('text sent to ET Ducky', () => {
  it('keeps titles out of HTML attributes and strips control characters', () => {
    expect(ticketTitle('App request: "x" onmouseover="alert(1)" <b>\u0007 Ada\'s\nzoo')).toBe("App request: x onmouseover=alert(1) b Ada's zoo");
    expect(ticketBody('line one\nline\ttwo\u0000\u001b[31m')).toBe('line one\nline\ttwo[31m');
  });
});
