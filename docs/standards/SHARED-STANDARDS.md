<!-- synced from n3ary/standards@4175a47 on 2026-07-11 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Shared standards manifest

Lists which standards are shared (canonical in `n3ary/standards/`) vs local-only (in the consumer repo's own `docs/standards/`).

## Shared (canonical in this repo)

Every standard below is vendored into each consumer repo's `docs/standards/` via the sync workflow.

| Standard | Purpose |
|---|---|
| [agent-worktrees.md](agent-worktrees.md) | When AI agents may use git worktrees; always ask first. |
| [comments.md](comments.md) | Inline comment policy: one-line WHY only; restated prose is deleted, not preserved. |
| [core-principles.md](core-principles.md) | Simplicity first, reuse before write, clean architecture. |
| [diagramming.md](diagramming.md) | Mermaid + GFM admonitions — visual conventions. |
| [documentation.md](documentation.md) | Where docs live, how to write them, what doesn't belong. |
| [issue-plan-lifecycle.md](issue-plan-lifecycle.md) | Plans are short-lived work artifacts on a branch, not in `main`; issues are long-lived records of intent. |
| [naming.md](naming.md) | Files, directories, code identifiers. |
| [repo-settings.md](repo-settings.md) | Branch protection, merge strategy, Dependabot, secret scanning — applied to every n3ary repo. |
| [testing.md](testing.md) | Scope, location, size targets. |
| [verification.md](verification.md) | Verify before stating; confidence in answers. |
| [version-management.md](version-management.md) | CalVer `YY.M.D-N` versions in `Europe/Bucharest` timezone. Bump on merge to `main` by the org-level release bot. |
| [workflow-naming.md](workflow-naming.md) | The `[<type>] <subject> (<trigger>)` format for `name:` and the `<verb>-<scope>.yml` format for filenames. |
| [workflow-conventions.md](workflow-conventions.md) | The description block header, least-privilege `permissions:`, `head.sha` checkout for post-merge workflows. |
| [org-automation.md](org-automation.md) | The `n3ary-release-bot` Cloudflare Worker + GitHub App. Install, deploy, on-call, secret rotation. |

## Local-only (per consumer repo)

### `neary`

- [`docs/standards/feed-agnostic.md`](https://github.com/n3ary/app/blob/main/docs/standards/feed-agnostic.md) — the "no per-feed exceptions" rule is app-specific. The producer repos (`gtfs`, `gtfs-adapters`) are upstream of app's data and don't apply.

### `neary-gtfs`

None today. Future feed-pipeline-specific standards (e.g. CSV-encoding rules, ETag-skip semantics) belong in `neary-gtfs/docs/standards/`.

### `gtfs-adapters`

None today. Future per-feed-adapter-specific standards (e.g. CSV encoding rules for one feed) belong in `gtfs-adapters/adapters/<feed>/docs/standards/` rather than at the repo root.

## Adding a standard

1. **Cross-repo?** → put it in this repo's `standards/` directory. Add it to the table above. The sync workflow will vendore it to every consumer repo on the next push.
2. **Consumer-specific?** → put it in that consumer repo's `docs/standards/`. Don't add it to this manifest.

Renaming / removing a standard: delete or rename the file here, update the table above, push. The sync workflow will create vendor PRs that delete or rename the vendored copies in each consumer repo.