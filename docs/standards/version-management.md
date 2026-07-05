<!-- synced from n3ary/standards@063866e on 2026-07-05 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Version management

The version in `package.json` is bumped on every PR via a bot commit on the PR branch. When the PR merges to `main`, `main` already has the new version. Other open PRs rebase onto `main` to pick up the new version (or get auto-rebased by Dependabot).

Cross-ref: [../specs/ci-and-versioning.md](../specs/ci-and-versioning.md) for the implementation walkthrough (this standard is the rule; that spec is how it's wired up).

## Rules

- **One source of truth: `package.json#version`.** No git-SHA-based versioning, no separate version file, no `__BUILD_VERSION__` constant.
- **Bump on PR, not on merge.** The PR-validation workflow runs on every `pull_request` event, compares the PR branch's `package.json#version` to `origin/main`'s, and bumps if needed as a bot commit on the PR branch. When the PR merges, `main` already has the new version. Other open PRs that haven't bumped yet will bump to `main + 1` on their next push.
- **Patch-only.** This codebase has no API consumers; semver minor/major distinctions don't carry meaning. Every shipped change bumps patch.
- **Skip when only metadata changed.** If the PR's diff touches only `.github/**`, `.gitignore`, `LICENSE`, or `**/*.md`, skip the bump (no user-facing change).

## Why bump on PR

- The deploy workflow (which runs on `push: branches: [main]`) needs the version already incremented when it runs, so the published bundle reports the right number.
- Bumping on the PR branch keeps `main` strictly linear and avoids a race between merge and bump.

## What this looks like for two parallel PRs

Two PRs open at the same time:

| Step | PR-A's version | PR-B's version | `main` |
|---|---|---|---|
| Both branched from `main` at v1.5.20 | v1.5.20 | v1.5.20 | v1.5.20 |
| PR-A's bump workflow runs → bot commits v1.5.21 | v1.5.21 | v1.5.20 | v1.5.20 |
| PR-B's bump workflow runs → sees PR-A's ahead, but its own is still 20 vs main 20 → bumps to 21 | v1.5.21 | v1.5.21 | v1.5.20 |
| PR-A merges → main advances to 21 | — | v1.5.21 | v1.5.21 |
| PR-B is now behind by +1 → next push triggers bump workflow → bumps to 22 | — | v1.5.22 | v1.5.21 |
| PR-B merges → main advances to 22 | — | — | v1.5.22 |

`git pull --rebase` for local development handles this automatically. CI re-running handles it automatically. No special tooling needed.

## Anti-patterns to avoid

- **Don't bump on merge.** Adds a race between the bump commit and the deploy workflow; can produce deploys that report the wrong version.
- **Don't bump on push to main.** Same race; same deploy/version mismatch.
- **Don't bump on a tag.** We don't tag releases; the version in `package.json` is the only version string we publish.
- **Don't bump on a schedule.** Schedule-based bumps cause version drift between the source and the published bundle; the bump should always accompany a code change.

## Implementation reference

The bump is implemented as a shared composite action: [version-bump](https://github.com/n3ary/standards/tree/main/.github/actions/version-bump). All consumer repos (`n3ary/app`, `n3ary/gtfs`, `n3ary/gtfs-adapters`) use the same action, pinned to `@v1`.

Why shared (and not copy-pasted into each repo's `pr-validation.yml`):
- The bug we hit (`0.2.0-m1` parsing as `0.2.NaN`) was caused by copy-paste drift. Extracting to a shared action fixes the bug once and makes it testable in isolation.
- Bumping the action version is a coordinated change across all consumers. A versioned action (`@v1`) lets consumers pin to a known-good revision and update deliberately.

Usage:

```yaml
- name: Auto-bump version
  uses: n3ary/actions/.github/actions/version-bump@v1
  with:
    bump-skip-paths: '.github/,docs/,.gitignore,LICENSE'
```

The workflow still calls this action on every `pull_request` event; the action handles the bump and pushes the bot commit to the PR branch.