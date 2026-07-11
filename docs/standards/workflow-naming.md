<!-- synced from n3ary/standards@4175a47 on 2026-07-11 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Workflow naming

Every workflow file in every n3ary repo follows a single naming convention. The convention has two parts: the **filename** and the **`name:` field** at the top of the file. Both are required. Both are read by humans and by tools.

## The `name:` field format

```
[<type>] <subject> (<trigger>)
```

Three pieces, in order:

- **`<type>`** — the *purpose* of the workflow, from a fixed vocabulary. Always in square brackets.
- **`<subject>`** — a noun phrase that names the artifact, system, or concern. Never a verb.
- **`<trigger>`** — when the workflow runs, in plain English, in parentheses.

The format is the same in the file (as the `name:` field) and in the filename (without the brackets, see below). When a human scans the Actions tab of any n3ary repo, every row starts with a recognizable type tag, and the list sorts usefully.

### Type vocabulary

Pick exactly one. The type describes *what the workflow does*, not what it touches.

| Type | Does what | Example |
|---|---|---|
| `check` | Validates PRs, runs tests, lints, drift-checks. Never pushes. | `[check] PR validation (on PR)` |
| `build` | Produces an artifact (container image, binary) but doesn't deploy it. | `[build] gtfs-rt container image (on push to main)` |
| `deploy` | Ships an artifact to a runtime (VM, edge, K8s). | `[deploy] PWA to Cloudflare Pages (on push to main)` |
| `release` | Publishes a versioned package (npm, container, tag) to a registry. | `[release] @n3ary/gtfs-spec to GH Packages (on PR merge)` |
| `ops` | Infrastructure work (VM rebuild, recovery, manual DB ops). | `[ops] rebuild gtfs-rt VM (manual)` |
| `monitor` | Periodic healthcheck or sync; usually write-only to issues/status. | `[monitor] gtfs-rt uptime (on schedule)` |
| `deps` | Dependabot / Renovate. Auto-generated, mostly hands-off. | `[deps] Dependabot updates (on schedule + on PR)` |

If a workflow does more than one of these things, **split it**. A single workflow that builds, deploys, and publishes is three workflows, not one.

### Subject rules

- **The subject is a noun phrase that names the thing, not the action.** `gtfs-rt container image` not `Build gtfs-rt image`. `@n3ary/gtfs-spec` not `publish @n3ary/gtfs-spec`.
- **Multi-artifact repos: always include the artifact.** `gtfs-rt container image` (which image), `@n3ary/gtfs-spec` (which package), `gtfs-adapter-cluj-napoca` (which adapter).
- **Single-artifact repos: can be the app name.** `PWA` for `n3ary/app`, `marketing site` for `n3ary/website`, `branding assets` for `n3ary/branding`.
- **Never use a verb in the subject.** The type already encodes the action; the subject is the *thing being worked on*.
- **No registry paths in the name.** The registry isn't the artifact. `Build ghcr.io/n3ary/gtfs-rt` is wrong; `gtfs-rt container image` is right.
- **No arrows or decorative symbols.** `Daily multi-feed pipeline → R2` is wrong; `daily multi-feed pipeline to R2` is right. The arrow adds nothing.
- **No parentheticals for the artifact.** `gtfs-rt recovery (VM reboot)` is wrong; the subject is `gtfs-rt VM recovery`, no parenthetical needed.
- **Always include a scope when the type doesn't make it obvious.** `Deploy to Hetzner` is wrong (deploy of what?); `gtfs-rt to Hetzner` is right. `Deploy to Production` is wrong (production of what?); `PWA to Cloudflare Pages` is right.

### Trigger vocabulary

Pick exactly one. The trigger describes *when* the workflow runs, in plain English.

| Trigger | GitHub YAML |
|---|---|
| `on PR` | `pull_request` (any branch) |
| `on PR to main` | `pull_request: branches: [main]` |
| `on push to main` | `push: branches: [main]` |
| `on PR merge` | `pull_request: types: [closed]` with `if: github.event.pull_request.merged == true` |
| `on schedule` | `schedule: cron: ...` |
| `on webhook` | `repository_dispatch` (external trigger) |
| `manual` | `workflow_dispatch` only |
| `on PR + manual` | combo (rare; prefer two workflows) |
| `on schedule + manual` | combo (common for ops and monitor) |

Avoid `on push` (any branch). Be specific. `on push to main` is almost always what you want; bare `on push` triggers on every branch push, which is rarely the intent.

## Filename format

```
<verb>-<scope>.yml
```

Lowercase, kebab-case, leading verb. The verb is the type. The scope is the subject (or a shortened form of it when the subject is long).

| `name:` field | Filename |
|---|---|
| `[check] PR validation (on PR)` | `pr-check.yml` |
| `[build] gtfs-rt container image (on push to main)` | `build-gtfs-rt.yml` |
| `[release] @n3ary/gtfs-spec to GH Packages (on PR merge)` | `release-gtfs-spec.yml` |
| `[release] @n3ary/gtfs-adapter-cluj-napoca to GH Packages (on PR merge)` | `release-gtfs-adapter.yml` |
| `[release] daily multi-feed pipeline to R2 (on schedule)` | `release-daily-multi-feed.yml` |
| `[deploy] PWA to Cloudflare Pages (on push to main)` | `deploy-pwa.yml` |
| `[deploy] gtfs-rt to Hetzner (manual)` | `deploy-gtfs-rt.yml` |
| `[ops] rebuild gtfs-rt VM (manual)` | `ops-rebuild-gtfs-rt-vm.yml` |
| `[ops] gtfs-rt VM recovery (manual)` | `ops-recover-gtfs-rt-vm.yml` |
| `[monitor] gtfs-rt uptime (on schedule)` | `monitor-gtfs-rt-uptime.yml` |

The filename and the `name:` field carry the same information. The filename is what you see in the file tree; the `name:` field is what you see in the Actions tab. Keeping them in sync means the file is self-describing in both views.

## Why this convention

- **The Actions tab is the org's CI health dashboard.** When the list reads `[check]`, `[build]`, `[deploy]`, `[release]`, `[ops]`, `[monitor]`, you can scan it for the failure type in one glance. When the list reads `Build ghcr.io/...`, `Daily multi-feed pipeline → R2`, `gtfs-rt recovery (VM reboot)`, you can't.
- **The convention is grep-able.** `grep -l '^\[release\]' .github/workflows/*.yml` finds every publish path. `grep -l 'on PR merge' .github/workflows/*.yml` finds every workflow that depends on a merged PR. The structure pays off in tooling.
- **The convention is teaching.** When someone opens a workflow file, the filename and the `name:` field together tell them the purpose before they read a single YAML line. They don't have to read the `on:` and `jobs:` blocks to know what they're looking at.

## Examples: before and after

### `gtfs-publisher` (current → target)

| Current `name:` | Current file | Target `name:` | Target file |
|---|---|---|---|
| `Build ghcr.io/n3ary/gtfs-rt` | `build-gtfs-rt.yml` | `[build] gtfs-rt container image (on push to main)` | `build-gtfs-rt.yml` |
| `Daily multi-feed pipeline → R2` | `daily.yml` | `[release] daily multi-feed pipeline to R2 (on schedule)` | `release-daily-multi-feed.yml` |
| `Deploy gtfs-rt to Hetzner` | `deploy-gtfs-rt.yml` | `[deploy] gtfs-rt to Hetzner (manual)` | `deploy-gtfs-rt.yml` |
| *(empty — no name field)* | `publish-spec.yml` | `[release] @n3ary/gtfs-spec to GH Packages (on PR merge)` | `release-gtfs-spec.yml` |
| `Rebuild gtfs-rt VM` | `rebuild-gtfs-rt-vm.yml` | `[ops] rebuild gtfs-rt VM (manual)` | `ops-rebuild-gtfs-rt-vm.yml` |
| `gtfs-rt recovery (VM reboot)` | `recovery.yml` | `[ops] gtfs-rt VM recovery (manual)` | `ops-recover-gtfs-rt-vm.yml` |
| `gtfs-rt uptime` | `uptime.yml` | `[monitor] gtfs-rt uptime (on schedule)` | `monitor-gtfs-rt-uptime.yml` |
| `PR Validation` | `pr-validation.yml` | `[check] PR validation (on PR)` | `pr-check.yml` |

### `gtfs-adapters`

| Current `name:` | Current file | Target `name:` | Target file |
|---|---|---|---|
| `PR Validation` | `pr-validation.yml` | `[check] PR validation (on PR)` | `pr-check.yml` |
| `Publish adapters` | `publish-adapter.yml` | `[release] @n3ary/gtfs-adapter-cluj-napoca to GH Packages (on PR merge)` | `release-gtfs-adapter.yml` |

### `app`

| Current `name:` | Current file | Target `name:` | Target file |
|---|---|---|---|
| `PR Validation` | `pr-validation.yml` | `[check] PR validation (on PR)` | `pr-check.yml` |
| `Deploy to Production` | `deploy-production.yml` | `[deploy] PWA to Cloudflare Pages (on push to main)` | `deploy-pwa.yml` |

### `website` and `branding`

| Current `name:` | Current file | Target `name:` | Target file |
|---|---|---|---|
| `PR Validation` | `pr-validation.yml` | `[check] PR validation (on PR)` | `pr-check.yml` |
| `Deploy to Cloudflare Pages` | `deploy.yml` | `[deploy] marketing site to Cloudflare Pages (on push to main)` | `deploy-marketing.yml` (or `deploy-site.yml`) |
| `Deploy to Cloudflare Pages` | `deploy.yml` (`branding`) | `[deploy] branding assets (on push to main)` | `deploy-branding.yml` |

## How to apply

1. Open the workflow file.
2. Add the new `name:` field at the top, in the `[<type>] <subject> (<trigger>)` format.
3. If the file is being renamed, do it in the same commit. The old file is deleted, the new file is created with the new name and the new `name:` field. Update any docs or references that point to the old filename.
4. Add the description block header from [workflow-conventions.md](workflow-conventions.md) at the top of the file.
5. Open a PR. The diff is reviewable in one read.

## What if a workflow doesn't fit the vocabulary

The vocabulary is intentionally small. If a workflow genuinely doesn't fit (e.g. a one-off migration script, a data backfill), use the closest type and document the deviation in the description block. The convention is a tool for consistency, not a cage.
