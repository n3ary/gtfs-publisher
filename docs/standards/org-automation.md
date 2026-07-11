<!-- synced from n3ary/standards@4175a47 on 2026-07-11 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Org automation: the release bot

The n3ary org runs an org-level GitHub App called **`n3ary-release-bot`** that bumps `package.json#version` on `main` after every merged PR. The bot is the canonical place for cross-cutting version management; per-consumer workflows do not implement version bumps.

## What the bot does

On every `pull_request: closed` event with `merged == true`, the bot:

1. Verifies the webhook signature.
2. Reads the repo's `package.json#version` on the current `main` tip.
3. Computes the next **CalVer** version: `YY.M.D-N` in `Europe/Bucharest` timezone, counter resets at day boundary, counter starts at `1`. See [version-management.md](version-management.md) for the format and the algorithm.
4. Checks whether the merge commit already changed the version (the `skip-if-already-touched` rule). If yes, the bot no-ops.
5. Creates a new branch `release/calver-<version>` from the merge commit.
6. Commits the version bump to the new branch (a single commit covering all bumped `package.json` files in the repo).
7. Opens a pull request from the new branch to `main`, titled `chore(release): <version>`.
8. Enables **auto-merge** on the pull request.

The PR is a normal contributor PR. With 0 required reviews (n3ary's branch protection standard), auto-merge fires as soon as the required status checks pass. The version lands on `main` within ~10-30 seconds of the original PR merge, without any human click.

## Why PR-based (not direct push)

GitHub's `bypass_actors` feature for GitHub Apps requires **GitHub Team or Enterprise** ($4/user/month). The n3ary org is on the free plan. The PR-based flow works on the free plan:

- The bot is a contributor, not a privileged actor.
- The version-bump PR goes through the normal review + status-checks path.
- Auto-merge handles the merge itself.
- No bypass-actor rule, no Team upgrade, no direct push to `main`.

The trade-off: the version-bump PR is visible in the org's PR queue (you can ignore it; it's a one-line change). If a required status check is broken, the PR sits open until the check is fixed or the PR is merged manually.

The bot is a Cloudflare Worker. Source: `n3ary/release-bot/src/`. Deploy: `wrangler deploy` from the repo root.

## What the bot does NOT do

- **Bump on the PR branch.** The PR branch is the dev's; the bot has no business there. The whole point of the bot is the bump happens on `main`, not on the PR.
- **Bump on a tag, on a schedule, or on `push` to `main` directly.** Those are anti-patterns. See [version-management.md](version-management.md).
- **Bypass the review / checks path.** The version-bump PR goes through the normal review + status-checks path with the bot acting as a contributor. No org-level bypass-actor rule, no admin override, no direct-push privilege. The audit trail is the same as any other contributor PR.
- **Publish to npm, push a container image, or deploy.** Those are per-consumer workflows with repo-specific secrets. The bot is version-management only.
- **Resolve merge conflicts.** If the bot's commit fails (e.g. the branch ref was updated by a concurrent run), the bot retries with the latest state. Bounded retries; after N failures it surfaces an alert.

## Where it lives

```
n3ary/release-bot/
├── app.yml                     # GitHub App manifest
├── src/
│   ├── index.ts                # Worker entry, route dispatch
│   ├── webhook.ts              # webhook signature verification, event handling
│   ├── bump.ts                 # CalVer arithmetic: nextCalVer(current, now, tz)
│   ├── commit.ts               # discoverAndOpenPR: discover, skip rules, branch, commit, PR, auto-merge
│   ├── pr.ts                   # createBranch, openPullRequest, enableAutoMerge, findOpenReleasePR
│   ├── auth.ts                 # JWT signing + installation token exchange
│   └── types.ts                # shared types
├── test/
│   ├── bump.test.ts            # CalVer unit tests
│   ├── commit.test.ts          # per-file idempotency tests (skip rules, isPackageTouched)
│   └── helpers.ts              # test helpers
├── wrangler.toml               # Cloudflare Worker config
├── pnpm-workspace.yaml         # pnpm 11 allowBuilds: for esbuild + sharp + workerd
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
└── README.md                   # install + deploy + on-call runbook
```

The repo is public. The Cloudflare Worker secrets (app ID, app private key, webhook secret) are not in the repo; they are set via `wrangler secret put` during deploy.

## Install (one-time, on the n3ary org)

### 1. Register the GitHub App

The app is registered via a manifest-based flow:

1. Go to `https://github.com/organizations/n3ary/settings/apps/new` (or the equivalent for the org).
2. Paste the contents of `n3ary/release-bot/app.yml` as the manifest.
3. Confirm the app's name (`n3ary-release-bot`), webhook URL (the Cloudflare Worker URL), and the `pull_request` event.
4. GitHub creates the app and provides an **App ID** and a **private key** (PEM). Download the private key; it does not get shown again.

### 2. Set the Cloudflare Worker secrets

From the `n3ary/release-bot` repo root:

```bash
wrangler secret put GITHUB_APP_ID
# paste the App ID

wrangler secret put GITHUB_APP_PRIVATE_KEY
# paste the entire PEM, including the BEGIN/END lines

wrangler secret put GITHUB_WEBHOOK_SECRET
# paste a strong random string; same value goes into the app's "Webhook secret" field in the GH UI
```

### 3. Deploy the Worker

```bash
wrangler deploy
```

The Worker is now live at a `*.workers.dev` URL. Configure the GitHub App's webhook URL to that URL (append `/webhook`).

### 4. Install the app on the org

In the GitHub App settings, click "Install App" and select the n3ary org. Grant access to "All repositories" (or a specific subset if you want to limit the bot to certain repos).

### 5. Re-accept the new permissions in the GH UI (only if upgrading from a previous version)

If the app was already installed on the org (e.g. from a previous version of this bot that used direct push), GitHub will show a "new permissions requested" banner in the app's settings. The new permission is `pull_requests: write` (needed for the bot to open PRs and enable auto-merge). Click through and accept. Without this, the bot can create the branch and commit, but cannot open the PR or enable auto-merge.

### 6. Remove the per-repo `github-actions[bot]` bypass (cleanup)

Before the bot was added, some repos had a per-repo bypass for `github-actions[bot]` to handle the `action_required` gate from the old auto-bump. That bypass is no longer needed. Walk each repo's branch protection settings and remove the `github-actions[bot]` entry. This cleanup is part of the consumer PR for each repo.

## How it works in detail

### Webhook handling

The Worker accepts `POST /webhook`. It:

1. Reads the `X-Hub-Signature-256` header.
2. Computes HMAC-SHA256 of the body with the webhook secret.
3. Compares the two with `crypto.timingSafeEqual`. Rejects on mismatch.
4. Parses the event.
5. For `pull_request` events with `action == "closed"` and `pull_request.merged == true`, dispatches to the bump logic. Otherwise returns 200 and does nothing.

### CalVer arithmetic

The core function is `nextCalVer(current, now, tz)` in `src/bump.ts`:

```typescript
export function nextCalVer(current: string, now: DateTime, tz: string): string {
  const today = now.setZone(tz);
  const todayStr = `${pad2(today.year % 100)}.${today.month}.${today.day}`;

  const parsed = parseCalVer(current);
  if (!parsed) {
    // Current version isn't CalVer (first time, or transitioning from semver).
    return `${todayStr}-1`;
  }

  const currentStr = `${pad2(parsed.year)}.${parsed.month}.${parsed.day}`;
  if (currentStr === todayStr) {
    return `${todayStr}-${parsed.counter + 1}`;
  }

  return `${todayStr}-1`;
}
```

`parseCalVer` accepts the format `YY.M.D-N` and returns `{year, month, day, counter}` or `null` if the string doesn't match. The `null` case (transitioning from semver, or a malformed version) falls back to `${today}-1`, which is the right behavior for the cutover.

### Idempotency (the `skip-if-already-touched` rule)

Before writing a new version, the bot reads the version at `HEAD~1` of `main` (the parent of the merge commit) and compares it to the version at `HEAD` (the merge commit's content). If they differ, the merge already changed the version — the dev's manual edit wins, the bot no-ops.

For multi-package repos, the check is per-`package.json` file. A dev who edits `libs/spec/package.json#version` does not affect the root `package.json#version`, so the root still gets its own bump.

### Committing to the branch

The bot commits the version bump to its own branch (`release/calver-<version>`), not to `main`. The PR + auto-merge is what lands the commit on `main`.

For each bumped `package.json`:

- **Single-file bump**: `PUT /repos/{owner}/{repo}/contents/{path}` with the new file content. The API auto-creates the commit on the bot's branch.
- **Multi-file bump**: Git Data API — `POST /repos/{owner}/{repo}/git/blobs` per file, then `POST /repos/{owner}/{repo}/git/trees` (with `base_tree` set to the merge commit's tree and only the changed entries passed), then `POST /repos/{owner}/{repo}/git/commits`, then `PATCH /repos/{owner}/{repo}/git/refs/heads/<branch>` to update the branch ref.

In both cases, the commit author is the app's identity (`n3ary-release-bot[bot] <[email protected]>`) and the commit message is `chore(release): <version>` (single) or `chore(release): <v1>, <v2>, ...` (multi-file, one entry per bumped `package.json`).

The bot does NOT touch `main` directly. The PR + auto-merge is what lands the commit on `main`.

### Concurrency

Two PRs that merge in quick succession can fire two bot invocations. The Cloudflare Worker is stateless, so there's no built-in mutex. The bot's idempotency guards are:

- **`createBranch` is idempotent** (`src/pr.ts`): if the branch already exists (e.g. from a previous attempt for the same version), the function returns `"exists"` instead of erroring. The bot continues with the commit step on the existing ref.
- **`findOpenReleasePR` short-circuits** (`src/pr.ts`): if a previous webhook run already created a `release/calver-*` PR that's still open, the new event no-ops and the existing PR is the one that lands. Surfaced in the log as `Idempotency: open release PR #N already exists; no-op`.

These two guards cover the common races. Transient GitHub API errors (5xx) get a standard bounded retry. After N failures, the Worker logs the failure and the next PR merge re-triggers the bump for the missed one.

## On-call runbook

When the bot fails:

1. Check the Cloudflare Worker logs: `wrangler tail` from the repo root. Look for the last 100 events.
2. If the failure is a GitHub API error (5xx), wait and retry. GitHub's API has transient failures.
3. If the failure is a `409 Conflict` after 3 retries, manually verify the state of `main`:
   ```bash
   gh api repos/n3ary/<repo>/contents/package.json --jq '.content' | base64 -d | jq .version
   ```
   If the version is stale (not the expected CalVer), trigger a manual bump:
   ```bash
   curl -X POST https://n3ary-release-bot.<account>.workers.dev/test/bump \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"owner":"n3ary","repo":"<repo>","ref":"main"}'
   ```
4. If the failure is repeated across multiple repos, check the bot's installation status in the GitHub UI. The app may have been suspended or its installation token may have expired.
5. If the failure is a Cloudflare Worker issue (Worker down, region outage), the version bumps are deferred. The next successful deploy re-triggers them via the next PR merge.

## Secret rotation

The bot has four secrets, all stored as Cloudflare Worker secrets:

- `GITHUB_APP_ID` — the app's numeric ID. Stable; rotate only if the app is recreated.
- `GITHUB_APP_PRIVATE_KEY` — the app's PEM private key. Rotate annually. The old key remains valid until you remove it from the GH UI; the new key works immediately. No downtime.
- `GITHUB_WEBHOOK_SECRET` — a strong random string used to sign webhooks. Rotate annually, or immediately if a leak is suspected. To rotate, set a new value via `wrangler secret put`, then update the app's "Webhook secret" in the GH UI to match.
- `ADMIN_TOKEN` — bearer token for the manual `/test/bump` endpoint (used in the on-call runbook). Rotate annually, or immediately if a leak is suspected.

After rotating any secret, verify with a test PR merge that the bot still fires.

## What this is NOT

- **Not release-please.** Google's release-please opens a Release PR with a CHANGELOG and a version bump; humans review the Release PR before merge. The n3ary bot opens a `chore(release): <version>` PR and enables auto-merge — humans don't have to click, but the commit still goes through the same review + status-checks path as any contributor. The trade-off vs. release-please: less ceremony, no CHANGELOG. CalVer's "date is in the version" is the only human-readable signal needed.
- **Not semantic-release.** semantic-release analyzes commit messages to decide patch/minor/major. The n3ary bot uses CalVer + daily counter, with no commit-message parsing.
- **Not a generic CI runner.** The bot is version-management only. Builds, tests, deploys, and publishes are per-consumer workflows with repo-specific secrets.

## Related

- [version-management.md](version-management.md) — the rule the bot implements
- [workflow-naming.md](workflow-naming.md) — how the per-consumer workflows are named
- [workflow-conventions.md](workflow-conventions.md) — how the per-consumer workflows are structured
- `n3ary/release-bot/` — the bot's source code
