# Version management

The version in `package.json` is bumped on every PR via a bot commit on the PR branch. When the PR merges to `main`, `main` already has the new version. Other open PRs rebase onto `main` to pick up the new version (or get auto-rebased by Dependabot).

Cross-ref: [../../DEVELOPMENT.md](../../DEVELOPMENT.md) for the implementation walkthrough (this standard is the rule; the dev guide documents how it's wired up).

## Rules

- **One source of truth: `package.json#version`.** No git-SHA-based versioning, no separate version file.
- **Bump on PR, not on merge.** The PR-validation workflow runs on every `pull_request` event, compares the PR branch's `package.json#version` to `origin/main`'s, and bumps if needed as a bot commit on the PR branch. When the PR merges, `main` already has the new version. Other open PRs that haven't bumped yet will bump to `main + 1` on their next push.
- **Patch-only.** This codebase has no API consumers; semver minor/major distinctions don't carry meaning. Every shipped change bumps patch.
- **Skip when only metadata changed.** If the PR's diff touches only `docs/**`, `.github/**`, `.gitignore`, or `LICENSE`, skip the bump (no user-facing change).

## Why bump on PR

- The daily pipeline (which runs on `push: branches: [main]`) needs the version already incremented when it runs, so the published artifacts reflect the right number.
- Bumping on the PR branch keeps `main` strictly linear and avoids a race between merge and bump.

## What this looks like for two parallel PRs

Two PRs open at the same time:

| Step | PR-A's version | PR-B's version | `main` |
|---|---|---|---|
| Both branched from `main` at v0.1.0 | v0.1.0 | v0.1.0 | v0.1.0 |
| PR-A's bump workflow runs → bot commits v0.1.1 | v0.1.1 | v0.1.0 | v0.1.0 |
| PR-B's bump workflow runs → bumps to 1 (matches PR-A) | v0.1.1 | v0.1.1 | v0.1.0 |
| PR-A merges → main advances to 1 | — | v0.1.1 | v0.1.1 |
| PR-B is now behind → next push triggers bump workflow → bumps to 2 | — | v0.1.2 | v0.1.1 |
| PR-B merges → main advances to 2 | — | — | v0.1.2 |

`git pull --rebase` for local development handles this automatically. CI re-running handles it automatically.

## Anti-patterns to avoid

- **Don't bump on merge.** Adds a race between the bump commit and the daily pipeline; can produce artifacts that report the wrong version.
- **Don't bump on push to main.** Same race; same version mismatch.
- **Don't bump on a schedule.** Schedule-based bumps cause version drift between the source and the published artifacts; the bump should always accompany a code change.

## Implementation reference

The bump is implemented as a shared composite action: [n3ary/standards/.github/actions/version-bump](https://github.com/n3ary/standards/tree/main/.github/actions/version-bump). All three repos (neary, neary-gtfs, cluj-napoca-gtfs-adapter) use the same action, pinned to `@v1`.

Why shared (and not copy-pasted into each repo's `pr-validation.yml`):
- The bug we hit (`0.2.0-m1` parsing as `0.2.NaN`) was caused by copy-paste drift. Extracting to a shared action fixes the bug once and makes it testable in isolation.
- Bumping the action version is a coordinated change across all consumers. A versioned action (`@v1`) lets consumers pin to a known-good revision and update deliberately.

Usage:

```yaml
- name: Auto-bump version
  uses: n3ary/standards/.github/actions/version-bump@v1
  with:
    bump-skip-paths: 'docs/,.github/,.gitignore,LICENSE'
```

This repo overrides the default `bump-skip-paths` to also include `docs/` (in addition to the default `.github/`, `.gitignore`, `LICENSE`) because the daily pipeline's `paths-ignore` already excludes docs-only changes.