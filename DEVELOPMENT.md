# Development Guide

## Contributing

`main` is protected — every change goes through a PR.

```bash
git checkout -b <type>/<short-description>
# work, commit
git push -u origin <branch>
gh pr create --fill
gh pr merge --squash --delete-branch
```

Push to `main` (PR merge or direct) auto-triggers the pipeline via
[`.github/workflows/daily.yml`](.github/workflows/daily.yml). Docs-only
PRs (`**/*.md`, `.gitignore`, `LICENSE`) are excluded via `paths-ignore`
so README edits don't churn the R2 bucket.

Branch protection:
- PR required, 0 approvals (solo-dev friendly)
- Linear history (squash/rebase only)
- No force-push, no branch deletion
- Admin override allowed for genuine emergencies

## Prerequisites

- Node.js 24+
- `unzip` on PATH (every CI runner has it; macOS/Linux too)

No API keys needed — the pipeline only hits `api.transitous.org` and
whatever URLs are declared in per-feed `config.json` files.

## Setup

```bash
npm install
```

## Commands

```bash
npm run pipeline   # full build → outputs/
npm test           # vitest --run --passWithNoTests
npm run lint
```

Pipeline anatomy lives in [`src/pipeline/README.md`](src/pipeline/README.md).

## Adding a feed

Single source of truth: [`countries.json`](countries.json) `include[]`.
Per-feed config files are optional overlays.

### Default: plain Transitous mirror

1. Add the country's ISO code to `countries.json` `countries[]` if not
   already present.
2. Find the source name at
   `https://raw.githubusercontent.com/public-transport/transitous/main/feeds/<iso>.json`.
   Confirm `https://api.transitous.org/gtfs/<iso>_<name>.gtfs.zip`
   returns 200.
3. Add the name to `countries.json` `include[]`.
4. `npm run pipeline` locally; confirm `outputs/feeds.json` validates
   and `outputs/<id>.sqlite3.gz` opens
   (`sqlite3 <(gunzip -c outputs/<id>.sqlite3.gz) 'SELECT COUNT(*) FROM trips'`).

That's it — no `feeds/<id>/` needed for a plain mirror.

### Overlay app-side metadata or a different source

Create `feeds/<id>/config.json` when you need to:

- Swap the source for a sister-repo zip (`source.type=remote`)
- Provide / override realtime URLs (the MDB-resolver default may be
  missing or wrong)
- Override the inferred license text or attribution URL

Worked example: [`feeds/cluj-napoca/config.json`](feeds/cluj-napoca/config.json).

Minimum shape:

```json
{
  "enhances": "<TransitousName>",
  "license": { "attribution_text": "..." }
}
```

To use a sister-repo zip instead of Transitous, add:

```json
{
  "enhances": "<TransitousName>",
  "source": {
    "type": "remote",
    "publisher": "<who built the upstream zip>",
    "url": "https://.../the-feed.gtfs.zip"
  },
  "license": { "attribution_text": "..." },
  "smoke": {
    "expectedPublisher": "<must match feed_info.txt feed_publisher_name>",
    "tripIdPattern": "^...$"
  }
}
```

Other optional overlay fields: `id`, `name`, `country`, `region`,
`timezone`, `languages`, `realtime`. Anything you don't set
inherits from the Transitous-derived base.

Orphan overrides (a `feeds/<id>/` whose `enhances` doesn't match any
`include[]` entry) print a warning and produce nothing.

## CI

[`.github/workflows/daily.yml`](.github/workflows/daily.yml) runs at
00:30 UTC, on `workflow_dispatch`, and on every push to `main`,
uploading to the `neary-gtfs` Cloudflare R2 bucket. The app reads from
`https://gtfs.n3ary.com/feeds.json`.

### Publish target

Secrets and variables driving the R2 upload live in repo settings:

- Secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (R2 S3-compatible token,
  scoped Object Read+Write on the `neary-gtfs` bucket).
- Variables: `R2_S3_ENDPOINT`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`.

Uploads set `Cache-Control: public, max-age=300` on both `feeds.json`
and each `<id>.sqlite3.gz` — matches the previous GitHub-raw behavior
so propagation stays bounded to ≤ 5 min per publish.
