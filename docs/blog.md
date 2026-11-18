# The ducklingtablet.com blog

Posts live in `site/blog/posts/<slug>.md`. `node tools/blog.mjs build` renders them into `site/blog/<slug>.html`,
rebuilds `site/blog/index.html`, `site/blog/feed.xml` and the blog entries in `site/sitemap.xml`, and refuses any post
that fails the linter. The rendered files are committed, since nginx serves `site/` as static files. The deploy
(`deploy/deploy.ps1`) copies `site/` as it is.

```
node tools/blog.mjs new <slug> "<title>"    a post from the template, with draft: true
node tools/blog.mjs check                   the linter, no files written
node tools/blog.mjs build                   render, index, feed, sitemap
```

A post has a front matter block (`title`, `description` of 150 to 200 characters, `date` as YYYY-MM-DD, and
`draft: true` while it is not ready) and a Markdown body with `##` headings, paragraphs, lists, links, and
inline code. The file name is the URL, so it is lowercase words joined by hyphens.

## Who reads it and why it exists

Parents deciding whether a locked-down learning tablet suits their child, and parents who already have one and
want to set it up or understand what the apps do. The blog exists so that those searches land on
ducklingtablet.com. Every post answers a question a parent would type into a search engine, in plain words, with
the facts the repo backs.

## Writing rules (the ET Ducky house style, binding)

The full rules are the ET Ducky promotion brief, section 5 (in the ET Ducky promo queue's config, document
`brief`). The ones that apply to a blog post:

- No em dashes, no en dashes, no " - " asides. One idea per sentence. No semicolons. Split the sentence.
- Plain declarative sentences. Contractions are fine. Cut the second half of a long sentence and see if it still
  says what it needs to. End a sentence on the action.
- No promotional or comparison language. Not "unlike X", "X, not Y", "the best", "competitors", "seamless",
  "powerful". Informative and specific, with numbers where they exist.
- No decorative unicode or emoji. Use the Oxford comma in every list of three or more.
- No colon-introduced lists or explanations inside a sentence. Put the items in the sentence. A colon may end a
  line that introduces separate steps.
- No idioms, analogies, personification, or invented scenarios. Say "fails", "conflicts with", "functioning as
  intended". Do not make a point vivid with a hypothetical child, tablet, or family.
- No illustrative tails ("so you can ..."), no setup lines ("In this post", "Let's"), no evaluative shorthand
  ("the right choice"), no definitional framing ("X is the part of Y that Z"), no vague back-references ("this
  gap", "the same way"). Name the object.
- Open a feature post with what the feature does, stated directly. Lead a how-to with the reader's goal or the
  first step as an imperative. End on the last useful step, with no closing remark on how important it was.
- Plain words over product jargon. Spell out a vendor term on first use with the acronym in parentheses and link
  the vendor's own documentation once, at most one such link per post.
- Describe what the AI apps do as finding and suggesting, never deciding.
- No app counts, no "currently" states, no version numbers. They go stale.
- Mention the product once with a link where it fits. The reader's question comes first.

Things never to write: anything from the ET Ducky brief's Never say list that touches this product (certifications
and attestations that do not exist, customer counts, revenue), a child's or family's real name or data, a
screenshot that shows a real child, a claim about a competitor, a feature the repo does not have, a price other
than the one on the site today.

## Where the facts come from

Only these. A fact that none of them backs is left out.

- `apps/<id>/manifest.json`: each app's name, description, subjects, ages, and its `about` block (`concept`,
  `progression`, `lifeSkills`). The About text is the source for any post about an app.
- `docs/ladders.md`: the grade bands per subject and how levels move.
- `site/*.html`: what the site says about setup, the lockdown on each platform, pricing, privacy, and support.
- `web/src/screens/Parent.tsx`, `web/src/screens/Pair.tsx`: the exact words of the setup and lockdown steps.
- `portal/src/screens/Family.tsx`: what the parent portal controls and how each section is named.
- `Duckling-Build-Plan.md` in `D:\Ducking_Docs` (the project doc `claude/duckling-tablet-build-plan.md`) for
  decisions and dates, when it is available.
- A public primary source fetched in the same run (a vendor's documentation page, a government or university
  page) for a general fact about child development or a platform, linked where it is used.

## Topics, and the order to pick them in

Keep `docs/blog-topics.md` as the record: each topic that has a post, each that is waiting, and each that was
rejected with the reason. Pick the first waiting topic whose facts are in the repo. The kinds, in rough order of
value to a parent searching:

1. Setup and lockdown how-tos, one platform per post (Android pinning and the home screen, iPad Screen Time and
   Guided Access, Windows child account). The step text comes from the parent area.
2. One app per post: what it trains, how it grows from pre-K to 8th grade, what a parent sees in the portal.
3. How the parent portal does one job (allowed websites, other apps with daily minutes, a second parent, app
   requests, levels per subject).
4. The narrator, the avatar, stars, and what travels between tablets.
5. Privacy in plain terms (what is kept, what never leaves the tablet, how to delete everything).
6. A parent's question about screen time or learning at a grade level, answered with a public primary source
   and the apps that fit, without turning it into a pitch.

Never two posts on the same app or the same platform within 60 days. Never a post built around a bug or an
outage.

## The weekly drafting task

A scheduled task ("Duckling Tablet blog draft") runs once a week in the cloud with this repo. It does not
publish. It:

1. Pulls `main`, reads this file, `docs/blog-topics.md`, and the published posts in `site/blog/posts/`.
2. Picks the next topic and gathers the facts from the sources above, quoting the repo rather than memory.
3. Writes the post with `node tools/blog.mjs new`, removes `draft: true`, and runs `node tools/blog.mjs check`
   until it passes. Then `node tools/blog.mjs build`.
4. Updates `docs/blog-topics.md`.
5. Commits on a branch `blog/<slug>`, pushes it, and opens a pull request titled with the post's title, whose
   body holds the description, the word count, the sources used, and the rendered text, with the attribution
   lines the repo uses.
6. Sends Chris one message with the title and the pull request link.

Chris reads the pull request, edits or rejects it there, merges it, and deploys. A merged post is live at the
next deploy. A rejected pull request's reason goes into `docs/blog-topics.md` under the topic, so the next run
does not repeat it.
