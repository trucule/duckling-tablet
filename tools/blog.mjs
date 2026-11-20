#!/usr/bin/env node
// The ducklingtablet.com blog. Posts are Markdown files in site/blog/posts/<slug>.md with a front matter block;
// this tool renders them into site/blog/<slug>.html with the site's own shell, rebuilds site/blog/index.html and
// site/blog/feed.xml, and adds the posts to site/sitemap.xml. The rendered files are committed, since the site is
// served as static files. docs/blog.md says what a post is and how one gets written.
//
//   node tools/blog.mjs new <slug> "<title>"   makes site/blog/posts/<slug>.md from the template
//   node tools/blog.mjs build                  renders every post, the index, the feed and the sitemap
//   node tools/blog.mjs check                  the build's checks without writing (exit 1 on a problem)
//   node tools/blog.mjs reply <file>           checks a forum reply in a plain text file against the same prose rules,
//                                              plus a disclosure line, one link at most, and 250 words at most
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site'), BLOG = path.join(SITE, 'blog'), POSTS = path.join(BLOG, 'posts');
const ORIGIN = 'https://ducklingtablet.com';
const GA = `<!-- Google Analytics for this website only. The apps and the parent portal carry no analytics. -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-780R29EZDT"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-780R29EZDT',{allow_google_signals:false,allow_ad_personalization_signals:false});</script>`;
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap" rel="stylesheet">`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const [cmd, ...args] = process.argv.slice(2);

function readPost(file) {
  const raw = fs.readFileSync(path.join(POSTS, file), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: no front matter`);
  const meta = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1'); }
  const slug = file.replace(/\.md$/, '');
  for (const k of ['title', 'description', 'date']) if (!meta[k]) throw new Error(`${file}: front matter needs ${k}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) throw new Error(`${file}: date must be YYYY-MM-DD`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`${file}: the file name is the URL; use lowercase words and hyphens`);
  return { slug, meta, body: m[2].trim(), draft: meta.draft === 'true' };
}

// Markdown, the parts a post uses: headings, paragraphs, lists, links, emphasis, code, quotes, images.
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}
function render(md) {
  const out = []; const lines = md.split('\n'); let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{2,4}) (.*)$/))) { const n = m[1].length; const id = m[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); out.push(`<h${n} id="${id}">${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^[-*] /.test(l) || /^\d+\. /.test(l)) {
      const ordered = /^\d+\. /.test(l), items = [];
      while (i < lines.length && (/^[-*] /.test(lines[i]) || /^\d+\. /.test(lines[i]))) { items.push(lines[i].replace(/^([-*]|\d+\.) /, '')); i++; }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (l.startsWith('> ')) { const q = []; while (i < lines.length && lines[i].startsWith('> ')) { q.push(lines[i].slice(2)); i++; } out.push(`<blockquote><p>${inline(q.join(' '))}</p></blockquote>`); continue; }
    if (l.startsWith('```')) { const c = []; i++; while (i < lines.length && !lines[i].startsWith('```')) { c.push(lines[i]); i++; } i++; out.push(`<pre><code>${esc(c.join('\n'))}</code></pre>`); continue; }
    const p = []; while (i < lines.length && lines[i].trim() && !/^(#{2,4} |[-*] |\d+\. |> |```)/.test(lines[i])) { p.push(lines[i]); i++; }
    out.push(`<p>${inline(p.join(' '))}</p>`);
  }
  return out.join('\n');
}

const prettyDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

function shell({ title, description, url, body, current, extraHead = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
${GA}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Duckling Tablet</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="alternate" type="application/rss+xml" title="Duckling Tablet blog" href="/blog/feed.xml">
<meta property="og:title" content="${esc(title)} | Duckling Tablet">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${ORIGIN}/og.png?v=2">
<meta property="og:type" content="${current === 'post' ? 'article' : 'website'}">
${FONTS}
<link rel="stylesheet" href="/site.css">
${extraHead}</head>
<body>
<header class="site-header"><div class="wrap">
<a class="brand" href="/"><img src="/logo.png" alt="" width="40" height="40">Duckling Tablet</a>
<nav class="site-nav" aria-label="Site"><a class="nav-downloads" href="/#get-it">Downloads</a><a href="/apps">Apps</a><a href="/#pricing">Pricing</a><a href="/blog/"${current ? ' aria-current="page"' : ''}>Blog</a><a href="/support">Support</a></nav>
</div></header>
<main>
${body}
</main>
<footer class="site-footer"><div class="wrap">
<div>
<img src="/logo.png" alt="Duckling Tablet" width="72" height="72" style="display:block;margin-bottom:0.8rem">
<p>Duckling Tablet is made by ET Ducky LLC in Bellingham, Washington.</p>
<p>Questions: <a href="mailto:admin@etducky.com">admin@etducky.com</a></p>
</div>
<nav aria-label="Legal and help">
<a href="/privacy">Privacy policy</a>
<a href="/children-privacy">Children's privacy notice</a>
<a href="/terms">Terms of service</a>
<a href="/support">Support</a>
<a href="/blog/">Blog</a>
<a href="/download">Windows download</a>
</nav>
</div></footer>
<script src="/site.js" defer></script>
</body>
</html>
`;
}

// The linter. The house style from the ET Ducky promotion brief (section 5) as far as a program can check it, plus
// the checks the ET Ducky blog script makes (new_blog_post.py: dashes, description length, slug, placeholders),
// plus links that exist. A post with any problem is not built.
const WORDS = [
  [/\b(unlike|compared to|competitors?|versus|vs\.?)\b/i, 'comparison framing'],
  [/\b(the best|revolutionary|game-?chang\w*|seamless\w*|unleash\w*|supercharge\w*|cutting-edge|state-of-the-art|world-class|powerful|robust|effortless\w*|delight\w*|magic\w*)\b/i, 'promotional wording'],
  [/\b(at the end of the day|in a nutshell|silver bullet|low-hanging fruit|hit the ground running|a breeze|no-brainer|doing its job|under the hood|think of it as|imagine)\b/i, 'an idiom, analogy, or personification'],
  [/\b(the right (shape|caveat|call|choice)|the honest\b|the real (question|answer))\b/i, 'evaluative shorthand'],
  [/\b(is the (part|kind|sort|piece) of\b|is what .{1,40} is about)/i, 'definitional framing'],
  [/\b(let's|we'll|in this post|in this article|today we)\b/i, 'a setup line instead of the subject'],
  [/\b(simply|just|easily|basically|obviously)\b/i, 'a filler adverb'],
  [/\b(already (own|owns|owned|have|has|had|use|uses|using)|you already|as you know|needless to say|it goes without saying|as expected|naturally|of course|no need to|without (having|needing) to|(don't|doesn't|do not|does not) (have|need) to)\b/i, 'a statement of the obvious'],
];
// The prose checks shared by posts and forum replies: text is everything a reader sees, prose is the body with code
// and link targets removed.
function lintProse(text, prose, problems) {
  if (/\[[^\]]+\](?!\()/.test(text.replace(/!\[[^\]]*\]/g, ''))) problems.push('a [placeholder]');
  if (/\u2014/.test(text)) problems.push('an em dash');
  if (/\u2013/.test(text)) problems.push('an en dash');
  if (/ - /.test(prose)) problems.push('a spaced hyphen used as an aside');
  if (/;/.test(prose)) problems.push('a semicolon');
  if (/[\u2600-\u27bf\u{1f300}-\u{1faff}\u2190-\u21ff\u2022]/u.test(text)) problems.push('an emoji or decorative symbol');
  for (const [re, what] of WORDS) { const m = prose.match(re); if (m) problems.push(`${what} ("${m[0]}")`); }
  // A colon inside a sentence that goes on introduces a list or an explanation (brief rule 2). A colon that ends
  // the line, before steps or a code block, is allowed.
  for (const m of prose.matchAll(/[A-Za-z][^\n:]*: +[a-z][^\n]*/g)) { problems.push(`a colon inside a sentence ("${m[0].slice(0, 60)}")`); break; }
  // Oxford comma: "a, b and c" without the comma before and (rule 51).
  const ox = prose.match(/\b\w+, \w+(?: \w+)? (?:and|or) \w+/);
  if (ox && !/, (?:and|or) /.test(ox[0])) problems.push(`a list without the Oxford comma ("${ox[0]}")`);
  for (const m of prose.matchAll(/[^.!?\n]{220,}[.!?]/g)) { problems.push(`a sentence over 220 characters ("${m[0].slice(0, 50)}...")`); break; }
}

// A forum reply Chris posts under his own name (docs/blog.md, "Forum replies"): the prose rules, a disclosure line
// that says he makes Duckling, at most one link, at most 250 words, and the product named no more than twice.
function lintReply(text) {
  const problems = [];
  const prose = text.replace(/https?:\/\/\S+/g, '').replace(/\]\([^)]*\)/g, ']');
  lintProse(text, prose, problems);
  if (!/\b(I (make|made|build|built|run|wrote)|disclosure)\b/i.test(text)) problems.push('no disclosure line (say that you make Duckling Tablet)');
  const links = (text.match(/https?:\/\/\S+/g) || []);
  if (links.length > 1) problems.push(`${links.length} links (at most one)`);
  if (links.some((l) => !/^https:\/\/(www\.)?(ducklingtablet\.com|parents\.ducklingtablet\.com)/.test(l))) problems.push('a link to a site other than ducklingtablet.com');
  const words = prose.split(/\s+/).filter(Boolean).length;
  if (words > 250) problems.push(`${words} words (at most 250)`);
  if (words < 40) problems.push(`${words} words (at least 40)`);
  const names = (text.match(/\bDuckling\b/g) || []).length;
  if (names > 2) problems.push(`Duckling named ${names} times (at most twice)`);
  return problems;
}

function lint(post) {
  const problems = [];
  const text = post.meta.title + '\n' + post.meta.description + '\n' + post.body;
  const prose = post.body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']');
  lintProse(text, prose, problems);
  if (post.meta.description.length < 150 || post.meta.description.length > 200) problems.push(`a description of ${post.meta.description.length} characters (150 to 200)`);
  const words = prose.split(/\s+/).filter(Boolean).length;
  if (words < 400) problems.push(`${words} words (at least 400)`);
  if (words > 1400) problems.push(`${words} words (at most 1400)`);
  if (/^# /m.test(post.body)) problems.push('a level-one heading in the body (the title is the h1)');
  if (!/^## /m.test(post.body)) problems.push('no section headings');
  for (const m of post.body.matchAll(/\]\((\/[^)\s#]*)/g)) {
    const p = m[1].replace(/\/$/, '');
    const candidates = [path.join(SITE, p), path.join(SITE, p + '.html'), path.join(SITE, p, 'index.html')];
    if (!candidates.some((c) => fs.existsSync(c))) problems.push(`a link to ${m[1]} that is not on the site`);
  }
  for (const m of post.body.matchAll(/!\[([^\]]*)\]/g)) if (!m[1].trim()) { problems.push('an image without alt text'); break; }
  return problems;
}

function build(write) {
  fs.mkdirSync(POSTS, { recursive: true });
  const posts = fs.readdirSync(POSTS).filter((f) => f.endsWith('.md')).map(readPost).sort((a, b) => b.meta.date.localeCompare(a.meta.date));
  let bad = 0;
  for (const p of posts) {
    const url = `${ORIGIN}/blog/${p.slug}`;
    const body = `<article class="wrap page post">
<header>
<p class="post-date"><time datetime="${p.meta.date}">${prettyDate(p.meta.date)}</time></p>
<h1>${esc(p.meta.title)}</h1>
<p>${esc(p.meta.description)}</p>
</header>
${render(p.body)}
<p class="post-foot"><a href="/blog/">All posts</a></p>
</article>`;
    const html = shell({ title: p.meta.title, description: p.meta.description, url, body, current: 'post' });
    const problems = lint(p);
    if (problems.length) { bad++; console.log(`${p.slug}: ${problems.join('; ')}`); }
    if (write && !p.draft) fs.writeFileSync(path.join(BLOG, `${p.slug}.html`), html);
  }
  const live = posts.filter((p) => !p.draft);
  const index = `<div class="wrap page">
<header>
<h1>Blog</h1>
<p>Notes on the apps, the lockdown on each platform, and what a child does with a tablet that runs only learning apps. <a href="/blog/feed.xml">RSS feed</a>.</p>
</header>
<ul class="post-list">
${live.map((p) => `<li><time datetime="${p.meta.date}">${prettyDate(p.meta.date)}</time><h2><a href="/blog/${p.slug}">${esc(p.meta.title)}</a></h2><p>${esc(p.meta.description)}</p></li>`).join('\n')}
</ul>
</div>`;
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Duckling Tablet blog</title>
<link>${ORIGIN}/blog/</link>
<description>Notes on the apps, the lockdown on each platform, and what a child does with a tablet that runs only learning apps.</description>
<language>en-us</language>
${live.map((p) => `<item><title>${esc(p.meta.title)}</title><link>${ORIGIN}/blog/${p.slug}</link><guid>${ORIGIN}/blog/${p.slug}</guid><pubDate>${new Date(p.meta.date + 'T12:00:00Z').toUTCString()}</pubDate><description>${esc(p.meta.description)}</description></item>`).join('\n')}
</channel></rss>
`;
  if (write) {
    fs.writeFileSync(path.join(BLOG, 'index.html'), shell({ title: 'Blog', description: 'Notes on the apps, the lockdown on each platform, and what a child does with a tablet that runs only learning apps.', url: `${ORIGIN}/blog/`, body: index, current: 'blog' }));
    fs.writeFileSync(path.join(BLOG, 'feed.xml'), feed);
    const sm = path.join(SITE, 'sitemap.xml');
    const base = fs.readFileSync(sm, 'utf8').split('\n').filter((l) => !l.includes('/blog')).filter((l) => l.trim() && !l.includes('</urlset>'));
    const urls = [`  <url><loc>${ORIGIN}/blog/</loc></url>`, ...live.map((p) => `  <url><loc>${ORIGIN}/blog/${p.slug}</loc><lastmod>${p.meta.date}</lastmod></url>`)];
    fs.writeFileSync(sm, [...base, ...urls, '</urlset>', ''].join('\n'));
    // Rendered posts whose source is gone.
    for (const f of fs.readdirSync(BLOG)) if (f.endsWith('.html') && f !== 'index.html' && !live.some((p) => `${p.slug}.html` === f)) fs.unlinkSync(path.join(BLOG, f));
  }
  console.log(`${live.length} post${live.length === 1 ? '' : 's'}${posts.length > live.length ? `, ${posts.length - live.length} draft` : ''}${bad ? `, ${bad} with problems` : ''}`);
  return bad === 0;
}

if (cmd === 'new') {
  const [slug, title] = args;
  if (!slug || !title) { console.error('usage: node tools/blog.mjs new <slug> "<title>"'); process.exit(2); }
  fs.mkdirSync(POSTS, { recursive: true });
  const file = path.join(POSTS, `${slug}.md`);
  if (fs.existsSync(file)) { console.error(`${file} exists`); process.exit(1); }
  fs.writeFileSync(file, `---
title: ${title}
description: One or two sentences for the listing, search results and the feed.
date: ${new Date().toISOString().slice(0, 10)}
draft: true
---

The first paragraph says what the post covers and who it is for.

## A heading

Body text. Plain declarative sentences, no em dashes, no promotional wording, and only facts the repo or a cited source backs. Remove "draft: true" from the front matter when the post is ready to publish.
`);
  console.log(file);
} else if (cmd === 'build') {
  process.exit(build(true) ? 0 : 1);
} else if (cmd === 'check') {
  process.exit(build(false) ? 0 : 1);
} else if (cmd === 'reply') {
  const [file] = args;
  if (!file) { console.error('usage: node tools/blog.mjs reply <file>'); process.exit(2); }
  const problems = lintReply(fs.readFileSync(file, 'utf8'));
  if (problems.length) { console.log(problems.join('; ')); process.exit(1); }
  console.log('ok');
} else {
  console.error('usage: node tools/blog.mjs new <slug> "<title>" | build | check | reply <file>'); process.exit(2);
}
