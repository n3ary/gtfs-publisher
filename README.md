# gtfs-publisher

A feed-agnostic GTFS publisher. Reads each operator's upstream source via a
per-feed adapter package, and publishes the three artifacts any GTFS
consumer needs:

1. **Raw GTFS Schedule zips** — the spec-compliant `.gtfs.zip` for each feed,
   content-addressed by sha256. This is the artifact external GTFS tooling
   (onebusaway, gtfs-to-html, transit planners, validators) reads. It is
   **strictly the public GTFS Schedule spec** — no per-feed extensions are
   added here.

2. **GTFS-RT feeds** — a Fastify HTTP server proxies live `vehicle_positions`,
   `trip_updates`, and `service_alerts` GTFS-Realtime protobuf feeds. Same
   upstream sources as the static side; the protocol-buffer wire format is
   the standard, no extensions.

3. **SQLite blobs** — `<id>-<hash12>.sqlite3.gz`, one per feed. This is what
   the [n3ary/app](https://github.com/n3ary/app) PWA stores in OPFS and
   queries at runtime. **Per-feed extensions are injected here** — the
   cluj adapter, for example, adds `networks.network_color` and a
   `_neary_config` table — but the extensions **never leak into the
   published `.gtfs.zip`**. The zip stays spec-clean; the sqlite blob
   carries whatever each consumer needs.

> [!NOTE]
> **Live artifacts**: [`https://gtfs.n3ary.com/feeds.json`](https://gtfs.n3ary.com/feeds.json)
> (R2 via custom domain `gtfs.n3ary.com`)

## What this repo is not

- It is **not** a GTFS validator. It consumes whatever the adapter produces.
- It is **not** a feed-source registry. Operators live in `feeds/<id>/config.json`,
  with `source.publisher` pointing at a published adapter package (e.g.
  `@n3ary/gtfs-adapter-<feed>` from
  [`n3ary/gtfs-adapters`](https://github.com/n3ary/gtfs-adapters)).
- It is **not** a trip planner. It only publishes data.

## Repository layout

```
.
├── apps/
│   ├── gtfs-static/        static pipeline: resolve feeds → acquire zips → make-sqlite → R2
│   └── gtfs-rt/            Fastify GTFS-RT proxy: serves protobuf over HTTP
├── libs/
│   └── spec/               shared @n3ary/gtfs-spec (types, SQL DDL, ZIP readers)
├── feeds/<id>/config.json per-feed overrides (source.publisher, secrets[], timing, smoke)
├── countries.json          single source of truth for which feeds to publish
├── docs/
│   ├── architecture/       data-pipeline.md (system-level diagram)
│   └── ops/                secrets-and-deploy.md, publishing.md
└── .github/workflows/      daily.yml (publish), pr-validation.yml
```

Apps vs. libs: `apps/*` are deployable (cron pipeline, long-running HTTP service, eventually the CF edge worker). `libs/*` are imported as workspace dependencies by other packages — `libs/spec` is the only one right now and it's the only one published (to GH Packages as `@n3ary/gtfs-spec`).

## Adding a new feed

1. Add `feeds/<id>/config.json` (copy an existing one as a template).
2. Set `source.type` to `"adapter"` + `source.publisher` to the adapter's
   npm package name.
3. Add the feed's required secrets to `secrets[]` (env var names).
4. Add the env vars to the GitHub Actions secrets on this repo, then add
   them to `.github/workflows/daily.yml`'s env block.
5. Add the Transitous source name (if any) to `countries.json`'s `include[]`
   so the catalog lookup finds it.

No code change in `apps/gtfs-static/src/cli.ts` — the orchestrator is
feed-agnostic and discovers adapters by `source.publisher` at runtime.

## Quick start

```bash
npm install
npm run pipeline   # full build → outputs/ + (optionally) R2
npm test           # vitest --run --passWithNoTests
```

## Documentation

- [docs/architecture/data-pipeline.md](docs/architecture/data-pipeline.md) —
  system-level diagram of the static + RT pipelines, what each publishes
- [docs/ops/secrets-and-deploy.md](docs/ops/secrets-and-deploy.md) — R2
  credentials, daily workflow, RT proxy deploy
- [docs/standards/version-management.md](docs/standards/version-management.md) —
  the bump-on-PR rule

## Contributing

`main` is protected — every change goes through a PR.
[`.github/workflows/pr-validation.yml`](.github/workflows/pr-validation.yml)
bumps `package.json#version` on the PR branch and runs test + lint +
pipeline smoke.

## Brand

The visual identity (logo, favicon, social card, wordmarks) lives in the
canonical [n3ary/branding](https://github.com/n3ary/branding) repo and is
served at <https://branding.n3ary.com>. This repo doesn't ship any brand
assets — if you need the GitHub org avatar, the repo social preview, or a
logo, pull from there (see [the SETUP.md there](https://github.com/n3ary/branding/blob/main/SETUP.md)
for the URL map).

## Data license

Schedule data © its respective transit operators (per-feed
`license.attribution_text` in `feeds.json`). Generated for public transit
information purposes.

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE) — free for individuals,
hobbyists, education, research, and charitable organizations. Any commercial
use (paid products, paid services, or hosted services for revenue) needs a
separate license from the author. See the LICENSE file for the full terms.