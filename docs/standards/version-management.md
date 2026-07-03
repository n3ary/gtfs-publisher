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

- `.github/workflows/pr-validation.yml` implements the bump. See its comments for the exact shell sequence (`npm version <next> --no-git-tag-version`, `git commit`, `git push`).
- The workflow YAML is portable; copy it from [neary's reference](https://github.com/ciotlosm/neary/blob/main/.github/workflows/pr-validation.yml) and adjust the validation commands to match this repo's tooling (`npm test`, `npm run lint`, `npm run pipeline` with `SKIP_PUBLISH=1`).