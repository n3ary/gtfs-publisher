<!-- synced from n3ary/standards@f478439 on 2026-07-06 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Repo settings

GitHub-side configuration that every n3ary repo must apply at the org level. Cross-repo so settings stay in lockstep — if one repo drifts, the next person to onboard a new repo will copy the wrong template.

## Branch protection on `main`

Apply the following protection to every repo's `main` branch. PR-only access to `main`, with the same rules for admins as for anyone else.

| Setting | Value | Why |
|---|---|---|
| Require linear history | on | Forces squash or rebase merges; matches the merge strategy below. |
| Require conversation resolution | on | Stops PRs from merging with unresolved review threads. |
| Dismiss stale pull request approvals on new commits | on | A re-pushed change invalidates prior approval. |
| Allow force pushes | off | No rewriting of `main` history. |
| Allow deletions | off | No deleting `main`. |
| Enforce admins | on | Admins follow the same rules as everyone else. No "emergency override" path — fix the workflow, don't bypass it. |
| Required approving reviews | 0 | Default for solo maintainer. Bump to 1+ when a second maintainer joins; flip `require_code_owner_reviews` to on if/when a `CODEOWNERS` file lands. |
| Required status checks | per-repo | Whatever the repo's CI already runs (`validate`, shared `/ ASCII-only check`, shared `/ Standards drift check` for repos that use the shared workflows). For repos with no CI, leave empty. |

API quirk worth knowing: branch protection is **PUT** only (not PATCH). The payload also requires `required_status_checks` in the body — pass `null` to disable. See the [GitHub REST API docs](https://docs.github.com/en/rest/branches/branch-protection).

## Merge strategy

Configured in repo settings → General → Pull Requests.

| Setting | Value | Why |
|---|---|---|
| Allow squash merging | on | Default merge method. |
| Allow rebase merging | on | Optional fast-forward path. |
| Allow merge commits | **off** | With linear history enforced, merge commits can no longer create a non-linear graph — but the button still shows. Off makes the UI match the intent. |
| Always suggest updating pull request branches | on | Reduces conflicts when the base branch advances; pairs with linear history. |
| Automatically delete head branches | on | Keeps the branch list clean. |
| Allow auto-merge | on | Lets CI repos auto-merge PRs when checks pass. |

## Dependabot

Free on public repos; org sits on the Free plan.

| Setting | Value |
|---|---|
| Dependabot alerts (vulnerability alerts) | on |
| Dependabot security updates | on |
| Dependabot version updates (`.github/dependabot.yml`) | on |

`dependabot.yml` shape — every repo that has npm dependencies (i.e. has a `package.json`) and every repo that has GitHub Actions (i.e. has `.github/workflows/*.yml`) gets the following:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 10

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
```

For repos without a `package.json` (e.g. the static `n3ary/website`, the `n3ary/branding` assets repo, `n3ary/actions` reusable workflows), drop the `npm` block and keep only the `github-actions` block.

`dependabot.yml` is per-repo and is **not** vendored by the sync workflow — the shared `/ Standards drift check` verifies the standard file itself, not the per-repo config. Each repo's `dependabot.yml` is its own responsibility.

## Secret scanning

Free for public repos; off for private without GHAS.

| Setting | Value |
|---|---|
| Secret scanning | on |
| Push protection | off (requires GitHub Advanced Security — paid) |

## Applying these settings

The branch protection, merge strategy, and Dependabot / secret scanning toggles are not vendored — each repo opts in via the GitHub API or repo settings UI. The bootstrap sequence for a new repo:

1. Create the repo.
2. Apply the branch protection from the table above (`PUT /repos/{owner}/{repo}/branches/main/protection`).
3. Apply the merge strategy from the table above (`PATCH /repos/{owner}/{repo}` with `delete_branch_on_merge`, `allow_squash_merge`, `allow_rebase_merge`, `allow_merge_commit: false`, `allow_auto_merge: true`, `allow_update_branch: true`).
4. Drop `.github/dependabot.yml` (per the ecosystem rule) and commit it.
5. Enable Dependabot alerts + security updates + secret scanning on the repo (`PATCH /repos/{owner}/{repo}` with `security_and_analysis.*`).

## Anti-patterns

- **Disabling `enforce_admins`** to "fix something quickly" — fixes the symptom, creates a footgun for next time. The right move is to fix the workflow that's blocking you.
- **Allowing merge commits** "just for this one PR" — the inconsistency lingers and the UI shows the wrong button. Squash or rebase; nothing else.
- **Pushing `dependabot.yml` only to repos with `package.json`** — repos with reusable workflows still need `github-actions` ecosystem updates; `actions/checkout` etc. age.
- **Enabling push protection on the Free plan** — the toggle is greyed out at the repo level, but a misclick at the org-level GHAS page will try to bill you. Don't.
- **Skipping the `github-actions` ecosystem on a static repo** — even a pure-HTML repo with `.github/workflows/*.yml` needs Dependabot to bump its `uses:` refs.

## Cross-refs

- [agent-worktrees.md](agent-worktrees.md) — agent-specific workflow rules ("always open a PR", "no direct push to main"); its settings table now points here.
- [version-management.md](version-management.md) — `package.json#version` bumping rules, unrelated to GitHub settings but often the reason a PR pipeline runs.
