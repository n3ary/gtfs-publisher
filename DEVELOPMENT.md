# Development Guide

## Contributing

`main` is protected — every change goes through a PR.

```bash
git checkout -b <type>/<short-description>
# work, commit
git push -u origin <branch>
gh pr create --fill          # opens a PR with commit msg as body
gh pr merge --squash --delete-branch
```

PR merge to `main` (and pushes to `main` more generally) auto-triggers
the daily pipeline via `.github/workflows/daily.yml`. Docs-only PRs
(`README.md`, `DEVELOPMENT.md`, `.gitignore`) are excluded via
`paths-ignore` to avoid pointless rebuilds.

Branch protection settings:
- PR required, 0 approvals (solo-dev friendly)
- Linear history (squash/rebase only)
- No force-push, no branch deletion
- Admin override allowed for genuine emergencies

## Prerequisites

- Node.js 24+
- `unzip` on PATH (every CI runner has it; macOS/Linux do too)

No API keys needed — the pipeline only hits `api.transitous.org` and
the upstream URLs declared in per-feed `config.json` files.

## Setup

```bash
npm install
```

## Commands

```bash
npm run pipeline   # full daily build → outputs/
npm test           # vitest --run
npm run lint
```

Pipeline anatomy lives in [README.md](README.md#pipeline) — no need to
duplicate the diagram here.

## Adding a feed

Single source of truth: `countries.json` `include[]`.

### Plain Transitous mirror (default)

1. Add the country's ISO code to `countries.json` `countries[]` (if not
   already present).
2. Find the Transitous source name at
   `https://raw.githubusercontent.com/public-transport/transitous/main/feeds/<iso>.json`.
   Confirm `https://api.transitous.org/gtfs/<iso>_<name>.gtfs.zip` returns 200.
3. Add the name to `countries.json` `include[]`.
4. Run `npm run pipeline` locally; confirm `outputs/feeds.json`
   validates and the per-feed `.sqlite3.gz` opens
   (`sqlite3 outputs/<id>.sqlite3 'SELECT COUNT(*) FROM trips'`).

### Remote-sourced feed (sister-repo zip)

Use when the Transitous mirror is stale and a separate repo produces a
better GTFS zip for that operator (e.g.
[`cluj-napoca-gtfs-adapter`](https://github.com/ciotlosm/cluj-napoca-gtfs-adapter)
reconciles three sources for CTP Cluj).

1. Do steps 1–3 above so the Transitous source is in `include[]`.
2. Create `feeds/<your-id>/config.json` (directory name = feed id
   unless `id` overrides). See
   [`feeds/cluj-napoca/config.json`](feeds/cluj-napoca/config.json)
   for a complete example. Required fields:

   ```json
   {
     "enhances": "<TransitousName>",
     "source": {
       "type": "remote",
       "publisher": "<who built the upstream zip>",
       "url": "https://.../the-feed.gtfs.zip"
     },
     "license": { "attribution_text": "..." }
   }
   ```

   Optional fields you can overlay: `id`, `name`, `country`, `region`,
   `timezone`, `languages`, `realtime`, `tranzy`, and a `smoke` block
   (`expectedPublisher`, `tripIdPattern`) that runs on every fetched
   zip and fails the build on contract violation.

3. Orphan overrides (a `feeds/<id>/` whose `enhances` doesn't match any
   `include[]` entry) print a warning and produce nothing.

## CI

`.github/workflows/daily.yml` runs nightly (00:30 UTC) and on
`workflow_dispatch`, targeting the `binaries` branch. App consumes from
`https://cdn.jsdelivr.net/gh/ciotlosm/neary-gtfs@binaries/feeds.json`.
