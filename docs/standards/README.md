<!-- synced from n3ary/standards@4175a47 on 2026-07-11 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Standards (shared)

This directory is the canonical source of truth for **repo-agnostic standards** in the n3ary org. The 3 consumer repos (`n3ary/app`, `n3ary/gtfs`, `n3ary/gtfs-adapters`) **vendor** these files into their own `docs/standards/` and a sync CI keeps the copies current.

See [SHARED-STANDARDS.md](SHARED-STANDARDS.md) for the manifest: which standard is shared, which stays local to a consumer repo, and which repos have local-only exemptions.

## Sync model

```
n3ary/standards/standards/<name>.md   ← canonical (this repo)
       │
       │ sync-standards workflow (PR-driven)
       ▼
neary/docs/standards/<name>.md             ← vendored copy (consumer)
neary-gtfs/docs/standards/<name>.md        ← vendored copy
n3ary/gtfs-adapters/adapters/cluj-napoca/docs/standards/<name>.md  ← vendored copy
```

Each vendored copy carries a header so it's clear where it came from:

```
<!-- synced from n3ary/standards@<sha> on <date> -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

(standard content)
```

Editing the vendored copy locally is a smell — the next sync will overwrite it. To change a shared standard, edit the canonical file in `n3ary/standards/standards/` and let the sync CI open PRs in each consumer repo.

## Local usage

To run the sync locally (opens vendor PRs against each consumer repo via the GitHub API):

```bash
# From the n3ary/standards repo root:
node scripts/vendor-standards.mjs
```

This requires:
- `gh` CLI authenticated (for opening PRs)
- Git push access to each consumer repo

For pure local vendoring without opening PRs (e.g. testing):

```bash
node scripts/vendor-standards.mjs --local /tmp/vendor-test
```

This writes the vendored copies to a local directory for inspection. No git operations.

## Drift check (consumer side)

Each consumer repo has a `.github/workflows/check-standards-drift.yml` that runs on PRs to `main`. It compares the `<!-- synced from ... -->` header against `n3ary/standards@main` and fails if the vendored copy is out of date. The fix is to merge the auto-PR that `sync-standards.yml` opened, or run `node scripts/vendor-standards.mjs` locally.

## What's NOT here

Repo-specific standards stay in the consumer repo. Example: `feed-agnostic.md` lives only in `neary/docs/standards/` — it's about the neary PWA's contract with feeds, not about anything cross-repo.

When you add a new standard, ask:

1. **Is it cross-repo?** → put it here in `n3ary/standards/standards/`. Add it to [SHARED-STANDARDS.md](SHARED-STANDARDS.md).
2. **Is it consumer-specific?** → put it in the consumer repo's `docs/standards/`. Don't add it to the manifest.

## References

- [neary/docs/standards/documentation.md](https://github.com/n3ary/app/blob/main/docs/standards/documentation.md) — placement rules (where docs go in this repo)
- [n3ary/standards/README.md](../../README.md) — top-level overview of n3ary/standards