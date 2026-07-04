# Secrets and deployment

Repo-level secrets and variables driving the daily R2 publish. Repo settings (not committed).

## Secrets

| Name | Purpose |
|---|---|
| `R2_ACCESS_KEY_ID` | R2 S3-compatible token, scoped Object Read+Write on the `neary-gtfs` bucket |
| `R2_SECRET_ACCESS_KEY` | (paired with access key) |
| `GITHUB_TOKEN` | Optional. Set in CI for higher `api.github.com` rate limit on the MobilityData catalog lookup. Without it: 60 req/hour — well under our 1-call-per-run usage. |

## Variables

| Name | Purpose |
|---|---|
| `R2_S3_ENDPOINT` | S3-compatible endpoint URL |
| `R2_BUCKET` | Bucket name (currently `neary-gtfs`) |
| `R2_PUBLIC_BASE_URL` | Public base URL — `feeds.json` and `*.sqlite3.gz` are served with `Cache-Control: public, max-age=31536000, immutable` |

## Cache headers

Uploads set `Cache-Control: public, max-age=300` on `feeds.json` and each `<id>.sqlite3.gz` — propagation stays bounded to ≤ 5 min per publish, matches the previous GitHub-raw behavior the sister repo's consumer relied on.

## Daily workflow

[`.github/workflows/daily.yml`](../../.github/workflows/daily.yml) runs at 00:30 UTC (after Transitous's ~00:00 UTC daily import), on `workflow_dispatch`, and on push to `main`. Docs-only changes (any README, anywhere) are excluded via `paths-ignore` so README edits don't churn the R2 bucket.

## Branch protection

PR-required, 0 approvals (solo-dev friendly), linear history (squash/rebase only), no force-push, no branch deletion, admin override allowed for genuine emergencies. Required status checks: `validate` must pass. Branches must be up to date before merge (so the version-sequencing in `pr-validation.yml` can't race).

## Local pipeline

See [`../../DEVELOPMENT.md`](../../DEVELOPMENT.md) for the `pnpm pipeline` and `pnpm test` setup. For a smoke build without R2 upload: `SKIP_PUBLISH=1 pnpm pipeline`.

<!-- The R2 bucket is named `neary-gtfs` for historical reasons. We renamed the GitHub repo to `n3ary/gtfs` but kept the bucket name (and CDN URL `gtfs.n3ary.com`) to avoid breaking external links. -->
