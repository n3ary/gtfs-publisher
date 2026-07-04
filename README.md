# neary-gtfs

The app-side companion to a GTFS feed: turns one or more upstream `.gtfs.zip` URLs into the two things the [n3ary/app](https://github.com/n3ary/app) PWA actually needs to render a city:

1. A `.sqlite3.gz` blob per feed (the app's in-OPFS data store).
2. A single `feeds.json` registry with everything else the app reads at launch — bbox, center, timezone, agencies, license, realtime URLs, and the upstream ETag we use for change-detection.

> [!NOTE]
> **Live registry**: [`https://gtfs.n3ary.com/feeds.json`](https://gtfs.n3ary.com/feeds.json) (Cloudflare R2 via custom domain)

The repo deliberately does **not** produce GTFS — it consumes it. Where the zip comes from is a per-feed detail (Transitous mirror, sister-repo adapter, …) and lives in [`feeds/<id>/config.json`](feeds/).

## Quick start

```bash
npm install
npm run pipeline   # full build → outputs/
npm test           # vitest --run --passWithNoTests
```

## Documentation

- [docs/architecture/data-pipeline.md](docs/architecture/data-pipeline.md) — system-level diagram of the pipeline, source flavors, what this repo produces
- [docs/ops/secrets-and-deploy.md](docs/ops/secrets-and-deploy.md) — R2 credentials, branch protection, daily workflow
- [DEVELOPMENT.md](DEVELOPMENT.md) — local development setup, contributing workflow, adding a new feed
- [src/pipeline/README.md](src/pipeline/README.md) — pipeline stage implementation walkthrough

## Repository layout

```
.
├── countries.json            single source of truth for what we publish
├── feeds/<id>/config.json    per-feed override (optional)
├── src/pipeline/              pipeline implementation (see src/pipeline/README.md)
├── schemas/feeds.schema.json Ajv validation for feeds.json
├── outputs/                   build artifacts (gitignored, uploaded to R2)
├── docs/
│   ├── architecture/         system-level diagrams (data-pipeline.md)
│   ├── ops/                   deployment + secrets (secrets-and-deploy.md)
│   └── standards/             repo-agnostic standards (vendor from neary-shared)
└── .github/workflows/         daily.yml, pr-validation.yml
```

## Contributing

`main` is protected — every change goes through a PR. See [docs/standards/version-management.md](docs/standards/version-management.md) for the bump-on-PR rule. PRs trigger [`.github/workflows/pr-validation.yml`](.github/workflows/pr-validation.yml), which bumps `package.json#version` on the PR branch and runs test + lint + pipeline smoke.

## Brand

The visual identity (logo, favicon, social card, wordmarks) lives in the canonical [n3ary/branding](https://github.com/n3ary/branding) repo and is served at <https://branding.n3ary.com>. This repo doesn't ship any brand assets — if you need the GitHub org avatar, the repo social preview, or a logo, pull from there (see [the SETUP.md there](https://github.com/n3ary/branding/blob/main/SETUP.md) for the URL map).

## License

Schedule data © its respective transit operators (per-feed `license.attribution_text` in `feeds.json`). Generated for public transit information purposes.