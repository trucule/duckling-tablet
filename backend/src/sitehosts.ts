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
  // Checked 2026-11-25 in Chrome: an Epic video's main playlist is on www.getepic.com and its segments on
  // cdn-video-gcp-media-v2.getepic.com, but the playlist for each quality level comes from www.getepicapi.com, Epic's
  // API domain. Without it the player stops with hls:networkError_levelLoadError.
  'getepic.com': ['www.getepicapi.com', 'getepicapi.com'],
};

// Advertising, analytics and crash-reporting services that learning sites load alongside their own pages. A tablet
// refuses them like any other host, but does not offer them to a parent as something a video may need, and its
// "Video blocked" button does not appear for them. A parent can still allow one from the full list.
export const TRACKER_HOSTS: string[] = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com', 'googletagmanager.com',
  'googletagservices.com', 'adservice.google.com', 'imasdk.googleapis.com', 'facebook.net', 'connect.facebook.net',
  'facebook.com', 'newrelic.com', 'nr-data.net', 'osano.com', 'iterable.com', 'hotjar.com', 'segment.io', 'segment.com',
  'mixpanel.com', 'amplitude.com', 'sentry.io', 'bugsnag.com', 'branch.io', 'app.link', 'appsflyer.com',
  'adsafeprotected.com', 'moatads.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'scorecardresearch.com',
  'quantserve.com', 'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'casalemedia.com', 'amazon-adsystem.com',
  'clarity.ms', 'bing.com', 'tiktok.com', 'snapchat.com', 'pinterest.com', 'twitter.com', 'ads-twitter.com',
  'optimizely.com', 'fullstory.com', 'onetrust.com', 'cookielaw.org', 'cookiebot.com', 'trustarc.com',
  'intercom.io', 'zendesk.com', 'zdassets.com', 'datadoghq.com', 'browser-intake-datadoghq.com',
];

/** A site as the allowlist names it: lower case, without a leading *. or www. */
export const bare = (h: string) => h.trim().toLowerCase().replace(/^\*\./, '').replace(/^www\./, '');
const under = (host: string, list: string[]) => list.some((p) => host === p || host.endsWith(`.${p}`));
// Domains under which many unrelated people and companies publish: a hosting or storage service's own name, or a
// country's second level (co.uk). Allowing one would let every site under it through (the shells match subdomains),
// so neither the allowlist nor a parent's Allow on a blocked address takes one. A name under it is fine
// (d123.cloudfront.net is one distribution, kids.github.io one person's pages). A curated list: the full Public
// Suffix List would need a dependency that has not been approved.
export const SHARED_SUFFIXES: string[] = [
  'github.io', 'gitlab.io', 'bitbucket.io', 'githubusercontent.com', 'raw.githubusercontent.com',
  'cloudfront.net', 'amazonaws.com', 's3.amazonaws.com', 'elasticbeanstalk.com', 'awsapprunner.com', 'amplifyapp.com',
  'googleapis.com', 'storage.googleapis.com', 'googleusercontent.com', 'appspot.com', 'web.app', 'firebaseapp.com',
  'firebasestorage.app', 'run.app', 'cloudfunctions.net',
  'azurewebsites.net', 'azureedge.net', 'blob.core.windows.net', 'core.windows.net', 'azurestaticapps.net', 'trafficmanager.net',
  'herokuapp.com', 'vercel.app', 'netlify.app', 'netlify.com', 'pages.dev', 'workers.dev', 'r2.dev', 'onrender.com', 'fly.dev',
  'railway.app', 'glitch.me', 'repl.co', 'replit.app', 'replit.dev', 'surge.sh', 'neocities.org', 'ngrok.io', 'ngrok-free.app',
  'akamaized.net', 'akamaihd.net', 'edgesuite.net', 'edgekey.net', 'fastly.net', 'fastlylb.net', 'b-cdn.net', 'cdn77.org',
  'digitaloceanspaces.com', 'cdn.digitaloceanspaces.com', 'linodeobjects.com', 'backblazeb2.com', 'wasabisys.com',
  'blogspot.com', 'wordpress.com', 'wixsite.com', 'weebly.com', 'tumblr.com', 'substack.com', 'carrd.co', 'webflow.io',
  'squarespace.com', 'myshopify.com', 'framer.website', 'notion.site', 'canva.site', 'sites.google.com', 'dropboxusercontent.com',
  'jsdelivr.net', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'imgur.com', 'i.imgur.com',
];
// A country's second level: co.uk, com.au, org.nz, gob.mx and the like.
const SECOND_LEVEL = /^(co|com|net|org|gov|gob|edu|ac|or|ne|go|mil|nic|ltd|plc|sch|nhs|info|biz|nom|gen|firm|web|int|me|tv|in)\.[a-z]{2}$/;

export const SHARED_COUNTRY = 'That name covers every site in a country. Use the site\'s own name.';
export const SHARED_SERVICE = 'That address is shared by many unrelated sites. Use the site\'s own address under it.';
export const WHOLE_SITE = 'That address opens a whole website for browsing. To allow it, add the website under Websites.';

/** Why a host cannot be allowed on its own (a shared or country domain), or null when it can. */
export function sharedHostReason(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  // Fixed sentences, so the portal and the tablet show them in Spanish too (their dictionaries carry them).
  if (!h.includes('.') || SECOND_LEVEL.test(h)) return SHARED_COUNTRY;
  if (SHARED_SUFFIXES.includes(h)) return SHARED_SERVICE;
  return null;
}

// Whole websites for browsing and social media. A blocked address on one of them is not offered with Allow, because
// allowing it would open the whole site, not one website's videos; a parent who wants that adds it under Websites.
// Their media hosts (i.ytimg.com, player.vimeo.com) are not on this list.
export const BROWSING_HOSTS: string[] = [
  'google.com', 'youtube.com', 'bing.com', 'duckduckgo.com', 'yahoo.com', 'baidu.com', 'yandex.com', 'ask.com',
  'wikipedia.org', 'reddit.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'threads.net',
  'snapchat.com', 'pinterest.com', 'tumblr.com', 'discord.com', 'twitch.tv', 'kick.com', 'amazon.com', 'ebay.com',
  'roblox.com', 'vimeo.com', 'dailymotion.com', 'archive.org', 'telegram.org', 'whatsapp.com', 'linkedin.com', 'quora.com',
];

/** Why a blocked address is not offered with Allow, or null when it is. */
export function refusalFor(host: string): string | null {
  const shared = sharedHostReason(host);
  if (shared) return shared;
  const h = host.toLowerCase();
  return BROWSING_HOSTS.some((b) => h === b || h === `www.${b}` || h === `m.${b}`) ? WHOLE_SITE : null;
}

/** True for an advertising, analytics or crash-reporting host (TRACKER_HOSTS). */
export const isTracker = (host: string) => under(host.toLowerCase(), TRACKER_HOSTS);

/** The allowlist entry a page belongs to (getepic.com for www.getepic.com), or null when it belongs to none. */
export function siteFor(page: string, allowed: string[]): string | null {
  const p = page.trim().toLowerCase().replace(/\.$/, '');
  let best: string | null = null;
  for (const a of allowed.map(bare)) if (a && (p === a || p.endsWith(`.${a}`)) && (!best || a.length > best.length)) best = a;
  return best;
}

// Sign-in services a website may send the child's parent to ("Log in with Google" on a learning site): the account
// pages and the files they load, nothing that browses. A tablet allows them only while it has an allowed website,
// and the shells present a standard browser user agent on them, since Google refuses to sign in inside what it
// takes for an embedded web view (error disallowed_useragent). Pages elsewhere on these services are not on this
// list, so a sign-in host never becomes a way to the rest of the web.
export const SIGN_IN_HOSTS: string[] = [
  // Google: the account pages, their scripts and fonts, the token endpoint, and the YouTube account hop Google
  // makes on the way back. Not play.google.com or www.google.com, which browse.
  'accounts.google.com', 'accounts.youtube.com', 'apis.google.com', 'oauth2.googleapis.com', 'www.googleapis.com',
  'ssl.gstatic.com', 'www.gstatic.com', 'fonts.gstatic.com', 'fonts.googleapis.com',
  // Sign in with Apple.
  'appleid.apple.com', 'appleid.cdn-apple.com', 'idmsa.apple.com', 'gsa.apple.com',
  // Microsoft accounts, school and personal.
  'login.microsoftonline.com', 'login.live.com', 'login.microsoft.com', 'aadcdn.msftauth.net', 'aadcdn.msauth.net', 'logincdn.msauth.net', 'account.live.com',
  // School single sign-on portals.
  'clever.com', 'launchpad.classlink.com', 'login.classlink.com', 'myapps.classlink.com', 'cdn.classlink.com',
];


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
