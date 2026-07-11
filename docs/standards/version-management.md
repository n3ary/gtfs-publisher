<!-- synced from n3ary/standards@4175a47 on 2026-07-11 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Version management

Every shipped change to any n3ary repo produces a new version in that repo's `package.json#version`. Versions follow the **CalVer** format `YY.M.D-N`, where `N` is the release counter for that day. The version is bumped **on merge to `main`**, not on PR, by an org-level GitHub App (the `n3ary-release-bot`). No per-consumer workflow file is involved.

## Rules

- **One source of truth: `package.json#version`.** No git-SHA-based versioning, no separate version file, no `__BUILD_VERSION__` constant.
- **CalVer format `YY.M.D-N`.** `YY` is the two-digit year, `M` is the month (1-12, no leading zero), `D` is the day (1-31, no leading zero), `N` is the release counter for that day (starts at `1`).
  - Example: `26.7.11-1` is the first release of 11 July 2026.
  - The same day, the second release is `26.7.11-2`, the third is `26.7.11-3`, and so on.
  - The next day, the counter resets to `1`: `26.7.12-1`.
- **Timezone: `Europe/Bucharest`.** The day boundary is midnight in the org's local timezone. This is the only place "today" is defined for the bot.
- **Bump on merge, by the org-level release bot.** The bot is a GitHub App installed on the n3ary org. On every `pull_request: closed` event with `merged == true`, it opens a pull request titled `chore(release): <version>` with the version bump on a `release/calver-<version>` branch, and enables auto-merge on the PR. With 0 required reviews (the n3ary branch protection standard), the version lands on `main` as soon as the required status checks pass. No per-consumer workflow file references the bot.
- **Skip when the merge already changed the version.** If the merge commit's `package.json#version` differs from its parent's, the dev manually edited the version (e.g. for a tagged build, a one-off release, or a backport). The bot's idempotency check sees this and no-ops. The dev's edit wins.
- **Multi-package repos are handled per `package.json`.** The bot discovers every `package.json` under the repo tree (root, `libs/spec/`, `adapters/*/`, etc.) and bumps each one independently. The `skip-if-already-touched` rule applies per file.

## Why CalVer with a daily counter

- The date is human-meaningful. `26.7.11-3` is a release of 11 July 2026, third of the day. Anyone reading the version string knows when it shipped.
- Multiple releases per day get unique versions via the counter. `26.7.11-1`, `26.7.11-2`, `26.7.11-3` is unambiguous.
- No semver discipline required. The org has no API consumers; `minor`/`major` distinctions carry no meaning. CalVer encodes the only signal that matters: "when did this ship".
- The bot's bump logic is simpler than semver-increment. The same algorithm handles first-ever-release, same-day, and new-day cases.

## Why the release bot, not a per-repo workflow

The previous model (bot commit on the PR branch, via the `n3ary/actions/.github/actions/version-bump` composite action) had three structural problems:

1. **Branch-out-of-sync pain.** The bot pushed a commit on the PR branch after `validate` passed. Every `main` advance forced a rebase, which dropped the bot's commit, which re-triggered the bot, which landed in the `action_required` gate because `github-actions[bot]` is treated as a first-time contributor. The cycle is documented in the `n3ary-pr-automation` agent memory and has bitten every active consumer repo.

2. **`contents: write` on PR-time workflows.** Every `pr-validation.yml` had `permissions: contents: write` solely to support the auto-bump. That's a real privilege: a malicious dependency that exploits the workflow could push commits to the repo. With the bot, PR-time workflows only need `contents: read`.

3. **Stale action references.** `n3ary/gtfs-adapters` was on `version-bump@v12` while the rest of the org was on `@v22`. Dependabot opened a PR (#44, merged 2026-07-06) that bumped 2 of 3 `n3ary/actions` references in the same file — the third stayed at `v12`. The per-consumer action reference is fragile in a way that wasn't visible until this exact case landed. The release bot eliminates the per-consumer action reference for versioning entirely, so this class of bug cannot recur.

## What this looks like

### A single PR merge on 11 July 2026

```
main is at 26.7.11-1 (from an earlier merge today)

11:30  PR #142 "fix: handle missing stop times" merges
       → bot receives webhook, reads main = 26.7.11-1
       → bot computes next = 26.7.11-2 (same day, counter+1)
       → bot opens PR "chore(release): 26.7.11-2" against main
       → auto-merge fires as soon as required checks pass (~10-30 s)
       → main is now 26.7.11-2

15:45  PR #143 "chore: bump deps" merges
       → bot receives webhook, reads main = 26.7.11-2
       → bot computes next = 26.7.11-3 (same day, counter+1)
       → bot opens PR "chore(release): 26.7.11-3" against main
       → auto-merge fires
       → main is now 26.7.11-3
```

### A merge on 12 July 2026 (new day)

```
main is at 26.7.11-3 (from 11 July)

10:00  PR #144 "feat: support multiple agencies" merges
       → bot receives webhook, reads main = 26.7.11-3
       → bot computes next = 26.7.12-1 (new day, counter resets to 1)
       → bot opens PR "chore(release): 26.7.12-1" against main
       → auto-merge fires
       → main is now 26.7.12-1
```

### A dev manually edits the version

```
main is at 26.7.11-2

14:00  PR #145 "fix: typo" opens, dev edits libs/spec/package.json#version to 26.7.12-1
       (the dev wants the spec to ship ahead of the next app release)
14:30  PR #145 merges
       → bot receives webhook, reads main's libs/spec/package.json#version = 26.7.12-1
       → bot reads main's libs/spec/package.json#version at HEAD~1 = 26.7.11-2
       → bot sees they differ → no-op on libs/spec/package.json
       → main is now 26.7.12-1, exactly as the dev intended
```

### Two PRs merge in quick succession

```
main is at 26.7.11-1

11:30:00  PR-A merges → bot webhook fires
11:30:02  PR-B merges → bot webhook fires
11:30:05  PR-A's webhook runs first → reads 26.7.11-1, opens PR "chore(release): 26.7.11-2"
11:30:08  PR-B's webhook runs → calls findOpenReleasePR, sees PR-A's PR is still open, no-ops
11:30:35  PR-A's PR auto-merges → main is now 26.7.11-2
```

The two webhooks don't race. The second one short-circuits on `findOpenReleasePR` and lets PR-A's PR land first. Once main is at 26.7.11-2, the next PR merge in any repo will trigger the bot again for the 26.7.11-3 bump on the original repo (not on PR-B's repo — each bot run is scoped to the repo that fired the webhook).

## What ships in `package.json`

The version string lives only in `package.json#version`. There is no separate version file, no `__BUILD_VERSION__` constant, no build-time substitution. The version that ships is the version in the file at commit time.

For multi-package repos (e.g. `gtfs-publisher` with `libs/spec/`, `gtfs-adapters` with `adapters/*/`), each `package.json` is bumped independently. The release bot's idempotency check is per-file: a dev who edits `libs/spec/package.json#version` does not affect `gtfs-publisher`'s root `package.json#version`.

## Anti-patterns to avoid

- **Don't bump on the PR branch.** The PR branch is the dev's; the bot has no business there. The bot creates its own `release/calver-<version>` branch and opens a PR — the dev's branch is never touched.
- **Don't bump on a tag.** We don't tag releases. The version in `package.json` is the only version string we publish. If a tag is ever needed, the release bot's commit message is the natural anchor.
- **Don't bump on a schedule.** Schedule-based bumps cause version drift between the source and the published bundle. The bump should always accompany a code change.
- **Don't hand-edit `package.json#version` in a PR unless you mean it.** The bot's `skip-if-already-touched` rule treats any version change in the merge as intentional. If the version change is a mistake (e.g. you ran `npm version` locally and committed it), the bot will silently no-op on the bump and your mistake becomes the version.
- **Don't use semver.** The org has no API consumers; semver minor/major don't carry meaning. If a future product does have API consumers, the CalVer format is still the right anchor; the product's own versioning is its concern, not the org's.

## Implementation reference

The bump is implemented as the `n3ary/release-bot` Cloudflare Worker, deployed via `wrangler`. The bot's source lives in `n3ary/release-bot/src/`:

- `webhook.ts` — receives GitHub webhooks, verifies signature, dispatches.
- `bump.ts` — CalVer arithmetic, the `nextCalVer(current, now, tz)` function.
- `commit.ts` — discovers `package.json` files, applies the per-file skip rules, creates the `release/calver-<version>` branch, commits the version bump, opens the PR, enables auto-merge.
- `pr.ts` — branch + PR operations (`createBranch` is idempotent; `findOpenReleasePR` short-circuits on existing open release PRs).
- `auth.ts` — JWT signing + installation token exchange.

The bot is a GitHub App registered with the manifest in `n3ary/release-bot/app.yml`, installed on the n3ary org. The bot is a contributor, not a privileged actor — no org-level bypass-actor rule is required.

The `n3ary/actions/.github/actions/version-bump` composite action **remains** for the `version-input` publish path (used by `gtfs-publisher`'s `release-gtfs-spec.yml` and `gtfs-adapters`'s `release-gtfs-adapter.yml` to publish a specific version). Its `pr-bump` mode is deprecated; no consumer calls it.

## What this means for existing repos

On cutover, each consumer repo's `package.json#version` is set to today's CalVer (`26.7.11-1` if today is 11 July 2026). After that, every PR merge produces a new CalVer commit on main automatically. The previous semver versions are not carried over; the new CalVer versions start fresh from the cutover date.
