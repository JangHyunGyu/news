# Publication SEO verification — 2026-10-12

Scope: permanent article URLs, HTML rendering, date-specific canonicals, automatic
sitemaps and a source-independent publication store. Additional news sources are
not enabled; the user selected infrastructure only.

## Data and persistence

- Production snapshot: 2,109 daily entries, 2,027 distinct HN IDs.
- Idempotent backfill creates 276 publications from completed translations/summaries.
- Daily HN rows remain unchanged. Legacy summaries and failed/unavailable translations
  are excluded from article backfill, not deleted from the original daily editions.
- The `(source_key, source_item_id)` key prevents source-ID collisions. Internal
  article IDs and first publication dates survive retranslation and daily replacement.
- Updates to published text change `modified_at`; identical retries do not.
- Database backup and screenshots are outside the repository in
  `D:/workspace/_workspace/news-seo-20261012/`.

## Browser and crawl checks

- Compared production baseline against the local Worker using the production data copy.
- Desktop 1440 × 1000 and mobile 390 × 844: home, current edition, dated edition,
  article popup. All eight full-page screenshot pairs are pixel-identical.
- Browser analytics/session/error-reporting scripts were disabled equally in both
  comparison runs to isolate application rendering and avoid test analytics events.
- Existing title/card click opens the same popup; close/history and previous/next
  navigation pass on both viewports. Date links now work without JavaScript.
- New article and archive pages render without horizontal overflow on both viewports.
- JavaScript-disabled navigation from a dated edition to full article text passes.
- No browser page errors in the interaction test.
- All 499 URLs enumerated by the three local sitemaps returned HTTP 200; no broken
  article/date/static entries were found. Unknown articles, missing dates and invalid
  pagination return HTTP 404 with noindex.
- Article title/body and JSON-LD escape hostile markup. Bootstrap data excludes the
  original full-text payload and serializes script delimiters safely.

## Korean copy review

The new AI translation notice was checked using the local `im-not-ai` Codex light
procedure with an independent monolith review. Original and final text, metrics and
gate output are in `_workspace/2026-10-12-001-4a86/`. No prose changes were needed:
0.0% change, six checks passed, deterministic gate exit 0. Existing article bodies
were preserved byte-for-byte as stored; no scenario or character dialogue was edited.

## Release checks and limits

Final `npm test`: 32 tests and 73 repository checks passed. Final
`npx wrangler deploy --dry-run --outdir dist`: passed (558.27 KiB upload,
136.86 KiB gzip). `git diff --check`: passed. Recheck `main` before committing/pushing.
Production migration and deployment require a clean tree whose HEAD equals
`origin/main`. Keep `articles` if rolling the Worker back.

This establishes discoverable, indexable publication pages. Google/Naver indexing,
rankings and Search Console acceptance are not verified or guaranteed by these tests.
The live robots.txt continues to advertise `/sitemap.xml`; no Search Console submission
has been performed.
