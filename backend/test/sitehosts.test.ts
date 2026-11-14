import { describe, expect, it } from 'vitest';
import { mediaHostsFor } from '../src/sitehosts.js';

describe('media hosts for allowed websites', () => {
  it('lists a site\'s hosts for the site, its www name and its subdomains only', () => {
    const pbs = ['kids.pbs-video.pbs.org', 'proxy.drm.pbs.org', 'urs-anonymous-detect.pbs.org', 'urs.pbs.org'];
    expect(mediaHostsFor(['pbskids.org'])).toEqual(pbs);
    expect(mediaHostsFor(['www.pbskids.org', '*.pbskids.org', 'Games.PBSKids.org'])).toEqual(pbs);
    expect(mediaHostsFor(['notpbskids.org', 'pbskids.org.evil.com', 'example.org'])).toEqual([]);
    expect(mediaHostsFor([])).toEqual([]);
  });
});
