<!-- synced from n3ary/standards@4175a47 on 2026-07-11 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Workflow conventions

Rules every workflow file in every n3ary repo follows. These are the *content* rules that complement the [naming rules](workflow-naming.md). Read this once before editing any workflow file; refer back when in doubt.

## The description block header

Every workflow file starts with a comment block that reads as English. The header is the first thing a human sees when they open the file; it answers the four questions that come up cold: what, when, what does it need, who do I ping.

```yaml
# ----------------------------------------------------------------------------
# [check] PR validation (on PR)
#
# Validates every PR: shared ASCII + standards-drift checks, repo-specific
# build + test + pipeline smoke. Never pushes to the branch.
#
# Trigger:     pull_request
# Permissions: contents: read, packages: read
# Secrets:     NPM_TOKEN (for pnpm install from GH Packages)
# Owner:       @ciotlosm
# Run time:    ~3-7 min
# ----------------------------------------------------------------------------
name: '[check] PR validation (on PR)'

on:
  pull_request:
    branches: [main]
...
```

### Field reference

| Field | Required | Meaning |
|---|---|---|
| `name:` line | yes | The `[<type>] <subject> (<trigger>)` from the naming standard. Use single quotes around the value to keep YAML simple even when the subject contains colons. |
| `# <name>` line | yes | Repeat of the `name:` field, in plain text. For humans reading the file. |
| `#` blank line + one-line purpose | yes | One or two sentences. What does this workflow *do*, in plain English, without jargon? |
| `Trigger:` | yes | The trigger in plain English. If multiple triggers, list them. |
| `Permissions:` | yes | The `permissions:` block, in plain English. List each scope with its level. |
| `Secrets:` | yes if any | Every secret the workflow reads, with the reason in parentheses. If none, write `Secrets: none`. |
| `Owner:` | yes | The GitHub username to ping when this breaks. For n3ary: always `@ciotlosm`. |
| `Run time:` | yes | Typical wall-clock duration. Format: `~N min`, `~N sec`, or `~N-M min` for a range. |

The header is a comment. YAML ignores it. The header is for humans and for grep.

## Principle of least privilege for `permissions:`

Every workflow declares the minimum `permissions:` it actually needs. The default for the whole workflow is at the top, and individual jobs can override per-job `permissions:` when they need less (or more, rarely).

### Defaults to apply

- **`[check]` workflows: `contents: read`, `packages: read`**. They validate; they never push. The `pr-check.yml` workflow in every consumer repo should look like this after the cutover.
- **`[build]` workflows: `contents: read`, `packages: write`**. They need `packages: write` only if they push a container image to GHCR.
- **`[deploy]` workflows: `contents: read`**. They read the repo (e.g. to resolve a SHA), they don't push.
- **`[release]` workflows: `contents: write`, `packages: write`, `id-token: write`** (the last for npm provenance). The bot is the exception; it gets a different identity, see [org-automation.md](org-automation.md).
- **`[ops]` workflows: `contents: read`, `issues: write` if it files recovery issues, `actions: read` if it inspects other runs**.
- **`[monitor]` workflows: `contents: read`, `issues: write` if it files incidents**.

### The `contents: write` privilege

**`contents: write` on a PR-time workflow is a red flag.** It means the workflow can push commits to the repo. With the release bot in place, the only consumer workflow that needs `contents: write` is `[release]`. The `[check]` (PR validation) workflow MUST drop to `contents: read` after the cutover. If you find yourself adding `contents: write` to a PR-time workflow, stop and ask: should this be the release bot instead?

### Per-job overrides

Jobs that need less than the workflow default can override per-job `permissions:`:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: read
    steps: ...

  publish:
    runs-on: ubuntu-latest
    needs: test
    permissions:
      contents: write
      packages: write
      id-token: write
    steps: ...
```

This is the right shape: the `test` job has the least privilege it needs; only `publish` has write access. The default at the top of the file is the *narrowest* of the per-job needs, used as a fallback for any job that doesn't override.

## The `head.sha` checkout for post-merge workflows

When a workflow runs *after* a PR merge (i.e. on `pull_request: types: [closed]` with `merged == true`, or on `push: branches: [main]` from the merge), and the workflow reads the version of the just-merged content, the checkout must use the **PR's head SHA**, not the current tip of `main`.

Why: the release bot pushes a `chore(release)` commit to `main` shortly after the merge. If a publish or build workflow checks out `main` *after* the bot's push, the workflow sees the *next* version, not the version that corresponds to the just-merged PR's content. That makes the published artifact report the wrong version.

```yaml
on:
  pull_request:
    types: [closed]
    branches: [main]

jobs:
  publish:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - name: Checkout PR tip
        uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
```

This is the canonical pattern for any workflow that needs to read the *content* of the just-merged PR. Workflows that need to read the *current state of main* (e.g. for the post-bump version) check out `main` as usual; those are rare in practice.

## What belongs in a workflow vs. in the release bot

Some work is per-consumer, some is org-level. The decision boundary:

**Per-consumer workflow** (lives in the consumer repo's `.github/workflows/`):
- Anything that reads repo-specific secrets (`NPM_TOKEN`, `TRANZY_API_KEY`, `GHCR_TOKEN`, `CLOUDFLARE_API_TOKEN`, etc.).
- Anything that runs the consumer's own test/build pipeline (`pnpm test`, `pnpm build`, the full pipeline smoke).
- Anything that deploys to repo-specific infrastructure (Hetzner VM, Cloudflare Pages project, etc.).
- PR-time validation: lint, type-check, test, ASCII check, standards drift.

**Org-level release bot** (lives in `n3ary/release-bot/`):
- The version bump on main. Cross-cuts every repo; identical logic everywhere; no per-repo secrets.
- Anything that should behave identically across all repos with no configuration drift.

**Shared action in `n3ary/actions/`** (lives in `n3ary/actions/.github/actions/`):
- A *composable piece* of workflow logic that multiple consumer workflows call with different inputs (e.g. `setup-pnpm-gh-packages-auth`, `package/publish` with `version-input`).
- Reusable workflow logic that benefits from versioned releases.

If a piece of work could be done the same way in every repo with no per-repo configuration, it belongs in the release bot, not in a per-consumer workflow.

## Branch protection alignment

Every n3ary repo's `main` branch has the same protection rules:

- **Require a pull request before merging.** No direct pushes (except via the org-level bypass for the release bot).
- **Require approvals: 1.**
- **Dismiss stale pull request approvals when new commits are pushed.**
- **Require status checks to pass before merging.** The set of required checks is repo-specific; the shared ones are `shared / ASCII-only check` and `shared / Standards drift check`.
- **Require branches to be up to date before merging.**
- **Do not allow force pushes.**
- **Do not allow deletions.**

The release bot is added to the org-level "Allow specified actors to bypass required pull requests" list. This means the bot's `chore(release)` commits land on `main` directly, without going through a PR. Per-repo `github-actions[bot]` bypass rules (which were needed for the old `auto-bump on PR` model) are removed during the consumer cleanup.

## Dependabot

Every n3ary repo has `.github/dependabot.yml` configured for both ecosystems:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-pull-requests-limit: 10

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
```

Dependabot is necessary but not sufficient. The `gtfs-adapters` `version-bump@v12` staleness (PR #44, merged 2026-07-06, bumped 2 of 3 `n3ary/actions` references) is documented evidence: Dependabot's grouping can miss a reference in a multi-reference file. The release bot eliminates the per-consumer action reference for versioning entirely, so this class of bug cannot recur for the version-bump concern. Dependabot remains the source of truth for npm and public GitHub Actions updates; the org-automation layer covers the org-specific concerns.

## How to apply these conventions to a new workflow

1. Pick the type from the [naming standard](workflow-naming.md). If you can't fit the workflow into the type vocabulary, document the deviation in the description block header and tell `@ciotlosm` so the standard can grow.
2. Pick the trigger from the same standard. Be specific. Avoid bare `on push`.
3. Write the description block header at the top of the file. Use the exact field names from this doc.
4. Declare the narrowest `permissions:` the workflow needs. Default to `contents: read` unless a job needs write.
5. If the workflow reads the version of the just-merged PR's content, use the `head.sha` checkout pattern. If it reads the current state of `main`, use the regular `ref: main` pattern.
6. If the work could be done the same way in every repo with no per-repo config, consider whether it belongs in the release bot instead.
7. Open a PR. The diff is reviewable in one read.
